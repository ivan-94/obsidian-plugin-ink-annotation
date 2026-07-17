export type AnchoredLayerPlacement = 'above' | 'below';

export interface AnchoredLayerAnchorRect {
  readonly bottom: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface LayerSize {
  readonly height: number;
  readonly width: number;
}

export interface ViewportBounds {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface AnchoredLayerPosition {
  readonly left: number;
  readonly placement: AnchoredLayerPlacement;
  readonly top: number;
}

export function calculateAnchoredLayerPosition(input: {
  readonly anchorRect: AnchoredLayerAnchorRect;
  readonly gap?: number;
  readonly layerSize: LayerSize;
  readonly margin?: number;
  readonly preferredPlacement: AnchoredLayerPlacement;
  readonly viewport: ViewportBounds;
}): AnchoredLayerPosition {
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 12;
  const safeLeft = input.viewport.left + margin;
  const safeTop = input.viewport.top + margin;
  const safeRight = input.viewport.left + input.viewport.width - margin;
  const safeBottom = input.viewport.top + input.viewport.height - margin;
  const maximumLeft = Math.max(safeLeft, safeRight - input.layerSize.width);
  const maximumTop = Math.max(safeTop, safeBottom - input.layerSize.height);
  const desiredLeft =
    input.anchorRect.left + input.anchorRect.width / 2 - input.layerSize.width / 2;
  const aboveTop = input.anchorRect.top - gap - input.layerSize.height;
  const belowTop = input.anchorRect.bottom + gap;
  const fitsAbove = aboveTop >= safeTop;
  const fitsBelow = belowTop + input.layerSize.height <= safeBottom;
  const placement = resolvePlacement({
    anchorRect: input.anchorRect,
    fitsAbove,
    fitsBelow,
    gap,
    preferredPlacement: input.preferredPlacement,
    safeBottom,
    safeTop,
  });
  const preferredTop = placement === 'above' ? aboveTop : belowTop;

  return {
    left: Math.round(clamp(desiredLeft, safeLeft, maximumLeft)),
    placement,
    top: Math.round(clamp(preferredTop, safeTop, maximumTop)),
  };
}

export function positionAnchoredElement(input: {
  readonly anchorRect: AnchoredLayerAnchorRect;
  readonly document: Document;
  readonly element: HTMLElement;
  readonly gap?: number;
  readonly margin?: number;
  readonly preferredPlacement: AnchoredLayerPlacement;
}): AnchoredLayerPosition {
  const viewport = viewportBounds(input.document);
  const margin = input.margin ?? 12;
  input.element.style.setProperty(
    '--inkstone-anchored-max-height',
    `${Math.max(0, viewport.height - margin * 2)}px`,
  );
  input.element.style.setProperty(
    '--inkstone-anchored-max-width',
    `${Math.max(0, viewport.width - margin * 2)}px`,
  );
  const bounds = input.element.getBoundingClientRect();
  const position = calculateAnchoredLayerPosition({
    anchorRect: input.anchorRect,
    ...(input.gap === undefined ? {} : { gap: input.gap }),
    layerSize: {
      height: bounds.height || input.element.offsetHeight,
      width: bounds.width || input.element.offsetWidth,
    },
    ...(input.margin === undefined ? {} : { margin: input.margin }),
    preferredPlacement: input.preferredPlacement,
    viewport,
  });
  input.element.style.left = `${position.left}px`;
  input.element.style.top = `${position.top}px`;
  input.element.dataset.inkstonePlacement = position.placement;
  return position;
}

export function observeAnchoredElement(input: {
  readonly anchorRect: AnchoredLayerAnchorRect;
  readonly document: Document;
  readonly element: HTMLElement;
  readonly gap?: number;
  readonly margin?: number;
  readonly preferredPlacement: AnchoredLayerPlacement;
}): () => void {
  const update = (): void => {
    positionAnchoredElement(input);
  };
  const ownerWindow = input.document.defaultView;
  const visualViewport = ownerWindow?.visualViewport;
  const ResizeObserverConstructor = ownerWindow?.ResizeObserver;
  const resizeObserver =
    ResizeObserverConstructor === undefined
      ? null
      : new ResizeObserverConstructor(() => {
          update();
        });

  update();
  resizeObserver?.observe(input.element);
  ownerWindow?.addEventListener('resize', update);
  visualViewport?.addEventListener('resize', update);
  visualViewport?.addEventListener('scroll', update);

  return () => {
    resizeObserver?.disconnect();
    ownerWindow?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('scroll', update);
  };
}

export function observeViewportBottomActionBar(input: {
  readonly document: Document;
  readonly element: HTMLElement;
  readonly margin?: number;
}): () => void {
  const margin = input.margin ?? 12;
  const update = (): void => {
    const viewport = viewportBounds(input.document);
    const maximumWidth = Math.max(0, viewport.width - margin * 2);
    input.element.style.setProperty('--inkstone-anchored-max-width', `${maximumWidth}px`);
    const bounds = input.element.getBoundingClientRect();
    const layerWidth = Math.min(maximumWidth, bounds.width || input.element.offsetWidth);
    const layerHeight = Math.min(viewport.height, bounds.height || input.element.offsetHeight);
    const viewportBottom = viewport.top + viewport.height;
    const mobileNavbar = input.document.querySelector<HTMLElement>('.mobile-navbar');
    const navbarBounds = mobileNavbar?.getBoundingClientRect();
    const availableBottom =
      navbarBounds !== undefined &&
      navbarBounds.top > viewport.top &&
      navbarBounds.top < viewportBottom &&
      navbarBounds.bottom >= viewportBottom - margin
        ? navbarBounds.top
        : viewportBottom;
    const left = viewport.left + Math.max(margin, (viewport.width - layerWidth) / 2);
    const top = Math.max(viewport.top + margin, availableBottom - margin - layerHeight);
    input.element.style.bottom = 'auto';
    input.element.style.left = `${Math.round(left)}px`;
    input.element.style.right = 'auto';
    input.element.style.top = `${Math.round(top)}px`;
    input.element.dataset.inkstonePlacement = 'bottom-action-bar';
  };
  const ownerWindow = input.document.defaultView;
  const visualViewport = ownerWindow?.visualViewport;
  const ResizeObserverConstructor = ownerWindow?.ResizeObserver;
  const resizeObserver =
    ResizeObserverConstructor === undefined
      ? null
      : new ResizeObserverConstructor(() => {
          update();
        });

  update();
  resizeObserver?.observe(input.element);
  ownerWindow?.addEventListener('resize', update);
  visualViewport?.addEventListener('resize', update);
  visualViewport?.addEventListener('scroll', update);

  return () => {
    resizeObserver?.disconnect();
    ownerWindow?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('scroll', update);
  };
}

export function viewportBounds(document: Document): ViewportBounds {
  const visualViewport = document.defaultView?.visualViewport;
  if (visualViewport !== undefined && visualViewport !== null) {
    return {
      height: visualViewport.height,
      left: visualViewport.offsetLeft,
      top: visualViewport.offsetTop,
      width: visualViewport.width,
    };
  }
  return {
    height: document.documentElement.clientHeight,
    left: 0,
    top: 0,
    width: document.documentElement.clientWidth,
  };
}

function resolvePlacement(input: {
  readonly anchorRect: AnchoredLayerAnchorRect;
  readonly fitsAbove: boolean;
  readonly fitsBelow: boolean;
  readonly gap: number;
  readonly preferredPlacement: AnchoredLayerPlacement;
  readonly safeBottom: number;
  readonly safeTop: number;
}): AnchoredLayerPlacement {
  const preferredFits = input.preferredPlacement === 'above' ? input.fitsAbove : input.fitsBelow;
  if (preferredFits) return input.preferredPlacement;
  const alternate = input.preferredPlacement === 'above' ? 'below' : 'above';
  const alternateFits = alternate === 'above' ? input.fitsAbove : input.fitsBelow;
  if (alternateFits) return alternate;
  const aboveSpace = input.anchorRect.top - input.gap - input.safeTop;
  const belowSpace = input.safeBottom - input.anchorRect.bottom - input.gap;
  return aboveSpace >= belowSpace ? 'above' : 'below';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
