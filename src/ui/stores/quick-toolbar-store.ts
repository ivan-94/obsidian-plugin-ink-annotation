import { signal, type Signal } from '@preact/signals';

export interface QuickToolbarStore {
  readonly errorMessage: Signal<string | null>;
  readonly pendingAction: Signal<string | null>;
}

export function createQuickToolbarStore(): QuickToolbarStore {
  return {
    errorMessage: signal(null),
    pendingAction: signal(null),
  };
}

export function resetQuickToolbarStore(store: QuickToolbarStore): void {
  store.errorMessage.value = null;
  store.pendingAction.value = null;
}
