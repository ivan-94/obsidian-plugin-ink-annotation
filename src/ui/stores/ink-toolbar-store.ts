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
  readonly committing: boolean;
  readonly dragging: boolean;
  readonly interaction: 'draw' | 'select';
  readonly multiple: boolean;
  readonly optionsVisible: boolean;
  readonly position: InkToolbarPosition | null;
  readonly saveError: string | null;
  readonly selectedCount: number;
  readonly statusText: string;
  readonly tool: InkStroke['tool'];
  readonly width: number;
  readonly zoomMode: 'fit' | 'manual';
  readonly zoomScale: number;
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
      committing: false,
      dragging: false,
      interaction: preference.interaction ?? 'draw',
      multiple: preference.multiple ?? false,
      optionsVisible: preference.optionsVisible ?? false,
      position:
        preference.toolbarPosition === undefined
          ? null
          : { ...preference.toolbarPosition, dragged: true },
      saveError: null,
      selectedCount: 0,
      statusText: 'Markup',
      tool: preference.tool,
      width: preference.width,
      zoomMode: preference.zoomMode ?? 'fit',
      zoomScale: preference.zoomScale ?? 1,
    }),
  };
}
