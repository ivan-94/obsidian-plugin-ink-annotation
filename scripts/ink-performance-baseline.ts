import { InkDocumentSession } from '../src/application/ink-document-session';
import type { InkStroke, InkSurfaceRecord } from '../src/domain/ink-surface';

export interface InkPerformanceBaselineOptions {
  readonly sampleCount?: number;
  readonly warmupCount?: number;
}

export interface InkPerformanceBaselineResult {
  readonly conditions: readonly {
    readonly compositeStrokeCount: number;
    readonly durationMs: {
      readonly maximum: number;
      readonly p50: number;
      readonly p95: number;
      readonly p99: number;
      readonly sampleCount: number;
    };
    readonly name: 'empty' | 'history-1k' | 'history-10k-30-surfaces';
    readonly pointCount: number;
    readonly strokeCount: number;
    readonly surfaceCount: number;
  }[];
  readonly forbiddenWork: readonly {
    readonly countPerMeasuredSnapshot: 1;
    readonly kind: 'cold-snapshot' | 'historical-copy' | 'historical-scan' | 'historical-sort';
    readonly phase: 'input';
  }[];
  readonly sampleCount: number;
  readonly warmupCount: number;
}

const CONDITIONS = [
  { name: 'empty', strokeCount: 0, surfaceCount: 1 },
  { name: 'history-1k', strokeCount: 1_000, surfaceCount: 3 },
  { name: 'history-10k-30-surfaces', strokeCount: 10_000, surfaceCount: 30 },
] as const;

/** Replays the current document snapshot hot path through the production session implementation. */
export function runInkPerformanceBaseline(
  options: InkPerformanceBaselineOptions = {},
): InkPerformanceBaselineResult {
  const sampleCount = positiveInteger(options.sampleCount ?? 100, 'sampleCount');
  const warmupCount = nonNegativeInteger(options.warmupCount ?? 25, 'warmupCount');
  const conditions = CONDITIONS.map((condition) => {
    const session = new InkDocumentSession({
      surfaces: createSurfaces(condition.surfaceCount, condition.strokeCount),
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: () => Promise.resolve(),
      },
    });
    for (let index = 0; index < warmupCount; index += 1) session.snapshot();
    const durations: number[] = [];
    let compositeStrokeCount = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const startedAt = performance.now();
      const snapshot = session.snapshot();
      durations.push(performance.now() - startedAt);
      compositeStrokeCount = snapshot.surface.strokes.length;
    }
    if (compositeStrokeCount !== condition.strokeCount) {
      throw new Error(
        `${condition.name} composed ${compositeStrokeCount} strokes; expected ${condition.strokeCount}.`,
      );
    }
    const sorted = durations.sort((left, right) => left - right);
    return {
      compositeStrokeCount,
      durationMs: {
        maximum: round(sorted.at(-1) ?? 0),
        p50: round(percentile(sorted, 0.5)),
        p95: round(percentile(sorted, 0.95)),
        p99: round(percentile(sorted, 0.99)),
        sampleCount,
      },
      name: condition.name,
      pointCount: condition.strokeCount * 2,
      strokeCount: condition.strokeCount,
      surfaceCount: condition.surfaceCount,
    };
  });

  return {
    conditions,
    forbiddenWork: [
      { countPerMeasuredSnapshot: 1, kind: 'cold-snapshot', phase: 'input' },
      { countPerMeasuredSnapshot: 1, kind: 'historical-scan', phase: 'input' },
      { countPerMeasuredSnapshot: 1, kind: 'historical-sort', phase: 'input' },
      { countPerMeasuredSnapshot: 1, kind: 'historical-copy', phase: 'input' },
    ],
    sampleCount,
    warmupCount,
  };
}

function createSurfaces(surfaceCount: number, strokeCount: number): readonly InkSurfaceRecord[] {
  let nextStroke = 0;
  return Array.from({ length: surfaceCount }, (_value, surfaceIndex): InkSurfaceRecord => {
    const count =
      Math.floor(strokeCount / surfaceCount) + (surfaceIndex < strokeCount % surfaceCount ? 1 : 0);
    const strokes = Array.from({ length: count }, (): InkStroke => {
      const index = nextStroke;
      nextStroke += 1;
      const x = 16 + (index % 80) * 8;
      const y = 16 + (index % 300) * 3;
      return {
        color: '#111111',
        id: `stroke-${index}`,
        points: [
          { pressure: 0.5, time: index * 2, x, y },
          { pressure: 0.5, time: index * 2 + 1, x: x + 2, y: y + 2 },
        ],
        tool: 'pen',
        width: 2,
      };
    });
    return {
      createdAt: '2026-07-17T00:00:00.000Z',
      filePath: 'Ink Performance Fixture.md',
      id: `surface-${surfaceIndex}`,
      layout: {
        blockFingerprints: [`block-${surfaceIndex}`],
        fontFamily: 'system-ui',
        fontSize: 16,
        lineHeight: 24,
        logicalHeight: 1_000,
        logicalWidth: 704,
        originY: surfaceIndex * 1_000,
        sourceRevision: 'fixture-source',
        themeMode: 'light',
      },
      noteId: 'fixture-note',
      revision: 1,
      schemaVersion: 2,
      status: 'active',
      strokes,
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
  });
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be non-negative.`);
  return value;
}

function percentile(sorted: readonly number[], value: number): number {
  return sorted[Math.ceil(value * sorted.length) - 1] ?? 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
