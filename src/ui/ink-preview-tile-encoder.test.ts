// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InkPreviewTileWorkerEncoder } from './ink-preview-tile-encoder';

describe('InkPreviewTileWorkerEncoder', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('transfers encoding to one Worker and returns its PNG bytes', async () => {
    const transfers: Transferable[][] = [];
    class FakeWorker {
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminate = vi.fn();

      postMessage(message: { readonly id: number }, transfer: Transferable[]): void {
        transfers.push(transfer);
        const bytes = Uint8Array.of(1, 2, 3).buffer;
        queueMicrotask(() =>
          this.onmessage?.(
            new MessageEvent('message', { data: { bytes, id: message.id, type: 'encoded' } }),
          ),
        );
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:preview-encoder'),
      revokeObjectURL: vi.fn(),
    });
    const bitmap = {} as ImageBitmap;
    const canvas = {
      height: 512,
      transferToImageBitmap: vi.fn(() => bitmap),
      width: 512,
    } as unknown as OffscreenCanvas;
    const encoder = new InkPreviewTileWorkerEncoder();

    await expect(encoder.encode(canvas)).resolves.toEqual(Uint8Array.of(1, 2, 3).buffer);
    expect(transfers).toEqual([[bitmap]]);
    encoder.dispose();
  });

  it('disables cache encoding when Worker construction is unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const encoder = new InkPreviewTileWorkerEncoder();

    await expect(
      encoder.encode({ transferToImageBitmap: vi.fn() } as unknown as OffscreenCanvas),
    ).resolves.toBeNull();
  });
});
