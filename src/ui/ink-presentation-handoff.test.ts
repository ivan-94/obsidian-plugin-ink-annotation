// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  crossfadeInkPresentationHandoff,
  stageInkPresentationHandoff,
} from './ink-presentation-handoff';

describe('Ink presentation handoff', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the outgoing pixels until the compositor opacity transition settles', () => {
    vi.useFakeTimers();
    const incoming = document.createElement('div');
    const outgoing = document.createElement('div');
    const settled = vi.fn();

    stageInkPresentationHandoff(incoming);
    expect(incoming.classList.contains('is-ink-presentation-entering')).toBe(true);

    crossfadeInkPresentationHandoff({ incoming, onSettled: settled, outgoing });

    expect(incoming.classList.contains('is-ink-presentation-entering')).toBe(false);
    expect(incoming.classList.contains('is-ink-presentation-handoff')).toBe(true);
    expect(outgoing.classList.contains('is-ink-presentation-leaving')).toBe(true);
    expect(settled).not.toHaveBeenCalled();

    vi.advanceTimersByTime(139);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).not.toHaveBeenCalled();

    const transitionEnd = new Event('transitionend') as TransitionEvent;
    Object.defineProperty(transitionEnd, 'propertyName', { value: 'opacity' });
    incoming.dispatchEvent(transitionEnd);

    expect(settled).toHaveBeenCalledOnce();
    expect(incoming.classList.contains('is-ink-presentation-handoff')).toBe(false);
    expect(outgoing.classList.contains('is-ink-presentation-leaving')).toBe(false);
  });

  it('uses a delayed timer only as a missing-transitionend fallback', () => {
    vi.useFakeTimers();
    const incoming = document.createElement('div');
    const outgoing = document.createElement('div');
    const settled = vi.fn();
    stageInkPresentationHandoff(incoming);

    crossfadeInkPresentationHandoff({ incoming, onSettled: settled, outgoing });

    vi.advanceTimersByTime(239);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('completes immediately when Reduced Motion is enabled', () => {
    const incoming = document.createElement('div');
    const outgoing = document.createElement('div');
    const settled = vi.fn();
    stageInkPresentationHandoff(incoming);

    crossfadeInkPresentationHandoff({
      incoming,
      onSettled: settled,
      outgoing,
      reducedMotion: true,
    });

    expect(settled).toHaveBeenCalledOnce();
    expect(incoming.classList.contains('is-ink-presentation-handoff')).toBe(false);
    expect(outgoing.classList.contains('is-ink-presentation-leaving')).toBe(false);
  });

  it('cancels a superseded fade without settling the superseded lifecycle', () => {
    vi.useFakeTimers();
    const incoming = document.createElement('div');
    const outgoing = document.createElement('div');
    const settled = vi.fn();
    stageInkPresentationHandoff(incoming);

    const cancel = crossfadeInkPresentationHandoff({ incoming, onSettled: settled, outgoing });
    cancel();
    vi.runAllTimers();

    expect(settled).not.toHaveBeenCalled();
    expect(incoming.classList.contains('is-ink-presentation-handoff')).toBe(false);
    expect(outgoing.classList.contains('is-ink-presentation-leaving')).toBe(false);
  });
});
