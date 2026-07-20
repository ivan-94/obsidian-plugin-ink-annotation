import { describe, expect, it } from 'vitest';

import { INK_SAMPLE_FLAGS, type InkSampleCursor, type InkSampleView } from './ink-contact';
import type { InkBorrowedControlTraceDelta } from './ink-control-trace';
import type { InkStroke } from './ink-surface';
import {
  LegacyRoundInkStrokeGeometry,
  legacyGeometryCacheKey,
  type InkActivePresentationWriter,
} from './ink-stroke-geometry';

describe('legacy-round-v1 InkStrokeGeometry', () => {
  it('compiles historical points without rewriting them and freezes round geometry semantics', () => {
    const source = stroke('legacy', 'pen', '#112233', 4);
    const geometry = new LegacyRoundInkStrokeGeometry().compile(source);

    expect(geometry).toMatchObject({
      bounds: { height: 24, width: 34, x: 8, y: 8 },
      paint: {
        color: '#112233',
        composite: 'source-over',
        lineCap: 'round',
        lineJoin: 'round',
        opacity: 1,
      },
      strokeId: 'legacy',
      tool: 'pen',
      version: 'legacy-round-v1',
      width: 4,
    });
    expect(geometry.digest).toBe('f0d5d526');
    expect(geometry.points).toEqual(source.points);
    expect(geometry.points).not.toBe(source.points);
    expect(Object.isFrozen(geometry.points)).toBe(true);
    expect(source.points).toEqual([
      { pressure: 0.2, time: 0, x: 10, y: 10 },
      { pressure: 0.8, time: 16, x: 40, y: 30 },
    ]);
  });

  it('normalizes one-stroke Highlighter density from legacy colors', () => {
    const compiler = new LegacyRoundInkStrokeGeometry();

    expect(compiler.compile(stroke('old-mark', 'highlighter', '#ffd54f', 12)).paint).toMatchObject({
      color: '#ffd54f',
      opacity: 0.45,
    });
    expect(
      compiler.compile(stroke('foundation-mark', 'highlighter', '#ffd54f88', 12)).paint,
    ).toMatchObject({ color: '#ffd54f', opacity: 136 / 255 });
  });

  it('keeps geometry digest and cache key independent of zoom and DPR projection', () => {
    const source = stroke('cached', 'pen', '#112233', 4);
    const compiler = new LegacyRoundInkStrokeGeometry();
    const geometry = compiler.compile(source);
    const first = legacyGeometryCacheKey(source, 7);
    const projectedAtHalf = project(geometry.points, 0.5, 1);
    const projectedAtTwo = project(geometry.points, 2, 3);

    expect(first).toBe(legacyGeometryCacheKey(source, 7));
    expect(first).not.toContain('0.5');
    expect(first).not.toContain('dpr');
    expect(compiler.compile(source).digest).toBe(geometry.digest);
    expect(projectedAtHalf).not.toEqual(projectedAtTwo);
  });

  it('owns conservative bounds and point hit semantics for every legacy consumer', () => {
    const source = stroke('hit', 'pen', '#112233', 4);
    const compiler = new LegacyRoundInkStrokeGeometry();

    expect(compiler.bounds(source)).toEqual(compiler.compile(source).bounds);
    expect(compiler.hitTest(source, point(25, 20, 8), 0)).toBe(true);
    expect(compiler.hitTest(source, point(25, 23, 8), 1)).toBe(true);
    expect(compiler.hitTest(source, point(25, 30, 8), 1)).toBe(false);
  });

  it('extends only newly stable segments plus a bounded mutable tail', () => {
    const compiler = new LegacyRoundInkStrokeGeometry();
    const style = { color: '#112233', tool: 'pen' as const, width: 4 };
    const first = compiler.extend(null, {
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      strokeId: 'active',
      style,
    });
    const second = compiler.extend(first.state, {
      delta: {
        mutableTail: [point(40, 30, 16)],
        stablePrefixDelta: [point(20, 20, 4), point(30, 25, 8)],
      },
      strokeId: 'active',
      style,
    });

    expect(first.stablePathDelta).toEqual([]);
    expect(first.mutablePath.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ]);
    expect(second.stablePathDelta.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 25 },
    ]);
    expect(second.state.stableSegmentCount).toBe(2);
    expect(second.mutablePath.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 30, y: 25 },
      { x: 40, y: 30 },
    ]);
  });

  it('deduplicates only full duplicate points and freezes the stable point batch', () => {
    const compiler = new LegacyRoundInkStrokeGeometry();
    const style = { color: '#112233', tool: 'pen' as const, width: 4 };
    const start = { pressure: 0.2, tiltX: 0, tiltY: 0, time: 0, x: 10, y: 10 };
    const pressureChange = { ...start, pressure: 0.7, time: 4 };
    const tiltChange = { ...pressureChange, tiltX: 12 };
    const first = compiler.extend(null, {
      delta: { mutableTail: [], stablePrefixDelta: [start] },
      strokeId: 'full-point-semantics',
      style,
    });
    const second = compiler.extend(first.state, {
      delta: {
        mutableTail: [],
        stablePrefixDelta: [{ ...start }, pressureChange, { ...pressureChange }, tiltChange],
      },
      strokeId: 'full-point-semantics',
      style,
    });

    expect(second.stablePathDelta).toEqual([start, pressureChange, tiltChange]);
    expect(second.state.stableSegmentCount).toBe(2);
    expect(Object.isFrozen(second.stablePathDelta)).toBe(true);
    expect(second.stablePathDelta.every((stablePoint) => Object.isFrozen(stablePoint))).toBe(true);
    expect(second.stablePathDelta[0]).not.toBe(start);
    expect(second.stablePathDelta[1]).not.toBe(pressureChange);
    expect(second.stablePathDelta[2]).not.toBe(tiltChange);
  });

  it('keeps cumulative stable geometry equivalent across event regrouping', () => {
    const compiler = new LegacyRoundInkStrokeGeometry();
    const style = { color: '#112233', tool: 'pen' as const, width: 4 };
    const ordered = [
      { pressure: 0.2, tiltX: 0, tiltY: 0, time: 0, x: 10, y: 10 },
      { pressure: 0.4, tiltX: 0, tiltY: 0, time: 4, x: 20, y: 15 },
      { pressure: 0.4, tiltX: 5, tiltY: 0, time: 8, x: 30, y: 20 },
      { pressure: 0.8, tiltX: 5, tiltY: 0, time: 12, x: 40, y: 25 },
    ];
    const singleBatch = compiler.extend(null, {
      delta: { mutableTail: [], stablePrefixDelta: ordered },
      strokeId: 'regrouped',
      style,
    });
    const firstBatch = compiler.extend(null, {
      delta: { mutableTail: [], stablePrefixDelta: ordered.slice(0, 2) },
      strokeId: 'regrouped',
      style,
    });
    const secondBatch = compiler.extend(firstBatch.state, {
      delta: { mutableTail: [], stablePrefixDelta: ordered.slice(2) },
      strokeId: 'regrouped',
      style,
    });
    const regroupedPath = [...firstBatch.stablePathDelta, ...secondBatch.stablePathDelta.slice(1)];

    expect(regroupedPath).toEqual(singleBatch.stablePathDelta);
    expect(secondBatch.state).toEqual(singleBatch.state);
  });

  it('returns only the new stable path seam after a 50k-point history', () => {
    const compiler = new LegacyRoundInkStrokeGeometry();
    const style = { color: '#112233', tool: 'pen' as const, width: 4 };
    const prefix = Array.from({ length: 50_000 }, (_value, index) => point(index, 10, index));
    const first = compiler.extend(null, {
      delta: { mutableTail: [], stablePrefixDelta: prefix },
      strokeId: 'long',
      style,
    });
    const next = compiler.extend(first.state, {
      delta: { mutableTail: [], stablePrefixDelta: [point(50_000, 10, 50_000)] },
      strokeId: 'long',
      style,
    });

    expect(first.stablePathDelta).toHaveLength(50_000);
    expect(next.stablePathDelta).toEqual([prefix.at(-1), point(50_000, 10, 50_000)]);
    expect(next.state.stableSegmentCount).toBe(50_000);
  });

  it('streams borrowed numeric samples into a writer without retaining its reused cursor', () => {
    const compiler = new LegacyRoundInkStrokeGeometry();
    const session = compiler.beginActivePresentation({
      strokeId: 'numeric-active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    const writes = numericWriter();
    const first = session.extend(
      numericDelta([sampleCursor(10, 10, 0)], [sampleCursor(20, 20, 4)]),
      writes.writer,
    );

    expect(writes.stable).toEqual([]);
    expect(writes.mutable).toEqual([
      expect.objectContaining({ x: 10, y: 10 }),
      expect.objectContaining({ x: 20, y: 20 }),
    ]);
    expect(first.stableSegmentCount).toBe(0);

    const second = session.extend(
      numericDelta([sampleCursor(20, 20, 4), sampleCursor(30, 25, 8)], [sampleCursor(40, 30, 12)]),
      writes.writer,
    );

    expect(writes.stable.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 25 },
    ]);
    expect(writes.mutable.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 30, y: 25 },
      { x: 40, y: 30 },
    ]);
    expect(second).toMatchObject({
      mutableTailSampleCount: 1,
      stableSegmentCount: 2,
      strokeId: 'numeric-active',
    });
  });
});

