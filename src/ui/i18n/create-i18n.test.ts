import { describe, expect, it } from 'vitest';

import { createI18n, normalizeLocale } from './create-i18n';

describe('Inkstone locale normalization', () => {
  it('uses Simplified Chinese only for the exact supported Chinese locale', () => {
    expect(normalizeLocale('zh')).toBe('zh');
    expect(normalizeLocale('ZH')).toBe('zh');
    expect(normalizeLocale('zh-TW')).toBe('en');
    expect(normalizeLocale('zh-HK')).toBe('en');
  });

  it('renders locale-specific copy with typed parameters', () => {
    expect(createI18n('en').t('sidebar.selectedCount', { count: 1 })).toBe('1 selected');
    expect(createI18n('en').t('sidebar.selectedCount', { count: 2 })).toBe('2 selected');
    expect(createI18n('zh').t('sidebar.selectedCount', { count: 2 })).toBe('已选择 2 项');
  });
});
