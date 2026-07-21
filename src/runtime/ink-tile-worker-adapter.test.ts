import { describe, expect, it, vi } from 'vitest';

import type { InkStroke } from '../domain/ink-surface';
import { createInkTileWorkerAdapter } from './ink-tile-worker-adapter';

const ARTIFACT = Object.freeze({ digest: 'b'.repeat(64), source: '/* tile worker */' });
const PROBE = Object.freeze({
  artifactDigest: ARTIFACT.digest,
  capabilities: Object.freeze({
    highlighterRaster: true as const,
    imageBitmapTransfer: true as const,
    offscreenCanvas2d: true as const,
    penRaster: true as const,
    presenterAdoption: true as const,
  }),
  kind: 'ready' as const,
});

describe('InkTileWorkerAdapter', () => {
  it('builds one exact-token tile and transfers bitmap ownership to the caller', async () => {
    const fixture = adapterFixture();
    const created = createInkTileWorkerAdapter({
      artifact: ARTIFACT,
      host: fixture.host,
      probe: PROBE,
      scheduler: fixture.scheduler,
    });
    expect(created.kind).toBe('ready');
    if (created.kind !== 'ready') throw new Error('Expected a ready Tile Worker Adapter.');
    const mirror = await synchronize(created.adapter, fixture.worker());

    const pending = created.adapter.build(buildRequest('job-1', mirror));
    const worker = fixture.worker();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 7,
        jobId: 'job-1',
        token: 'token-job-1',
        type: 'raster',
      }),
    );
    const rasterMessage = worker.postMessage.mock.calls.find(
      ([message]) => (message as { readonly type?: string }).type === 'raster',
    )?.[0] as Readonly<Record<string, unknown>> | undefined;
    expect(rasterMessage === undefined ? undefined : Object.hasOwn(rasterMessage, 'strokes')).toBe(
      false,
    );
    const close = vi.fn();
    worker.emitMessage({
      bitmap: { close },
      generation: 7,
      jobId: 'job-1',
      token: 'token-job-1',
      type: 'raster-result',
    });

    const result = await pending;
    expect(result).toMatchObject({ generation: 7, jobId: 'job-1', kind: 'built' });
    expect(close).not.toHaveBeenCalled();
    if (result.kind === 'built') result.bitmap.close();
    expect(close).toHaveBeenCalledOnce();
    created.adapter.dispose();
  });

  it('closes a stale result and returns fallback only after the Worker job is fenced', async () => {
    const fixture = adapterFixture();
    const created = createInkTileWorkerAdapter({
      artifact: ARTIFACT,
      host: fixture.host,
      probe: PROBE,
      scheduler: fixture.scheduler,
    });
    if (created.kind !== 'ready') throw new Error('Expected a ready Tile Worker Adapter.');
    const mirror = await synchronize(created.adapter, fixture.worker());
    const pending = created.adapter.build(buildRequest('stale', mirror));
    const close = vi.fn();
    fixture.worker().emitMessage({
      bitmap: { close },
      generation: 7,
      jobId: 'stale',
      token: 'wrong-token',
      type: 'raster-result',
    });

    await expect(pending).resolves.toEqual({ kind: 'fallback', reason: 'stale-result' });
    expect(close).toHaveBeenCalledOnce();
    expect(created.adapter.stats().runningJobCount).toBe(0);
    created.adapter.dispose();
  });

  it('acknowledges scoped pauses before admitting queued raster work', async () => {
    const fixture = adapterFixture();
    const created = createInkTileWorkerAdapter({
      artifact: ARTIFACT,
      host: fixture.host,
      probe: PROBE,
      scheduler: fixture.scheduler,
    });
    if (created.kind !== 'ready') throw new Error('Expected a ready Tile Worker Adapter.');
    const mirror = await synchronize(created.adapter, fixture.worker());
    const lease = created.adapter.acquirePause('contact:mount-a');
    const worker = fixture.worker();
    const pause = worker.postMessage.mock.calls.find(
      ([message]) => (message as { readonly type?: string }).type === 'pause',
    )?.[0] as { readonly leaseId?: string; readonly type?: string } | undefined;
    expect(pause?.type).toBe('pause');
    const pending = created.adapter.build(buildRequest('paused', mirror));
    expect(worker.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'paused', type: 'raster' }),
    );
    worker.emitMessage({ leaseId: pause?.leaseId, type: 'paused' });
    await lease.acknowledged;
    lease.release();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'paused', type: 'raster' }),
    );
    created.adapter.cancel('paused');
    worker.emitMessage({ jobId: 'paused', type: 'cancelled' });
    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    created.adapter.dispose();
  });

  it('circuit-breaks once on Worker fault and never starts fallback concurrently', async () => {
    const fixture = adapterFixture();
    const created = createInkTileWorkerAdapter({
      artifact: ARTIFACT,
      host: fixture.host,
      probe: PROBE,
      scheduler: fixture.scheduler,
    });
    if (created.kind !== 'ready') throw new Error('Expected a ready Tile Worker Adapter.');
    const mirror = await synchronize(created.adapter, fixture.worker());
    const first = created.adapter.build(buildRequest('first', mirror));
    const second = created.adapter.build(buildRequest('second', mirror));
    fixture.worker().emitError();

    await expect(first).resolves.toEqual({ kind: 'fallback', reason: 'worker-fault' });
    await expect(second).resolves.toEqual({ kind: 'fallback', reason: 'worker-fault' });
    await expect(created.adapter.build(buildRequest('after-fault', mirror))).resolves.toEqual({
      kind: 'fallback',
      reason: 'worker-fault',
    });
    expect(fixture.worker().terminate).toHaveBeenCalledOnce();
    expect(fixture.workers).toHaveLength(1);
    created.adapter.dispose();
  });
});

