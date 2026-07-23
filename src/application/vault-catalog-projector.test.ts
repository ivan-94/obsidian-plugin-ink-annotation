import { describe, expect, it, vi } from 'vitest';

import type { SnapshotAnnotationRecord } from '../domain/snapshot-annotation';
import { VaultCatalogProjector } from './vault-catalog-projector';

describe('VaultCatalogProjector', () => {
  it('projects a canonical Snapshot record with current Markdown and no image or stroke payload', async () => {
    const upsertEntry = vi.fn();
    const putSnapshotBinding = vi.fn();
    const readMarkdown = vi.fn().mockResolvedValue('Prefix Gamma block suffix');
    const projector = new VaultCatalogProjector({
      catalog: {
        putSnapshotBinding,
        removeEntry: vi.fn(),
        removeSnapshotBinding: vi.fn(),
        upsertEntry,
      },
      readMarkdown,
    });

    await projector.applySnapshotRecord(snapshotRecord());

    expect(readMarkdown).toHaveBeenCalledWith('Notes/Test.md');
    expect(upsertEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        annotationId: 'snapshot-a',
        linkState: 'linked',
        noteId: 'note-a',
        position: 7,
        strokeCount: 1,
        type: 'snapshot',
      }),
    );
    const projected = upsertEntry.mock.calls[0]?.[0] as unknown;
    expect(JSON.stringify(projected)).not.toContain('points');
    expect(JSON.stringify(projected)).not.toContain('capture-');
    expect(JSON.stringify(projected)).not.toContain('sourceRevision');
    expect(putSnapshotBinding).toHaveBeenCalledWith(
      expect.objectContaining({ annotationId: 'snapshot-a', sourceRevision: 'source-a' }),
    );
  });
});

function snapshotRecord(): SnapshotAnnotationRecord {
  const target = {
    position: { end: 11, start: 0, unit: 'utf16-code-unit' as const },
    quote: { exact: 'Gamma block', prefix: '', suffix: '' },
    scope: { headingPath: ['Chapter'] },
    sourceRevision: 'source-a',
  };
  return {
    asset: {
      backend: { id: 'fake', version: '1' },
      byteLength: 33,
      fileName: `capture-${'a'.repeat(64)}.png`,
      logicalHeight: 200,
      logicalWidth: 300,
      mimeType: 'image/png',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
      sha256: 'a'.repeat(64),
    },
    capturedAt: '2026-07-22T00:00:00.000Z',
    createdAt: '2026-07-22T00:00:00.000Z',
    filePath: 'Notes/Test.md',
    id: 'snapshot-a',
    ink: {
      logicalHeight: 200,
      logicalWidth: 300,
      strokes: [
        {
          color: '#111111',
          id: 'stroke-a',
          points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
          tool: 'pen',
          width: 2,
        },
      ],
    },
    noteId: 'note-a',
    revision: 2,
    schemaVersion: 1,
    source: {
      coverage: [target],
      focus: target,
      headingPath: ['Chapter'],
      sourceRevision: 'source-a',
    },
    status: 'active',
    updatedAt: '2026-07-22T01:00:00.000Z',
  };
}
