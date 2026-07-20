import { describe, expect, it } from 'vitest';

import { decideInkKernelRendererBakeoff } from './ink-kernel-renderer-bakeoff';

describe('decideInkKernelRendererBakeoff', () => {
  it('makes a frozen Worker WASM SIMD decision for an exact production-device geometry win', () => {
    const decision = decideInkKernelRendererBakeoff(validWasmEvidence());

    expect(decision).toEqual({
      decision: 'eligible-worker-wasm-simd',
      reason: 'material-worker-wasm-win',
      wasmBufferTransport: 'transferable-array-buffer-pool',
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('keeps JavaScript when WASM saves less than 1 ms and delivers less than 2x throughput', () => {
    const evidence = validWasmEvidence();
    const wasm = evidence.wasm as Record<string, unknown>;
    wasm.geometryP95Ms = 3.001;
    wasm.throughputRatio = 1.999;

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'not-adopted-js',
      reason: 'candidate-not-eligible',
    });
  });

  it('accepts a production-device 2x throughput win when candidate P95 is unavailable', () => {
    const evidence = validWasmEvidence();
    const wasm = evidence.wasm as Record<string, unknown>;
    Reflect.deleteProperty(wasm, 'geometryP95Ms');
    wasm.throughputRatio = 2;

    expect(decideInkKernelRendererBakeoff(evidence)).toMatchObject({
      decision: 'eligible-worker-wasm-simd',
    });
  });

  it('never promotes a candidate without production iPad evidence', () => {
    const evidence = validWasmEvidence();
    evidence.productionDevice = false;

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'not-adopted-js',
      reason: 'production-device-evidence-required',
    });
  });

  it('does not promote a microbenchmark-only WASM result on a production device', () => {
    const evidence = validWasmEvidence();
    const wasm = evidence.wasm as Record<string, unknown>;
    wasm.evidenceKind = 'microbenchmark';

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'not-adopted-js',
      reason: 'production-bakeoff-required',
    });
  });

  it('forbids a material main-thread WASM result', () => {
    const evidence = validWasmEvidence();
    const wasm = evidence.wasm as Record<string, unknown>;
    wasm.execution = 'main-thread';
    wasm.geometryP95Ms = 1;
    wasm.throughputRatio = 4;

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'not-adopted-js',
      reason: 'candidate-not-eligible',
    });
  });

  it('requires quantized parity and identical JS/WASM geometry digests', () => {
    const parityFailure = validWasmEvidence();
    (parityFailure.wasm as Record<string, unknown>).quantizedParity = false;
    const digestMismatch = validWasmEvidence();
    (digestMismatch.wasm as Record<string, unknown>).candidateDigest = 'different-geometry';

    for (const evidence of [parityFailure, digestMismatch]) {
      expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
        decision: 'not-adopted-js',
        reason: 'candidate-not-eligible',
      });
    }
  });

  it.each(['dedicatedWorker', 'wasm', 'wasmSimd'])(
    'requires the %s capability before selecting Worker WASM SIMD',
    (capability) => {
      const evidence = validWasmEvidence();
      const wasm = evidence.wasm as Record<string, unknown>;
      const capabilities = wasm.capabilities as Record<string, unknown>;
      capabilities[capability] = false;

      expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
        decision: 'not-adopted-js',
        reason: 'candidate-not-eligible',
      });
    },
  );

  it('rejects SAB/WASM threads unless the production WebView is cross-origin isolated', () => {
    const evidence = validWasmEvidence();
    const wasm = evidence.wasm as Record<string, unknown>;
    const capabilities = wasm.capabilities as Record<string, unknown>;
    wasm.usesThreads = true;
    capabilities.sharedArrayBuffer = true;
    capabilities.crossOriginIsolated = false;

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'not-adopted-js',
      reason: 'candidate-not-eligible',
    });
  });

  it('records SAB transport only after affirmative SAB and isolation evidence', () => {
    const evidence = validWasmEvidence();
    const wasm = evidence.wasm as Record<string, unknown>;
    const capabilities = wasm.capabilities as Record<string, unknown>;
    wasm.usesThreads = true;
    capabilities.sharedArrayBuffer = true;
    capabilities.crossOriginIsolated = true;

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'eligible-worker-wasm-simd',
      reason: 'material-worker-wasm-win',
      wasmBufferTransport: 'shared-array-buffer',
    });
  });

  it.each(['pointer-delivery', 'host-long-task', 'message-transfer', 'compositor'])(
    'stops for the measured %s platform limiter even when WASM evidence looks promotable',
    (limiter) => {
      const evidence = validWasmEvidence();
      evidence.limiter = limiter;

      const decision = decideInkKernelRendererBakeoff(evidence);

      expect(decision).toEqual({
        decision: 'platform-limit-stop-respec',
        reason: 'non-renderer-platform-limiter',
      });
      expect(Object.isFrozen(decision)).toBe(true);
    },
  );

  it('selects Offscreen WebGL2 after a correct production-device raster win', () => {
    const decision = decideInkKernelRendererBakeoff(validGpuEvidence());

    expect(decision).toEqual({
      decision: 'eligible-offscreen-webgl2',
      reason: 'material-offscreen-webgl2-win',
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('accepts either lower raster P95 or higher throughput as GPU performance evidence', () => {
    const p95Evidence = validGpuEvidence();
    Reflect.deleteProperty(p95Evidence.gpu as Record<string, unknown>, 'throughputRatio');
    const throughputEvidence = validGpuEvidence();
    const throughputGpu = throughputEvidence.gpu as Record<string, unknown>;
    Reflect.deleteProperty(throughputGpu, 'referenceRasterP95Ms');
    Reflect.deleteProperty(throughputGpu, 'rasterP95Ms');
    throughputGpu.throughputRatio = 1.01;

    for (const evidence of [p95Evidence, throughputEvidence]) {
      expect(decideInkKernelRendererBakeoff(evidence)).toMatchObject({
        decision: 'eligible-offscreen-webgl2',
      });
    }
  });

  it('keeps Canvas 2D when Offscreen WebGL2 lacks capability, parity, digest equality, or a win', () => {
    const unavailable = validGpuEvidence();
    const unavailableGpu = unavailable.gpu as Record<string, unknown>;
    (unavailableGpu.capabilities as Record<string, unknown>).offscreenWebgl2 = false;
    const parityFailure = validGpuEvidence();
    (parityFailure.gpu as Record<string, unknown>).quantizedParity = false;
    const digestMismatch = validGpuEvidence();
    (digestMismatch.gpu as Record<string, unknown>).candidateDigest = 'different-geometry';
    const noWin = validGpuEvidence();
    const noWinGpu = noWin.gpu as Record<string, unknown>;
    noWinGpu.rasterP95Ms = 8;
    noWinGpu.throughputRatio = 1;

    for (const evidence of [unavailable, parityFailure, digestMismatch, noWin]) {
      expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
        decision: 'not-adopted-js',
        reason: 'candidate-not-eligible',
      });
    }
  });

  it('never allows WebGPU capability or a WebGPU-only bake-off to become the release Adapter', () => {
    const evidence = validGpuEvidence();
    const gpu = evidence.gpu as Record<string, unknown>;
    const capabilities = gpu.capabilities as Record<string, unknown>;
    gpu.adapter = 'webgpu';
    gpu.rasterP95Ms = 1;
    gpu.throughputRatio = 8;
    capabilities.offscreenWebgl2 = false;
    capabilities.webgpu = true;

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'not-adopted-js',
      reason: 'candidate-not-eligible',
    });
  });

  it('does not promote capability and parity evidence without a production-device performance win', () => {
    const wasmEvidence = validWasmEvidence();
    const wasm = wasmEvidence.wasm as Record<string, unknown>;
    Reflect.deleteProperty(wasm, 'geometryP95Ms');
    Reflect.deleteProperty(wasm, 'throughputRatio');
    const gpuEvidence = validGpuEvidence();
    const gpu = gpuEvidence.gpu as Record<string, unknown>;
    Reflect.deleteProperty(gpu, 'referenceRasterP95Ms');
    Reflect.deleteProperty(gpu, 'rasterP95Ms');
    Reflect.deleteProperty(gpu, 'throughputRatio');

    for (const evidence of [wasmEvidence, gpuEvidence]) {
      expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
        decision: 'not-adopted-js',
        reason: 'candidate-not-eligible',
      });
    }
  });

  it('does not promote a microbenchmark-only Offscreen WebGL2 result', () => {
    const evidence = validGpuEvidence();
    (evidence.gpu as Record<string, unknown>).evidenceKind = 'microbenchmark';

    expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
      decision: 'not-adopted-js',
      reason: 'production-bakeoff-required',
    });
  });

  it('does not cross-promote GPU evidence for geometry or WASM evidence for raster', () => {
    const geometryWithGpu = validGpuEvidence();
    geometryWithGpu.limiter = 'geometry';
    const rasterWithWasm = validWasmEvidence();
    rasterWithWasm.limiter = 'raster';

    for (const evidence of [geometryWithGpu, rasterWithWasm]) {
      expect(decideInkKernelRendererBakeoff(evidence)).toEqual({
        decision: 'not-adopted-js',
        reason: 'production-bakeoff-required',
      });
    }
  });

  it('fails closed on missing, non-finite, unknown, and hostile evidence', () => {
    const missingLimiter = validWasmEvidence();
    Reflect.deleteProperty(missingLimiter, 'limiter');
    const nonFiniteP95 = validWasmEvidence();
    nonFiniteP95.jsGeometryP95Ms = Number.POSITIVE_INFINITY;
    const unknownLimiter = validWasmEvidence();
    unknownLimiter.limiter = 'network';
    const missingDigest = validWasmEvidence();
    Reflect.deleteProperty(missingDigest.wasm as Record<string, unknown>, 'referenceDigest');
    const missingIsolationEvidence = validWasmEvidence();
    const missingIsolationCapabilities = (missingIsolationEvidence.wasm as Record<string, unknown>)
      .capabilities as Record<string, unknown>;
    Reflect.deleteProperty(missingIsolationCapabilities, 'crossOriginIsolated');
    const invalidCandidateMetric = validWasmEvidence();
    (invalidCandidateMetric.wasm as Record<string, unknown>).throughputRatio = '2';
    const incompleteGpuP95 = validGpuEvidence();
    Reflect.deleteProperty(incompleteGpuP95.gpu as Record<string, unknown>, 'referenceRasterP95Ms');
    const inheritedEvidence = Object.create(validWasmEvidence()) as Record<string, unknown>;
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('private hostile evidence');
        },
      },
    );

    for (const evidence of [
      undefined,
      [],
      {},
      missingLimiter,
      nonFiniteP95,
      unknownLimiter,
      missingDigest,
      missingIsolationEvidence,
      invalidCandidateMetric,
      incompleteGpuP95,
      inheritedEvidence,
      hostile,
    ]) {
      const decision = decideInkKernelRendererBakeoff(evidence);
      expect(decision).toEqual({
        decision: 'not-adopted-js',
        reason: 'malformed-evidence',
      });
      expect(Object.isFrozen(decision)).toBe(true);
    }
  });

  it('does not mutate deeply frozen profiler or bake-off evidence', () => {
    const evidence = deepFreeze(validGpuEvidence());
    const before = JSON.stringify(evidence);

    expect(decideInkKernelRendererBakeoff(evidence)).toMatchObject({
      decision: 'eligible-offscreen-webgl2',
    });
    expect(JSON.stringify(evidence)).toBe(before);
  });
});

