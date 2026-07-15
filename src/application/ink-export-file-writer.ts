import { chooseUniqueExportPath } from './text-annotation-exporter';
import { exportInkPng, exportInkSvg, renderInkStandaloneHtml } from './ink-exporter';
import type { InkSurfaceRecord } from '../domain/ink-surface';

export interface InkExportFileStore {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  write(path: string, contents: string): Promise<void>;
  writeBinary(path: string, contents: ArrayBuffer): Promise<void>;
}

export async function writeInkSvgExport(
  record: InkSurfaceRecord,
  store: InkExportFileStore,
): Promise<string> {
  const path = await uniquePath(record, 'svg', store);
  return guardedWrite(path, store, () => store.write(path, `${exportInkSvg(record)}\n`));
}

export async function writeInkPngExport(
  record: InkSurfaceRecord,
  store: InkExportFileStore,
): Promise<string> {
  const path = await uniquePath(record, 'png', store);
  const scale = Math.min(
    1,
    2400 / Math.max(record.layout.logicalWidth, record.layout.logicalHeight),
    Math.sqrt(16_777_216 / (record.layout.logicalWidth * record.layout.logicalHeight)),
  );
  const width = Math.max(1, Math.round(record.layout.logicalWidth * scale));
  const height = Math.max(1, Math.round(record.layout.logicalHeight * scale));
  const png = exportInkPng(record, { background: 'transparent', height, width });
  const bytes = png.slice();
  return guardedWrite(path, store, () => store.writeBinary(path, bytes.buffer));
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
