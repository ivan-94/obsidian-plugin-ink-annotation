import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import type { InkLayoutObservation } from '../domain/ink-surface-layout';
import { selectInkLayoutObservation } from './ink-layout-observation-policy';

describe('Ink layout observation policy', () => {
  it('lets an empty provisional surface adopt the settled virtualized layout', () => {
    expect(selectInkLayoutObservation(record([]), observation())).toMatchObject({
      logicalHeight: 2400,
      logicalWidth: 900,
    });
  });

  it('keeps the fixed logical box when user strokes already depend on its coordinates', () => {
    expect(selectInkLayoutObservation(record([stroke()]), observation())).toMatchObject({
      logicalHeight: 1200,
      logicalWidth: 960,
    });
  });
});

function record(strokes: InkSurfaceRecord['strokes']): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T00:00:00.000Z',
    filePath: 'Long.md',
    id: 'surface',
    layout: {
      blockFingerprints: ['a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes,
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

function observation(): InkLayoutObservation {
  return {
    fontAvailable: true,
    fontFamily: 'Inter',
    fontSize: 16,
    lineHeight: 24,
    logicalHeight: 2400,
    logicalWidth: 900,
    sourceRevision: 'source',
    themeMode: 'light',
    viewportWidth: 900,
  };
}

function stroke(): InkSurfaceRecord['strokes'][number] {
  return {
    color: '#111111',
    id: 'stroke',
    points: [
      { pressure: 0.5, time: 0, x: 10, y: 10 },
      { pressure: 0.5, time: 1, x: 20, y: 20 },
    ],
    tool: 'pen',
    width: 4,
  };
}
