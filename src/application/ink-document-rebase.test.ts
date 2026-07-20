import { describe, expect, it, vi } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { previewInkDocumentRebase } from '../domain/ink-surface-layout';
import { commitInkDocumentRebase } from './ink-document-rebase';
import type { InkSurfaceWriter } from './ink-surface-session';

describe('document-level Ink rebase', () => {
  it('commits every rebased surface through one atomic write with exact expected bases', async () => {
    const current = [surface('a', 0, 5), surface('b', 600, 9)];
    const preview = previewInkDocumentRebase(
      current,
      current.map((record, index) => ({
        endY: index * 400 + 400,
        layout: {
          fontAvailable: true,
          fontFamily: 'Inter',
          fontSize: 16,
          lineHeight: 24,
          logicalHeight: 400,
          logicalWidth: 800,
          sourceRevision: 'source-2',
          themeMode: 'light' as const,
          viewportWidth: 800,
        },
        section: {
          blockFingerprints: [`target-${index}`],
          headingPath: [`Target ${index}`],
          sectionFingerprint: `target-${index}`,
          sourceEnd: index * 100 + 80,
          sourceStart: index * 100,
        },
        startY: index * 400,
        surfaceId: record.id,
      })),
    );
    const updateSurface = vi.fn<InkSurfaceWriter['updateSurface']>();
    const updateSurfacesAtomically = vi.fn<
      NonNullable<InkSurfaceWriter['updateSurfacesAtomically']>
    >(() => Promise.resolve());

    const committed = await commitInkDocumentRebase({
      current,
      now: '2026-07-19T06:30:00.000Z',
      preview,
      writer: { updateSurface, updateSurfacesAtomically },
    });

    expect(updateSurface).not.toHaveBeenCalled();
    expect(updateSurfacesAtomically).toHaveBeenCalledTimes(1);
    expect(updateSurfacesAtomically).toHaveBeenCalledWith(committed, current);
    expect(committed).toMatchObject([
      { id: 'surface-a', revision: 6, updatedAt: '2026-07-19T06:30:00.000Z' },
      { id: 'surface-b', revision: 10, updatedAt: '2026-07-19T06:30:00.000Z' },
    ]);

    const forbiddenPerSurfaceWrite = vi.fn<InkSurfaceWriter['updateSurface']>();
    await expect(
      commitInkDocumentRebase({
        current,
        now: '2026-07-19T06:30:00.000Z',
        preview,
        writer: { updateSurface: forbiddenPerSurfaceWrite },
      }),
    ).rejects.toThrow(/requires an atomic multi-surface writer/u);
    expect(forbiddenPerSurfaceWrite).not.toHaveBeenCalled();
  });
});

function surface(id: string, originY: number, revision: number): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: [id],
      headingPath: [id],
      sectionFingerprint: id,
      sourceEnd: originY + 80,
      sourceStart: originY,
    },
    createdAt: '2026-07-19T06:00:00.000Z',
    filePath: 'Ink.md',
    id: `surface-${id}`,
    layout: {
      blockFingerprints: [id],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 600,
      logicalWidth: 960,
      originY,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision,
    schemaVersion: 3,
    status: 'needs-rebase',
    strokes: [],
    updatedAt: '2026-07-19T06:00:00.000Z',
  };
}