function validWasmEvidence(): Record<string, unknown> {
  return {
    jsGeometryP95Ms: 4,
    limiter: 'geometry',
    productionDevice: true,
    wasm: {
      candidateDigest: 'quantized-geometry-v1',
      capabilities: {
        crossOriginIsolated: false,
        dedicatedWorker: true,
        sharedArrayBuffer: false,
        wasm: true,
        wasmSimd: true,
      },
      evidenceKind: 'production-device-bakeoff',
      execution: 'worker',
      geometryP95Ms: 3,
      quantizedParity: true,
      referenceDigest: 'quantized-geometry-v1',
      throughputRatio: 1.5,
      usesThreads: false,
    },
  };
}

function validGpuEvidence(): Record<string, unknown> {
  return {
    gpu: {
      adapter: 'offscreen-webgl2',
      candidateDigest: 'quantized-geometry-v1',
      capabilities: {
        offscreenWebgl2: true,
        webgpu: false,
      },
      evidenceKind: 'production-device-bakeoff',
      quantizedParity: true,
      rasterP95Ms: 6,
      referenceDigest: 'quantized-geometry-v1',
      referenceRasterP95Ms: 8,
      throughputRatio: 1.25,
    },
    jsGeometryP95Ms: 2,
    limiter: 'raster',
    productionDevice: true,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