function buildRequest(
  jobId: string,
  mirror: {
    readonly digest: string;
    readonly mirrorSequence: number;
    readonly projectionIdentity: string;
    readonly sessionId: string;
  },
) {
  return {
    backingHeight: 256,
    backingWidth: 256,
    byteSize: 4_096,
    density: 1,
    generation: 7,
    isCurrent: () => true,
    jobId,
    key: `key-${jobId}`,
    mountId: 'mount-a',
    originX: -256,
    originY: 512,
    priority: 'visible-preview' as const,
    projectionDigest: mirror.digest,
    projectionIdentity: mirror.projectionIdentity,
    projectionMirrorSequence: mirror.mirrorSequence,
    sessionId: mirror.sessionId,
    token: `token-${jobId}`,
  };
}

async function synchronize(
  adapter: {
    synchronize(input: {
      readonly byteSize: number;
      readonly mirrorSequence: number;
      readonly mountId: string;
      readonly projectionIdentity: string;
      readonly sessionId: string;
      readonly strokes: readonly InkStroke[];
    }): Promise<{
      readonly digest: string;
      readonly mirrorSequence: number;
      readonly projectionIdentity: string;
      readonly sessionId: string;
    } | null>;
  },
  worker: FakeRasterWorker,
) {
  const pending = adapter.synchronize({
    byteSize: 2_048,
    mirrorSequence: 1,
    mountId: 'mount-a',
    projectionIdentity: 'projection-a',
    sessionId: 'session-a',
    strokes: Object.freeze([probeStroke()]),
  });
  const commit = worker.postMessage.mock.calls.find(
    ([message]) => (message as { readonly type?: string }).type === 'mirror-commit',
  )?.[0] as
    | {
        readonly digest?: string;
        readonly mirrorSequence?: number;
        readonly projectionIdentity?: string;
        readonly sessionId?: string;
        readonly syncId?: string;
      }
    | undefined;
  expect(commit).toMatchObject({
    mirrorSequence: 1,
    projectionIdentity: 'projection-a',
    sessionId: 'session-a',
  });
  worker.emitMessage({
    digest: commit?.digest,
    mirrorSequence: commit?.mirrorSequence,
    projectionIdentity: commit?.projectionIdentity,
    sessionId: commit?.sessionId,
    syncId: commit?.syncId,
    type: 'mirror-ack',
  });
  const acknowledgement = await pending;
  if (acknowledgement === null) throw new Error('Expected a projection mirror acknowledgement.');
  return acknowledgement;
}

function probeStroke(): InkStroke {
  return Object.freeze({
    color: '#101010',
    id: 'stroke',
    points: Object.freeze([
      Object.freeze({ pressure: 0.5, time: 0, x: 0, y: 0 }),
      Object.freeze({ pressure: 0.5, time: 10, x: 20, y: 20 }),
    ]),
    tool: 'pen' as const,
    width: 4,
  });
}

function adapterFixture() {
  const workers: FakeRasterWorker[] = [];
  class WorkerFixture extends FakeRasterWorker {
    constructor() {
      super();
      workers.push(this);
    }
  }
  const cancel = vi.fn();
  const schedule = vi.fn().mockReturnValue(Object.freeze({ kind: 'timer' }));
  return {
    host: {
      Blob: class BlobFixture {},
      URL: { createObjectURL: () => 'blob:tile-worker', revokeObjectURL: vi.fn() },
      Worker: WorkerFixture,
    },
    scheduler: { cancel, schedule },
    worker: () => {
      const worker = workers[0];
      if (worker === undefined) throw new Error('Expected Tile Worker construction.');
      return worker;
    },
    workers,
  };
}

class FakeRasterWorker {
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  emitError(): void {
    this.onerror?.({ preventDefault: vi.fn() });
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}
