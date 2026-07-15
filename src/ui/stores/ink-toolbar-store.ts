import { signal, type Signal } from '@preact/signals';

import type { InkStroke } from '../../domain/ink-surface';
import type { InkToolPreference } from '../../storage/local-ink-tool-preference';

export interface InkToolbarPosition {
  readonly dragged: boolean;
  readonly left: number;
  readonly top: number;
}

export interface InkToolbarState {
  readonly active: boolean;
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  readonly color: string;
  readonly dragging: boolean;
  readonly optionsVisible: boolean;
  readonly position: InkToolbarPosition | null;
  readonly saveError: string | null;
  readonly statusText: string;
  readonly tool: InkStroke['tool'];
  readonly width: number;
}

export interface InkToolbarStore {
  readonly state: Signal<InkToolbarState>;
}

export function createInkToolbarStore(preference: InkToolPreference): InkToolbarStore {
  return {
    state: signal({
      active: false,
      canRedo: false,
      canUndo: false,
      color: preference.color,
      dragging: false,
      optionsVisible: true,
      position: null,
      saveError: null,
      statusText: 'Ink Mode',
      tool: preference.tool,
      width: preference.width,
    }),
  };
}
