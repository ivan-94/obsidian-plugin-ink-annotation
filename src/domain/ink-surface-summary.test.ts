import { describe, expect, it, vi } from 'vitest';

import { SharedInkStrokeGeometry } from './ink-shared-stroke-geometry';
import type { InkSurfaceRecord } from './ink-surface';
import {
  joinInkStrokeSurfaceFragments,
  splitInkStrokeIntoSurfaceFragments,
} from './ink-surface-layout';
import { summarizeInkSurface } from './ink-surface-summary';

describe('Ink surface summary brush compatibility', () => {
  it('renders an unpublished physical Highlighter thumbnail from shared filled geometry', () => {
    const summary = summarizeInkSurface(physicalSurface());
    const path = /<path (?<attributes>[^>]+)\/>/u.exec(summary.thumbnailSvg)?.groups?.attributes;

    expect(path).toContain('data-ink-brush-version="highlighter-chisel-v1"');
    expect(path).toContain('fill="#ffcc00"');
    expect(path).toContain('fill-rule="nonzero"');
    expect(path).toContain('opacity="0.35"');
    expect(path).not.toContain('stroke-width');
  });

  it('joins every available linked fragment before compiling a thumbnail', () => {
    const records = splitPhysicalSurfaces();
    const joined = joinInkStrokeSurfaceFragments(
      records.flatMap((record) =>
        record.strokes.map((stroke) => ({
          endY: (record.layout.originY as number) + record.layout.logicalHeight,
          logicalHeight: record.layout.logicalHeight,
          schemaVersion: record.schemaVersion,
          startY: record.layout.originY as number,
          stroke,
          surfaceId: record.id,
        })),
      ),
    )[0];
    if (joined === undefined) throw new Error('Missing joined thumbnail fixture.');
    const expected = new SharedInkStrokeGeometry().compile(joined);
    if (!('geometry' in expected)) throw new Error('Expected joined physical geometry.');

    const summary = summarizeInkSurface(records[0] as InkSurfaceRecord, {
      relatedRecords: records,
    });

    expect(summary.thumbnailSvg).toContain(
      `data-ink-geometry-digest="${expected.geometry.geometryDigest}"`,
    );
    expect(summary.thumbnailSvg.match(/data-ink-stroke-id="joined-highlighter"/gu)).toHaveLength(1);
  });

  it('refuses to thumbnail a linked physical fragment without its complete sibling set', () => {
    const [top] = splitPhysicalSurfaces();
    if (top === undefined) throw new Error('Missing partial thumbnail fixture.');

    expect(() => summarizeInkSurface(top)).toThrow(/incomplete physical fragment boundary/u);
    expect(() => summarizeInkSurface(top, { relatedRecords: [top] })).toThrow(
      /incomplete physical fragment boundary/u,
    );
  });

  it('fails closed for an unknown Brush Render Version instead of making a legacy thumbnail', () => {
    const invalid = {
      ...physicalSurface(),
      strokes: [
        {
          ...physicalSurface().strokes[0],
          brushRenderVersion: 'future-brush-v9',
        },
      ],
    } as unknown as InkSurfaceRecord;

    expect(() => summarizeInkSurface(invalid)).toThrow(/unsupported brush metadata/u);
  });

  it('bounds derived thumbnail geometry while preserving the canonical stroke count', () => {
    const source = physicalSurface();
    const template = source.strokes[0];
    if (template === undefined) throw new Error('Missing bounded thumbnail fixture stroke.');
    const record: InkSurfaceRecord = {
      ...source,
      strokes: Array.from({ length: 200 }, (_, index) => ({
        ...template,
        id: `stroke-${index}`,
        points: template.points.map((point) => ({
          ...point,
          x: 10 + (index % 20) * 20,
          y: 10 + Math.floor(index / 20) * 16,
        })),
      })),
    };

    const summary = summarizeInkSurface(record);

    expect(summary.strokeCount).toBe(200);
    expect(summary.thumbnailSvg.match(/data-ink-stroke-id=/gu)).toHaveLength(64);
    expect(summary.thumbnailSvg).toContain('data-ink-stroke-id="stroke-0"');
    expect(summary.thumbnailSvg).toContain('data-ink-stroke-id="stroke-199"');
  });

  it('compiles immutable single-surface thumbnail geometry only once', () => {
    const record = physicalSurface();
    const compile = vi.spyOn(SharedInkStrokeGeometry.prototype, 'compile');

    summarizeInkSurface(record);
    const firstProjectionCompileCount = compile.mock.calls.length;
    summarizeInkSurface(record);

    expect(firstProjectionCompileCount).toBeGreaterThan(0);
    expect(compile).toHaveBeenCalledTimes(firstProjectionCompileCount);
  });
});

function physicalSurface(): InkSurfaceRecord {
  return {
    createdAt: '2026-07-18T00:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-physical',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 200,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 3,
    status: 'active',
    strokes: [
      {
        brushRenderVersion: 'highlighter-chisel-v1',
        color: '#ffcc00',
        id: 'physical-highlighter',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        points: [
          {
            orientation: {
              altitude: 0.4,
              azimuth: 1.2,
              kind: 'measured',
              reliable: true,
            },
            pressure: 0.5,
            pressureKind: 'measured',
            time: 0,
            x: 10,
            y: 20,
          },
        ],
        tool: 'highlighter',
        width: 12,
      },
    ],
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function splitPhysicalSurfaces(): readonly InkSurfaceRecord[] {
  const source = physicalSurface();
  const baseStroke = source.strokes[0];
  if (baseStroke === undefined) throw new Error('Missing physical thumbnail fixture stroke.');
  const stroke = {
    ...baseStroke,
    id: 'joined-highlighter',
    linkedStrokeId: 'joined-highlighter',
    points: [40, 50, 60].map((y, index) => ({
      orientation: {
        altitude: 0.25,
        azimuth: Math.PI / 2,
        kind: 'measured' as const,
        reliable: true,
      },
      pressure: 0.5,
      pressureKind: 'measured' as const,
      time: index * 10,
      x: 50,
      y,
    })),
  };
  const fragments = splitInkStrokeIntoSurfaceFragments({
    stroke,
    surfaces: [
      { endY: 50, id: 'top', logicalHeight: 50, startY: 0 },
      { endY: 100, id: 'bottom', logicalHeight: 50, startY: 50 },
    ],
  });
  return fragments.map((fragment, index) => ({
    ...source,
    id: fragment.surfaceId,
    layout: { ...source.layout, logicalHeight: 50, originY: index * 50 },
    strokes: [fragment.stroke],
  }));
}
