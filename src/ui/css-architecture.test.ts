import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

describe('production CSS architecture', () => {
  it('keeps one stylesheet organized into tokens, primitives, and feature sections', () => {
    expect(styles).toContain('/* tokens */');
    expect(styles).toContain('/* base / primitives */');
    expect(styles).toContain('/* features / Current File and Entire Vault sidebar */');
    expect(styles).toContain('/* features / Inspector and decision dialogs */');
    expect(styles).toContain('/* features / imperative Canvas and Preact Ink Toolbar */');
  });

  it('removes selectors belonging only to deleted imperative UI helpers', () => {
    expect(styles).not.toContain('.inkstone-icon-status');
    expect(styles).not.toContain('.inkstone-sidebar-row__edit');
    expect(styles).not.toContain('.inkstone-sidebar-row__details');
  });

  it('keeps inactive long-lived Scope hosts out of layout in Obsidian pop-out windows', () => {
    expect(styles).toContain('[data-inkstone-sidebar-scope-content][hidden]');
    expect(styles).toContain('[data-inkstone-sidebar-header-actions][hidden]');
    expect(styles).toMatch(
      /\[data-inkstone-sidebar-scope-content\]\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/u,
    );
  });

  it('gives the active Scope the remaining height without adding a second content inset', () => {
    expect(styles).toMatch(/\.inkstone-annotation-sidebar-view\s*\{[^}]*padding:\s*0/u);
    expect(styles).toMatch(
      /\.inkstone-sidebar\s*\{[^}]*--inkstone-sidebar-edge-padding:\s*8px[^}]*padding:\s*var\(--inkstone-sidebar-edge-padding\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-sidebar--preact\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/u,
    );
    expect(styles).toMatch(
      /\[data-inkstone-sidebar-content\]\s*\{[^}]*min-height:\s*0[^}]*height:\s*100%/u,
    );
    expect(styles).toMatch(
      /\[data-inkstone-sidebar-scope-content\]\s*\{[^}]*height:\s*100%[^}]*padding:\s*0/u,
    );
  });

  it('keeps full-height empty states as one centered content cluster', () => {
    expect(styles).toMatch(/\.inkstone-empty-state\s*\{[^}]*place-content:\s*center/u);
  });

  it('anchors Vault filters to the toolbar and centers the shared floating action dock', () => {
    expect(styles).toMatch(
      /\.inkstone-vault-filters--popover\s*\{[^}]*top:\s*calc\(var\(--inkstone-vault-toolbar-height\)\s*\+\s*8px\)[^}]*right:\s*0[^}]*left:\s*0/u,
    );
    expect(styles).toMatch(
      /\.inkstone-bulk-action-dock-host\s*\{[^}]*justify-content:\s*center[^}]*pointer-events:\s*none/u,
    );
    expect(styles).toMatch(
      /\.inkstone-bulk-action-dock\s*\{[^}]*max-width:\s*100%[^}]*border-radius:\s*999px[^}]*box-shadow:\s*none/u,
    );
  });

  it('keeps Vault checkboxes trailing and shares Current file selection feedback', () => {
    expect(styles).toMatch(
      /\.inkstone-vault-row\[data-inkstone-bulk-selection='true'\]\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/u,
    );
    expect(styles).toMatch(
      /:is\(\.inkstone-sidebar-row,\s*\.inkstone-sidebar-ink-row,\s*\.inkstone-vault-row\)\[aria-selected='true'\]\s*\{[^}]*background:\s*color-mix[^}]*border-color:\s*color-mix[^}]*box-shadow:\s*inset\s+3px/u,
    );
  });

  it('keeps the floating bulk toolbar icon-only and horizontally contained', () => {
    expect(styles).toMatch(
      /\.inkstone-bulk-action-dock\s+\.inkstone-icon-button\s*\{[^}]*width:\s*30px[^}]*min-width:\s*30px[^}]*padding:\s*0/u,
    );
    expect(styles).toMatch(
      /\.inkstone-bulk-action-dock__count\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/u,
    );
    expect(styles).toMatch(
      /\.inkstone-bulk-dialog\s*\{[^}]*width:\s*min\(320px,\s*calc\(100%\s*-\s*24px\)\)[^}]*box-shadow:\s*none/u,
    );
    expect(styles).toMatch(/\.inkstone-bulk-dialog__actions\s*\{[^}]*justify-content:\s*flex-end/u);
  });
});
