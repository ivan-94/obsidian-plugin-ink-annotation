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

  it('localizes command names and parameterized notices', () => {
    expect(createI18n('en').t('command.openAnnotations')).toBe('Open annotations for current file');
    expect(createI18n('zh').t('command.openAnnotations')).toBe('打开当前文件的标注');
    expect(createI18n('zh').t('notice.backgroundCleanupFailed', { count: 3 })).toBe(
      'Inkstone 无法清理 3 个后台任务。',
    );
  });
});
