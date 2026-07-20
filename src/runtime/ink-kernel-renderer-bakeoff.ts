export type InkKernelRendererLimiter =
  'compositor' | 'geometry' | 'host-long-task' | 'message-transfer' | 'pointer-delivery' | 'raster';

export interface InkWasmSimdCapabilitiesEvidence {
  readonly crossOriginIsolated: boolean;
  readonly dedicatedWorker: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly wasm: boolean;
  readonly wasmSimd: boolean;
}

export interface InkWasmSimdBakeoffEvidence {
  readonly candidateDigest: string;
  readonly capabilities: InkWasmSimdCapabilitiesEvidence;
  readonly evidenceKind: 'microbenchmark' | 'production-device-bakeoff';
  readonly execution: 'main-thread' | 'worker';
  readonly geometryP95Ms?: number;
  readonly quantizedParity: boolean;
  readonly referenceDigest: string;
  readonly throughputRatio?: number;
  readonly usesThreads: boolean;
}

export interface InkGpuCapabilitiesEvidence {
  readonly offscreenWebgl2: boolean;
  readonly webgpu: boolean;
}

export interface InkGpuBakeoffEvidence {
  readonly adapter: 'offscreen-webgl2' | 'webgpu';
  readonly candidateDigest: string;
  readonly capabilities: InkGpuCapabilitiesEvidence;
  readonly evidenceKind: 'microbenchmark' | 'production-device-bakeoff';
  readonly quantizedParity: boolean;
  readonly rasterP95Ms?: number;
  readonly referenceDigest: string;
  readonly referenceRasterP95Ms?: number;
  readonly throughputRatio?: number;
}

export interface InkKernelRendererBakeoffEvidence {
  readonly gpu?: InkGpuBakeoffEvidence;
  readonly jsGeometryP95Ms: number;
  readonly limiter: InkKernelRendererLimiter;
  readonly productionDevice: boolean;
  readonly wasm?: InkWasmSimdBakeoffEvidence;
}

export type InkKernelRendererBakeoffDecision =
  | Readonly<{
      decision: 'eligible-worker-wasm-simd';
      reason: 'material-worker-wasm-win';
      wasmBufferTransport: 'shared-array-buffer' | 'transferable-array-buffer-pool';
    }>
  | Readonly<{
      decision: 'eligible-offscreen-webgl2';
      reason: 'material-offscreen-webgl2-win';
    }>
  | Readonly<{
      decision: 'not-adopted-js';
      reason:
        | 'candidate-not-eligible'
        | 'malformed-evidence'
        | 'production-bakeoff-required'
        | 'production-device-evidence-required';
    }>
  | Readonly<{
      decision: 'platform-limit-stop-respec';
      reason: 'non-renderer-platform-limiter';
    }>;

const ELIGIBLE_WORKER_WASM: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'eligible-worker-wasm-simd',
  reason: 'material-worker-wasm-win',
  wasmBufferTransport: 'transferable-array-buffer-pool',
});
const ELIGIBLE_THREADED_WORKER_WASM: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'eligible-worker-wasm-simd',
  reason: 'material-worker-wasm-win',
  wasmBufferTransport: 'shared-array-buffer',
});
const ELIGIBLE_OFFSCREEN_WEBGL2: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'eligible-offscreen-webgl2',
  reason: 'material-offscreen-webgl2-win',
});
const CANDIDATE_NOT_ELIGIBLE: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'not-adopted-js',
  reason: 'candidate-not-eligible',
});
const MALFORMED_EVIDENCE: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'not-adopted-js',
  reason: 'malformed-evidence',
});
const PRODUCTION_DEVICE_REQUIRED: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'not-adopted-js',
  reason: 'production-device-evidence-required',
});
const PRODUCTION_BAKEOFF_REQUIRED: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'not-adopted-js',
  reason: 'production-bakeoff-required',
});
const PLATFORM_LIMIT_STOP_RESPEC: InkKernelRendererBakeoffDecision = Object.freeze({
  decision: 'platform-limit-stop-respec',
  reason: 'non-renderer-platform-limiter',
});

/**
 * Applies the S27R4 evidence Gate without mutating profiler evidence or runtime state.
 * Untrusted or incomplete evidence fails closed to the JavaScript fallback.
 */
export function decideInkKernelRendererBakeoff(
  evidence: unknown,
): InkKernelRendererBakeoffDecision {
  try {
    return decideValidatedBakeoff(requiredRecord(evidence));
  } catch {
    return MALFORMED_EVIDENCE;
  }
}

function decideValidatedBakeoff(
  input: Record<PropertyKey, unknown>,
): InkKernelRendererBakeoffDecision {
  const productionDevice = requiredBoolean(input.productionDevice);
  const limiter = requiredLimiter(input.limiter);
  const jsGeometryP95Ms = requiredNonNegativeNumber(input.jsGeometryP95Ms);
  if (!productionDevice) return PRODUCTION_DEVICE_REQUIRED;
  if (isPlatformLimiter(limiter)) return PLATFORM_LIMIT_STOP_RESPEC;
  if (limiter === 'raster') return decideGpuBakeoff(input.gpu);
  return decideWasmBakeoff(input.wasm, jsGeometryP95Ms);
}

