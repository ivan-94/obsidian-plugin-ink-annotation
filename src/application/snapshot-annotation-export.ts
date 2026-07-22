import type { SnapshotAnnotationRecord } from '../domain/snapshot-annotation';
import { chooseUniqueExportPath } from './text-annotation-exporter';

export interface SnapshotAnnotationFlattener {
  flatten(
    record: SnapshotAnnotationRecord,
    pngBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface SnapshotAnnotationExportStore {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  writeBinary(path: string, contents: ArrayBuffer): Promise<void>;
}

export async function writeSnapshotAnnotationPngExport(input: {
  readonly flattener: SnapshotAnnotationFlattener;
  readonly pngBytes: Uint8Array;
  readonly record: SnapshotAnnotationRecord;
  readonly signal?: AbortSignal;
  readonly store: SnapshotAnnotationExportStore;
}): Promise<string> {
  const heading = input.record.source.headingPath.at(-1) ?? input.record.id;
  const requested = `Inkstone Exports/Snapshot - ${safeName(input.record.filePath)} - ${safeName(heading)}.png`;
  const path = await chooseUniqueExportPath(requested, (candidate) =>
    input.store.exists(candidate),
  );
  const separator = path.lastIndexOf('/');
  if (separator > 0) await input.store.mkdir(path.slice(0, separator));
  const flattened = await input.flattener.flatten(
    input.record,
    Uint8Array.from(input.pngBytes),
    input.signal ?? new AbortController().signal,
  );
  try {
    await input.store.writeBinary(path, Uint8Array.from(flattened).buffer);
    return path;
  } catch (error) {
    await input.store.remove(path).catch(() => undefined);
    throw error;
  }
}

function safeName(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/gu, '-')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 96) || 'Snapshot'
  );
}
