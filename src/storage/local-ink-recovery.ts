import { planConcurrentInkAppendMerge } from '../domain/ink-concurrent-append-merge';
import {
  applyPreparedInkCommand,
  applyPreparedInkPhysicalSchemaActivation,
  assertInkPreparedPhysicalSchemaPlan,
  hashRecoveryBytes,
  type InkPreparedCommandPatch,
  type InkPreparedPhysicalSchemaActivation,
  type InkPreparedPhysicalSchemaPlan,
} from '../domain/ink-recovery-patch';
import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkSurfaceRecord,
} from '../domain/ink-surface';

const LEGACY_RECOVERY_LIMITS = Object.freeze({
  baseBytes: 16 * 1024 * 1024,
  commandBytes: 512 * 1024,
  entriesPerGeneration: 100_000,
});

interface LocalInkRecoveryCheckpointBase {
  readonly capturedAt: string;
  readonly filePath: string;
  readonly generation: string;
  readonly records: readonly InkSurfaceRecord[];
}

export type LocalInkRecoveryCheckpoint =
  | (LocalInkRecoveryCheckpointBase & { readonly version: 1 | 2 })
  | (LocalInkRecoveryCheckpointBase & {
      readonly expectedBases: readonly InkSurfaceRecord[];
      readonly pendingAttempts: readonly (InkSurfaceRecord | null)[];
      readonly version: 3;
    })
  | (LocalInkRecoveryCheckpointBase & {
      readonly acknowledgedRecords: readonly InkSurfaceRecord[];
      readonly acknowledgedSequence: number;
      readonly baseRecords: readonly InkSurfaceRecord[];
      readonly lastSequence: number;
      readonly version: 4;
    });

/** Temporary compatibility boundary for reading retired S26/S26R1 data. */
export interface InkLegacyRecoveryReader {
  load(filePath: string): LocalInkRecoveryCheckpoint | null;
}

export type LocalInkRecoveryPlan =
  | { readonly kind: 'conflict'; readonly message: string }
  | {
      readonly expectedBases: readonly InkSurfaceRecord[];
      readonly kind: 'none' | 'restore';
      readonly records: readonly InkSurfaceRecord[];
      readonly writes: readonly InkSurfaceRecord[];
    };

/**
 * Read-only migration reader for Recovery v1-v4. It never claims, rewrites, quarantines, clears,
 * acknowledges, or compacts legacy bytes. Canonical sidecars are the only migration destination.
 */
