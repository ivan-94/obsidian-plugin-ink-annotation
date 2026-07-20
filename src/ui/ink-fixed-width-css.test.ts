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

  it('stacks stable and mutable Active Stroke layers without capturing input', () => {
    const activeStackRule = styles.match(/\.inkstone-ink-active-stack\s*\{([^}]*)\}/u)?.[1] ?? '';

    expect(activeStackRule).toMatch(/position:\s*absolute/u);
    expect(activeStackRule).toMatch(/inset:\s*0/u);
    expect(activeStackRule).toMatch(/pointer-events:\s*none/u);
  });

  it('keeps the pane-wide surface pointer-transparent so native Reading View scrolling remains available', () => {
    expect(styles).toMatch(/\.inkstone-ink-surface\s*\{[^}]*pointer-events:\s*none/u);
    expect(styles).not.toMatch(
      /\.is-ink-(?:mode|preview)\s+\.inkstone-ink-surface\s*\{[^}]*pointer-events:\s*auto/u,
    );
    expect(styles).not.toMatch(/\.is-ink-mode\s+\.inkstone-ink-surface\s*\{[^}]*touch-action:/u);
  });

  it('does not turn Apple Pencil input into native touch scrolling', () => {
    expect(styles).not.toMatch(/(?:^|\})\s*\.inkstone-ink-workspace\s*\{[^}]*user-select:\s*none/u);
    expect(styles).not.toMatch(
      /\.is-ink-mode\s+\.inkstone-ink-workspace\s*\{[^}]*user-select:\s*none/u,
    );
    expect(styles).not.toMatch(
      /\.is-ink-mode\s+\.inkstone-ink-workspace\s*\{[^}]*touch-action:\s*none/u,
    );
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

  it('uses the full visible brush-width control as a native dropdown hit target', () => {
    expect(styles).toMatch(
      /\.inkstone-ink-controls__width\s+select\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%[^}]*opacity:\s*0/u,
    );
    expect(styles).toMatch(
      /\.inkstone-ink-controls__width-preview\s*\{[^}]*width:\s*16px[^}]*min-height:\s*1px[^}]*border-radius:\s*999px/u,
    );
    expect(styles).not.toContain('inkstone-ink-controls__width-sample');
  });

  it('does not draw an empty double-divider slot between the drag handle and Done action', () => {
    const doneRule = styles.match(/\.inkstone-ink-controls__done\s*\{([^}]*)\}/u)?.[1] ?? '';
    const dragRule = styles.match(/\.inkstone-ink-controls__drag-handle\s*\{([^}]*)\}/u)?.[1] ?? '';

    expect(doneRule).not.toMatch(/margin-left|border-left/u);
    expect(dragRule).not.toMatch(/margin-right|border-right/u);
  });

  it('distinguishes Preview, Edit, hidden Ink, saving, and error on the next-action button', () => {
    expect(styles).toMatch(
      /\.view-action\[data-inkstone-ink-action='true'\]\.is-preview\s*\{[^}]*color:\s*var\(--interactive-accent\)[^}]*background:\s*color-mix/u,
    );
    expect(styles).toMatch(
      /\.view-action\[data-inkstone-ink-action='true'\]\.is-active,\s*\.view-action\[data-inkstone-ink-action='true'\]\.is-active:hover\s*\{[^}]*color:\s*var\(--text-on-accent\)[^}]*background:\s*var\(--interactive-accent\)/u,
    );
    expect(styles).toMatch(
      /\.view-action\[data-inkstone-ink-action='true'\]\.has-hidden-ink::after\s*\{[^}]*background:\s*var\(--interactive-accent\)/u,
    );
    expect(styles).toMatch(
      /\.view-action\[data-inkstone-ink-action='true'\]\.is-pending\s+svg\s*\{[^}]*animation:\s*inkstone-spin/u,
    );
    expect(styles).toMatch(
      /\.view-action\[data-inkstone-ink-action='true'\]\.is-error\s*\{[^}]*color:\s*var\(--text-error\)/u,
    );
  });
});
