import { describe, expect, it } from 'vitest';

import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkPoint,
  type InkSurfaceRecord,
} from './ink-surface';
import {
  confirmInkRebase,
  partitionInkBlocks,
  previewInkRebase,
  reconcileInkSurface,
  splitInkStrokeIntoSurfaceFragments,
  type InkSurfaceSection,
} from './ink-surface-layout';

describe('bounded Ink surface layout', () => {
  it('partitions by heading section and bounded block groups without defaulting to full note', () => {
    const partitions = partitionInkBlocks(
      [
        block('h-a', 0, 5, ['A'], 'heading'),
        block('a-1', 6, 20, ['A']),
        block('a-2', 21, 35, ['A']),
        block('a-3', 36, 50, ['A']),
        block('h-b', 51, 56, ['B'], 'heading'),
        block('b-1', 57, 70, ['B']),
      ],
      { maxBlocks: 3 },
    );

    expect(partitions.map((surface) => [surface.headingPath, surface.blockFingerprints])).toEqual([
      [['A'], ['h-a', 'a-1', 'a-2']],
      [['A'], ['a-3']],
      [['B'], ['h-b', 'b-1']],
    ]);
    expect(partitions.every((surface) => !surface.fullNoteFallback)).toBe(true);
  });

  it('splits a crossing stroke into local linked fragments with a shared boundary point', () => {
    const fragments = splitInkStrokeIntoSurfaceFragments({
      color: '#4f46d8',
      linkedStrokeId: 'stroke-user-1',
      points: [point(100, 550), point(200, 650)],
      surfaces: [
        { endY: 600, id: 'surface-a', startY: 0 },
        { endY: 1200, id: 'surface-b', startY: 600 },
      ],
      tool: 'pen',
      width: 4,
    });

    expect(fragments).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.stroke.linkedStrokeId)).toEqual([
      'stroke-user-1',
      'stroke-user-1',
    ]);
    expect(fragments[0]?.stroke.points.at(-1)).toMatchObject({ x: 150, y: 600 });
    expect(fragments[1]?.stroke.points[0]).toMatchObject({ x: 150, y: 0 });
  });

  it('preserves drawing direction when a stroke crosses surfaces from bottom to top', () => {
    const fragments = splitInkStrokeIntoSurfaceFragments({
      color: '#4f46d8',
      linkedStrokeId: 'stroke-upward',
      points: [point(200, 650), point(100, 550)],
      surfaces: [
        { endY: 600, id: 'surface-a', startY: 0 },
        { endY: 1200, id: 'surface-b', startY: 600 },
      ],
      tool: 'pen',
      width: 4,
    });

    expect(fragments[0]?.stroke.points).toMatchObject([
      { x: 150, y: 600 },
      { x: 100, y: 550 },
    ]);
    expect(fragments[1]?.stroke.points).toMatchObject([
      { x: 200, y: 50 },
      { x: 150, y: 0 },
    ]);
  });

  it('round-trips a stroke across multiple surfaces below the visual error threshold', () => {
    const bounds = [
      { endY: 400, id: 'a', startY: 0 },
      { endY: 800, id: 'b', startY: 400 },
      { endY: 1200, id: 'c', startY: 800 },
    ];
    const original = [point(20, 350), point(220, 650), point(420, 950)];
    const fragments = splitInkStrokeIntoSurfaceFragments({
      color: '#4f46d8',
      linkedStrokeId: 'long-stroke',
      points: original,
      surfaces: bounds,
      tool: 'pen',
      width: 4,
    });
    const reloaded = fragments.map((fragment) => {
      const bound = bounds.find((candidate) => candidate.id === fragment.surfaceId);
      if (bound === undefined) throw new Error('Missing test bound.');
      const record = {
        ...surfaceFixture(),
        id: fragment.surfaceId,
        layout: { ...surfaceFixture().layout, logicalHeight: bound.endY - bound.startY },
        strokes: [fragment.stroke],
      };
      return {
        startY: bound.startY,
        stroke: decodeInkSurfaceRecord(encodeInkSurfaceRecord(record)).strokes[0],
      };
    });
    const joined = reloaded.flatMap(({ startY, stroke }, index) =>
      (stroke?.points ?? []).slice(index === 0 ? 0 : 1).map((candidate) => ({
        ...candidate,
        y: candidate.y + startY,
      })),
    );

    expect(maximumPolylineError(original, joined)).toBeLessThanOrEqual(1e-9);
  });

  it('keeps exact sections active, relocates intact moves, and isolates changed/missing targets', () => {
    const record = surfaceFixture();
    const exact = section('section-a', 100, 200, ['block-a']);
    expect(reconcileInkSurface(record, [exact], layout())).toMatchObject({ kind: 'active' });

    const moved = section('section-a', 500, 600, ['block-a']);
    expect(reconcileInkSurface(record, [moved], layout())).toMatchObject({
      kind: 'relocated',
      record: { binding: { sourceStart: 500 }, revision: 2, status: 'active' },
    });

    const changed = section('section-a-v2', 100, 210, ['block-edited']);
    expect(reconcileInkSurface(record, [changed], layout())).toMatchObject({
      kind: 'needs-rebase',
      record: { status: 'needs-rebase', strokes: record.strokes },
    });
    expect(reconcileInkSurface(record, [], layout())).toMatchObject({
      kind: 'unanchored',
      record: { status: 'unanchored', strokes: record.strokes },
    });
  });

  it('allows viewport scaling but blocks font, theme, and logical-layout drift', () => {
    const record = surfaceFixture();
    const target = section('section-a', 100, 200, ['block-a']);

    expect(
      reconcileInkSurface(record, [target], { ...layout(), viewportWidth: 480 }),
    ).toMatchObject({
      kind: 'active',
    });
    for (const changed of [
      { ...layout(), fontAvailable: false },
      { ...layout(), fontFamily: 'Arial' },
      { ...layout(), themeMode: 'dark' as const },
      { ...layout(), logicalWidth: 800 },
    ]) {
      expect(reconcileInkSurface(record, [target], changed)).toMatchObject({
        kind: 'needs-rebase',
      });
    }
  });

  it('refreshes an empty surface layout automatically because no user strokes can be distorted', () => {
    const record = { ...surfaceFixture(), strokes: [] };
    const target = section('section-a', 100, 200, ['block-a']);

    expect(
      reconcileInkSurface(record, [target], { ...layout(), logicalHeight: 2400 }),
    ).toMatchObject({
      kind: 'active',
      record: { layout: { logicalHeight: 2400 }, revision: 2, status: 'active', strokes: [] },
    });
  });

  it('returns a transient needs-rebase record to active when the exact layout matches again', () => {
    const record = { ...surfaceFixture(), revision: 2, status: 'needs-rebase' as const };
    const target = section('section-a', 100, 200, ['block-a']);

    expect(reconcileInkSurface(record, [target], layout())).toMatchObject({
      kind: 'active',
      record: { revision: 3, status: 'active', strokes: record.strokes },
    });
  });

  it('previews rebase without mutation and confirms one revision with transformed points', () => {
    const record = surfaceFixture();
    const original = structuredClone(record);
    const target = section('section-b', 300, 500, ['block-b']);
    const preview = previewInkRebase(record, target, {
      ...layout(),
      logicalHeight: 600,
      logicalWidth: 480,
    });

    expect(record).toEqual(original);
    expect(preview.record).toMatchObject({
      binding: { sectionFingerprint: 'section-b' },
      revision: 1,
      status: 'active',
      strokes: [
        {
          points: [
            { x: 50, y: 50 },
            { x: 100, y: 100 },
          ],
        },
      ],
    });

    const confirmed = confirmInkRebase(record, preview, '2026-07-14T12:00:00.000Z');
    expect(confirmed).toMatchObject({ revision: 2, updatedAt: '2026-07-14T12:00:00.000Z' });
    expect(() => confirmInkRebase({ ...record, revision: 2 }, preview, 'later')).toThrow(
      /changed after the preview/u,
    );
  });

  it('keeps intact siblings active through deterministic section reorder/edit cases', () => {
    const records = ['A', 'B', 'C'].map((name, index) =>
      surfaceForSection(name, index * 100, index * 100 + 80),
    );
    let seed = 0x5eed1234;
    for (let iteration = 0; iteration < 50; iteration += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const edited = seed % records.length;
      const deleted = iteration % 5 === 0 ? (seed >>> 8) % records.length : -1;
      const order = [...records.keys()]
        .filter((recordIndex) => recordIndex !== deleted)
        .sort((left, right) =>
          ((seed >>> left) & 1) === ((seed >>> right) & 1)
            ? left - right
            : ((seed >>> left) & 1) - ((seed >>> right) & 1),
        );
      const sections = order.map((recordIndex, position) => {
        const name = ['A', 'B', 'C'][recordIndex] as string;
        return section(
          recordIndex === edited ? `section-${name}-edited` : `section-${name}`,
          position * 100,
          position * 100 + 80,
          [recordIndex === edited ? `block-${name}-edited` : `block-${name}`],
          name,
        );
      });
      sections.splice(
        seed % (sections.length + 1),
        0,
        section('section-inserted', 900, 980, ['block-inserted'], 'Inserted'),
      );
      records.forEach((record, recordIndex) => {
        const result = reconcileInkSurface(record, sections, layout());
        if (recordIndex === deleted) {
          expect(result.kind).toBe('unanchored');
        } else if (recordIndex === edited) {
          expect(result.kind).toBe('needs-rebase');
        } else {
          expect(['active', 'relocated']).toContain(result.kind);
        }
        expect(result.record.strokes).toEqual(record.strokes);
      });
    }
  });
});