export class LocalInkRecoveryReader implements InkLegacyRecoveryReader {
  private readonly journalPrefix: string;
  private readonly checkpointPrefix: string;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'key' | 'length'>,
    vaultName: string,
    deviceId: string,
  ) {
    const scope = `inkstone:${encodeURIComponent(vaultName)}:${encodeURIComponent(deviceId)}:`;
    this.checkpointPrefix = `${scope}ink-recovery-v1:`;
    this.journalPrefix = `${scope}ink-recovery-journal-v4:`;
  }

  load(filePath: string): LocalInkRecoveryCheckpoint | null {
    const journalHead = this.storage.getItem(this.journalHeadKey(filePath));
    if (journalHead !== null) {
      try {
        return this.loadJournal(filePath, journalHead);
      } catch (error) {
        throw new Error(
          `Legacy Recovery Journal v4 is corrupt for ${filePath}; raw bytes were preserved.`,
          { cause: error },
        );
      }
    }

    const contents = this.storage.getItem(this.checkpointKey(filePath));
    if (contents === null) return null;
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!isEncodedCheckpoint(parsed, filePath)) throw new Error('invalid checkpoint envelope');
      const records = parsed.records.map(decodeInkSurfaceRecord);
      assertRecoveryRecords(filePath, records);
      const common = {
        capturedAt: parsed.capturedAt,
        filePath,
        generation: parsed.generation,
        records,
      };
      if (parsed.version !== 3) return { ...common, version: parsed.version };

      const expectedBases = parsed.expectedBases.map(decodeInkSurfaceRecord);
      const pendingAttempts = parsed.pendingAttempts.map((record) =>
        record === null ? null : decodeInkSurfaceRecord(record),
      );
      if (!validSaveState(filePath, records, expectedBases, pendingAttempts)) {
        throw new Error('invalid version-3 checkpoint records');
      }
      return { ...common, expectedBases, pendingAttempts, version: 3 };
    } catch (error) {
      throw new Error(
        `Legacy Ink Recovery checkpoint is corrupt for ${filePath}; raw bytes were preserved.`,
        { cause: error },
      );
    }
  }

  private loadJournal(filePath: string, headBytes: string): LocalInkRecoveryCheckpoint {
    const head = decodeJournalHead(headBytes, filePath);
    const baseBytes = this.storage.getItem(this.journalBaseKey(filePath, head.generation));
    if (baseBytes === null) throw new Error('missing Recovery Journal v4 base');
    if (byteLength(baseBytes) > LEGACY_RECOVERY_LIMITS.baseBytes) {
      throw new Error('Recovery Journal v4 base exceeds its versioned size limit');
    }
    const base = decodeJournalBase(baseBytes, filePath, head);
    const baseRecords = base.records.map(decodeInkSurfaceRecord);
    assertRecoveryRecords(filePath, baseRecords);
    if (journalRecordsDigest(baseRecords) !== head.baseDigest) {
      throw new Error('Recovery Journal v4 base digest mismatch');
    }

    const entryPrefix = `${this.journalGenerationPrefix(filePath, head.generation)}entry/`;
    const entryKeys = this.storageKeys()
      .filter((key) => key.startsWith(entryPrefix))
      .map((key) => ({ key, sequence: Number(key.slice(entryPrefix.length)) }))
      .sort((left, right) => left.sequence - right.sequence);
    if (entryKeys.length > LEGACY_RECOVERY_LIMITS.entriesPerGeneration) {
      throw new Error('Recovery Journal v4 exceeds its versioned entry limit');
    }

    let records: readonly InkSurfaceRecord[] = baseRecords;
    let digest = head.baseDigest;
    const commandIds = new Set<string>();
    const entries: DecodedJournalEntry[] = [];
    for (const [index, candidate] of entryKeys.entries()) {
      const sequence = index + 1;
      if (!Number.isInteger(candidate.sequence) || candidate.sequence !== sequence) {
        throw new Error('Recovery Journal v4 entry sequence is not contiguous');
      }
      const bytes = this.storage.getItem(candidate.key);
      if (bytes === null) throw new Error('Recovery Journal v4 entry disappeared');
      const envelope = decodeJournalEntry(bytes, head, sequence, digest);
      if (commandIds.has(envelope.commandId)) {
        throw new Error(`Recovery Journal v4 duplicates command ${envelope.commandId}.`);
      }
      records = applyRecoveryJournalCommand(records, base.schemaPlan, envelope.command);
      digest =
        head.digestMode === 'command-chain-v1'
          ? journalCommandChainDigest({
              commandId: envelope.commandId,
              currentDigest: digest,
              payloadChecksum: envelope.payloadChecksum,
              sequence,
            })
          : journalRecordsDigest(records);
      if (digest !== envelope.afterDigest) {
        throw new Error('Recovery Journal v4 after digest mismatch');
      }
      commandIds.add(envelope.commandId);
      entries.push({ command: envelope.command, envelope });
    }

    const acknowledgementBytes = this.storage.getItem(
      this.journalAckKey(filePath, head.generation),
    );
    let acknowledgedRecords: readonly InkSurfaceRecord[] = baseRecords;
    let acknowledgedSequence = 0;
    if (acknowledgementBytes !== null) {
      const acknowledgement = decodeJournalAck(acknowledgementBytes, head, entries.length);
      let acknowledgedWorking: readonly InkSurfaceRecord[] = baseRecords;
      for (const entry of entries.slice(0, acknowledgement.sequence)) {
        acknowledgedWorking = applyRecoveryJournalCommand(
          acknowledgedWorking,
          base.schemaPlan,
          entry.command,
        );
      }
      const versionById = new Map(acknowledgement.surfaces.map((surface) => [surface.id, surface]));
      const expectedSequenceDigest =
        acknowledgement.sequence === 0
          ? head.baseDigest
          : entries[acknowledgement.sequence - 1]?.envelope.afterDigest;
      if (
        versionById.size !== acknowledgedWorking.length ||
        acknowledgedWorking.some((record) => !versionById.has(record.id)) ||
        (acknowledgement.contentMode === 'journal-sequence-v1'
          ? expectedSequenceDigest === undefined ||
            acknowledgement.sequenceDigest !== expectedSequenceDigest
          : acknowledgedWorking.some((record) => {
              const version = versionById.get(record.id) as
                EncodedLegacyJournalSurfaceVersion | undefined;
              return version === undefined || version.contentDigest !== recordContentDigest(record);
            }))
      ) {
        throw new Error('Recovery Journal v4 acknowledgement does not cover an exact prefix.');
      }
      acknowledgedRecords = acknowledgedWorking.map((record) => {
        const version = versionById.get(record.id) as EncodedJournalSurfaceVersion;
        return { ...record, revision: version.revision, updatedAt: version.updatedAt };
      });
      acknowledgedSequence = acknowledgement.sequence;
    }

    let recoveryRecords: readonly InkSurfaceRecord[] = acknowledgedRecords;
    for (const entry of entries.slice(acknowledgedSequence)) {
      recoveryRecords = applyRecoveryJournalCommand(
        recoveryRecords,
        base.schemaPlan,
        entry.command,
      );
    }
    return {
      acknowledgedRecords,
      acknowledgedSequence,
      baseRecords,
      capturedAt: head.capturedAt,
      filePath,
      generation: head.generation,
      lastSequence: entries.length,
      records: recoveryRecords,
      version: 4,
    };
  }

  private checkpointKey(filePath: string): string {
    return `${this.checkpointPrefix}${encodeURIComponent(filePath)}`;
  }

  private journalAckKey(filePath: string, generation: string): string {
    return `${this.journalGenerationPrefix(filePath, generation)}ack`;
  }

  private journalBaseKey(filePath: string, generation: string): string {
    return `${this.journalGenerationPrefix(filePath, generation)}base`;
  }

  private journalGenerationPrefix(filePath: string, generation: string): string {
    return `${this.journalRoot(filePath)}generation/${encodeURIComponent(generation)}/`;
  }

  private journalHeadKey(filePath: string): string {
    return `${this.journalRoot(filePath)}head`;
  }

  private journalRoot(filePath: string): string {
    return `${this.journalPrefix}${encodeURIComponent(filePath)}:`;
  }

  private storageKeys(): readonly string[] {
    return Array.from({ length: this.storage.length }, (_value, index) =>
      this.storage.key(index),
    ).filter((key): key is string => key !== null);
  }
}

