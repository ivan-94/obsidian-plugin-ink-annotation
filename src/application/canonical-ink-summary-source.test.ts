import { describe, expect, it, vi } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { summarizeInkSurface } from '../domain/ink-surface-summary';
import { CanonicalInkSummarySource } from './canonical-ink-summary-source';

describe('CanonicalInkSummarySource', () => {
  it('projects the authoritative document snapshot instead of an empty legacy summary index', async () => {
    const snapshot = inkSnapshot('UAT - Blank Ink.md');
    const listLegacySurfaceSummaries = vi.fn(() => Promise.resolve([]));
    const source = new CanonicalInkSummarySource({
      legacy: { listSurfaceSummaries: listLegacySurfaceSummaries, readSurface: vi.fn() },
      snapshots: { read: () => Promise.resolve(snapshot) },
    });

    await expect(source.listSurfaceSummaries(snapshot.filePath)).resolves.toMatchObject([
      {
        filePath: snapshot.filePath,
        id: snapshot.id,
        revision: snapshot.revision,
        strokeCount: 1,
      },
    ]);
    expect(listLegacySurfaceSummaries).not.toHaveBeenCalled();
  });

  it('falls back to migration summaries only when no document snapshot exists', async () => {
    const legacy = [summarizeInkSurface(inkSnapshot('Legacy.md'))];
    const listSurfaceSummaries = vi.fn(() => Promise.resolve(legacy));
    const source = new CanonicalInkSummarySource({
      legacy: { listSurfaceSummaries, readSurface: vi.fn() },
      snapshots: { read: () => Promise.resolve(null) },
    });

    await expect(source.listSurfaceSummaries('Legacy.md')).resolves.toBe(legacy);
    expect(listSurfaceSummaries).toHaveBeenCalledWith('Legacy.md');
  });

  it('reads the authoritative snapshot row used by Current file actions', async () => {
    const snapshot = inkSnapshot('UAT - Blank Ink.md');
    const readLegacySurface = vi.fn();
    const source = new CanonicalInkSummarySource({
      legacy: {
        listSurfaceSummaries: vi.fn(),
        readSurface: readLegacySurface,
      },
      snapshots: { read: () => Promise.resolve(snapshot) },
    });

    await expect(source.readSurface(snapshot.filePath, snapshot.id)).resolves.toBe(snapshot);
    await expect(source.readSurface(snapshot.filePath, 'another-surface')).resolves.toBeNull();
    expect(readLegacySurface).not.toHaveBeenCalled();
  });
});

function inkSnapshot(filePath: string): InkSurfaceRecord {
  return {
    createdAt: '2026-07-21T00:00:00.000Z',
    deviceId: 'device-a',
    filePath,
    id: 'ink-document',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1_000,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-a',
      themeMode: 'light',
    },
    noteId: 'note-a',
    revision: 3,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#4338ca',
        id: 'stroke-a',
        points: [
          { pressure: 0.5, time: 0, x: 10, y: 20 },
          { pressure: 0.5, time: 16, x: 40, y: 30 },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-21T00:00:01.000Z',
  };
}
