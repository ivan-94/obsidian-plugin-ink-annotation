import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

describe('production CSS architecture', () => {
  it('keeps one stylesheet organized into tokens, primitives, and feature sections', () => {
    expect(styles).toContain('/* tokens */');
    expect(styles).toContain('/* base / primitives */');
    expect(styles).toContain('/* features / Current File and Entire Vault sidebar */');
    expect(styles).toContain('/* features / Inspector and decision dialogs */');
    expect(styles).toContain('/* features / Snapshot markup toolbar */');
    expect(styles).toContain('/* features / bounded Snapshot Annotation editor */');
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
    expect(styles).toMatch(
      /\.inkstone-annotation-sidebar-view\s*\{[^}]*padding:\s*0\s*!important/u,
    );
    expect(styles).toMatch(
      /\.inkstone-sidebar\s*\{[^}]*--inkstone-sidebar-edge-padding:\s*12px[^}]*padding:\s*var\(--inkstone-sidebar-edge-padding\)/u,
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

  it('aligns the compact Vault toolbar controls with the header action size', () => {
    expect(styles).toMatch(
      /\.inkstone-sidebar--vault\s*\{[^}]*--inkstone-vault-toolbar-height:\s*var\(--inkstone-control-height\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-vault-search\s*\{[^}]*min-height:\s*var\(--inkstone-vault-toolbar-height\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-vault-toolbar\s*>\s*\.inkstone-icon-button\s*\{[^}]*min-width:\s*var\(--inkstone-vault-toolbar-height\)[^}]*min-height:\s*var\(--inkstone-vault-toolbar-height\)/u,
    );
  });

  it('resets iPad native search and button chrome inside plugin surfaces', () => {
    expect(styles).toMatch(
      /:is\(\s*\.inkstone-quick-toolbar,[\s\S]*?\.inkstone-ink-controls\s*\)\s*:is\(button,\s*input\[type='search'\],\s*input\[type='text'\],\s*textarea\)\s*\{[^}]*-webkit-appearance:\s*none[^}]*appearance:\s*none/u,
    );
    expect(styles).toMatch(
      /:is\(\.inkstone-sidebar__search,\s*\.inkstone-vault-search\)\s+input\[type='search'\]\s*\{[^}]*border-radius:\s*0/u,
    );
    expect(styles).toMatch(
      /\.inkstone-ink-controls\s+input\[type='color'\]\s*\{[^}]*-webkit-appearance:\s*none[^}]*appearance:\s*none[^}]*border-radius:\s*50%/u,
    );
    expect(styles).toMatch(
      /\.inkstone-ink-controls__width-preview\s*\{[^}]*background:\s*currentColor/u,
    );
    expect(styles).toMatch(
      /\.inkstone-ink-controls__width\s+select\s*\{[^}]*position:\s*absolute[^}]*opacity:\s*0/u,
    );
  });

  it('lets Inspector controls shrink within the iPad mobile panel', () => {
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector__editor-controls\s*\{[^}]*min-width:\s*0/u,
    );
    expect(styles).toMatch(/\.inkstone-annotation-inspector__segments\s*\{[^}]*min-width:\s*0/u);
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector__segments\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector\s+\.inkstone-annotation-inspector__segments\s+button\s*\{[^}]*min-width:\s*0/u,
    );
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector__styles\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*overflow:\s*hidden/u,
    );
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector__styles\s*>\s*\.inkstone-annotation-inspector__style\s*\{[^}]*min-width:\s*var\(--inkstone-control-height\)[^}]*max-width:\s*var\(--inkstone-control-height\)/u,
    );
    expect(styles).toMatch(
      /:is\([\s\S]*?\.inkstone-annotation-inspector[\s\S]*?\)\s*\.inkstone-icon-button\s*\{[^}]*min-width:\s*var\(--inkstone-control-height\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector\s+\.inkstone-annotation-inspector__save\s*\{[^}]*min-width:\s*82px/u,
    );
  });

  it('keeps a long overlap quote inside its choice row without covering the mark label', () => {
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector\s+\[data-inkstone-overlap-choice\]\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/u,
    );
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector\s+\[data-inkstone-overlap-choice\]\s*>\s*span:first-child\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/u,
    );
    expect(styles).toMatch(
      /\.inkstone-annotation-inspector\s+\[data-inkstone-overlap-choice\]\s*>\s*span:last-child\s*\{[^}]*white-space:\s*nowrap/u,
    );
  });

  it('keeps the Snapshot overlay below Obsidian frameless title bars', () => {
    expect(styles).toMatch(
      /body\.is-frameless:not\(\.is-fullscreen\):not\(\.is-mobile\)\s+\.inkstone-snapshot-editor\s*\{[^}]*top:\s*calc\(var\(--titlebar-height\)\s*\/\s*var\(--zoom-factor\)\)/u,
    );
    expect(styles).toMatch(
      /body\.is-frameless\.is-hidden-frameless:not\(\.is-fullscreen\):not\(\.is-mobile\)\s+\.inkstone-snapshot-editor\s*\{[^}]*top:\s*calc\(var\(--header-height\)\s*-\s*1px\)/u,
    );
  });

  it('reserves the iPad safe header and defaults the shared Ink toolbar to the bottom', () => {
    expect(styles).toMatch(
      /body\.is-mobile\s+\.inkstone-snapshot-editor\s*\{[^}]*--inkstone-snapshot-mobile-safe-top:\s*max\(24px,\s*env\(safe-area-inset-top\)\)[^}]*box-sizing:\s*border-box[^}]*padding-top:\s*var\(--inkstone-snapshot-mobile-safe-top\)/u,
    );
    expect(styles).toMatch(
      /body\.is-mobile\s+\.inkstone-ink-controls\s*\{[^}]*top:\s*auto[^}]*bottom:\s*max\(8px,\s*env\(safe-area-inset-bottom\)\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-snapshot-editor__close\s*\{[^}]*min-width:\s*40px[^}]*min-height:\s*40px/u,
    );
  });

  it('keeps persistent Inkstone text annotations visible while a Snapshot is captured', () => {
    expect(styles).not.toMatch(/\.is-inkstone-snapshot-capturing\s+\[class\*=['"]inkstone-['"]\]/u);
  });

  it('lets the Snapshot camera own centering from the viewport origin', () => {
    expect(styles).toMatch(
      /\.inkstone-snapshot-editor__viewport\s*\{[^}]*position:\s*relative[^}]*display:\s*block[^}]*overflow:\s*hidden/u,
    );
    expect(styles).toMatch(
      /\.inkstone-snapshot-editor__frame\s*\{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*left:\s*0[^}]*width:\s*var\(--inkstone-snapshot-width\)/u,
    );
  });

  it('adapts the shared sidebar by container width instead of viewport width', () => {
    expect(styles).toMatch(
      /\.inkstone-annotation-sidebar-view\s*\{[^}]*container-name:\s*inkstone-sidebar[^}]*container-type:\s*inline-size/u,
    );
    expect(styles).toContain('@container inkstone-sidebar (max-width: 380px)');
    expect(styles).toContain('@container inkstone-sidebar (max-width: 300px)');
    expect(styles).toMatch(
      /@container inkstone-sidebar \(max-width:\s*300px\)[\s\S]*?\.inkstone-sidebar__scope-label\s*\{[^}]*display:\s*none/u,
    );
    expect(styles).toMatch(
      /@container inkstone-sidebar \(max-width:\s*380px\)[\s\S]*?--inkstone-sidebar-compact-control-size:\s*30px/u,
    );
    expect(styles).toMatch(
      /@container inkstone-sidebar \(max-width:\s*380px\)[\s\S]*?--inkstone-sidebar-row-min-height:\s*58px/u,
    );
    expect(styles).toMatch(
      /@container inkstone-sidebar \(max-width:\s*380px\)[\s\S]*?\.inkstone-sidebar__search\s*\{[^}]*min-height:\s*var\(--inkstone-sidebar-compact-control-size\)/u,
    );
    expect(styles).toMatch(
      /@container inkstone-sidebar \(max-width:\s*380px\)[\s\S]*?\.inkstone-sidebar-ink-row\s+img\s*\{[^}]*width:\s*44px[^}]*height:\s*34px/u,
    );
  });

  it('lays out Current file Snapshot cards as a two-column masonry with a narrow fallback', () => {
    expect(styles).toMatch(
      /\.inkstone-snapshot-masonry\s*\{[^}]*column-count:\s*2[^}]*column-gap:\s*8px/u,
    );
    expect(styles).toMatch(
      /@container inkstone-sidebar \(max-width:\s*280px\)[\s\S]*?\.inkstone-snapshot-masonry\s*\{[^}]*column-count:\s*1/u,
    );
    expect(styles).toMatch(
      /\.inkstone-snapshot-row\s*\{[^}]*width:\s*100%[^}]*break-inside:\s*avoid/u,
    );
  });

  it('contains Snapshot cards inside narrow leaves and fills thumbnails with cover cropping', () => {
    expect(styles).toMatch(
      /\.inkstone-annotation-sidebar-view\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/u,
    );
    expect(styles).toMatch(
      /\.inkstone-snapshot-card\s*\{[^}]*box-sizing:\s*border-box[^}]*min-width:\s*0[^}]*max-width:\s*100%/u,
    );
    expect(styles).toMatch(
      /\.inkstone-snapshot-card__thumbnail\s*>\s*img\s*\{[^}]*object-fit:\s*cover/u,
    );
  });

  it('keeps Snapshot cards and their overlay controls flat', () => {
    expect(styles).toMatch(/\.inkstone-snapshot-card\s*\{[^}]*box-shadow:\s*none/u);
    expect(styles).toMatch(/\.inkstone-snapshot-card\.is-active\s*\{[^}]*box-shadow:\s*none/u);
    expect(styles).toMatch(/\.inkstone-snapshot-card__summary\s*\{[^}]*box-shadow:\s*none/u);
    expect(styles).toMatch(/\.inkstone-snapshot-card__actions\s*\{[^}]*box-shadow:\s*none/u);
  });

  it('anchors the Snapshot selection control in the overflow slot with explicit states', () => {
    expect(styles).toMatch(
      /\.inkstone-snapshot-card__selection\s*\{[^}]*position:\s*absolute[^}]*top:\s*8px[^}]*right:\s*8px[^}]*width:\s*32px[^}]*height:\s*32px/u,
    );
    expect(styles).toMatch(
      /\.inkstone-snapshot-card__selection\.is-selected\s*\{[^}]*background:\s*var\(--interactive-accent\)[^}]*border-color:\s*var\(--interactive-accent\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-snapshot-card__selection:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--interactive-accent\)/u,
    );
  });

  it('keeps Vault toolbar-to-results spacing compact without an empty chip row', () => {
    expect(styles).toMatch(/\.inkstone-sidebar--vault\s*\{[^}]*gap:\s*6px/u);
  });

  it('uses compact type for Vault file headers and count badges', () => {
    expect(styles).toMatch(
      /\.inkstone-vault-group-header__toggle\s+strong\s*\{[^}]*font-size:\s*var\(--font-ui-smaller\)/u,
    );
    expect(styles).toMatch(
      /\.inkstone-vault-group-header__count\s*\{[^}]*min-width:\s*20px[^}]*font-size:\s*var\(--font-ui-smaller\)/u,
    );
  });

  it('keeps Vault checkboxes trailing and shares Current file selection feedback', () => {
    expect(styles).toMatch(
      /\.inkstone-vault-row\[data-inkstone-bulk-selection='true'\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s*;/u,
    );
    expect(styles).toMatch(
      /:is\(\.inkstone-sidebar-row,\s*\.inkstone-sidebar-ink-row,\s*\.inkstone-vault-row\)\[aria-selected='true'\]\s*\{[^}]*background:\s*color-mix[^}]*border-color:\s*color-mix[^}]*box-shadow:\s*inset\s+3px/u,
    );
  });

  it('uses one shared visual contract for every list-item action trigger', () => {
    expect(styles).toMatch(
      /\.inkstone-list-item__action-trigger\s*\{[^}]*min-width:\s*30px[^}]*min-height:\s*30px[^}]*border:\s*0\s*!important/u,
    );
    expect(styles).not.toContain('.inkstone-vault-row > .inkstone-icon-button');
    expect(styles).not.toContain('.inkstone-sidebar-row__actions > .inkstone-icon-button');
    expect(styles).not.toContain('.inkstone-sidebar-ink-row__actions .inkstone-icon-button {');
    expect(styles).not.toContain('.inkstone-sidebar__overflow-menu');
    expect(styles).not.toContain('.inkstone-sidebar-row__menu');
    expect(styles).not.toContain('.inkstone-sidebar-ink-row__menu');
    expect(styles).not.toContain('.inkstone-vault-row__menu');
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