/** Builds a fail-closed one-time migration without overwriting a diverged canonical revision. */
export function planLocalInkRecovery(
  canonical: readonly InkSurfaceRecord[],
  checkpoint: LocalInkRecoveryCheckpoint,
  now: string,
): LocalInkRecoveryPlan {
  if (checkpoint.version === 4) {
    const pendingAttempts = checkpoint.records.map((record, index) => {
      const acknowledged = checkpoint.acknowledgedRecords[index];
      if (acknowledged === undefined || sameRecordContent(record, acknowledged)) return null;
      return {
        ...record,
        revision: acknowledged.revision + 1,
        updatedAt: checkpoint.capturedAt,
      };
    });
    return planLocalInkRecovery(
      canonical,
      {
        capturedAt: checkpoint.capturedAt,
        expectedBases: checkpoint.acknowledgedRecords,
        filePath: checkpoint.filePath,
        generation: checkpoint.generation,
        pendingAttempts,
        records: checkpoint.records,
        version: 3,
      },
      now,
    );
  }

  const canonicalById = new Map(canonical.map((record) => [record.id, record]));
  const checkpointIds = new Set(checkpoint.records.map(({ id }) => id));
  if (
    canonicalById.size !== checkpoint.records.length ||
    canonical.some(({ id }) => !checkpointIds.has(id))
  ) {
    return {
      kind: 'conflict',
      message: `Local Ink recovery for ${checkpoint.filePath} no longer matches its canonical surface set.`,
    };
  }

  const writes: InkSurfaceRecord[] = [];
  const records: InkSurfaceRecord[] = [];
  const expectedBases: InkSurfaceRecord[] = [];
  if (checkpoint.version !== 3) {
    for (const recovered of checkpoint.records) {
      const persisted = canonicalById.get(recovered.id);
      if (persisted === undefined || !sameRecordContent(persisted, recovered)) {
        return {
          kind: 'conflict',
          message: `Legacy local Ink recovery surface ${recovered.id} cannot prove its canonical base.`,
        };
      }
      records.push(persisted);
    }
    return { expectedBases, kind: 'none', records, writes };
  }

  for (const [index, recovered] of checkpoint.records.entries()) {
    const persisted = canonicalById.get(recovered.id);
    const expectedBase = checkpoint.expectedBases[index];
    const pendingAttempt = checkpoint.pendingAttempts[index];
    if (
      persisted === undefined ||
      expectedBase === undefined ||
      pendingAttempt === undefined ||
      expectedBase.id !== recovered.id ||
      expectedBase.noteId !== recovered.noteId ||
      expectedBase.filePath !== checkpoint.filePath ||
      (pendingAttempt !== null &&
        (pendingAttempt.id !== recovered.id ||
          pendingAttempt.noteId !== expectedBase.noteId ||
          pendingAttempt.filePath !== checkpoint.filePath ||
          pendingAttempt.revision !== expectedBase.revision + 1))
    ) {
      return {
        kind: 'conflict',
        message: `Local Ink recovery surface ${recovered.id} has invalid version ancestry.`,
      };
    }

    if (pendingAttempt === null) {
      if (!sameRecord(persisted, expectedBase) || !sameRecordContent(recovered, expectedBase)) {
        return {
          kind: 'conflict',
          message: `Local Ink recovery surface ${recovered.id} has no pending attempt for its working content.`,
        };
      }
      records.push(persisted);
      continue;
    }

    if (
      sameRecordContent(persisted, recovered) &&
      (persisted.revision === expectedBase.revision + 1 ||
        persisted.revision === pendingAttempt.revision + 1)
    ) {
      records.push(persisted);
      continue;
    }

    if (sameRecord(persisted, pendingAttempt)) {
      if (!sameRecordContent(recovered, pendingAttempt)) {
        const candidate = {
          ...recovered,
          revision: pendingAttempt.revision + 1,
          updatedAt: now,
        };
        records.push(candidate);
        writes.push(candidate);
        expectedBases.push(pendingAttempt);
      } else {
        records.push(persisted);
      }
      continue;
    }

    const appendMerge = planConcurrentInkAppendMerge({
      base: expectedBase,
      local: sameRecordContent(recovered, pendingAttempt)
        ? pendingAttempt
        : {
            ...recovered,
            revision: expectedBase.revision + 1,
            updatedAt: pendingAttempt.updatedAt,
          },
      remote: persisted,
    });
    if (appendMerge.kind === 'merge') {
      const candidate = { ...appendMerge.record, updatedAt: now };
      records.push(candidate);
      writes.push(candidate);
      expectedBases.push(persisted);
      continue;
    }
    if (appendMerge.kind === 'already-merged') {
      records.push(appendMerge.record);
      continue;
    }

    const effectiveExpectedBase = sameRecord(persisted, expectedBase)
      ? expectedBase
      : sameRecordExceptExpandedLogicalHeight(persisted, expectedBase)
        ? persisted
        : null;
    if (effectiveExpectedBase === null) {
      return {
        kind: 'conflict',
        message: `Local Ink recovery surface ${recovered.id} diverged from its expected canonical base.`,
      };
    }
    const candidate = sameRecordContent(recovered, pendingAttempt)
      ? pendingAttempt
      : {
          ...recovered,
          revision: effectiveExpectedBase.revision + 1,
          updatedAt: now,
        };
    records.push(candidate);
    writes.push(candidate);
    expectedBases.push(effectiveExpectedBase);
  }

  return {
    expectedBases,
    kind: writes.length === 0 ? 'none' : 'restore',
    records,
    writes,
  };
}

