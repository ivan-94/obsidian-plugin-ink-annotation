export type InkSaveIntent = 'background' | 'exit';

export type InkModeState =
  | { readonly kind: 'reading' }
  | {
      readonly dirty: boolean;
      readonly kind: 'ink-mode';
      readonly pendingIntent?: InkSaveIntent;
      readonly saveError: string | null;
    }
  | { readonly intent: InkSaveIntent; readonly kind: 'saving' };

export type InkModeEvent =
  | { readonly type: 'background' }
  | { readonly type: 'enter' }
  | { readonly type: 'request-exit' }
  | { readonly type: 'retry-save' }
  | { readonly message: string; readonly type: 'save-failed' }
  | { readonly type: 'save-succeeded' }
  | { readonly type: 'stroke-changed' };

export function reduceInkModeState(state: InkModeState, event: InkModeEvent): InkModeState {
  switch (state.kind) {
    case 'reading':
      if (event.type === 'enter') {
        return { dirty: false, kind: 'ink-mode', saveError: null };
      }
      break;
    case 'ink-mode':
      if (event.type === 'stroke-changed') {
        return { ...state, dirty: true, saveError: null };
      }
      if (event.type === 'request-exit') {
        return state.dirty ? { intent: 'exit', kind: 'saving' } : { kind: 'reading' };
      }
      if (event.type === 'background') {
        return state.dirty ? { intent: 'background', kind: 'saving' } : state;
      }
      if (event.type === 'retry-save' && state.saveError !== null) {
        return { intent: state.pendingIntent ?? 'background', kind: 'saving' };
      }
      break;
    case 'saving':
      if (event.type === 'save-succeeded') {
        return state.intent === 'exit'
          ? { kind: 'reading' }
          : { dirty: false, kind: 'ink-mode', saveError: null };
      }
      if (event.type === 'save-failed') {
        return {
          dirty: true,
          kind: 'ink-mode',
          pendingIntent: state.intent,
          saveError: event.message,
        };
      }
      break;
  }
  throw new Error(`Invalid Ink Mode transition: ${state.kind} + ${event.type}.`);
}