function numericDelta(
  stable: readonly InkSampleCursor[],
  mutable: readonly InkSampleCursor[],
): InkBorrowedControlTraceDelta {
  return {
    kind: 'borrowed-numeric',
    mutableTail: sampleView(mutable),
    stablePrefixDelta: sampleView(stable),
  };
}

function sampleView(samples: readonly InkSampleCursor[]): InkSampleView {
  const reused = sampleCursor(0, 0, 0);
  return {
    length: samples.length,
    forEachSample(consumer) {
      for (const sample of samples) {
        Object.assign(reused, sample);
        consumer(reused);
        reused.x = Number.NaN;
        reused.y = Number.NaN;
      }
    },
  };
}

function sampleCursor(x: number, y: number, time: number): InkSampleCursor {
  return {
    altitude: Math.PI / 3,
    azimuth: Math.PI / 4,
    flags:
      INK_SAMPLE_FLAGS.pressureMeasured |
      INK_SAMPLE_FLAGS.altitudeMeasured |
      INK_SAMPLE_FLAGS.azimuthMeasured,
    pressure: 0.5,
    time,
    x,
    y,
  };
}

function numericWriter(): {
  readonly mutable: InkSampleCursor[];
  readonly stable: InkSampleCursor[];
  readonly writer: InkActivePresentationWriter;
} {
  const stable: InkSampleCursor[] = [];
  const mutable: InkSampleCursor[] = [];
  const copy = (sample: InkSampleCursor): InkSampleCursor => ({ ...sample });
  return {
    mutable,
    stable,
    writer: {
      appendMutable: (sample) => mutable.push(copy(sample)),
      appendStable: (sample) => stable.push(copy(sample)),
      resetMutable: () => mutable.splice(0),
    },
  };
}

function stroke(id: string, tool: InkStroke['tool'], color: string, width: number): InkStroke {
  return {
    color,
    id,
    points: [point(10, 10, 0), point(40, 30, 16)],
    tool,
    width,
  };
}

function point(x: number, y: number, time: number) {
  return { pressure: time === 0 ? 0.2 : 0.8, time, x, y };
}

function project(
  points: readonly { readonly x: number; readonly y: number }[],
  scale: number,
  dpr: number,
) {
  return points.map(({ x, y }) => ({ x: x * scale * dpr, y: y * scale * dpr }));
}
