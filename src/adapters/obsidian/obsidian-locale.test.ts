import { describe, expect, it } from 'vitest';

import { resolveObsidianLocale } from './obsidian-locale';

describe('Obsidian locale adapter', () => {
  it('uses the public configured language when it is available', () => {
    expect(
      resolveObsidianLocale({
        getLanguage: () => 'zh',
        momentLocale: () => 'en',
      }),
    ).toBe('zh');
  });

  it('falls back to the Moment locale on Obsidian 1.7.2', () => {
    expect(resolveObsidianLocale({ momentLocale: () => 'zh' })).toBe('zh');
  });
});
