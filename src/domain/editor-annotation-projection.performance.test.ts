import { describe, expect, it } from 'vitest';

import type { ResolvedHighlight } from '../application/annotation-service';
import type { TextAnnotationRecord } from './text-annotation';
import { buildEditorAnnotationProjection } from './editor-annotation-projection';

describe('editor annotation projection performance', () => {
  it('keeps a 200k-character document viewport bounded', () => {
    const documentLength = 200_000;
    const resolved: ResolvedHighlight[] = [];
    for (let start = 0; start < documentLength - 5; start += 10) {
      resolved.push({
        end: start + 5,
        record: record(`annotation-${start}`, start, start + 5),
        start,
      });
    }
    const startedAt = performance.now();

    const projection = buildEditorAnnotationProjection(
      resolved,
      [{ from: 100_000, to: 101_000 }],
      documentLength,
    );
    const durationMs = performance.now() - startedAt;

    expect(projection.marks).toHaveLength(100);
    expect(durationMs).toBeLessThan(250);
  });
});

function record(id: string, start: number, end: number): TextAnnotationRecord {
  return {
    createdAt: '2026-07-14T00:00:00.000Z',
    filePath: 'Large.md',
    id,
    mark: { kind: 'highlight', styleId: 'sun' },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end, start, unit: 'utf16-code-unit' },
      quote: { exact: 'xxxxx', prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}
