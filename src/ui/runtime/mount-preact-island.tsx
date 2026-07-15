import { createElement, render, type Attributes, type ComponentType } from 'preact';

export interface UiIsland<Props> {
  mount(container: HTMLElement, props: Props): void;
  update(props: Props): void;
  unmount(): void;
}

export function createPreactIsland<Props>(component: ComponentType<Props>): UiIsland<Props> {
  let container: HTMLElement | null = null;

  const renderProps = (props: Props): void => {
    if (container === null) {
      throw new Error('Cannot update a Preact UI island before it is mounted.');
    }
    render(createElement(component, props as Attributes & Props), container);
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