type InkRecoveryJournalCommand = InkPreparedCommandPatch | InkPreparedPhysicalSchemaActivation;

interface EncodedJournalHead {
  readonly baseDigest: string;
  readonly capturedAt: string;
  readonly digestMode?: 'command-chain-v1';
  readonly filePath: string;
  readonly generation: string;
  readonly kind: 'head';
  readonly ownerId: string;
  readonly version: 4;
}

interface EncodedJournalBase {
  readonly filePath: string;
  readonly generation: string;
  readonly kind: 'base';
  readonly ownerId: string;
  readonly records: readonly string[];
  readonly recordsChecksum: string;
  readonly schemaPlan?: EncodedPhysicalSchemaPlan;
  readonly version: 4;
}

type EncodedPhysicalSchemaPlan =
  | InkPreparedPhysicalSchemaPlan
  | (Omit<InkPreparedPhysicalSchemaPlan, 'sourceCanonicalBytes'> & {
      readonly sourceEncoding: 'journal-base-records-v1';
    });

interface DecodedJournalBase extends Omit<EncodedJournalBase, 'schemaPlan'> {
  readonly schemaPlan?: InkPreparedPhysicalSchemaPlan;
}

interface EncodedJournalEntry {
  readonly afterDigest: string;
  readonly beforeDigest: string;
  readonly command: InkRecoveryJournalCommand;
  readonly commandId: string;
  readonly generation: string;
  readonly kind: 'entry';
  readonly ownerId: string;
  readonly payloadChecksum: string;
  readonly payloadLength: number;
  readonly sequence: number;
  readonly version: 4;
}

