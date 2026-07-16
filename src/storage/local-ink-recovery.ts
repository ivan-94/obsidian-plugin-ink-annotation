import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkSurfaceRecord,
} from '../domain/ink-surface';

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
    });

export interface InkRecoverySaveState {
  readonly expectedBases: readonly InkSurfaceRecord[];
  readonly pendingAttempts: readonly (InkSurfaceRecord | null)[];
}

export interface InkRecoveryStore {
  claim?(filePath: string, ownerId: string): void;
  clear(filePath: string, generation: string): void;
  load(filePath: string): LocalInkRecoveryCheckpoint | null;
  save(
    filePath: string,
    records: readonly InkSurfaceRecord[],
    ownerId?: string,
    state?: InkRecoverySaveState,
  ): string;
}

export type LocalInkRecoveryPlan =
  | {
      readonly kind: 'conflict';
      readonly message: string;
    }
  | {
      readonly expectedBases: readonly InkSurfaceRecord[];
      readonly kind: 'none' | 'restore';
      readonly records: readonly InkSurfaceRecord[];
      readonly writes: readonly InkSurfaceRecord[];
    };

/** Device-local write-ahead checkpoint; canonical Vault sidecars remain the source of truth. */
export class LocalInkRecoveryStore implements InkRecoveryStore {
  private generation = 0;
  private readonly prefix: string;

  constructor(
    private readonly storage: Storage,
    vaultName: string,
    deviceId: string,
  ) {
    this.prefix = `inkstone:${encodeURIComponent(vaultName)}:${encodeURIComponent(deviceId)}:ink-recovery-v1:`;
  }

  load(filePath: string): LocalInkRecoveryCheckpoint | null {
    const contents = this.storage.getItem(this.key(filePath));
    if (contents === null) return null;
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!isEncodedCheckpoint(parsed, filePath)) throw new Error('invalid checkpoint envelope');
      const records = parsed.records.map((record) => decodeInkSurfaceRecord(record));
      if (
        records.length === 0 ||
        records.some((record) => record.filePath !== filePath) ||
        new Set(records.map(({ id }) => id)).size !== records.length
      ) {
        throw new Error('invalid checkpoint records');
      }
      const common = {
        capturedAt: parsed.capturedAt,
        filePath,
        generation: parsed.generation,
        records,
      };
      if (parsed.version === 3) {
        const expectedBases = parsed.expectedBases.map((record) => decodeInkSurfaceRecord(record));
        const pendingAttempts = parsed.pendingAttempts.map((record) =>
          record === null ? null : decodeInkSurfaceRecord(record),
        );
        if (!validSaveState(filePath, records, { expectedBases, pendingAttempts })) {
          throw new Error('invalid version-3 checkpoint records');
        }
        return { ...common, expectedBases, pendingAttempts, version: 3 };
      }
      return { ...common, version: parsed.version };
    } catch (error) {
      const quarantineKey = `${this.key(filePath)}:quarantine:${Date.now()}-${globalThis.crypto.randomUUID()}`;
      try {
        this.storage.setItem(quarantineKey, contents);
        this.storage.removeItem(this.key(filePath));
      } catch {
        throw new Error(
          `Local Ink recovery checkpoint is corrupt for ${filePath} and could not be quarantined.`,
          { cause: error },
        );
      }
      throw new Error(
        `Local Ink recovery checkpoint is corrupt for ${filePath}; raw bytes were quarantined as ${quarantineKey}.`,
        {
          cause: error,
        },
      );
    }
  }

  claim(filePath: string, ownerId: string): void {
    if (ownerId.length === 0) throw new Error('Ink recovery owner must not be empty.');
    this.storage.setItem(this.leaseKey(filePath), ownerId);
  }

  save(
    filePath: string,
    records: readonly InkSurfaceRecord[],
    ownerId?: string,
    state?: InkRecoverySaveState,
  ): string {
    if (
      records.length === 0 ||
      records.some((record) => record.filePath !== filePath) ||
      new Set(records.map(({ id }) => id)).size !== records.length
    ) {
      throw new Error('Local Ink recovery requires unique bounded records from one file.');
    }
    if (ownerId !== undefined && this.storage.getItem(this.leaseKey(filePath)) !== ownerId) {
      throw new Error(`Cannot save ${filePath} from a stale Ink recovery owner.`);
    }
    if (state !== undefined && !validSaveState(filePath, records, state)) {
      throw new Error('Version-3 local Ink recovery state is incomplete or inconsistent.');
    }
    this.generation += 1;
    const generation = `${Date.now()}-${this.generation}-${globalThis.crypto.randomUUID()}`;
    this.storage.setItem(
      this.key(filePath),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        ...(state === undefined
          ? {}
          : {
              expectedBases: state.expectedBases.map((record) => encodeInkSurfaceRecord(record)),
              pendingAttempts: state.pendingAttempts.map((record) =>
                record === null ? null : encodeInkSurfaceRecord(record),
              ),
            }),
        filePath,
        generation,
        records: records.map((record) => encodeInkSurfaceRecord(record)),
        version: state === undefined ? 2 : 3,
      }),
    );
    return generation;
  }

  clear(filePath: string, generation: string): void {
    const key = this.key(filePath);
    const contents = this.storage.getItem(key);
    if (contents === null) return;
    try {
      const parsed: unknown = JSON.parse(contents);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'generation' in parsed &&
        parsed.generation === generation
      ) {
        this.storage.removeItem(key);
      }
    } catch {
      // A corrupt newer value must never be removed by an older generation's completion.
    }
  }

  private key(filePath: string): string {
    return `${this.prefix}${encodeURIComponent(filePath)}`;
  }

  private leaseKey(filePath: string): string {
    return `${this.key(filePath)}:owner`;
  }
}

