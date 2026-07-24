// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  leaseSnapshotCaptureSubject,
  SnapshotCaptureBackendRegistry,
} from './snapshot-capture-backend';
import { ForeignObjectSnapshotCaptureBackend } from './foreign-object-snapshot-capture-backend';

describe('Inkstone foreignObject Snapshot capture backend', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('inlines computed styles and local images before returning the shared PNG contract', async () => {
    const root = document.createElement('div');
    root.className = 'markdown-preview-sizer';
    root.innerHTML = '<h1 style="color: rgb(1, 2, 3)">Test</h1><img src="app://vault/a.png">';
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(10, 20, 240, 300));
    const image = root.querySelector('img') as HTMLImageElement;
    Object.defineProperties(image, {
      complete: { value: true },
      naturalHeight: { value: 50 },
      naturalWidth: { value: 80 },
    });
    const rasterizeSvg = vi.fn((input: { svg: string }) => {
      expect(input.svg).toContain('foreignObject');
      expect(input.svg).toContain('data:image/png;base64,fixture');
      expect(input.svg).toContain('color: rgb(1, 2, 3)');
      return Promise.resolve(pngHeader(480, 400));
    });
    const backend = new ForeignObjectSnapshotCaptureBackend({
      document,
      rasterizeSvg,
      resolveImageDataUrl: () => Promise.resolve('data:image/png;base64,fixture'),
    });
    const registry = new SnapshotCaptureBackendRegistry([backend]);

    const result = await registry.capture('inkstone-foreign-object', {
      captureGeneration: 2,
      desiredPixelRatio: 2,
      signal: new AbortController().signal,
      subject: leaseSnapshotCaptureSubject(root),
      viewportCssRect: { height: 200, left: 10, top: 20, width: 240 },
    });

    expect(result).toMatchObject({
      backendId: 'inkstone-foreign-object',
      backendVersion: '1',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 480,
    });
  });

  it('inlines an already loaded Vault image without issuing a fetch request', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="app://vault/local.png">';
    const sourceImage = root.querySelector('img') as HTMLImageElement;
    Object.defineProperties(sourceImage, {
      complete: { value: true },
      naturalHeight: { value: 50 },
      naturalWidth: { value: 80 },
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['local-image'], { type: 'image/png' }));
    });
    const fetchRequest = vi.fn();
    vi.stubGlobal('fetch', fetchRequest);
    const rasterizeSvg = vi.fn(({ svg }: { svg: string }) => {
      expect(svg).toContain('data:image/png;base64,');
      return Promise.resolve(pngHeader(100, 100));
    });
    const backend = new ForeignObjectSnapshotCaptureBackend({ document, rasterizeSvg });

    await backend.capture({
      captureGeneration: 2,
      desiredPixelRatio: 1,
      signal: new AbortController().signal,
      subject: leaseSnapshotCaptureSubject(root),
      viewportCssRect: { height: 100, left: 0, top: 0, width: 100 },
    });

    expect(fetchRequest).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(sourceImage, 0, 0, 80, 50);
  });

  it('honors cancellation before publishing a raster result', async () => {
    const root = document.createElement('div');
    root.textContent = 'Test';
    const controller = new AbortController();
    const backend = new ForeignObjectSnapshotCaptureBackend({
      document,
      rasterizeSvg: () => {
        controller.abort();
        return Promise.resolve(pngHeader(100, 100));
      },
    });

    await expect(
      backend.capture({
        captureGeneration: 1,
        desiredPixelRatio: 1,
        signal: controller.signal,
        subject: leaseSnapshotCaptureSubject(root),
        viewportCssRect: { height: 100, left: 0, top: 0, width: 100 },
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('preserves generated SVG and substitutes resource-level failures without aborting capture', async () => {
    const root = document.createElement('div');
    const annotation = document.createElement('span');
    annotation.className = 'inkstone-text-highlight';
    annotation.textContent = 'annotated words stay visible';
    const noteAnchor = document.createElement('button');
    noteAnchor.className = 'inkstone-note-anchor';
    noteAnchor.textContent = '1';
    const remoteImage = document.createElement('img');
    remoteImage.src = 'https://example.invalid/remote.png';
    const brokenLocalImage = document.createElement('img');
    brokenLocalImage.src = 'app://vault/broken.png';
    const resolverFailureImage = document.createElement('img');
    resolverFailureImage.src = 'app://vault/unreadable.png';
    const iframe = document.createElement('iframe');
    const canvas = document.createElement('canvas');
    const mermaid = document.createElement('div');
    mermaid.className = 'mermaid';
    mermaid.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    root.append(
      annotation,
      noteAnchor,
      remoteImage,
      brokenLocalImage,
      resolverFailureImage,
      iframe,
      canvas,
      mermaid,
    );
    Object.defineProperties(remoteImage, {
      complete: { value: true },
      currentSrc: { value: remoteImage.src },
      naturalHeight: { value: 60 },
      naturalWidth: { value: 80 },
    });
    Object.defineProperties(brokenLocalImage, {
      complete: { value: true },
      naturalHeight: { value: 0 },
      naturalWidth: { value: 0 },
    });
    Object.defineProperties(resolverFailureImage, {
      complete: { value: true },
      naturalHeight: { value: 60 },
      naturalWidth: { value: 80 },
    });
    const rasterizeSvg = vi.fn(({ svg }: { svg: string }) => {
      expect(svg).toContain('class="inkstone-text-highlight"');
      expect(svg).toContain('annotated words stay visible');
      expect(svg).not.toContain('inkstone-note-anchor');
      expect(svg).toContain('class="mermaid"');
      expect(svg).toContain('<svg');
      expect(svg.match(/data-inkstone-snapshot-placeholder=/gu)).toHaveLength(5);
      expect(svg).toContain('remote-image');
      expect(svg).toContain('local-image');
      expect(svg).toContain('iframe');
      expect(svg).toContain('canvas');
      return Promise.resolve(pngHeader(100, 100));
    });
    const backend = new ForeignObjectSnapshotCaptureBackend({
      document,
      rasterizeSvg,
      resolveImageDataUrl: () => Promise.reject(new Error('fixture local read failed')),
    });

    await expect(
      backend.capture({
        captureGeneration: 3,
        desiredPixelRatio: 1,
        signal: new AbortController().signal,
        subject: leaseSnapshotCaptureSubject(root),
        viewportCssRect: { height: 100, left: 0, top: 0, width: 100 },
      }),
    ).resolves.toMatchObject({ backendId: 'inkstone-foreign-object' });
    expect(rasterizeSvg).toHaveBeenCalledOnce();
  });

  it('retries once with a generated-content placeholder after foreignObject raster failure', async () => {
    const root = document.createElement('div');
    const math = document.createElement('div');
    math.className = 'math';
    math.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    root.append(math);
    const rasterizeSvg = vi
      .fn<(input: { svg: string }) => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error('fixture foreignObject raster failure'))
      .mockImplementationOnce(({ svg }) => {
        expect(svg).toContain('data-inkstone-snapshot-placeholder="math"');
        return Promise.resolve(pngHeader(100, 100));
      });
    const backend = new ForeignObjectSnapshotCaptureBackend({ document, rasterizeSvg });

    await expect(
      backend.capture({
        captureGeneration: 4,
        desiredPixelRatio: 1,
        signal: new AbortController().signal,
        subject: leaseSnapshotCaptureSubject(root),
        viewportCssRect: { height: 100, left: 0, top: 0, width: 100 },
      }),
    ).resolves.toMatchObject({ backendId: 'inkstone-foreign-object' });
    expect(rasterizeSvg).toHaveBeenCalledTimes(2);
  });

  it('rasterizes SVG through a data URL image when iPad cannot decode the SVG Blob', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<h1>iPad fixture</h1><p>Visible content</p>';
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 100, 50));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([pngHeader(200, 100).buffer as ArrayBuffer], { type: 'image/png' }));
    });
    const createImageBitmap = vi
      .fn()
      .mockRejectedValue(
        new DOMException(
          'Cannot decode the data in the argument to createImageBitmap',
          'InvalidStateError',
        ),
      );
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const decodedImage = document.createElement('img');
    const loadSvgImage = vi
      .fn<(dataUrl: string, signal: AbortSignal) => Promise<HTMLImageElement>>()
      .mockResolvedValue(decodedImage);
    const backendOptions = { document, loadSvgImage };
    const backend = new ForeignObjectSnapshotCaptureBackend(backendOptions);

    await expect(
      backend.capture({
        captureGeneration: 5,
        desiredPixelRatio: 2,
        signal: new AbortController().signal,
        subject: leaseSnapshotCaptureSubject(root),
        viewportCssRect: { height: 50, left: 0, top: 0, width: 100 },
      }),
    ).resolves.toMatchObject({ pixelHeight: 100, pixelWidth: 200 });

    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(loadSvgImage).toHaveBeenCalledOnce();
    expect(loadSvgImage.mock.calls[0]?.[0]).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u);
    expect(decodeURIComponent(loadSvgImage.mock.calls[0]?.[0] ?? '')).toContain('foreignObject');
    expect(drawImage).toHaveBeenCalledWith(decodedImage, 0, 0, 200, 100);
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
