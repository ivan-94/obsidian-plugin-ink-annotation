import { encodeTextAnnotationRecord, type TextAnnotationRecord } from '../domain/text-annotation';
import { hashText } from '../domain/text-anchor';
import type { TextFileStore } from './sidecar-repository';

const GRAVEYARD_ROOT = '.obsidian-annotations/v1/graveyard';
const MAX_SEGMENT_BYTES = 1024 * 1024;

export interface TextGraveyardEntryV1 {
  readonly compactedAt: string;
  readonly deletedAt: string;
  readonly deletionRevision: number;
  readonly kind: 'text';
  readonly noteId: string;
  readonly payloadSha256: string;
  readonly reason: 'record-deleted';
  readonly recordId: string;
  readonly sourcePathAtDeletion: string;
}

interface GraveyardSegmentV1 {
  readonly createdAt: string;
  readonly entries: readonly TextGraveyardEntryV1[];
  readonly ownerDeviceId: string;
  readonly schemaVersion: 1;
  readonly segmentId: string;
  readonly updatedAt: string;
}

export class GraveyardRepository {
  private entriesCache: Promise<readonly TextGraveyardEntryV1[]> | null = null;

  constructor(
    private readonly store: TextFileStore,
    private readonly ownerDeviceId: string,
  ) {
    if (ownerDeviceId.length === 0) {
      throw new Error('Graveyard owner device ID must not be empty.');
    }
  }

  async recordTextTombstones(
    records: readonly TextAnnotationRecord[],
    compactedAt: string,
  ): Promise<void> {
    if (records.length === 0) return;
    const month = parseMonth(compactedAt);
    const entries = await Promise.all(
      records.map(async (record): Promise<TextGraveyardEntryV1> => {
        if (record.deletedAt === undefined) {
          throw new Error(`Cannot compact active annotation ${record.id}.`);
        }
        return {
          compactedAt,
          deletedAt: record.deletedAt,
          deletionRevision: record.revision,
          kind: 'text',
          noteId: record.noteId,
          payloadSha256: await hashText(encodeTextAnnotationRecord(record)),
          reason: 'record-deleted',
          recordId: record.id,
          sourcePathAtDeletion: record.filePath,
        };
      }),
    );
    const ownerRoot = `${GRAVEYARD_ROOT}/${await hashText(this.ownerDeviceId)}`;
    await this.store.mkdir(ownerRoot);
    const existingEntries = await this.loadEntries();
    const existingKeys = new Set(existingEntries.map(entryKey));
    let pending = entries.filter((entry) => !existingKeys.has(entryKey(entry)));
    if (pending.length === 0) return;

    const segmentNames = (await this.store.list(ownerRoot))
      .filter((name) => new RegExp(`^${month}-\\d{3}\\.json$`, 'u').test(name))
      .sort();
    let segmentNumber = Number.parseInt(segmentNames.at(-1)?.slice(-8, -5) ?? '1', 10);
    let segment = await this.readOwnedSegment(ownerRoot, month, segmentNumber, compactedAt);

    while (pending.length > 0) {
      const entry = pending[0];
      if (entry === undefined) break;
      const expanded: GraveyardSegmentV1 = {
        ...segment,
        entries: [...segment.entries, entry],
        updatedAt: compactedAt,
      };
      if (segment.entries.length > 0 && encodedByteLength(expanded) > MAX_SEGMENT_BYTES) {
        await this.writeAndVerify(ownerRoot, segment);
        segmentNumber += 1;
        segment = createSegment(this.ownerDeviceId, month, segmentNumber, compactedAt);
        continue;
      }
      segment = expanded;
      pending = pending.slice(1);
    }
    await this.writeAndVerify(ownerRoot, segment);
    this.entriesCache = null;
  }

  async suppressesTextRecord(record: TextAnnotationRecord, contents: string): Promise<boolean> {
    const digest = await hashText(contents);
    let entries: readonly TextGraveyardEntryV1[];
    try {
      entries = await this.loadEntries();
    } catch {
      // Unreadable deletion evidence can neither hide a candidate nor authorize physical cleanup.
      return false;
    }
    return entries.some(
      (entry) =>
        entry.noteId === record.noteId &&
        entry.recordId === record.id &&
        (entry.deletionRevision > record.revision ||
          (entry.deletionRevision === record.revision && entry.payloadSha256 === digest)),
    );
  }

  private loadEntries(): Promise<readonly TextGraveyardEntryV1[]> {
    this.entriesCache ??= this.readAllEntries();
    return this.entriesCache;
  }

