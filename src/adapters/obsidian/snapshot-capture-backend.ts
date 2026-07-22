import { readPngImageDimensions } from '../../domain/png-image';

const SNAPSHOT_CAPTURE_SUBJECT: unique symbol = Symbol('snapshot-capture-subject');
const subjectLeases = new WeakMap<SnapshotCaptureSubjectHandle, unknown>();

export interface SnapshotCaptureCssRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** Adapter-owned, process-local handle. It must never enter a record or application state. */
export interface SnapshotCaptureSubjectHandle {
  readonly [SNAPSHOT_CAPTURE_SUBJECT]: true;
}

export interface SnapshotCaptureCapabilities {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly contentClasses: readonly string[];
  readonly platform: 'both' | 'desktop-electron' | 'web';
  readonly supportsCancellation: boolean;
}

export interface SnapshotCaptureRequest {
  readonly captureGeneration: number;
  readonly desiredPixelRatio: number;
  readonly signal: AbortSignal;
  readonly subject: SnapshotCaptureSubjectHandle;
  readonly viewportCssRect: SnapshotCaptureCssRect;
}

export interface SnapshotCaptureBackendResult {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly captureGeneration: number;
  readonly capturedCssRect: SnapshotCaptureCssRect;
  readonly mimeType: 'image/png';
  readonly pixelHeight: number;
  readonly pixelRatio: number;
  readonly pixelWidth: number;
  readonly pngBytes: Uint8Array;
}

export interface SnapshotCaptureBackend {
  describe(): SnapshotCaptureCapabilities;
  capture(request: SnapshotCaptureRequest): Promise<SnapshotCaptureBackendResult>;
}

export type SnapshotCaptureFailureCode =
  'aborted' | 'backend-unavailable' | 'capture-failed' | 'invalid-result' | 'stale-capture';

export class SnapshotCaptureError extends Error {
  constructor(
    readonly code: SnapshotCaptureFailureCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'SnapshotCaptureError';
  }
}

export function leaseSnapshotCaptureSubject(subject: unknown): SnapshotCaptureSubjectHandle {
  const handle = Object.freeze({
    [SNAPSHOT_CAPTURE_SUBJECT]: true as const,
  });
  subjectLeases.set(handle, subject);
  return handle;
}

/** Internal adapter seam used only by capture backends in this directory. */
export function resolveSnapshotCaptureSubject(handle: SnapshotCaptureSubjectHandle): unknown {
  const subject = subjectLeases.get(handle);
  if (subject === undefined) {
    throw new SnapshotCaptureError(
      'backend-unavailable',
      'The Snapshot capture subject lease is no longer available.',
    );
  }
  return subject;
}

export class SnapshotCaptureBackendRegistry {
  private readonly backends = new Map<string, SnapshotCaptureBackend>();

  constructor(backends: readonly SnapshotCaptureBackend[]) {
    for (const backend of backends) {
      const capabilities = backend.describe();
      if (capabilities.backendId.length === 0 || capabilities.backendVersion.length === 0) {
        throw new Error('Snapshot capture backends require a non-empty ID and version.');
      }
      if (this.backends.has(capabilities.backendId)) {
        throw new Error(`Duplicate Snapshot capture backend: ${capabilities.backendId}`);
      }
      this.backends.set(capabilities.backendId, backend);
    }
  }

  listCapabilities(): readonly SnapshotCaptureCapabilities[] {
    return [...this.backends.values()].map((backend) => backend.describe());
  }

  async capture(
    backendId: string,
    request: SnapshotCaptureRequest,
  ): Promise<SnapshotCaptureBackendResult> {
    assertCaptureRequest(request);
    if (request.signal.aborted) throw abortedCapture();
    const backend = this.backends.get(backendId);
    if (backend === undefined) {
      throw new SnapshotCaptureError(
        'backend-unavailable',
        `Snapshot capture backend is unavailable: ${backendId}`,
      );
    }
    const capabilities = backend.describe();
    let result: SnapshotCaptureBackendResult;
    try {
      result = await backend.capture(request);
    } catch (error) {
      if (error instanceof SnapshotCaptureError) throw error;
      throw new SnapshotCaptureError('capture-failed', 'Snapshot capture failed.', {
        cause: error,
      });
    }
    if (request.signal.aborted) throw abortedCapture();
    validateCaptureResult(capabilities, request, result);
    return result;
  }
}

function assertCaptureRequest(request: SnapshotCaptureRequest): void {
  if (!Number.isSafeInteger(request.captureGeneration) || request.captureGeneration < 0) {
    throw invalidResult('Snapshot capture generation must be a non-negative safe integer.');
  }
  if (!Number.isFinite(request.desiredPixelRatio) || request.desiredPixelRatio <= 0) {
    throw invalidResult('Snapshot capture pixel ratio must be finite and positive.');
  }
  const { height, left, top, width } = request.viewportCssRect;
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw invalidResult('Snapshot capture rectangle must be finite and non-empty.');
  }
}

function validateCaptureResult(
  capabilities: SnapshotCaptureCapabilities,
  request: SnapshotCaptureRequest,
  result: SnapshotCaptureBackendResult,
): void {
  if (result.captureGeneration !== request.captureGeneration) {
    throw new SnapshotCaptureError(
      'stale-capture',
      'Snapshot capture completed for an obsolete Reading View generation.',
    );
  }
  if (
    result.backendId !== capabilities.backendId ||
    result.backendVersion !== capabilities.backendVersion ||
    result.mimeType !== 'image/png' ||
    !sameRect(result.capturedCssRect, request.viewportCssRect)
  ) {
    throw invalidResult('Snapshot capture provenance or geometry does not match its request.');
  }
  const dimensions = readPngImageDimensions(result.pngBytes);
  if (dimensions.width !== result.pixelWidth || dimensions.height !== result.pixelHeight) {
    throw invalidResult('Snapshot capture PNG dimensions do not match its result metadata.');
  }
  const widthRatio = result.pixelWidth / result.capturedCssRect.width;
  const heightRatio = result.pixelHeight / result.capturedCssRect.height;
  if (
    !Number.isFinite(result.pixelRatio) ||
    result.pixelRatio <= 0 ||
    Math.abs(widthRatio - heightRatio) > 0.02 ||
    Math.abs(widthRatio - result.pixelRatio) > 0.02
  ) {
    throw invalidResult('Snapshot capture pixel ratio is inconsistent with its PNG dimensions.');
  }
}

function sameRect(left: SnapshotCaptureCssRect, right: SnapshotCaptureCssRect): boolean {
  return (
    left.height === right.height &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width
  );
}

function abortedCapture(): SnapshotCaptureError {
  return new SnapshotCaptureError('aborted', 'Snapshot capture was cancelled.');
}

function invalidResult(message: string): SnapshotCaptureError {
  return new SnapshotCaptureError('invalid-result', message);
}
