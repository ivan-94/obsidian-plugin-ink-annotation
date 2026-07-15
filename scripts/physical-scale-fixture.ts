import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hashText } from '../src/domain/text-anchor';
import {
  encodeTextAnnotationRecord,
  type TextAnnotationRecord,
  type TextAnnotationTarget,
} from '../src/domain/text-annotation';

const SIDECAR_ROOT = '.obsidian-annotations/v1/notes';
const SCALE_SOURCE_ROOT = 'Scale HAT';
const NOW = '2026-07-15T00:00:00.000Z';
const CONTEXT_LENGTH = 32;

export interface PhysicalScaleFixtureOptions {
  readonly longDocumentPath?: string;
  readonly longTargetCount?: number;
  readonly scaleNoteCount?: number;
  readonly scaleRecordsPerNote?: number;
  readonly vaultRoot: string;
}

export interface PhysicalScaleFixtureResult {
  readonly canonicalFiles: number;
  readonly longDocument: {
    readonly bytes: number;
    readonly filePath: string;
    readonly records: number;
  };
  readonly scaleVault: {
    readonly notes: number;
    readonly records: number;
    readonly sourceDirectory: string;
  };
  readonly totalRecords: number;
  readonly vaultRoot: string;
}

/**
 * Creates a disposable physical-HAT fixture using the production text-record codec.
 * The caller must point it at an empty canonical sidecar root and remove/restore the
 * generated tree after profiling; this deliberately does not mutate an existing dataset.
 */
export async function preparePhysicalScaleFixture(
  options: PhysicalScaleFixtureOptions,
): Promise<PhysicalScaleFixtureResult> {
  const longDocumentPath = options.longDocumentPath ?? 'HAT Long 200k.md';
  const longTargetCount = positiveInteger(options.longTargetCount ?? 500, 'longTargetCount');
  const scaleNoteCount = positiveInteger(options.scaleNoteCount ?? 100, 'scaleNoteCount');
  const scaleRecordsPerNote = positiveInteger(
    options.scaleRecordsPerNote ?? 195,
    'scaleRecordsPerNote',
  );
  await assertEmpty(join(options.vaultRoot, SIDECAR_ROOT));
  await assertEmpty(join(options.vaultRoot, SCALE_SOURCE_ROOT));

  const pending: Array<{ readonly contents: string; readonly path: string }> = [];
  const longSource = await readFile(join(options.vaultRoot, longDocumentPath), 'utf8');
  const longSourceRevision = await hashText(longSource);
  const longNoteId = 'physical-scale-long-note';
  const longPathHash = await hashText(longDocumentPath);
  addMeta(pending, options.vaultRoot, {
    filePath: longDocumentPath,
    noteId: longNoteId,
    pathHash: longPathHash,
    sourceFingerprint: longSourceRevision,
  });

  const longTargets = distributedLongTargets(longSource, longTargetCount, longSourceRevision);
  longTargets.forEach((target, index) => {
    pending.push({
      contents: encodeTextAnnotationRecord(
        textRecord({
          filePath: longDocumentPath,
          id: `physical-long-${String(index).padStart(4, '0')}`,
          noteId: longNoteId,
          recordIndex: index,
          target,
        }),
      ),
      path: sidecarAnnotationPath(
        options.vaultRoot,
        longPathHash,
        `physical-long-${String(index).padStart(4, '0')}`,
      ),
    });
  });

  for (let noteIndex = 0; noteIndex < scaleNoteCount; noteIndex += 1) {
    const filePath = `${SCALE_SOURCE_ROOT}/Note-${String(noteIndex).padStart(3, '0')}.md`;
    const source = scaleSource(noteIndex, scaleRecordsPerNote);
    const sourceRevision = await hashText(source);
    const pathHash = await hashText(filePath);
    const noteId = `physical-scale-note-${String(noteIndex).padStart(3, '0')}`;
    pending.push({ contents: source, path: join(options.vaultRoot, filePath) });
    addMeta(pending, options.vaultRoot, {
      filePath,
      noteId,
      pathHash,
      sourceFingerprint: sourceRevision,
    });

    let cursor = 0;
    for (let recordIndex = 0; recordIndex < scaleRecordsPerNote; recordIndex += 1) {
      const exact = `needle-${noteIndex}-${recordIndex}`;
      const start = source.indexOf(exact, cursor);
      if (start < 0) throw new Error(`Could not locate ${exact} in ${filePath}.`);
      const end = start + exact.length;
      cursor = end;
      const id = `physical-vault-${String(noteIndex).padStart(3, '0')}-${String(
        recordIndex,
      ).padStart(3, '0')}`;
      pending.push({
        contents: encodeTextAnnotationRecord(
          textRecord({
            filePath,
            id,
            noteId,
            recordIndex,
            target: targetForRange(source, start, end, sourceRevision, recordIndex + 2),
          }),
        ),
        path: sidecarAnnotationPath(options.vaultRoot, pathHash, id),
      });
    }
  }

  await runPool(pending, 96, async ({ contents, path }) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  });

  const scaleRecords = scaleNoteCount * scaleRecordsPerNote;
  return {
    canonicalFiles: longTargetCount + scaleRecords + scaleNoteCount + 1,
    longDocument: {
      bytes: Buffer.byteLength(longSource),
      filePath: longDocumentPath,
      records: longTargetCount,
    },
    scaleVault: {
      notes: scaleNoteCount,
      records: scaleRecords,
      sourceDirectory: SCALE_SOURCE_ROOT,
    },
    totalRecords: longTargetCount + scaleRecords,
    vaultRoot: options.vaultRoot,
  };
}

