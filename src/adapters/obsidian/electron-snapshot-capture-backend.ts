import { readPngImageDimensions } from '../../domain/png-image';
import {
  resolveSnapshotCaptureSubject,
  SnapshotCaptureError,
  type SnapshotCaptureBackend,
  type SnapshotCaptureBackendResult,
  type SnapshotCaptureCapabilities,
  type SnapshotCaptureRequest,
} from './snapshot-capture-backend';

interface ElectronNativeImageLike {
  isEmpty(): boolean;
  toPNG(options?: { readonly scaleFactor?: number }): Uint8Array;
}

export interface ElectronWebContentsCaptureLike {
  capturePage(rect: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  }): Promise<ElectronNativeImageLike>;
}

interface ElectronSnapshotCaptureSubject {
  readonly kind: 'electron-web-contents';
  readonly webContents: ElectronWebContentsCaptureLike;
}

const CAPABILITIES = Object.freeze({
  backendId: 'electron-capture-page',
  backendVersion: '1',
  contentClasses: Object.freeze([
    'reading-view-viewport',
    'composited-svg-math-generated-content',
    'composited-media-and-remote-images',
  ]),
  platform: 'desktop-electron' as const,
  supportsCancellation: false,
});

export class ElectronSnapshotCaptureBackend implements SnapshotCaptureBackend {
  describe(): SnapshotCaptureCapabilities {
    return CAPABILITIES;
  }

  async capture(request: SnapshotCaptureRequest): Promise<SnapshotCaptureBackendResult> {
    if (request.signal.aborted) {
      throw new SnapshotCaptureError('aborted', 'Snapshot capture was cancelled.');
    }
    const subject = resolveSnapshotCaptureSubject(request.subject);
    if (!isElectronCaptureSubject(subject)) {
      throw new SnapshotCaptureError(
        'backend-unavailable',
        'Electron Snapshot capture requires the current desktop webContents.',
      );
    }
    const { height, left, top, width } = request.viewportCssRect;
    const image = await subject.webContents.capturePage({ height, width, x: left, y: top });
    if (image.isEmpty()) {
      throw new SnapshotCaptureError(
        'invalid-result',
        'Electron returned an empty Snapshot image.',
      );
    }
    const pngBytes = Uint8Array.from(image.toPNG({ scaleFactor: request.desiredPixelRatio }));
    const dimensions = readPngImageDimensions(pngBytes);
    const pixelRatio = dimensions.width / width;
    return Object.freeze({
      backendId: CAPABILITIES.backendId,
      backendVersion: CAPABILITIES.backendVersion,
      captureGeneration: request.captureGeneration,
      capturedCssRect: Object.freeze({ ...request.viewportCssRect }),
      mimeType: 'image/png' as const,
      pixelHeight: dimensions.height,
      pixelRatio,
      pixelWidth: dimensions.width,
      pngBytes,
    });
  }
}

function isElectronCaptureSubject(value: unknown): value is ElectronSnapshotCaptureSubject {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ElectronSnapshotCaptureSubject>;
  return (
    candidate.kind === 'electron-web-contents' &&
    typeof candidate.webContents?.capturePage === 'function'
  );
}
