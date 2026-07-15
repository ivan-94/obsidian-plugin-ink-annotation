// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AnnotationConflictDialog,
  type AnnotationConflictReviewView,
} from './annotation-conflict-dialog';

describe('annotation conflict dialog', () => {
  afterEach(() => document.body.replaceChildren());

  it('requires an explicit candidate and reports that original artifacts are retained', async () => {
    const resolved: string[] = [];
    const dialog = new AnnotationConflictDialog({ document });
    dialog.show({
      conflicts: [fixture()],
      onResolve: (annotationId, candidatePath) => {
        resolved.push(annotationId, candidatePath);
        return Promise.resolve();
      },
    });
    const action = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Resolve with selected copy"]',
    );
    expect(action?.disabled).toBe(true);
    const choices = document.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    choices[1]?.click();
    expect(action?.disabled).toBe(false);
    action?.click();

    await vi.waitFor(() => expect(resolved).toEqual(['annotation-1', 'notes/iPad.json']));
    expect(document.querySelector('[data-inkstone-conflict-status]')?.textContent).toContain(
      'Original conflict files were preserved',
    );
  });

  it('keeps the dialog open and requires a fresh review after a stale save', async () => {
    const dialog = new AnnotationConflictDialog({ document });
    dialog.show({
      conflicts: [fixture()],
      onResolve: () => Promise.reject(new Error('changed since review')),
    });
    document.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Resolve with selected copy"]')
      ?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('review it again'),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('closes with Escape and restores focus', () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    const dialog = new AnnotationConflictDialog({ document });
    dialog.show({ conflicts: [fixture()], invoker, onResolve: () => Promise.resolve() });

    document
      .querySelector<HTMLElement>('[role="dialog"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });

  it('shows an Ink preview and reports the selected conflict kind', async () => {
    const calls: string[] = [];
    const dialog = new AnnotationConflictDialog({ document });
    dialog.show({
      conflicts: [
        {
          annotationId: 'surface-1',
          candidates: [
            {
              body: '2 strokes · active',
              path: 'surfaces/iPad.json',
              previewSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>',
              quote: 'Architecture › Ink',
              revision: 2,
              tags: [],
              updatedAt: '2026-07-14T10:00:00.000Z',
            },
          ],
          kind: 'ink',
        },
      ],
      onResolve: (id, path, kind) => {
        calls.push(`${kind}:${id}:${path}`);
        return Promise.resolve();
      },
    });

    expect(
      document.querySelector<HTMLImageElement>('img[alt="Ink preview for copy 1"]')?.src,
    ).toContain('data:image/svg+xml');
    document.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Resolve with selected copy"]')
      ?.click();
    await vi.waitFor(() => expect(calls).toEqual(['ink:surface-1:surfaces/iPad.json']));
  });
});

function fixture(): AnnotationConflictReviewView {
  return {
    annotationId: 'annotation-1',
    kind: 'text',
    candidates: [
      {
        body: 'Mac note',
        deviceId: 'mac-device',
        mark: { kind: 'highlight', styleId: 'highlight-sun' },
        path: 'notes/Mac.json',
        quote: 'Conflicted passage',
        revision: 2,
        tags: ['mac'],
        updatedAt: '2026-07-14T10:00:00.000Z',
      },
      {
        body: 'iPad note',
        deviceId: 'ipad-device',
        mark: { kind: 'underline', styleId: 'highlight-mint' },
        path: 'notes/iPad.json',
        quote: 'Conflicted passage',
        revision: 2,
        tags: ['ipad'],
        updatedAt: '2026-07-14T10:01:00.000Z',
      },
    ],
  };
}