/** Builds a fail-closed recovery write without overwriting a diverged canonical revision. */
export function planLocalInkRecovery(
  canonical: readonly InkSurfaceRecord[],
  checkpoint: LocalInkRecoveryCheckpoint,
  now: string,
): LocalInkRecoveryPlan {
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
    return { expectedBases: [], kind: 'none', records, writes };
  }

  if (
    checkpoint.expectedBases.length !== checkpoint.records.length ||
    checkpoint.pendingAttempts.length !== checkpoint.records.length
  ) {
    return {
      kind: 'conflict',
      message: `Local Ink recovery for ${checkpoint.filePath} has incomplete version tokens.`,
    };
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
        continue;
      }
      records.push(persisted);
      continue;
    }

    if (!sameRecord(persisted, expectedBase)) {
      return {
        kind: 'conflict',
        message: `Local Ink recovery surface ${recovered.id} diverged from its expected canonical base.`,
      };
    }

    const candidate = sameRecordContent(recovered, pendingAttempt)
      ? pendingAttempt
      : {
          ...recovered,
          revision: expectedBase.revision + 1,
          updatedAt: now,
        };
    records.push(candidate);
    writes.push(candidate);
    expectedBases.push(expectedBase);
  }
  return {
    expectedBases,
    kind: writes.length === 0 ? 'none' : 'restore',
    records,
    writes,
  };
}

function sameRecord(left: InkSurfaceRecord, right: InkSurfaceRecord): boolean {
  return encodeInkSurfaceRecord(left) === encodeInkSurfaceRecord(right);
}

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

function isEncodedCheckpoint(value: unknown, filePath: string): value is EncodedCheckpoint {
  if (!(
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    (value.version === 1 || value.version === 2 || value.version === 3) &&
    'filePath' in value &&
    value.filePath === filePath &&
    'capturedAt' in value &&
    typeof value.capturedAt === 'string' &&
    'generation' in value &&
    typeof value.generation === 'string' &&
    value.generation.length > 0 &&
    'records' in value &&
    Array.isArray(value.records) &&
    value.records.every((record) => typeof record === 'string')
  )) {
    return false;
  }
  if (value.version === 1 || value.version === 2) return true;
  return (
    'expectedBases' in value &&
    Array.isArray(value.expectedBases) &&
    value.expectedBases.length === value.records.length &&
    value.expectedBases.every((record) => typeof record === 'string') &&
    'pendingAttempts' in value &&
    Array.isArray(value.pendingAttempts) &&
    value.pendingAttempts.length === value.records.length &&
    value.pendingAttempts.every((record) => record === null || typeof record === 'string')
  );
}

function validSaveState(
  filePath: string,
  records: readonly InkSurfaceRecord[],
  state: InkRecoverySaveState,
): boolean {
  if (
    state.expectedBases.length !== records.length ||
    state.pendingAttempts.length !== records.length
  ) {
    return false;
  }
  return records.every((record, index) => {
    const expectedBase = state.expectedBases[index];
    const pendingAttempt = state.pendingAttempts[index];
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

function sameRecordContent(left: InkSurfaceRecord, right: InkSurfaceRecord): boolean {
  const { revision: _leftRevision, updatedAt: _leftUpdatedAt, ...leftContent } = left;
  const { revision: _rightRevision, updatedAt: _rightUpdatedAt, ...rightContent } = right;
  void _leftRevision;
  void _leftUpdatedAt;
  void _rightRevision;
  void _rightUpdatedAt;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}
