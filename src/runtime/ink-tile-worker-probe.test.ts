import { describe, expect, it, vi } from 'vitest';

import { probeInkTileWorkerProductionArtifact } from './ink-tile-worker-probe';

const ARTIFACT = Object.freeze({ digest: 'a'.repeat(64), source: '/* exact tile worker */' });

describe('probeInkTileWorkerProductionArtifact', () => {
  it('uses the exact embedded artifact and proves transfer, presentation, both brushes, and cleanup', async () => {
    const fixture = workerProbeFixture();
    const pending = probeInkTileWorkerProductionArtifact({
      artifact: ARTIFACT,
      document: fixture.document,
      host: fixture.host,
      scheduler: fixture.scheduler,
      timeoutMs: 300,
    });
    const worker = fixture.worker();
    const request = worker.postMessage.mock.calls[0]?.[0] as
      | { readonly protocolVersion?: string; readonly requestId?: string; readonly type?: string }
      | undefined;
    expect(request).toMatchObject({ protocolVersion: 'ink-tile-worker-v1', type: 'probe' });
    const close = vi.fn();

    worker.emitMessage({
      bitmap: { close },
      height: 32,
      protocolVersion: 'ink-tile-worker-v1',
      requestId: request?.requestId,
      type: 'probe-result',
      width: 64,
    });

    await expect(pending).resolves.toEqual({
      artifactDigest: ARTIFACT.digest,
      capabilities: {
        highlighterRaster: true,
        imageBitmapTransfer: true,
        offscreenCanvas2d: true,
        penRaster: true,
        presenterAdoption: true,
      },
      kind: 'ready',
    });
    expect(fixture.BlobFixture).toHaveBeenCalledWith([ARTIFACT.source], {
      type: 'text/javascript',
    });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(fixture.context.drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce();
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it('fails closed on a protocol mismatch and closes a transferred bitmap', async () => {
    const fixture = workerProbeFixture();
    const pending = probeInkTileWorkerProductionArtifact({
      artifact: ARTIFACT,
      document: fixture.document,
      host: fixture.host,
      scheduler: fixture.scheduler,
    });
    const worker = fixture.worker();
    const close = vi.fn();
    worker.emitMessage({
      bitmap: { close },
      height: 32,
      protocolVersion: 'wrong-protocol',
      requestId: 'wrong-request',
      type: 'probe-result',
      width: 64,
    });

    await expect(pending).resolves.toEqual({
      artifactDigest: ARTIFACT.digest,
      failure: 'protocol-mismatch',
      kind: 'unavailable',
    });
    expect(close).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('bounds a silent production Worker and reports only a privacy-safe timeout category', async () => {
    const fixture = workerProbeFixture();
    const pending = probeInkTileWorkerProductionArtifact({
      artifact: ARTIFACT,
      document: fixture.document,
      host: fixture.host,
      scheduler: fixture.scheduler,
      timeoutMs: 60_000,
    });
    fixture.fireTimeout();
    const result = await pending;

    expect(result).toEqual({
      artifactDigest: ARTIFACT.digest,
      failure: 'probe-timeout',
      kind: 'unavailable',
    });
    expect(fixture.schedule).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(fixture.worker().terminate).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/blob:|private|device|version/iu);
  });
});

function workerProbeFixture() {
  const workers: FakeTileWorker[] = [];
  class WorkerFixture extends FakeTileWorker {
    constructor() {
      super();
      workers.push(this);
    }
  }
  const BlobFixture = vi.fn();
  const createObjectURL = vi.fn().mockReturnValue('blob:private-worker-url');
  const revokeObjectURL = vi.fn();
  const cancel = vi.fn();
  const schedule = vi.fn().mockReturnValue(Object.freeze({ kind: 'timer' }));
  const alpha = new Uint8ClampedArray(64 * 32 * 4);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      if ((x >= 4 && x <= 28 && y >= 5 && y <= 13) || (x >= 36 && x <= 60 && y >= 18 && y <= 26)) {
        alpha[(y * 64 + x) * 4 + 3] = x < 32 ? 255 : 96;
      }
    }
  }
  const context = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: alpha })),
  };
  const canvas = { getContext: vi.fn(() => context), height: 0, width: 0 };
  return {
    BlobFixture,
    cancel,
    context,
    document: { createElement: vi.fn(() => canvas) } as unknown as Document,
    fireTimeout: () => {
      const callback = schedule.mock.calls[0]?.[0] as (() => void) | undefined;
      if (callback === undefined) throw new Error('Expected a scheduled timeout.');
      callback();
    },
    host: {
      Blob: BlobFixture,
      URL: { createObjectURL, revokeObjectURL },
      Worker: WorkerFixture,
    },
    revokeObjectURL,
    schedule,
    scheduler: { cancel, schedule },
    worker: () => {
      const worker = workers[0];
      if (worker === undefined) throw new Error('Expected Tile Worker construction.');
      return worker;
    },
  };
}

class FakeTileWorker {
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}