function decideWasmBakeoff(
  value: unknown,
  jsGeometryP95Ms: number,
): InkKernelRendererBakeoffDecision {
  if (value === undefined) return PRODUCTION_BAKEOFF_REQUIRED;
  const wasm = requiredRecord(value);
  const evidenceKind = requiredEvidenceKind(wasm.evidenceKind);
  if (evidenceKind === 'microbenchmark') return PRODUCTION_BAKEOFF_REQUIRED;
  const execution = requiredEnum(wasm.execution, ['main-thread', 'worker'] as const);
  const capabilities = requiredRecord(wasm.capabilities);
  const dedicatedWorker = requiredBoolean(capabilities.dedicatedWorker);
  const wasmAvailable = requiredBoolean(capabilities.wasm);
  const wasmSimdAvailable = requiredBoolean(capabilities.wasmSimd);
  const sharedArrayBuffer = requiredBoolean(capabilities.sharedArrayBuffer);
  const crossOriginIsolated = requiredBoolean(capabilities.crossOriginIsolated);
  const usesThreads = requiredBoolean(wasm.usesThreads);
  const quantizedParity = requiredBoolean(wasm.quantizedParity);
  const referenceDigest = requiredDigest(wasm.referenceDigest);
  const candidateDigest = requiredDigest(wasm.candidateDigest);
  const geometryP95Ms = optionalNonNegativeNumber(wasm, 'geometryP95Ms');
  const throughputRatio = optionalNonNegativeNumber(wasm, 'throughputRatio');

  if (
    execution !== 'worker' ||
    !dedicatedWorker ||
    !wasmAvailable ||
    !wasmSimdAvailable ||
    !quantizedParity ||
    candidateDigest !== referenceDigest
  ) {
    return CANDIDATE_NOT_ELIGIBLE;
  }
  if (usesThreads && (!sharedArrayBuffer || !crossOriginIsolated)) {
    return CANDIDATE_NOT_ELIGIBLE;
  }
  const materialWin =
    (geometryP95Ms !== null && jsGeometryP95Ms - geometryP95Ms >= 1) ||
    (throughputRatio !== null && throughputRatio >= 2);
  if (!materialWin) return CANDIDATE_NOT_ELIGIBLE;
  return usesThreads ? ELIGIBLE_THREADED_WORKER_WASM : ELIGIBLE_WORKER_WASM;
}

function decideGpuBakeoff(value: unknown): InkKernelRendererBakeoffDecision {
  if (value === undefined) return PRODUCTION_BAKEOFF_REQUIRED;
  const gpu = requiredRecord(value);
  const evidenceKind = requiredEvidenceKind(gpu.evidenceKind);
  if (evidenceKind === 'microbenchmark') return PRODUCTION_BAKEOFF_REQUIRED;
  const adapter = requiredEnum(gpu.adapter, ['offscreen-webgl2', 'webgpu'] as const);
  const capabilities = requiredRecord(gpu.capabilities);
  const offscreenWebgl2 = requiredBoolean(capabilities.offscreenWebgl2);
  requiredBoolean(capabilities.webgpu);
  const quantizedParity = requiredBoolean(gpu.quantizedParity);
  const referenceDigest = requiredDigest(gpu.referenceDigest);
  const candidateDigest = requiredDigest(gpu.candidateDigest);
  const referenceP95Ms = optionalNonNegativeNumber(gpu, 'referenceRasterP95Ms');
  const candidateP95Ms = optionalNonNegativeNumber(gpu, 'rasterP95Ms');
  const throughputRatio = optionalNonNegativeNumber(gpu, 'throughputRatio');
  if ((referenceP95Ms === null) !== (candidateP95Ms === null))
    throw new Error('Incomplete P95 pair.');

  if (
    adapter !== 'offscreen-webgl2' ||
    !offscreenWebgl2 ||
    !quantizedParity ||
    candidateDigest !== referenceDigest
  ) {
    return CANDIDATE_NOT_ELIGIBLE;
  }
  const materialWin =
    (referenceP95Ms !== null && candidateP95Ms !== null && referenceP95Ms > candidateP95Ms) ||
    (throughputRatio !== null && throughputRatio > 1);
  return materialWin ? ELIGIBLE_OFFSCREEN_WEBGL2 : CANDIDATE_NOT_ELIGIBLE;
}

function requiredRecord(value: unknown): Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected evidence record.');
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Expected plain evidence record.');
  }
  return value as Record<PropertyKey, unknown>;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Expected boolean evidence.');
  return value;
}

function requiredNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Expected finite non-negative evidence.');
  }
  return value;
}

function optionalNonNegativeNumber(
  record: Record<PropertyKey, unknown>,
  key: string,
): number | null {
  if (!(key in record)) return null;
  return requiredNonNegativeNumber(record[key]);
}

function requiredDigest(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Expected geometry digest.');
  }
  return value;
}

function requiredEvidenceKind(value: unknown): 'microbenchmark' | 'production-device-bakeoff' {
  return requiredEnum(value, ['microbenchmark', 'production-device-bakeoff'] as const);
}

function requiredLimiter(value: unknown): InkKernelRendererLimiter {
  return requiredEnum(value, [
    'compositor',
    'geometry',
    'host-long-task',
    'message-transfer',
    'pointer-delivery',
    'raster',
  ] as const);
}

function requiredEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new Error('Expected known evidence classification.');
  }
  return value as Value;
}

function isPlatformLimiter(
  value: InkKernelRendererLimiter,
): value is Exclude<InkKernelRendererLimiter, 'geometry' | 'raster'> {
  return value !== 'geometry' && value !== 'raster';
}
