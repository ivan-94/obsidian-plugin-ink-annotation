import { describe, expect, it, vi } from 'vitest';

import {
  probeActiveInkWorkerCapabilities,
  probeInkRuntimeCapabilities,
} from './ink-runtime-capabilities';

describe('probeInkRuntimeCapabilities', () => {
  it('reports absent runtime APIs with privacy-safe enumerable outcomes', () => {
    expect(probeInkRuntimeCapabilities({})).toEqual({
      crossOriginIsolated: unavailable('api-unavailable'),
      dedicatedWorkerConstruct: unavailable('api-unavailable'),
      dedicatedWorkerModule: unavailable('api-unavailable'),
      navigatorGpu: unavailable('api-unavailable'),
      offscreenCanvas2d: unavailable('api-unavailable'),
      offscreenCanvasTransfer: unavailable('api-unavailable'),
      offscreenWebgl2: unavailable('api-unavailable'),
      pointerPredictedEvents: unavailable('api-unavailable'),
      sharedArrayBuffer: unavailable('api-unavailable'),
      wasm: unavailable('api-unavailable'),
      wasmSimd: unavailable('api-unavailable'),
      workerAnimationFrame: unavailable('api-unavailable'),
    });
  });

  it('reports getPredictedEvents presence without invoking the PointerEvent API', () => {
    const getPredictedEvents = vi.fn();
    class PointerEventFixture {}
    Object.assign(PointerEventFixture.prototype, { getPredictedEvents });

    const report = probeInkRuntimeCapabilities({ PointerEvent: PointerEventFixture });

    expect(report.pointerPredictedEvents).toEqual(available());
    expect(getPredictedEvents).not.toHaveBeenCalled();
  });

  it('actively confirms module evaluation and an actual Worker rAF callback, then cleans up', async () => {
    const workers: FakeActiveWorker[] = [];
    class WorkerFixture extends FakeActiveWorker {
      constructor(url: unknown, options: unknown) {
        super(url, options);
        workers.push(this);
      }
    }
    class BlobFixture {}
    const timeoutHandle = Object.freeze({ kind: 'timeout' });
    const schedule = vi.fn().mockReturnValue(timeoutHandle);
    const cancel = vi.fn();
    const revokeObjectURL = vi.fn();

    const pending = probeActiveInkWorkerCapabilities({
      host: {
        Blob: BlobFixture,
        URL: { createObjectURL: () => 'blob:private-probe-url', revokeObjectURL },
        Worker: WorkerFixture,
      },
      scheduler: { cancel, schedule },
      timeoutMs: 250,
    });
    const worker = workers[0];
    if (worker === undefined) throw new Error('Expected active Worker construction.');
    worker.emitMessage('inkstone:module-ready');
    worker.emitMessage('inkstone:worker-raf-ready');

    await expect(pending).resolves.toEqual({
      dedicatedWorkerConstruct: available(),
      dedicatedWorkerModule: available(),
      workerAnimationFrame: available(),
    });
    expect(worker.options).toEqual({ type: 'module' });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 250);
    expect(cancel).toHaveBeenCalledWith(timeoutHandle);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private-probe-url');
    expect(JSON.stringify(await pending)).not.toContain('blob:');
  });

  it('keeps a completed module handshake while a missing Worker rAF times out', async () => {
    const fixture = activeWorkerFixture();
    const pending = probeActiveInkWorkerCapabilities({
      host: fixture.host,
      scheduler: fixture.scheduler,
      timeoutMs: 400,
    });
    const worker = fixture.worker();
    worker.emitMessage('inkstone:module-ready');
    fixture.fireTimeout();

    await expect(pending).resolves.toEqual({
      dedicatedWorkerConstruct: available(),
      dedicatedWorkerModule: available(),
      workerAnimationFrame: unavailable('probe-timeout'),
    });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('bounds an absent module handshake and reports timeout without guessing CSP', async () => {
    const fixture = activeWorkerFixture();
    const pending = probeActiveInkWorkerCapabilities({
      host: fixture.host,
      scheduler: fixture.scheduler,
      timeoutMs: 60_000,
    });
    const worker = fixture.worker();
    fixture.fireTimeout();

    await expect(pending).resolves.toEqual({
      dedicatedWorkerConstruct: available(),
      dedicatedWorkerModule: unavailable('probe-timeout'),
      workerAnimationFrame: unavailable('probe-timeout'),
    });
    expect(fixture.scheduler.schedule).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('reports a missing Worker rAF API only after module evaluation succeeds', async () => {
    const fixture = activeWorkerFixture();
    const pending = probeActiveInkWorkerCapabilities({
      host: fixture.host,
      scheduler: fixture.scheduler,
    });
    const worker = fixture.worker();
    worker.emitMessage('inkstone:module-ready');
    worker.emitMessage('inkstone:worker-raf-unavailable');

    await expect(pending).resolves.toEqual({
      dedicatedWorkerConstruct: available(),
      dedicatedWorkerModule: available(),
      workerAnimationFrame: unavailable('api-unavailable'),
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('reduces Blob module load errors to a version-free category and suppresses details', async () => {
    const fixture = activeWorkerFixture();
    const preventDefault = vi.fn();
    const pending = probeActiveInkWorkerCapabilities({
      host: fixture.host,
      scheduler: fixture.scheduler,
    });
    const worker = fixture.worker();
    worker.emitError({
      message: 'private CSP policy and device version',
      filename: 'blob:private-probe-url',
      preventDefault,
    });
    const result = await pending;

    expect(result).toEqual({
      dedicatedWorkerConstruct: available(),
      dedicatedWorkerModule: unavailable('module-load-failed'),
      workerAnimationFrame: unavailable('module-load-failed'),
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/private|blob:|device|version|CSP/u);
  });

  it('distinguishes unavailable Blob module setup from Worker construction failure', async () => {
    class WorkerFixture {
      terminate() {}
    }
    class ThrowingBlob {
      constructor() {
        throw new Error('private Blob policy detail');
      }
    }
    const result = await probeActiveInkWorkerCapabilities({
      host: {
        Blob: ThrowingBlob,
        URL: { createObjectURL: () => 'blob:private', revokeObjectURL: vi.fn() },
        Worker: WorkerFixture,
      },
    });

    expect(result).toEqual({
      dedicatedWorkerConstruct: unavailable('needs-active-probe'),
      dedicatedWorkerModule: unavailable('blob-module-unavailable'),
      workerAnimationFrame: unavailable('blob-module-unavailable'),
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('revokes the Blob URL when active Worker construction fails', async () => {
    class BlobFixture {}
    class ThrowingWorker {
      constructor() {
        throw new Error('private Worker construction detail');
      }
    }
    const revokeObjectURL = vi.fn();

    const result = await probeActiveInkWorkerCapabilities({
      host: {
        Blob: BlobFixture,
        URL: { createObjectURL: () => 'blob:private', revokeObjectURL },
        Worker: ThrowingWorker,
      },
    });

    expect(result).toEqual({
      dedicatedWorkerConstruct: unavailable('construct-failed'),
      dedicatedWorkerModule: unavailable('construct-failed'),
      workerAnimationFrame: unavailable('construct-failed'),
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:private');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('fails closed but still revokes the URL when Worker termination fails', async () => {
    const fixture = activeWorkerFixture();
    const pending = probeActiveInkWorkerCapabilities({
      host: fixture.host,
      scheduler: fixture.scheduler,
    });
    const worker = fixture.worker();
    worker.terminate.mockImplementation(() => {
      throw new Error('private termination detail');
    });
    worker.emitMessage('inkstone:module-ready');
    worker.emitMessage('inkstone:worker-raf-ready');
    const result = await pending;

    expect(result).toEqual({
      dedicatedWorkerConstruct: unavailable('probe-failed'),
      dedicatedWorkerModule: unavailable('probe-failed'),
      workerAnimationFrame: unavailable('probe-failed'),
    });
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('reports isolation, SharedArrayBuffer, and navigator.gpu without invoking either API', () => {
    class FakeSharedArrayBuffer {}
    const gpu = Object.freeze({});

    const report = probeInkRuntimeCapabilities({
      SharedArrayBuffer: FakeSharedArrayBuffer,
      crossOriginIsolated: true,
      navigator: { gpu },
    });

    expect(report.crossOriginIsolated).toEqual(available());
    expect(report.sharedArrayBuffer).toEqual(available());
    expect(report.navigatorGpu).toEqual(available());
    expect(Object.values(report)).not.toContain(gpu);

    expect(probeInkRuntimeCapabilities({ crossOriginIsolated: false }).crossOriginIsolated).toEqual(
      unavailable('not-isolated'),
    );
  });

  it('validates core WebAssembly and SIMD with bounded modules without compiling them', () => {
    const validate = vi.fn().mockReturnValue(true);
    const report = probeInkRuntimeCapabilities({ WebAssembly: { validate } });

    expect(report.wasm).toEqual(available());
    expect(report.wasmSimd).toEqual(available());
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  it('uses valid core WebAssembly and SIMD feature modules', () => {
    const report = probeInkRuntimeCapabilities({ WebAssembly });

    expect(report.wasm).toEqual(available());
    expect(report.wasmSimd).toEqual(available());
  });

  it('does not infer SIMD support from core WebAssembly or expose validation errors', () => {
    const withoutSimd = probeInkRuntimeCapabilities({
      WebAssembly: { validate: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) },
    });
    const throwing = probeInkRuntimeCapabilities({
      WebAssembly: {
        validate: () => {
          throw new Error('device and version detail must stay private');
        },
      },
    });

    expect(withoutSimd.wasm).toEqual(available());
    expect(withoutSimd.wasmSimd).toEqual(unavailable('validation-failed'));
    expect(throwing.wasm).toEqual(unavailable('probe-failed'));
    expect(throwing.wasmSimd).toEqual(unavailable('probe-failed'));
    expect(JSON.stringify(throwing)).not.toContain('device');
  });

  it('probes disposable OffscreenCanvas 2D and WebGL2 contexts and releases WebGL2', () => {
    const loseContext = vi.fn();
    const getExtension = vi.fn().mockReturnValue({ loseContext });
    const contexts = {
      '2d': Object.freeze({}),
      webgl2: { getExtension },
    };
    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext(kind: keyof typeof contexts) {
        return contexts[kind];
      }
    }

    const report = probeInkRuntimeCapabilities({ OffscreenCanvas: FakeOffscreenCanvas });

    expect(report.offscreenCanvas2d).toEqual(available());
    expect(report.offscreenWebgl2).toEqual(available());
    expect(getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it('confirms a disposable DOM canvas can transfer to an OffscreenCanvas 2D context', () => {
    const getContext = vi.fn().mockReturnValue(Object.freeze({}));
    const transferControlToOffscreen = vi.fn().mockReturnValue({ getContext });
    const createElement = vi.fn().mockReturnValue({ transferControlToOffscreen });

    const report = probeInkRuntimeCapabilities({ document: { createElement } });

    expect(report.offscreenCanvasTransfer).toEqual(available());
    expect(createElement).toHaveBeenCalledWith('canvas');
    expect(transferControlToOffscreen).toHaveBeenCalledOnce();
    expect(getContext).toHaveBeenCalledWith('2d');
  });

  it('constructs and immediately terminates one privacy-safe disposable Worker', () => {
    const terminate = vi.fn();
    const constructedUrls: unknown[] = [];
    class FakeBlob {}
    class FakeWorker {
      constructor(url: unknown) {
        constructedUrls.push(url);
      }

      terminate() {
        terminate();
      }
    }
    const createObjectURL = vi.fn().mockReturnValue('blob:disposable-probe');
    const revokeObjectURL = vi.fn();

    const report = probeInkRuntimeCapabilities({
      Blob: FakeBlob,
      URL: { createObjectURL, revokeObjectURL },
      Worker: FakeWorker,
    });

    expect(report.dedicatedWorkerConstruct).toEqual(available());
    expect(report.dedicatedWorkerModule).toEqual(unavailable('needs-active-probe'));
    expect(report.workerAnimationFrame).toEqual(unavailable('needs-active-probe'));
    expect(constructedUrls).toEqual(['blob:disposable-probe']);
    expect(terminate).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:disposable-probe');
    expect(JSON.stringify(report)).not.toContain('blob:');
  });

  it('requires an active probe when a Worker exists but cannot be safely constructed in place', () => {
    class FakeWorker {
      terminate() {}
    }

    const report = probeInkRuntimeCapabilities({ Worker: FakeWorker });

    expect(report.dedicatedWorkerConstruct).toEqual(unavailable('needs-active-probe'));
    expect(report.dedicatedWorkerModule).toEqual(unavailable('needs-active-probe'));
    expect(report.workerAnimationFrame).toEqual(unavailable('needs-active-probe'));
  });

  it('converts host getter exceptions into version-free failure categories', () => {
    const navigator = Object.create(null, {
      gpu: {
        get: () => {
          throw new Error('private host and device detail');
        },
      },
    }) as unknown;

    const report = probeInkRuntimeCapabilities({ navigator });

    expect(report.navigatorGpu).toEqual(unavailable('probe-failed'));
    expect(report.wasm).toEqual(unavailable('api-unavailable'));
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('isolates a failing platform getter from unrelated capability probes', () => {
    const host = Object.create(null, {
      OffscreenCanvas: {
        get: () => {
          throw new Error('private GPU process detail');
        },
      },
      WebAssembly: { value: { validate: vi.fn().mockReturnValue(true) } },
    }) as unknown;

    const report = probeInkRuntimeCapabilities(host);

    expect(report.offscreenCanvas2d).toEqual(unavailable('probe-failed'));
    expect(report.offscreenWebgl2).toEqual(unavailable('probe-failed'));
    expect(report.wasm).toEqual(available());
    expect(report.wasmSimd).toEqual(available());
  });

  it('classifies OffscreenCanvas construction, context, and transfer failures without error text', () => {
    class ThrowingOffscreenCanvas {
      constructor() {
        throw new Error('private constructor detail');
      }
    }
    class ContextlessOffscreenCanvas {
      getContext() {
        return null;
      }
    }
    const transferControlToOffscreen = () => {
      throw new Error('private transfer detail');
    };

    const construction = probeInkRuntimeCapabilities({
      OffscreenCanvas: ThrowingOffscreenCanvas,
    });
    const context = probeInkRuntimeCapabilities({
      OffscreenCanvas: ContextlessOffscreenCanvas,
    });
    const transfer = probeInkRuntimeCapabilities({
      document: { createElement: () => ({ transferControlToOffscreen }) },
    });

    expect(construction.offscreenCanvas2d).toEqual(unavailable('construct-failed'));
    expect(construction.offscreenWebgl2).toEqual(unavailable('construct-failed'));
    expect(context.offscreenCanvas2d).toEqual(unavailable('context-unavailable'));
    expect(context.offscreenWebgl2).toEqual(unavailable('context-unavailable'));
    expect(transfer.offscreenCanvasTransfer).toEqual(unavailable('transfer-failed'));
    expect(JSON.stringify({ construction, context, transfer })).not.toContain('private');
  });

  it('revokes the disposable Worker URL when construction fails', () => {
    class FakeBlob {}
    class ThrowingWorker {
      constructor() {
        throw new Error('private worker detail');
      }

      terminate() {}
    }
    const revokeObjectURL = vi.fn();

    const report = probeInkRuntimeCapabilities({
      Blob: FakeBlob,
      URL: {
        createObjectURL: () => 'blob:disposable-probe',
        revokeObjectURL,
      },
      Worker: ThrowingWorker,
    });

    expect(report.dedicatedWorkerConstruct).toEqual(unavailable('construct-failed'));
    expect(report.dedicatedWorkerModule).toEqual(unavailable('needs-active-probe'));
    expect(report.workerAnimationFrame).toEqual(unavailable('needs-active-probe'));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:disposable-probe');
    expect(JSON.stringify(report)).not.toContain('private');
  });
});

class FakeActiveWorker {
  onerror: ((event: unknown) => unknown) | null = null;
  onmessage: ((event: { readonly data: unknown }) => unknown) | null = null;
  readonly terminate = vi.fn();

  constructor(
    readonly url: unknown,
    readonly options: unknown,
  ) {}

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitError(event: unknown): void {
    this.onerror?.(event);
  }
}

function activeWorkerFixture() {
  const workers: FakeActiveWorker[] = [];
  class WorkerFixture extends FakeActiveWorker {
    constructor(url: unknown, options: unknown) {
      super(url, options);
      workers.push(this);
    }
  }
  class BlobFixture {}
  let timeout: (() => void) | null = null;
  const cancel = vi.fn();
  const revokeObjectURL = vi.fn();
  const scheduler = {
    cancel,
    schedule: vi.fn((callback: () => void) => {
      timeout = callback;
      return Object.freeze({ kind: 'timeout' });
    }),
  };
  return {
    cancel,
    fireTimeout: () => {
      if (timeout === null) throw new Error('Expected a scheduled timeout.');
      timeout();
    },
    host: {
      Blob: BlobFixture,
      URL: { createObjectURL: () => 'blob:private-probe-url', revokeObjectURL },
      Worker: WorkerFixture,
    },
    revokeObjectURL,
    scheduler,
    worker: () => {
      const worker = workers[0];
      if (worker === undefined) throw new Error('Expected active Worker construction.');
      return worker;
    },
  };
}

function available() {
  return { available: true, failureCategory: 'none' };
}

function unavailable(failureCategory: string) {
  return { available: false, failureCategory };
}
