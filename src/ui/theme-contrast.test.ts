import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('theme contrast contract', () => {
  it('keeps a dedicated outline for plugin controls when themes replace button shadows', () => {
    const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

    expect(styles).toMatch(
      /\.inkstone-ink-controls\s+:is\(button,\s*input,\s*select,\s*textarea\):focus-visible/su,
    );
    expect(styles).toMatch(
      /\.inkstone-sidebar\s+:is\(button,\s*input,\s*select,\s*textarea\):focus-visible/su,
    );
    expect(styles).toMatch(/outline:\s*2px solid var\(--interactive-accent\)/su);
  });

  it('uses the stable theme body color inside filled Reading and Live Preview highlights', () => {
    const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

    expect(styles).toMatch(/\.inkstone-text-highlight\s*\{[^}]*color:\s*var\(--text-normal\)/su);
    expect(styles).toMatch(/\.inkstone-editor-highlight\s*\{[^}]*color:\s*var\(--text-normal\)/su);
    expect(styles).toMatch(/\.inkstone-text-highlight--underline-only\s*\{[^}]*color:\s*inherit/su);
    expect(styles).toMatch(
      /\.inkstone-editor-highlight\.inkstone-editor-underline-only\s*\{[^}]*color:\s*inherit/su,
    );
  });

  it('uses a lower highlight tint in dark themes so light body text stays readable', () => {
    const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

    expect(styles).toMatch(
      /\.theme-dark\s+\.inkstone-text-highlight\s*\{[^}]*var\(--text-highlight-bg\)\s+36%/su,
    );
    expect(styles).toMatch(
      /\.theme-dark\s+\.inkstone-editor-highlight\s*\{[^}]*var\(--inkstone-editor-color\)\s+30%/su,
    );
  });

  it('keeps alerts and compact problem headers readable across host theme colors', () => {
    const styles = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

    expect(styles).toMatch(
      /\.inkstone-sidebar__storage-alert\s*\{[^}]*color:\s*var\(--text-normal\)/su,
    );
    expect(styles).toMatch(
      /\.inkstone-sidebar-group--problems\s*>\s*h3\s*\{[^}]*color:\s*var\(--text-warning,\s*var\(--color-orange\)\)[^}]*background:\s*color-mix\([^}]*var\(--color-orange\)[^}]*var\(--background-primary\)/su,
    );
    expect(styles).toMatch(
      /\.inkstone-metadata-line__token--warning[^}]*\{[^}]*color:\s*var\(--text-warning,\s*var\(--color-orange\)\)/su,
    );
  });
});
