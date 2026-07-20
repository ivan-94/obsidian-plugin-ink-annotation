export const INK_PRESENTATION_HANDOFF_DURATION_MS = 140;
const INK_PRESENTATION_HANDOFF_FALLBACK_GRACE_MS = 100;

const HANDOFF_CLASS = 'is-ink-presentation-handoff';
const ENTERING_CLASS = 'is-ink-presentation-entering';
const LEAVING_CLASS = 'is-ink-presentation-leaving';

/** Stages an incoming fixed presentation layer without hiding the outgoing exact pixels. */
export function stageInkPresentationHandoff(layer: HTMLElement): void {
  layer.classList.add(HANDOFF_CLASS, ENTERING_CLASS);
}

/** Primes the visible outgoing layer so its later opacity change stays compositor-only. */
export function primeInkPresentationHandoff(layer: HTMLElement): void {
  layer.classList.add(HANDOFF_CLASS);
}

/**
 * Cross-fades two already-painted presentation layers on the compositor. Canvas work and caller
 * lifecycle completion never wait for this best-effort visual handoff.
 */
export function crossfadeInkPresentationHandoff(input: {
  readonly incoming: HTMLElement;
  readonly onSettled: () => void;
  readonly outgoing: HTMLElement;
  readonly reducedMotion?: boolean;
}): () => void {
  const { incoming, onSettled, outgoing } = input;
  const view = incoming.ownerDocument.defaultView;
  let settled = false;
  let timer: number | null = null;

  const cleanupClasses = (): void => {
    incoming.classList.remove(HANDOFF_CLASS, ENTERING_CLASS, LEAVING_CLASS);
    outgoing.classList.remove(HANDOFF_CLASS, ENTERING_CLASS, LEAVING_CLASS);
  };
  const removeListeners = (): void => {
    incoming.removeEventListener('transitionend', onTransitionEnd);
    outgoing.removeEventListener('transitionend', onTransitionEnd);
    if (timer !== null) view?.clearTimeout(timer);
    timer = null;
  };
  const finish = (): void => {
    if (settled) return;
    settled = true;
    removeListeners();
    cleanupClasses();
    onSettled();
  };
  const onTransitionEnd = (event: Event): void => {
    const propertyName = (event as TransitionEvent).propertyName;
    if (propertyName !== '' && propertyName !== 'opacity') return;
    finish();
  };

  incoming.classList.add(HANDOFF_CLASS);
  outgoing.classList.add(HANDOFF_CLASS, LEAVING_CLASS);
  incoming.classList.remove(ENTERING_CLASS, LEAVING_CLASS);

  const reducedMotion =
    input.reducedMotion ?? view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reducedMotion || view === null) {
    finish();
    return () => undefined;
  }

  incoming.addEventListener('transitionend', onTransitionEnd);
  outgoing.addEventListener('transitionend', onTransitionEnd);
  timer = view.setTimeout(
    finish,
    INK_PRESENTATION_HANDOFF_DURATION_MS + INK_PRESENTATION_HANDOFF_FALLBACK_GRACE_MS,
  );

  return () => {
    if (settled) return;
    settled = true;
    removeListeners();
    cleanupClasses();
  };
}