interface DecodedJournalEntry {
  readonly command: InkRecoveryJournalCommand;
  readonly envelope: EncodedJournalEntry;
}

interface EncodedJournalAckBase {
  readonly generation: string;
  readonly kind: 'ack';
  readonly ownerId: string;
  readonly sequence: number;
  readonly surfacesChecksum: string;
  readonly version: 4;
}

interface EncodedJournalSurfaceVersion {
  readonly id: string;
  readonly revision: number;
  readonly updatedAt: string;
}

interface EncodedLegacyJournalSurfaceVersion extends EncodedJournalSurfaceVersion {
  readonly contentDigest: string;
}

interface EncodedLegacyJournalAck extends EncodedJournalAckBase {
  readonly contentMode?: undefined;
  readonly surfaces: readonly EncodedLegacyJournalSurfaceVersion[];
}

interface EncodedSequenceJournalAck extends EncodedJournalAckBase {
  readonly contentMode: 'journal-sequence-v1';
  readonly sequenceDigest: string;
  readonly surfaces: readonly EncodedJournalSurfaceVersion[];
}

type EncodedJournalAck = EncodedLegacyJournalAck | EncodedSequenceJournalAck;

type EncodedCheckpoint =
  | {
      readonly capturedAt: string;
      readonly filePath: string;
      readonly generation: string;
      readonly records: readonly string[];
      readonly version: 1 | 2;
    }
  | {
      readonly capturedAt: string;
      readonly expectedBases: readonly string[];
      readonly filePath: string;
      readonly generation: string;
      readonly pendingAttempts: readonly (string | null)[];
      readonly records: readonly string[];
      readonly version: 3;
    };