  private async readAllEntries(): Promise<readonly TextGraveyardEntryV1[]> {
    const entries: TextGraveyardEntryV1[] = [];
    for (const owner of await this.store.list(GRAVEYARD_ROOT)) {
      const ownerRoot = `${GRAVEYARD_ROOT}/${owner}`;
      for (const filename of (await this.store.list(ownerRoot))
        .filter((name) => /^\d{4}-\d{2}-\d{3}\.json$/u.test(name))
        .sort()) {
        const contents = await this.store.read(`${ownerRoot}/${filename}`);
        if (contents === null) continue;
        entries.push(...decodeSegment(contents).entries);
      }
    }
    return entries;
  }

  private async readOwnedSegment(
    ownerRoot: string,
    month: string,
    segmentNumber: number,
    now: string,
  ): Promise<GraveyardSegmentV1> {
    const path = segmentPath(ownerRoot, month, segmentNumber);
    const contents = await this.store.read(path);
    if (contents === null) {
      return createSegment(this.ownerDeviceId, month, segmentNumber, now);
    }
    const segment = decodeSegment(contents);
    if (segment.ownerDeviceId !== this.ownerDeviceId) {
      throw new Error('Graveyard segment belongs to another device.');
    }
    return segment;
  }

  private async writeAndVerify(ownerRoot: string, segment: GraveyardSegmentV1): Promise<void> {
    const monthAndNumber = /:([0-9]{4}-[0-9]{2}):([0-9]+)$/u.exec(segment.segmentId);
    const month = monthAndNumber?.[1];
    const segmentNumber =
      monthAndNumber?.[2] === undefined ? Number.NaN : Number.parseInt(monthAndNumber[2], 10);
    if (month === undefined || !Number.isSafeInteger(segmentNumber)) {
      throw new Error('Graveyard segment ID is invalid.');
    }
    const path = segmentPath(ownerRoot, month, segmentNumber);
    const encoded = encodeSegment(segment);
    await this.store.write(path, encoded);
    const verified = await this.store.read(path);
    if (verified === null || encodeSegment(decodeSegment(verified)) !== encoded) {
      throw new Error('Graveyard segment verification failed; no annotation payload was removed.');
    }
  }
}

function createSegment(
  ownerDeviceId: string,
  month: string,
  segmentNumber: number,
  now: string,
): GraveyardSegmentV1 {
  return {
    createdAt: now,
    entries: [],
    ownerDeviceId,
    schemaVersion: 1,
    segmentId: `${ownerDeviceId}:${month}:${segmentNumber}`,
    updatedAt: now,
  };
}

function segmentPath(ownerRoot: string, month: string, segmentNumber: number): string {
  return `${ownerRoot}/${month}-${String(segmentNumber).padStart(3, '0')}.json`;
}

function parseMonth(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || !/^\d{4}-\d{2}-/u.test(value)) {
    throw new Error('Graveyard compaction time is invalid.');
  }
  return value.slice(0, 7);
}

function entryKey(entry: TextGraveyardEntryV1): string {
  return [
    entry.kind,
    entry.noteId,
    entry.recordId,
    entry.deletionRevision,
    entry.payloadSha256,
  ].join('\u0000');
}

function encodedByteLength(segment: GraveyardSegmentV1): number {
  return new TextEncoder().encode(encodeSegment(segment)).byteLength;
}

function encodeSegment(segment: GraveyardSegmentV1): string {
  return `${JSON.stringify(segment, null, 2)}\n`;
}

function decodeSegment(contents: string): GraveyardSegmentV1 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new Error('Graveyard segment is not valid JSON.', { cause });
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.segmentId !== 'string' ||
    typeof value.ownerDeviceId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('Graveyard segment does not match schema version 1.');
  }
  const entries = value.entries.map(decodeTextEntry);
  return {
    createdAt: value.createdAt,
    entries,
    ownerDeviceId: value.ownerDeviceId,
    schemaVersion: 1,
    segmentId: value.segmentId,
    updatedAt: value.updatedAt,
  };
}

function decodeTextEntry(value: unknown): TextGraveyardEntryV1 {
  if (
    !isRecord(value) ||
    value.kind !== 'text' ||
    value.reason !== 'record-deleted' ||
    typeof value.noteId !== 'string' ||
    typeof value.recordId !== 'string' ||
    typeof value.sourcePathAtDeletion !== 'string' ||
    typeof value.deletionRevision !== 'number' ||
    !Number.isSafeInteger(value.deletionRevision) ||
    value.deletionRevision < 1 ||
    typeof value.deletedAt !== 'string' ||
    typeof value.compactedAt !== 'string' ||
    typeof value.payloadSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.payloadSha256)
  ) {
    throw new Error('Graveyard text entry is invalid.');
  }
  return {
    compactedAt: value.compactedAt,
    deletedAt: value.deletedAt,
    deletionRevision: value.deletionRevision,
    kind: 'text',
    noteId: value.noteId,
    payloadSha256: value.payloadSha256,
    reason: 'record-deleted',
    recordId: value.recordId,
    sourcePathAtDeletion: value.sourcePathAtDeletion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
