// @vitest-environment jsdom

import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { createI18n } from './create-i18n';
import { I18nProvider, useI18n } from './locale-context';

describe('Preact i18n context', () => {
  afterEach(() => document.body.replaceChildren());

  it('makes one injected locale available to an island subtree', () => {
    const container = document.createElement('div');
    document.body.append(container);

    render(
      <I18nProvider i18n={createI18n('zh')}>
        <SelectedCount />
      </I18nProvider>,
      container,
    );

    expect(container.textContent).toBe('已选择 2 项');
  });
});

function SelectedCount() {
  const i18n = useI18n();
  return <span>{i18n.t('sidebar.selectedCount', { count: 2 })}</span>;
}
