// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnnotationExportDialog } from './annotation-export-dialog';

describe('annotation export dialog', () => {
  afterEach(() => document.body.replaceChildren());

  it('requires an explicit format and reports the unique output path', async () => {
    const calls: string[] = [];
    const dialog = new AnnotationExportDialog({ document });
    dialog.show({
      onExport: (format) => {
        calls.push(format);
        return Promise.resolve('Inkstone Exports/Current file 2.html');
      },
      title: 'Export current file',
    });
    const format = document.querySelector<HTMLSelectElement>('select[aria-label="Export format"]');
    if (format === null) {
      throw new Error('Expected format selector.');
    }
    format.value = 'html-mark';
    document.querySelector<HTMLButtonElement>('button[aria-label="Create export"]')?.click();

    await vi.waitFor(() => expect(calls).toEqual(['html-mark']));
    expect(document.querySelector('[data-inkstone-export-status]')?.textContent).toContain(
      'Inkstone Exports/Current file 2.html',
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps the dialog open and offers retry after a write failure', async () => {
    let attempts = 0;
    const dialog = new AnnotationExportDialog({ document });
    dialog.show({
      onExport: () => {
        attempts += 1;
        return Promise.reject(new Error('disk full'));
      },
      title: 'Export selection',
    });
    document.querySelector<HTMLButtonElement>('button[aria-label="Create export"]')?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't create export. Retry.",
      ),
    );
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Create export"]')?.disabled,
    ).toBe(false);
    expect(attempts).toBe(1);
  });

  it('closes on Escape and restores focus to the invoker', () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    const dialog = new AnnotationExportDialog({ document });
    dialog.show({ onExport: () => Promise.resolve('Export.md'), title: 'Export', invoker });

    document
      .querySelector<HTMLElement>('[role="dialog"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});