function decodeJournalHead(value: string, filePath: string): EncodedJournalHead {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 4 ||
    parsed.kind !== 'head' ||
    parsed.filePath !== filePath ||
    !nonEmptyString(parsed.generation) ||
    !nonEmptyString(parsed.ownerId) ||
    !nonEmptyString(parsed.baseDigest) ||
    (parsed.digestMode !== undefined && parsed.digestMode !== 'command-chain-v1') ||
    typeof parsed.capturedAt !== 'string'
  ) {
    throw new Error('invalid Recovery Journal v4 head');
  }
  return parsed as unknown as EncodedJournalHead;
}

function decodeJournalBase(
  value: string,
  filePath: string,
  head: EncodedJournalHead,
): DecodedJournalBase {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 4 ||
    parsed.kind !== 'base' ||
    parsed.filePath !== filePath ||
    parsed.generation !== head.generation ||
    parsed.ownerId !== head.ownerId ||
    !stringArray(parsed.records) ||
    parsed.records.length === 0 ||
    !nonEmptyString(parsed.recordsChecksum) ||
    hashRecoveryBytes(JSON.stringify(parsed.records)) !== parsed.recordsChecksum
  ) {
    throw new Error('invalid Recovery Journal v4 base');
  }
  const schemaPlan = decodeStoredPhysicalSchemaPlan(parsed.schemaPlan, parsed.records);
  if (parsed.schemaPlan !== undefined && schemaPlan === undefined) {
    throw new Error('invalid Recovery Journal v4 base schema plan');
  }
  const { schemaPlan: _schemaPlan, ...base } = parsed as unknown as EncodedJournalBase;
  void _schemaPlan;
  return schemaPlan === undefined ? base : { ...base, schemaPlan };
}

function decodeJournalEntry(
  value: string,
  head: EncodedJournalHead,
  sequence: number,
  beforeDigest: string,
): EncodedJournalEntry {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 4 ||
    parsed.kind !== 'entry' ||
    parsed.generation !== head.generation ||
    parsed.ownerId !== head.ownerId ||
    parsed.sequence !== sequence ||
    parsed.beforeDigest !== beforeDigest ||
    !nonEmptyString(parsed.afterDigest) ||
    !nonEmptyString(parsed.commandId) ||
    !isRecoveryJournalCommand(parsed.command) ||
    parsed.command.commandId !== parsed.commandId ||
    !nonNegativeInteger(parsed.payloadLength) ||
    !nonEmptyString(parsed.payloadChecksum)
  ) {
    throw new Error('invalid Recovery Journal v4 entry');
  }
  const payload = JSON.stringify(parsed.command);
  if (
    byteLength(payload) > LEGACY_RECOVERY_LIMITS.commandBytes ||
    byteLength(payload) !== parsed.payloadLength ||
    hashRecoveryBytes(payload) !== parsed.payloadChecksum
  ) {
    throw new Error('Recovery Journal v4 entry payload checksum mismatch');
  }
  return parsed as unknown as EncodedJournalEntry;
}

function decodeJournalAck(
  value: string,
  head: EncodedJournalHead,
  lastSequence: number,
): EncodedJournalAck {
  const parsed: unknown = JSON.parse(value);
  const sequenceMode =
    isRecord(parsed) &&
    parsed.contentMode === 'journal-sequence-v1' &&
    nonEmptyString(parsed.sequenceDigest);
  const legacyMode = isRecord(parsed) && parsed.contentMode === undefined;
  if (
    !isRecord(parsed) ||
    parsed.version !== 4 ||
    parsed.kind !== 'ack' ||
    parsed.generation !== head.generation ||
    parsed.ownerId !== head.ownerId ||
    !nonNegativeInteger(parsed.sequence) ||
    parsed.sequence > lastSequence ||
    !Array.isArray(parsed.surfaces) ||
    parsed.surfaces.length === 0 ||
    !(
      (sequenceMode && parsed.surfaces.every(isJournalSurfaceVersion)) ||
      (legacyMode && parsed.surfaces.every(isLegacyJournalSurfaceVersion))
    ) ||
    !nonEmptyString(parsed.surfacesChecksum) ||
    hashRecoveryBytes(JSON.stringify(parsed.surfaces)) !== parsed.surfacesChecksum
  ) {
    throw new Error('invalid Recovery Journal v4 acknowledgement');
  }
  return parsed as unknown as EncodedJournalAck;
}

