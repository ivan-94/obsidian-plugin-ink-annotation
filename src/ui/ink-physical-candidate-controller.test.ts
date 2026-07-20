import { describe, expect, it } from 'vitest';

import { InkLiveDocument } from '../application/ink-document-session';
import {
  INK_SAMPLE_FLAGS,
  type InkContactBatch,
  type InkSampleSequence,
} from '../domain/ink-contact';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { InkUnpublishedPhysicalInkCandidate } from './ink-physical-candidate-controller';

describe('unpublished physical Ink candidate controller', () => {
  it('seals the confirmed physical prefix when a forced Stage Frame change ends contact', async () => {
    const session = liveSession([]);
    const candidate = new InkUnpublishedPhysicalInkCandidate({
      createId: () => 'forced-frame-seal',
      session,
    });
    await candidate.enter();
    candidate.accept(batch('down', 'pen', [sample(10, 20, 1, 0.25)]));
    candidate.accept(batch('move', 'pen', [sample(18, 21, 8, 0.85)]));

    const completed = candidate.sealActive();

    expect(completed).toMatchObject({
      geometryUpdate: { kind: 'active-finish' },
      kind: 'completed',
      stroke: { id: 'forced-frame-seal' },
    });
    if (completed.kind !== 'completed') throw new Error('expected a sealed physical candidate');
    expect(completed.stroke.points.at(-1)).toMatchObject({ time: 8, x: 18, y: 21 });
  });

  it('seals Pen Active geometry and commits one live-first Add without Recovery or full geometry', async () => {
    const persisted: InkSurfaceRecord[] = [];
    const session = liveSession(persisted);
    const candidate = new InkUnpublishedPhysicalInkCandidate({
      createId: () => 'physical-pen',
      session,
    });

    await candidate.enter();
    expect(candidate.read()).toMatchObject({ kind: 'ready', publication: 'unpublished' });
    expect(candidate.accept(batch('down', 'pen', [sample(10, 20, 1, 0.25)]))).toMatchObject({
      kind: 'active',
      presentation: 'physical',
    });
    candidate.accept(batch('move', 'pen', [sample(18, 21, 8, 0.85)]));
    const completed = candidate.accept(batch('up', 'pen', [sample(23, 22, 12, 0)]));

    expect(completed).toMatchObject({
      geometryUpdate: {
        kind: 'active-finish',
        ownershipTransfer: 'active-to-committed-without-blank-frame',
      },
      kind: 'completed',
      presentation: 'physical',
      stroke: {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'physical-pen',
        tool: 'pen',
      },
    });
    expect(completed).not.toHaveProperty('geometry');
    expect(completed).not.toHaveProperty('activeCoverageDigest');
    expect(completed).not.toHaveProperty('committedCoverageDigest');

    expect(candidate.commitCompleted()).toMatchObject({ kind: 'committed' });
    expect(session.read().strokes.find(({ id }) => id === 'physical-pen')?.stroke).toEqual(
      completed.kind === 'completed' ? completed.stroke : undefined,
    );

    await session.background();
    expect(persisted.at(-1)).toMatchObject({
      schemaVersion: 3,
      strokes: [{ brushRenderVersion: 'pen-physical-v1', id: 'physical-pen' }],
    });
  });

  it('uses the same live-first completion contract for Highlighter', async () => {
    const session = liveSession([]);
    const candidate = new InkUnpublishedPhysicalInkCandidate({
      createId: () => 'physical-highlighter',
      session,
    });
    await candidate.enter();

    candidate.accept(batch('down', 'highlighter', [sample(10, 20, 1, 0.4)], '#ffcc00'));
    const completed = candidate.accept(
      batch('up', 'highlighter', [sample(30, 24, 10, 0)], '#ffcc00'),
    );

    expect(completed).toMatchObject({
      alpha: 0.35,
      geometryUpdate: { kind: 'active-finish' },
      kind: 'completed',
      stroke: {
        brushRenderVersion: 'highlighter-chisel-v1',
        color: '#ffcc00',
        tool: 'highlighter',
      },
    });
    expect(candidate.commitCompleted()).toMatchObject({ kind: 'committed' });
  });

  it('keeps a known geometry failure presentation-local and does not revive retained Retry', async () => {
    const session = liveSession([]);
    const candidate = new InkUnpublishedPhysicalInkCandidate({
      createId: () => 'degraded-pen',
      session,
    });
    await candidate.enter();

    candidate.accept(batch('down', 'pen', [sample(10, 20, 1, 0.4)]));
    expect(candidate.accept(batch('move', 'pen', [sample(1e15, 22, 5, 0.6)]))).toMatchObject({
      diagnostic: 'known-version-geometry-failure',
      kind: 'active',
      presentation: 'degraded-legacy',
    });
    const completed = candidate.accept(batch('up', 'pen', [sample(1e15, 24, 9, 0)]));
    expect(completed).toMatchObject({
      diagnostic: 'known-version-geometry-failure',
      kind: 'completed',
      presentation: 'degraded-legacy',
    });

    expect(candidate.commitCompleted()).toMatchObject({ kind: 'committed' });
    expect(candidate.read()).toMatchObject({ kind: 'ready' });
    expect(candidate.accept(batch('down', 'pen', [sample(40, 40, 20, 0.5)]))).toMatchObject({
      kind: 'active',
    });
  });

  it('fails closed for a non-opaque physical color', async () => {
    const candidate = new InkUnpublishedPhysicalInkCandidate({
      createId: () => 'invalid-color',
      session: liveSession([]),
    });
    await candidate.enter();

    expect(
      candidate.accept(batch('down', 'highlighter', [sample(10, 20, 1, 0.4)], '#11223388')),
    ).toMatchObject({ kind: 'failed', strokeId: 'invalid-color' });
    expect(candidate.read()).toMatchObject({ kind: 'failed' });
  });

  it('cancels one contact and returns to a non-blocking ready state', async () => {
    const candidate = new InkUnpublishedPhysicalInkCandidate({
      createId: () => 'cancelled-pen',
      session: liveSession([]),
    });
    await candidate.enter();
    candidate.accept(batch('down', 'pen', [sample(10, 20, 1, 0.4)]));

    expect(candidate.accept(batch('cancel', 'pen', []))).toEqual({
      kind: 'cancelled',
      strokeId: 'cancelled-pen',
    });
    expect(candidate.read()).toMatchObject({ kind: 'ready' });
    await candidate.discardUnused();
    expect(candidate.read()).toEqual({ kind: 'idle', publication: 'unpublished' });
  });
});

