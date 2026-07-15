import { chooseUniqueExportPath } from './text-annotation-exporter';

export interface TextExportFileStore {
  append(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  write(path: string, contents: string): Promise<void>;
}

export async function writeTextExportFile(input: {
  readonly chunks: AsyncIterable<string> | Iterable<string>;
  readonly requestedPath: string;
  readonly store: TextExportFileStore;
}): Promise<string> {
  const path = await chooseUniqueExportPath(input.requestedPath, (candidate) =>
    input.store.exists(candidate),
  );
  const separator = path.lastIndexOf('/');
  if (separator > 0) {
    await input.store.mkdir(path.slice(0, separator));
  }
  const writePath = input.store.rename === undefined ? path : hiddenTemporaryExportPath(path);
  if (writePath !== path) {
    await input.store.remove(writePath).catch(() => undefined);
  }
  let created = false;
  try {
    for await (const chunk of input.chunks) {
      if (!created) {
        await input.store.write(writePath, chunk);
        created = true;
      } else {
        await input.store.append(writePath, chunk);
      }
    }
    if (!created) {
      await input.store.write(writePath, '');
    }
    if (writePath !== path) {
      await input.store.rename?.(writePath, path);
    }
    return path;
  } catch (error) {
    await input.store.remove(writePath).catch(() => undefined);
    throw error;
  }
}

/** Keeps thousands of streamed chunks invisible to Obsidian's Markdown indexer. */
function hiddenTemporaryExportPath(path: string): string {
  const separator = path.lastIndexOf('/');
  const directory = separator < 0 ? '' : path.slice(0, separator + 1);
  const filename = separator < 0 ? path : path.slice(separator + 1);
  return `${directory}.${filename}.inkstone-export-tmp`;
}