function isEncodedCheckpoint(value: unknown, filePath: string): value is EncodedCheckpoint {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    value.filePath !== filePath ||
    typeof value.capturedAt !== 'string' ||
    !nonEmptyString(value.generation) ||
    !stringArray(value.records)
  ) {
    return false;
  }
  if (value.version !== 3) return true;
  return (
    stringArray(value.expectedBases) &&
    value.expectedBases.length === value.records.length &&
    Array.isArray(value.pendingAttempts) &&
    value.pendingAttempts.length === value.records.length &&
    value.pendingAttempts.every((record) => record === null || typeof record === 'string')
  );
}

function isPreparedCommandPatch(value: unknown): value is InkPreparedCommandPatch {
  return (
    isRecord(value) &&
    value.formatVersion === 1 &&
    nonEmptyString(value.commandId) &&
    typeof value.commandKind === 'string' &&
    nonNegativeInteger(value.documentGeneration) &&
    Array.isArray(value.surfacePatches) &&
    value.surfacePatches.every(
      (patch) =>
        isRecord(patch) &&
        nonEmptyString(patch.surfaceId) &&
        Array.isArray(patch.deleted) &&
        Array.isArray(patch.upserted),
    )
  );
}

function isPreparedPhysicalSchemaActivation(
  value: unknown,
): value is InkPreparedPhysicalSchemaActivation {
  return (
    isRecord(value) &&
    value.formatVersion === 1 &&
    value.kind === 'activate-physical-schema-v3' &&
    nonEmptyString(value.commandId) &&
    nonEmptyString(value.planDigest) &&
    nonEmptyString(value.planReference) &&
    nonNegativeInteger(value.readGeneration) &&
    nonEmptyString(value.sourceBaseDigest) &&
    Array.isArray(value.fragments)
  );
}

function isRecoveryJournalCommand(value: unknown): value is InkRecoveryJournalCommand {
  return isPreparedCommandPatch(value) || isPreparedPhysicalSchemaActivation(value);
}

function decodeStoredPhysicalSchemaPlan(
  value: unknown,
  sourceCanonicalBytes: readonly string[],
): InkPreparedPhysicalSchemaPlan | undefined {
  if (value === undefined) return undefined;
  const candidate =
    isRecord(value) && value.sourceEncoding === 'journal-base-records-v1'
      ? (() => {
          const { sourceEncoding: _sourceEncoding, ...identityAndCandidate } = value;
          void _sourceEncoding;
          return { ...identityAndCandidate, sourceCanonicalBytes };
        })()
      : value;
  if (
    !isRecord(candidate) ||
    candidate.formatVersion !== 1 ||
    candidate.kind !== 'ink-schema-v3-preparation' ||
    !stringArray(candidate.sourceCanonicalBytes) ||
    !stringArray(candidate.candidateCanonicalBytes)
  ) {
    return undefined;
  }
  const plan = candidate as unknown as InkPreparedPhysicalSchemaPlan;
  try {
    assertInkPreparedPhysicalSchemaPlan(plan);
    return plan;
  } catch {
    return undefined;
  }
}

function applyRecoveryJournalCommand(
  records: readonly InkSurfaceRecord[],
  schemaPlan: InkPreparedPhysicalSchemaPlan | undefined,
  command: InkRecoveryJournalCommand,
): readonly InkSurfaceRecord[] {
  if (isPhysicalSchemaActivation(command)) {
    if (schemaPlan === undefined) {
      throw new Error('Recovery Journal v4 physical command is missing its schema plan.');
    }
    return applyPreparedInkPhysicalSchemaActivation(records, schemaPlan, command);
  }
  return applyPreparedInkCommand(records, command);
}

function isPhysicalSchemaActivation(
  command: InkRecoveryJournalCommand,
): command is InkPreparedPhysicalSchemaActivation {
  return 'kind' in command && command.kind === 'activate-physical-schema-v3';
}

