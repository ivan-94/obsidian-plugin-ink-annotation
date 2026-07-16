import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

describe('Ink fixed-width workspace CSS', () => {
  it('centers the persisted logical width without freezing typography or page geometry', () => {
    expect(styles).toMatch(
      /\.inkstone-ink-workspace\s*\{[^}]*width:\s*var\(--inkstone-ink-logical-width\)[^}]*max-width:\s*none[^}]*margin-inline:\s*auto/u,
    );
    expect(styles).toMatch(
      /\.inkstone-ink-workspace\s*\{[^}]*min-height:\s*var\(--inkstone-ink-logical-height\)/u,
    );
    expect(styles).toMatch(
      /\.markdown-preview-view\.is-readable-line-width\s+\.markdown-preview-sizer\.inkstone-ink-workspace\s*\{[^}]*width:\s*var\(--inkstone-ink-logical-width\)[^}]*max-width:\s*none/u,
    );
    expect(styles).not.toContain('page-break-after');
    expect(styles).not.toContain('font-family: var(--inkstone-ink');
  });

  it('shows distinct edit-mode boundaries for the pane Canvas and 704 document', () => {
    expect(styles).toMatch(
      /\.is-ink-mode\s+\.inkstone-ink-workspace\s*\{[^}]*outline:\s*1px\s+solid\s+color-mix/u,
    );
    expect(styles).toMatch(
      /\.is-ink-mode\s+\.inkstone-ink-surface\s*\{[^}]*outline:\s*1px\s+solid\s+color-mix/u,
    );
  });

  it('keeps the pane Canvas viewport-fixed without adding itself to the scroll extent', () => {
    expect(styles).toMatch(/\.inkstone-ink-surface\s*\{[^}]*position:\s*fixed/u);
    expect(styles).toMatch(/\.inkstone-ink-canvas\s*\{[^}]*pointer-events:\s*none/u);
    expect(styles).not.toMatch(/\.inkstone-ink-canvas-active\s*\{[^}]*touch-action:\s*none/u);
  });

  it('removes the native horizontal track in Fit without disabling manual zoom scrolling', () => {
    expect(styles).toMatch(/\.inkstone-ink-host\.is-ink-fit\s*\{[^}]*overflow-x:\s*hidden/u);
    expect(styles).not.toMatch(/\.inkstone-ink-host\s*\{[^}]*overflow-x:\s*hidden/u);
  });

  it('keeps Ink toolbar icons in one visual slot and every narrow control reachable', () => {
    expect(styles).toMatch(
      /\.inkstone-icon-button__icon\s*\{[^}]*display:\s*inline-flex[^}]*width:\s*18px[^}]*height:\s*18px/u,
    );
    expect(styles).toMatch(
      /\.inkstone-icon-button__icon\s*>\s*svg\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/u,
    );
    expect(styles).toMatch(
      /\.inkstone-ink-controls\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/u,
    );
    expect(styles).not.toMatch(/\.inkstone-ink-controls\s*\{[^}]*overflow:\s*hidden/u);
  });

  it('does not draw an empty double-divider slot between the drag handle and Done action', () => {
    const doneRule = styles.match(/\.inkstone-ink-controls__done\s*\{([^}]*)\}/u)?.[1] ?? '';
    const dragRule = styles.match(/\.inkstone-ink-controls__drag-handle\s*\{([^}]*)\}/u)?.[1] ?? '';

    expect(doneRule).not.toMatch(/margin-left|border-left/u);
    expect(dragRule).not.toMatch(/margin-right|border-right/u);
  });
});
