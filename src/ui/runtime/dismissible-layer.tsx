import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo } from 'preact/hooks';

import type { ObsidianUiEnvironment } from './obsidian-ui-environment';

export type DismissReason = 'escape' | 'outside' | 'scroll';

export interface DismissibleLayerRegistration {
  readonly dismissOnScroll?: boolean;
  readonly element: HTMLElement;
  readonly exclusiveGroup?: string;
  readonly onDismiss: (reason: DismissReason) => boolean | void | Promise<boolean | void>;
  readonly returnFocus?: HTMLElement;
  readonly trigger?: HTMLElement;
}

export interface DismissibleMenuController {
  readonly close: () => void;
  readonly dispose: () => void;
  readonly open: () => void;
  readonly toggle: () => boolean;
}

interface RegisteredLayer extends DismissibleLayerRegistration {
  pending: boolean;
}

interface LayerRegistry {
  readonly document: Document;
  installed: boolean;
  readonly stack: RegisteredLayer[];
}

const registries = new WeakMap<Document, LayerRegistry>();
let menuSequence = 0;

export function registerDismissibleLayer(
  document: Document,
  registration: DismissibleLayerRegistration,
): () => void {
  const registry = registryFor(document);
  const layer: RegisteredLayer = { ...registration, pending: false };
  registry.stack.push(layer);
  installRegistry(registry);
  return () => {
    const index = registry.stack.indexOf(layer);
    if (index >= 0) registry.stack.splice(index, 1);
    if (registry.stack.length === 0) uninstallRegistry(registry);
  };
}

export function createDismissibleMenuController(input: {
  readonly document: Document;
  readonly menu: HTMLElement;
  readonly trigger: HTMLElement;
}): DismissibleMenuController {
  if (input.menu.id.length === 0) {
    menuSequence += 1;
    input.menu.id = `inkstone-dismissible-menu-${menuSequence}`;
  }
  input.menu.dataset.inkstoneDismissibleMenu = '';
  input.trigger.setAttribute('aria-controls', input.menu.id);
  input.trigger.setAttribute('aria-expanded', String(!input.menu.hidden));
  let unregister: (() => void) | null = null;
  const close = (): void => {
    unregister?.();
    unregister = null;
    input.menu.hidden = true;
    input.trigger.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    closeDismissibleLayerGroup(input.document, 'menu');
    input.menu.hidden = false;
    input.trigger.setAttribute('aria-expanded', 'true');
    unregister = registerDismissibleLayer(input.document, {
      element: input.menu,
      exclusiveGroup: 'menu',
      onDismiss: close,
      returnFocus: input.trigger,
      trigger: input.trigger,
    });
  };
  const toggle = (): boolean => {
    const shouldOpen = input.menu.hidden === true;
    if (shouldOpen) open();
    else close();
    return shouldOpen;
  };
  const handleMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
    input.trigger.focus({ preventScroll: true });
  };
  input.menu.addEventListener('keydown', handleMenuKeyDown);
  const dispose = (): void => {
    close();
    input.menu.removeEventListener('keydown', handleMenuKeyDown);
  };
  return { close, dispose, open, toggle };
}

export function DismissibleLayer({
  children,
  dismissOnScroll = false,
  environment,
  onDismiss,
  returnFocus,
  trigger,
}: {
  readonly children: ComponentChildren;
  readonly dismissOnScroll?: boolean;
  readonly environment: ObsidianUiEnvironment;
  readonly onDismiss: DismissibleLayerRegistration['onDismiss'];
  readonly returnFocus?: HTMLElement;
  readonly trigger?: HTMLElement;
}) {
  const host = useMemo(() => {
    const element = environment.document.createElement('div');
    element.dataset.inkstoneDismissibleLayer = '';
    return element;
  }, [environment.document]);

  useLayoutEffect(() => {
    environment.portalRoot.append(host);
    const unregister = registerDismissibleLayer(environment.document, {
      dismissOnScroll,
      element: host,
      onDismiss,
      ...(returnFocus === undefined ? {} : { returnFocus }),
      ...(trigger === undefined ? {} : { trigger }),
    });
    return () => {
      unregister();
      render(null, host);
      host.remove();
    };
  }, [
    dismissOnScroll,
    environment.document,
    environment.portalRoot,
    host,
    onDismiss,
    returnFocus,
    trigger,
  ]);

  useLayoutEffect(() => {
    render(<>{children}</>, host);
  }, [children, host]);

  return null;
}

function registryFor(document: Document): LayerRegistry {
  const existing = registries.get(document);
  if (existing !== undefined) return existing;
  const registry: LayerRegistry = { document, installed: false, stack: [] };
  registries.set(document, registry);
  return registry;
}

function installRegistry(registry: LayerRegistry): void {
  if (registry.installed) return;
  registry.installed = true;
  registry.document.addEventListener('pointerdown', handlePointerDown, true);
  registry.document.addEventListener('keydown', handleKeyDown, true);
  registry.document.addEventListener('scroll', handleScroll, true);
}

function uninstallRegistry(registry: LayerRegistry): void {
  if (!registry.installed) return;
  registry.installed = false;
  registry.document.removeEventListener('pointerdown', handlePointerDown, true);
  registry.document.removeEventListener('keydown', handleKeyDown, true);
  registry.document.removeEventListener('scroll', handleScroll, true);
}

function handlePointerDown(event: PointerEvent): void {
  const document = event.currentTarget as Document;
  const layer = topLayer(document);
  if (layer === undefined) return;
  const target = event.target;
  if (
    isNode(target) &&
    (layer.element.contains(target) || layer.trigger?.contains(target) === true)
  ) {
    return;
  }
  requestDismiss(layer, 'outside');
}

function isNode(value: EventTarget | null): value is Node {
  return value !== null && 'nodeType' in value;
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const layer = topLayer(event.currentTarget as Document);
  if (layer === undefined) return;
  event.preventDefault();
  requestDismiss(layer, 'escape');
}

function handleScroll(event: Event): void {
  const layer = topLayer(event.currentTarget as Document);
  if (layer?.dismissOnScroll === true) requestDismiss(layer, 'scroll');
}

function topLayer(document: Document): RegisteredLayer | undefined {
  return registries.get(document)?.stack.at(-1);
}

function closeDismissibleLayerGroup(document: Document, group: string): void {
  const stack = registries.get(document)?.stack;
  if (stack === undefined) return;
  for (const layer of [...stack].reverse()) {
    if (layer.exclusiveGroup === group) requestDismiss(layer, 'outside');
  }
}

function requestDismiss(layer: RegisteredLayer, reason: DismissReason): void {
  if (layer.pending) return;
  layer.pending = true;
  let result: boolean | void | Promise<boolean | void>;
  try {
    result = layer.onDismiss(reason);
  } catch {
    layer.pending = false;
    return;
  }
  if (isPromiseLike(result)) {
    void result.then(
      (dismissed) => finishDismiss(layer, dismissed),
      () => {
        layer.pending = false;
      },
    );
    return;
  }
  finishDismiss(layer, result);
}

function finishDismiss(layer: RegisteredLayer, dismissed: boolean | void): void {
  layer.pending = false;
  if (dismissed === false) return;
  layer.returnFocus?.focus({ preventScroll: true });
}

function isPromiseLike(
  value: boolean | void | Promise<boolean | void>,
): value is Promise<boolean | void> {
  return typeof value === 'object' && value !== null && 'then' in value;
}