function block(
  fingerprint: string,
  sourceStart: number,
  sourceEnd: number,
  headingPath: readonly string[],
  kind: 'block' | 'heading' = 'block',
) {
  return { fingerprint, headingPath, kind, sourceEnd, sourceStart } as const;
}

function section(
  sectionFingerprint: string,
  sourceStart: number,
  sourceEnd: number,
  blockFingerprints: readonly string[],
  heading = 'A',
): InkSurfaceSection {
  return { blockFingerprints, headingPath: [heading], sectionFingerprint, sourceEnd, sourceStart };
}

function layout() {
  return {
    fontAvailable: true,
    fontFamily: 'Inter',
    fontSize: 16,
    lineHeight: 24,
    logicalHeight: 1200,
    logicalWidth: 960,
    sourceRevision: 'source-2',
    themeMode: 'light' as const,
    viewportWidth: 960,
  };
}

function surfaceFixture(): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: ['block-a'],
      headingPath: ['A'],
      sectionFingerprint: 'section-a',
      sourceEnd: 200,
      sourceStart: 100,
    },
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-a',
    layout: {
      blockFingerprints: ['block-a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#4f46d8',
        id: 'fragment-1',
        linkedStrokeId: 'stroke-user-1',
        points: [point(100, 100), point(200, 200)],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function point(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}

function surfaceForSection(name: string, sourceStart: number, sourceEnd: number): InkSurfaceRecord {
  return {
    ...surfaceFixture(),
    binding: {
      blockFingerprints: [`block-${name}`],
      headingPath: [name],
      sectionFingerprint: `section-${name}`,
      sourceEnd,
      sourceStart,
    },
    id: `surface-${name}`,
    layout: { ...surfaceFixture().layout, blockFingerprints: [`block-${name}`] },
  };
}

function maximumPolylineError(original: readonly InkPoint[], joined: readonly InkPoint[]): number {
  return Math.max(
    ...joined.map((candidate) =>
      Math.min(
        ...lineSegments(original).map(([start, end]) => distanceToSegment(candidate, start, end)),
      ),
    ),
  );
}

function lineSegments(points: readonly InkPoint[]): readonly (readonly [InkPoint, InkPoint])[] {
  return points.slice(1).map((point, index) => [points[index] as InkPoint, point] as const);
}

function distanceToSegment(pointValue: InkPoint, start: InkPoint, end: InkPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const ratio =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((pointValue.x - start.x) * dx + (pointValue.y - start.y) * dy) / lengthSquared,
          ),
        );
  return Math.hypot(pointValue.x - (start.x + dx * ratio), pointValue.y - (start.y + dy * ratio));
}
