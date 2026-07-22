import { describe, expect, it, vi } from 'vitest';

import {
  SnapshotCaptureBackendRegistry,
  leaseSnapshotCaptureSubject,
} from './snapshot-capture-backend';
import { ElectronSnapshotCaptureBackend } from './electron-snapshot-capture-backend';

describe('Snapshot capture backend', () => {
  it('captures one Reading viewport through Electron and returns the shared validated PNG contract', async () => {
    const capturePage = vi.fn(() =>
      Promise.resolve({
        isEmpty: () => false,
        toPNG: () => pngHeader(600, 400),
      }),
    );
    const backend = new ElectronSnapshotCaptureBackend();
    const registry = new SnapshotCaptureBackendRegistry([backend]);
    const controller = new AbortController();

    const result = await registry.capture('electron-capture-page', {
      captureGeneration: 7,
      desiredPixelRatio: 2,
      signal: controller.signal,
      subject: leaseSnapshotCaptureSubject({
        kind: 'electron-web-contents',
        webContents: { capturePage },
      }),
      viewportCssRect: { height: 200, left: 20, top: 30, width: 300 },
    });

    expect(capturePage).toHaveBeenCalledWith({ height: 200, width: 300, x: 20, y: 30 });
    expect(result).toMatchObject({
      backendId: 'electron-capture-page',
      backendVersion: '1',
      captureGeneration: 7,
      capturedCssRect: { height: 200, left: 20, top: 30, width: 300 },
      mimeType: 'image/png',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
    });
    expect(result.pngBytes).toEqual(pngHeader(600, 400));
  });
});

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
