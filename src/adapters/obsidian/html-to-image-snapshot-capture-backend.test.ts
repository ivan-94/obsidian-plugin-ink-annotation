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

  it('freezes Reading View styles before the clone leaves its Obsidian ancestor context', async () => {
    const style = document.createElement('style');
    style.textContent = `
      .markdown-preview-view { background-color: rgb(250, 250, 250); }
      .markdown-rendered .capture-fixture-list-item { list-style-type: none; }
      .markdown-rendered .capture-fixture-link {
        background-image: linear-gradient(rgb(1, 2, 3), rgb(1, 2, 3));
        background-position: right center;
        background-repeat: no-repeat;
        padding-right: 12px;
      }
      .markdown-rendered .capture-fixture-inline-code {
        background-color: rgb(244, 244, 244);
        border-radius: 4px;
        padding: 2px 4px;
      }
      .markdown-rendered .capture-fixture-code-block {
        background-color: rgb(248, 248, 248);
        border-radius: 6px;
        padding: 12px 16px;
        position: relative;
      }
      .is-mobile .markdown-rendered .capture-fixture-code-block > .copy-code-button {
        height: auto;
        padding: 6px 8px;
        position: absolute;
        right: 0;
        top: 0;
        width: auto;
      }
      .markdown-rendered .capture-fixture-quote {
        border-left: 2px solid rgb(128, 96, 255);
        padding-left: 16px;
      }
      .markdown-rendered .capture-fixture-table-cell {
        border: 1px solid rgb(220, 220, 220);
        padding: 4px 8px;
      }
    `;
    document.body.classList.add('is-mobile');
    const preview = document.createElement('div');
    preview.className = 'markdown-preview-view markdown-rendered';
    const root = document.createElement('div');
    root.className = 'markdown-preview-sizer';
    root.innerHTML = `
      <ul><li class="capture-fixture-list-item">List item</li></ul>
      <a class="capture-fixture-link">External link</a>
      <code class="capture-fixture-inline-code">inline code</code>
      <pre class="capture-fixture-code-block"><button class="copy-code-button">Copy</button><code>code block</code></pre>
      <blockquote class="capture-fixture-quote">Quote</blockquote>
      <mark class="capture-fixture-mark">marked text</mark>
      <table><tbody><tr><td class="capture-fixture-table-cell">Cell</td></tr></tbody></table>
    `;
    preview.append(root);
    document.head.append(style);
    document.body.append(preview);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(80, -900, 600, 2400));
    const renderToBlob = vi.fn((node: HTMLElement) => {
      expect(node.style.background).toBe('rgb(250, 250, 250)');
      expect(node.classList).toContain('markdown-preview-view');
      expect(node.classList).toContain('markdown-rendered');
      const clone = node.querySelector<HTMLElement>('.markdown-preview-sizer');
      expect(clone?.style.transform).toBe('translate(40px, -1020px)');
      expect(
        clone?.querySelector<HTMLElement>('.capture-fixture-list-item')?.style.listStyleType,
      ).toBe('none');
      const link = clone?.querySelector<HTMLElement>('.capture-fixture-link');
      expect(link?.style.backgroundRepeat).toBe('no-repeat');
      expect(link?.style.backgroundPosition).toBe('right center');
      expect(link?.style.paddingRight).toBe('12px');
      const inlineCode = clone?.querySelector<HTMLElement>('.capture-fixture-inline-code');
      expect(inlineCode?.style.backgroundColor).toBe('rgb(244, 244, 244)');
      expect(inlineCode?.style.borderRadius).toBe('4px');
      expect(inlineCode?.style.padding).toBe('2px 4px');
      const codeBlock = clone?.querySelector<HTMLElement>('.capture-fixture-code-block');
      expect(codeBlock?.style.backgroundColor).toBe('rgb(248, 248, 248)');
      expect(codeBlock?.style.borderRadius).toBe('6px');
      expect(codeBlock?.style.padding).toBe('12px 16px');
      expect(codeBlock?.style.position).toBe('relative');
      const copyButton = codeBlock?.querySelector<HTMLElement>('.copy-code-button');
      expect(copyButton?.style.height).toBe('auto');
      expect(copyButton?.style.padding).toBe('6px 8px');
      expect(copyButton?.style.position).toBe('absolute');
      expect(copyButton?.style.right).toBe('0px');
      expect(copyButton?.style.top).toBe('0px');
      expect(copyButton?.style.width).toBe('auto');
      const quote = clone?.querySelector<HTMLElement>('.capture-fixture-quote');
      expect(quote?.style.borderLeft).toBe('2px solid rgb(128, 96, 255)');
      expect(quote?.style.paddingLeft).toBe('16px');
      const tableCell = clone?.querySelector<HTMLElement>('.capture-fixture-table-cell');
      expect(tableCell?.style.borderTopColor).toBe('rgb(220, 220, 220)');
      expect(tableCell?.style.borderTopStyle).toBe('solid');
      expect(tableCell?.style.borderTopWidth).toBe('1px');
      expect(tableCell?.style.padding).toBe('4px 8px');
      return Promise.resolve(
        new Blob([pngHeader(744, 1009).buffer as ArrayBuffer], { type: 'image/png' }),
      );
    });
    const backend = new HtmlToImageSnapshotCaptureBackend({ document, renderToBlob });

    try {
      await expect(
        backend.capture({
          captureGeneration: 8,
          desiredPixelRatio: 1,
          signal: new AbortController().signal,
          subject: leaseSnapshotCaptureSubject(root),
          subjectCssRect: { height: 2400, left: 80, top: -900, width: 600 },
          viewportCssRect: { height: 1009, left: 40, top: 120, width: 744 },
        }),
      ).resolves.toMatchObject({ pixelHeight: 1009, pixelWidth: 744 });
    } finally {
      preview.remove();
      style.remove();
      document.body.classList.remove('is-mobile');
    }
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