function liveSession(persisted: InkSurfaceRecord[]): InkLiveDocument {
  return new InkLiveDocument({
    debounceMs: 60_000,
    surfaces: [surface()],
    writer: {
      updateSurface: (record) => {
        persisted.push(structuredClone(record));
        return Promise.resolve(record);
      },
    },
  });
}

function batch(
  phase: InkContactBatch['phase'],
  tool: 'highlighter' | 'pen',
  samples: readonly ReturnType<typeof sample>[],
  color = '#112233',
): InkContactBatch {
  const sequence: InkSampleSequence = {
    copiedNativeSampleCount: 0,
    forEachSample(consumer): void {
      for (const current of samples) consumer({ ...current });
    },
    length: samples.length,
    materializedSampleCount: 0,
    materialize: () => [],
  };
  return {
    adapter: 'pointer',
    capabilities: { orientation: 'unavailable', pressure: 'measured' },
    contactId: 'pointer:7',
    frameEpoch: 1,
    logicalBounds: { height: 100, width: 704, x: 0, y: 0 },
    phase,
    sampleCount: samples.length,
    sampleSequence: sequence,
    samples: [],
    style: { color, tool, width: tool === 'highlighter' ? 10 : 4 },
  };
}

function sample(x: number, y: number, time: number, pressure: number) {
  return {
    altitude: 0,
    azimuth: 0,
    flags: INK_SAMPLE_FLAGS.pressureMeasured,
    pressure,
    time,
    x,
    y,
  };
}

function surface(): InkSurfaceRecord {
  return {
    createdAt: '2026-07-19T00:00:00.000Z',
    filePath: 'Notes/physical-candidate.md',
    id: 'surface-a',
    layout: {
      blockFingerprints: ['block'],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 100,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-r1',
      themeMode: 'light',
    },
    noteId: 'note-physical-candidate',
    revision: 1,
    schemaVersion: 3,
    status: 'active',
    strokes: [],
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}