function isJournalSurfaceVersion(value: unknown): value is EncodedJournalSurfaceVersion {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    typeof value.updatedAt === 'string'
  );
}

function isLegacyJournalSurfaceVersion(
  value: unknown,
): value is EncodedLegacyJournalSurfaceVersion {
  return isJournalSurfaceVersion(value) && isRecord(value) && nonEmptyString(value.contentDigest);
}

function validSaveState(
  filePath: string,
  records: readonly InkSurfaceRecord[],
  expectedBases: readonly InkSurfaceRecord[],
  pendingAttempts: readonly (InkSurfaceRecord | null)[],
): boolean {
  if (expectedBases.length !== records.length || pendingAttempts.length !== records.length) {
    return false;
  }
  return records.every((record, index) => {
    const expectedBase = expectedBases[index];
    const pendingAttempt = pendingAttempts[index];
    return (
      expectedBase !== undefined &&
      expectedBase.id === record.id &&
      expectedBase.noteId === record.noteId &&
      expectedBase.filePath === filePath &&
      ((pendingAttempt === null && sameRecordContent(record, expectedBase)) ||
        (pendingAttempt !== undefined &&
          pendingAttempt !== null &&
          pendingAttempt.id === record.id &&
          pendingAttempt.noteId === expectedBase.noteId &&
          pendingAttempt.filePath === filePath &&
          pendingAttempt.revision === expectedBase.revision + 1))
    );
  });
}

function assertRecoveryRecords(filePath: string, records: readonly InkSurfaceRecord[]): void {
  if (
    records.length === 0 ||
    records.some((record) => record.filePath !== filePath) ||
    new Set(records.map(({ id }) => id)).size !== records.length
  ) {
    throw new Error('Legacy Ink Recovery contains invalid bounded records.');
  }
}

function journalRecordsDigest(records: readonly InkSurfaceRecord[]): string {
  return hashRecoveryBytes(JSON.stringify(records.map(encodeInkSurfaceRecord)));
}

function journalCommandChainDigest(input: {
  readonly commandId: string;
  readonly currentDigest: string;
  readonly payloadChecksum: string;
  readonly sequence: number;
}): string {
  return hashRecoveryBytes(
    JSON.stringify({
      beforeDigest: input.currentDigest,
      commandId: input.commandId,
      payloadChecksum: input.payloadChecksum,
      sequence: input.sequence,
    }),
  );
}

function recordContentDigest(record: InkSurfaceRecord): string {
  const { revision: _revision, updatedAt: _updatedAt, ...content } = record;
  void _revision;
  void _updatedAt;
  return hashRecoveryBytes(stableJson(content));
}

function sameRecord(left: InkSurfaceRecord, right: InkSurfaceRecord): boolean {
  return encodeInkSurfaceRecord(left) === encodeInkSurfaceRecord(right);
}

function sameRecordExceptExpandedLogicalHeight(
  canonical: InkSurfaceRecord,
  checkpointBase: InkSurfaceRecord,
): boolean {
  if (checkpointBase.layout.logicalHeight <= canonical.layout.logicalHeight) return false;
  return sameRecord(canonical, {
    ...checkpointBase,
    layout: { ...checkpointBase.layout, logicalHeight: canonical.layout.logicalHeight },
  });
}

function sameRecordContent(left: InkSurfaceRecord, right: InkSurfaceRecord): boolean {
  if (left === right) return true;
  const {
    revision: _leftRevision,
    strokes: leftStrokes,
    updatedAt: _leftUpdatedAt,
    ...leftContent
  } = left;
  const {
    revision: _rightRevision,
    strokes: rightStrokes,
    updatedAt: _rightUpdatedAt,
    ...rightContent
  } = right;
  void _leftRevision;
  void _leftUpdatedAt;
  void _rightRevision;
  void _rightUpdatedAt;
  return (
    stableJson(leftContent) === stableJson(rightContent) &&
    stableJson(leftStrokes) === stableJson(rightStrokes)
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
