import { describe, expect, it } from 'vitest';

import { reduceInkModeState, type InkModeState } from './ink-mode-state';

describe('Ink Mode state machine', () => {
  it('enters, becomes dirty, saves, and returns to Reading only after local success', () => {
    let state: InkModeState = { kind: 'reading' };
    state = reduceInkModeState(state, { type: 'enter' });
    state = reduceInkModeState(state, { type: 'stroke-changed' });
    state = reduceInkModeState(state, { type: 'request-exit' });
    expect(state).toEqual({ intent: 'exit', kind: 'saving' });

    state = reduceInkModeState(state, { type: 'save-succeeded' });
    expect(state).toEqual({ kind: 'reading' });
  });

  it('keeps recoverable Ink in mode after failure and retries without losing exit intent', () => {
    let state: InkModeState = { dirty: true, kind: 'ink-mode', saveError: null };
    state = reduceInkModeState(state, { type: 'request-exit' });
    state = reduceInkModeState(state, { message: 'disk full', type: 'save-failed' });
    expect(state).toEqual({
      dirty: true,
      kind: 'ink-mode',
      pendingIntent: 'exit',
      saveError: 'disk full',
    });

    state = reduceInkModeState(state, { type: 'retry-save' });
    expect(state).toEqual({ intent: 'exit', kind: 'saving' });
  });

  it('background flush returns to Ink Mode rather than exiting the session', () => {
    let state: InkModeState = { dirty: true, kind: 'ink-mode', saveError: null };
    state = reduceInkModeState(state, { type: 'background' });
    expect(state).toEqual({ intent: 'background', kind: 'saving' });

    state = reduceInkModeState(state, { type: 'save-succeeded' });
    expect(state).toEqual({ dirty: false, kind: 'ink-mode', saveError: null });
  });

  it('rejects impossible transitions instead of silently hiding state bugs', () => {
    expect(() => reduceInkModeState({ kind: 'reading' }, { type: 'save-succeeded' })).toThrow(
      'Invalid Ink Mode transition',
    );
  });
});