function distributedLongTargets(
  source: string,
  count: number,
  sourceRevision: string,
): readonly TextAnnotationTarget[] {
  const candidates = [
    ...source.matchAll(
      /Paragraph \d+:|Inkstone long document selectable text 中文性能观察 stable markdown block\./gu,
    ),
  ].map((match) => ({ end: (match.index ?? 0) + match[0].length, start: match.index ?? 0 }));
  if (candidates.length < count) {
    throw new Error(`Long document provides ${candidates.length} targets; ${count} requested.`);
  }
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }
  return Array.from({ length: count }, (_, index) => {
    const candidate = candidates[Math.floor((index * candidates.length) / count)];
    if (candidate === undefined) throw new Error('Long target sampling failed.');
    const line = upperBound(lineStarts, candidate.start) - 1;
    return targetForRange(source, candidate.start, candidate.end, sourceRevision, line);
  });
}

function targetForRange(
  source: string,
  start: number,
  end: number,
  sourceRevision: string,
  line: number,
): TextAnnotationTarget {
  return {
    position: { end, start, unit: 'utf16-code-unit' },
    quote: {
      exact: source.slice(start, end),
      prefix: source.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: source.slice(end, end + CONTEXT_LENGTH),
    },
    scope: {
      headingPath: [source.startsWith('# HAT Long') ? 'HAT Long 200k' : 'Scale HAT'],
      sectionEndLine: line,
      sectionStartLine: line,
    },
    sourceRevision,
  };
}

function textRecord(input: {
  readonly filePath: string;
  readonly id: string;
  readonly noteId: string;
  readonly recordIndex: number;
  readonly target: TextAnnotationTarget;
}): TextAnnotationRecord {
  return {
    createdAt: NOW,
    filePath: input.filePath,
    id: input.id,
    mark: {
      kind: input.recordIndex % 5 === 0 ? 'underline' : 'highlight',
      styleId: [
        'highlight-sun',
        'highlight-mint',
        'highlight-sky',
        'highlight-rose',
        'highlight-violet',
      ][input.recordIndex % 5] as string,
    },
    noteId: input.noteId,
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: input.recordIndex % 20 === 0 ? ['physical-scale'] : [],
    target: input.target,
    updatedAt: NOW,
  };
}

function addMeta(
  pending: Array<{ readonly contents: string; readonly path: string }>,
  vaultRoot: string,
  input: {
    readonly filePath: string;
    readonly noteId: string;
    readonly pathHash: string;
    readonly sourceFingerprint: string;
  },
): void {
  pending.push({
    contents: `${JSON.stringify(
      {
        filePath: input.filePath,
        lastReconciledAt: NOW,
        noteId: input.noteId,
        pathHash: input.pathHash,
        schemaVersion: 1,
        sourceFingerprint: input.sourceFingerprint,
      },
      null,
      2,
    )}\n`,
    path: join(vaultRoot, SIDECAR_ROOT, input.pathHash, 'meta.json'),
  });
}

function sidecarAnnotationPath(vaultRoot: string, pathHash: string, id: string): string {
  return join(vaultRoot, SIDECAR_ROOT, pathHash, 'annotations', `${id}.json`);
}

function scaleSource(noteIndex: number, records: number): string {
  return `# Scale HAT ${noteIndex}\n\n${Array.from(
    { length: records },
    (_, index) => `Record ${index}: needle-${noteIndex}-${index} searchable physical scale row.`,
  ).join('\n')}\n`;
}

async function assertEmpty(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length > 0) {
      throw new Error(`Physical scale fixture requires an empty directory: ${path}`);
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

async function runPool<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) return;
      await task(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
}

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] as number) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
