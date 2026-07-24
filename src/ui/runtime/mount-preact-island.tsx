import { createElement, render, type Attributes, type ComponentType } from 'preact';

import type { I18n } from '../i18n/contract';
import { I18nProvider } from '../i18n/locale-context';

export interface UiIsland<Props> {
  mount(container: HTMLElement, props: Props): void;
  update(props: Props): void;
  unmount(): void;
}

export function createPreactIsland<Props>(
  component: ComponentType<Props>,
  options: { readonly i18n?: I18n } = {},
): UiIsland<Props> {
  let container: HTMLElement | null = null;

  const renderProps = (props: Props): void => {
    if (container === null) {
      throw new Error('Cannot update a Preact UI island before it is mounted.');
    }
    const content = createElement(component, props as Attributes & Props);
    render(
      options.i18n === undefined ? (
        content
      ) : (
        <I18nProvider i18n={options.i18n}>{content}</I18nProvider>
      ),
      container,
    );
  };

  return {
    mount(nextContainer, props) {
      if (container !== null) {
        render(null, container);
      }
      container = nextContainer;
      renderProps(props);
    },
    unmount() {
      if (container === null) return;
      render(null, container);
      container = null;
    },
    update(props) {
      renderProps(props);
    },
  };
}
