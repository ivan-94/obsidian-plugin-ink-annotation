import { chooseUniqueExportPath } from './text-annotation-exporter';
import {
  exportInkPng,
  exportInkPngRecords,
  exportInkSvg,
  exportInkSvgRecords,
  renderInkStandaloneHtml,
} from './ink-exporter';
import type { InkSurfaceRecord } from '../domain/ink-surface';

export interface InkExportFileStore {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  write(path: string, contents: string): Promise<void>;
  writeBinary(path: string, contents: ArrayBuffer): Promise<void>;
}

export interface InkExportLoadIssue {
  readonly kind: 'conflict' | 'corrupt-record' | 'duplicate-artifact' | 'unsupported-record';
  readonly message: string;
}

/** Refuses to turn a partial repository projection into an apparently complete export. */
export function assertInkExportLoadSupported(issues: readonly InkExportLoadIssue[]): void {
  for (const issue of issues) {
    switch (issue.kind) {
      case 'duplicate-artifact':
        break;
      case 'conflict':
      case 'corrupt-record':
      case 'unsupported-record':
        throw new Error(issue.message);
      default:
        throw new Error(
          `Ink export refused an unknown repository issue kind: ${String(issue.kind)}`,
        );
    }
  }
}

export async function writeInkSvgExport(
  record: InkSurfaceRecord,
  store: InkExportFileStore,
  relatedRecords: readonly InkSurfaceRecord[] = [record],
): Promise<string> {
  const path = await uniquePath(record, 'svg', store);
  const projection = projectSelectedInkSurface(record, relatedRecords);
  const svg = projection.length === 1 ? exportInkSvg(record) : exportInkSvgRecords(projection);
  return guardedWrite(path, store, () => store.write(path, `${svg}\n`));
}

export async function writeInkPngExport(
  record: InkSurfaceRecord,
  store: InkExportFileStore,
  relatedRecords: readonly InkSurfaceRecord[] = [record],
): Promise<string> {
  const path = await uniquePath(record, 'png', store);
  const projection = projectSelectedInkSurface(record, relatedRecords);
  const layout = projectedLayout(projection);
  const scale = Math.min(
    1,
    2400 / Math.max(layout.width, layout.height),
    Math.sqrt(16_777_216 / (layout.width * layout.height)),
  );
  const width = Math.max(1, Math.round(layout.width * scale));
  const height = Math.max(1, Math.round(layout.height * scale));
  const options = { background: 'transparent', height, width } as const;
  const png =
    projection.length === 1
      ? exportInkPng(record, options)
      : exportInkPngRecords(projection, options);
  const bytes = png.slice();
  return guardedWrite(path, store, () => store.writeBinary(path, bytes.buffer));
}

/**
 * A sidebar row still exports one selected surface, but a Logical Stroke split by bounded surfaces
 * must be compiled as one stroke. Unrelated sibling strokes stay out of the selected export.
 */
function projectSelectedInkSurface(
  selected: InkSurfaceRecord,
  relatedRecords: readonly InkSurfaceRecord[],
): readonly InkSurfaceRecord[] {
  const linkedStrokeIds = new Set(
    selected.strokes.flatMap((stroke) =>
      stroke.linkedStrokeId === undefined ? [] : [stroke.linkedStrokeId],
    ),
  );
  if (linkedStrokeIds.size === 0) return [selected];

  const projected: InkSurfaceRecord[] = [selected];
  for (const related of relatedRecords) {
    if (
      related.id === selected.id ||
      related.deletedAt !== undefined ||
      related.filePath !== selected.filePath ||
      related.noteId !== selected.noteId ||
      related.schemaVersion !== selected.schemaVersion
    ) {
      continue;
    }
    const strokes = related.strokes.filter(
      (stroke) => stroke.linkedStrokeId !== undefined && linkedStrokeIds.has(stroke.linkedStrokeId),
    );
    if (strokes.length > 0) projected.push({ ...related, strokes });
  }
  return projected;
}

function projectedLayout(records: readonly InkSurfaceRecord[]): {
  readonly height: number;
  readonly width: number;
} {
  const only = records.length === 1 ? records[0] : undefined;
  if (only !== undefined) {
    return { height: only.layout.logicalHeight, width: only.layout.logicalWidth };
  }
  const width = Math.max(...records.map((record) => record.layout.logicalWidth));
  if (records.every((record) => record.schemaVersion === 1)) {
    return {
      height: records.reduce((sum, record) => sum + record.layout.logicalHeight, 0),
      width,
    };
  }
  return {
    height: Math.max(
      ...records.map((record) => (record.layout.originY ?? 0) + record.layout.logicalHeight),
    ),
    width,
  };
}

export async function writeInkStandaloneReport(
  records: readonly InkSurfaceRecord[],
  input: { readonly generatedAt: string; readonly title: string },
  store: InkExportFileStore,
): Promise<string> {
  const requested = `Inkstone Exports/${safeName(input.title)}.html`;
  const path = await chooseUniqueExportPath(requested, (candidate) => store.exists(candidate));
  return guardedWrite(path, store, () =>
    store.write(path, renderInkStandaloneHtml(records, input)),
  );
}

async function uniquePath(
  record: InkSurfaceRecord,
  extension: 'png' | 'svg',
  store: InkExportFileStore,
): Promise<string> {
  const heading = record.binding?.headingPath.at(-1) ?? record.id;
  const requested = `Inkstone Exports/Ink - ${safeName(record.filePath)} - ${safeName(heading)}.${extension}`;
  return chooseUniqueExportPath(requested, (candidate) => store.exists(candidate));
}

async function guardedWrite(
  path: string,
  store: InkExportFileStore,
  write: () => Promise<void>,
): Promise<string> {
  const separator = path.lastIndexOf('/');
  if (separator > 0) await store.mkdir(path.slice(0, separator));
  try {
    await write();
    return path;
  } catch (error) {
    await store.remove(path).catch(() => undefined);
    throw error;
  }
}

function safeName(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/gu, '-')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 96) || 'Ink'
  );
}
