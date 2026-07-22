// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  leaseSnapshotCaptureSubject,
  SnapshotCaptureBackendRegistry,
} from './snapshot-capture-backend';
import { HtmlToImageSnapshotCaptureBackend } from './html-to-image-snapshot-capture-backend';

describe('html-to-image Snapshot capture backend', () => {
  it('isolates the leased Reading DOM and returns the shared bounded PNG contract', async () => {
    const root = document.createElement('div');
    root.className = 'markdown-preview-sizer';
    root.innerHTML = '<h1>Test</h1><p>Visible paragraph</p>';
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(20, 30, 300, 500));
    const renderToBlob = vi.fn(
      (
        node: HTMLElement,
        options: {
          canvasHeight?: number;
          canvasWidth?: number;
          height: number;
          pixelRatio: number;
          width: number;
        },
      ) => {
        expect(node.dataset.inkstoneSnapshotIsolation).toBe('');
        expect(node.style.left).toBe('0px');
        expect(node.style.top).toBe('0px');
        expect(options).not.toHaveProperty('canvasHeight');
        expect(options).not.toHaveProperty('canvasWidth');
        expect(options.height).toBe(200);
        expect(options.pixelRatio).toBe(2);
        expect(options.width).toBe(300);
        return Promise.resolve(
          new Blob([pngHeader(600, 400).buffer as ArrayBuffer], { type: 'image/png' }),
        );
      },
    );
    const backend = new HtmlToImageSnapshotCaptureBackend({ document, renderToBlob });
    const registry = new SnapshotCaptureBackendRegistry([backend]);

    const result = await registry.capture('html-to-image', {
      captureGeneration: 7,
      desiredPixelRatio: 2,
      signal: new AbortController().signal,
      subject: leaseSnapshotCaptureSubject(root),
      viewportCssRect: { height: 200, left: 20, top: 30, width: 300 },
    });

    expect(result).toMatchObject({
      backendId: 'html-to-image',
      backendVersion: '1.11.13',
      captureGeneration: 7,
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
    });
    expect(document.querySelector('[data-inkstone-snapshot-isolation]')).toBeNull();
  });

  it('preserves generated SVG and replaces individually unsupported nodes with placeholders', async () => {
    const root = document.createElement('div');
    const annotation = document.createElement('span');
    annotation.className = 'inkstone-text-highlight';
    annotation.textContent = 'annotated words stay visible';
    const noteAnchor = document.createElement('button');
    noteAnchor.className = 'inkstone-note-anchor';
    noteAnchor.textContent = '1';
    const localImage = document.createElement('img');
    localImage.src = 'app://local/image.png';
    const remoteImage = document.createElement('img');
    remoteImage.src = 'https://example.invalid/remote.png';
    const iframe = document.createElement('iframe');
    const canvas = document.createElement('canvas');
    const mermaid = document.createElement('div');
    mermaid.className = 'mermaid';
    mermaid.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    root.append(annotation, noteAnchor, localImage, remoteImage, iframe, canvas, mermaid);
    Object.defineProperties(localImage, {
      complete: { value: true },
      naturalWidth: { value: 0 },
    });
    Object.defineProperties(remoteImage, {
      complete: { value: true },
      currentSrc: { value: remoteImage.src },
      naturalHeight: { value: 60 },
      naturalWidth: { value: 80 },
    });
    const renderToBlob = vi.fn((node: HTMLElement) => {
      expect(node.querySelector('.inkstone-text-highlight')?.textContent).toBe(
        'annotated words stay visible',
      );
      expect(node.querySelector('.inkstone-note-anchor')).toBeNull();
      expect(node.querySelector('.mermaid svg')).not.toBeNull();
      expect(
        [...node.querySelectorAll<HTMLElement>('[data-inkstone-snapshot-placeholder]')].map(
          ({ dataset }) => dataset.inkstoneSnapshotPlaceholder,
        ),
      ).toEqual(['local-image', 'remote-image', 'iframe', 'canvas']);
      return Promise.resolve(
        new Blob([pngHeader(100, 100).buffer as ArrayBuffer], { type: 'image/png' }),
      );
    });
    const backend = new HtmlToImageSnapshotCaptureBackend({ document, renderToBlob });

    await expect(
      backend.capture({
        captureGeneration: 1,
        desiredPixelRatio: 1,
        signal: new AbortController().signal,
        subject: leaseSnapshotCaptureSubject(root),
        viewportCssRect: { height: 100, left: 0, top: 0, width: 100 },
      }),
    ).resolves.toMatchObject({ backendId: 'html-to-image' });
    expect(renderToBlob).toHaveBeenCalledOnce();
  });

  it('retries once with a generated-content placeholder when direct SVG rendering fails', async () => {
    const root = document.createElement('div');
    const mermaid = document.createElement('div');
    mermaid.className = 'mermaid';
    mermaid.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    root.append(mermaid);
    const renderToBlob = vi
      .fn<(node: HTMLElement) => Promise<Blob | null>>()
      .mockRejectedValueOnce(new Error('fixture SVG renderer failure'))
      .mockImplementationOnce((node) => {
        expect(node.querySelector('[data-inkstone-snapshot-placeholder="mermaid"]')).not.toBeNull();
        return Promise.resolve(
          new Blob([pngHeader(100, 100).buffer as ArrayBuffer], { type: 'image/png' }),
        );
      });
    const backend = new HtmlToImageSnapshotCaptureBackend({ document, renderToBlob });

    await expect(
      backend.capture({
        captureGeneration: 2,
        desiredPixelRatio: 1,
        signal: new AbortController().signal,
        subject: leaseSnapshotCaptureSubject(root),
        viewportCssRect: { height: 100, left: 0, top: 0, width: 100 },
      }),
    ).resolves.toMatchObject({ backendId: 'html-to-image' });
    expect(renderToBlob).toHaveBeenCalledTimes(2);
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  };
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
