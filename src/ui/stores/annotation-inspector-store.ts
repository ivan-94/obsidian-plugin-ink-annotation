import { signal, type Signal } from '@preact/signals';

import type { ReattachmentCandidate } from '../../domain/annotation-reattachment';
import type { StylePreset } from '../../domain/style-preset';
import type { TextAnnotationRecord } from '../../domain/text-annotation';

export type InspectorAsyncState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'success' };

export interface InspectorDraft {
  readonly body: string;
  readonly dirty: boolean;
  readonly markKind: 'highlight' | 'note' | 'underline';
  readonly record: TextAnnotationRecord;
  readonly styleId: string;
  readonly tags: string;
}

export type InspectorState =
  | { readonly kind: 'choosing'; readonly records: readonly TextAnnotationRecord[] }
  | { readonly kind: 'closed' }
  | {
      readonly draft: InspectorDraft;
      readonly feedback: string;
      readonly kind: 'editing';
      readonly save: InspectorAsyncState;
      readonly successfulAction: string | null;
    }
  | {
      readonly action: InspectorAsyncState;
      readonly kind: 'previewing-reattachment';
      readonly candidate: ReattachmentCandidate;
      readonly record: TextAnnotationRecord;
    }
  | {
      readonly action: InspectorAsyncState;
      readonly kind: 'deleted';
      readonly record: TextAnnotationRecord;
    };

export interface AnnotationInspectorStore {
  readonly state: Signal<InspectorState>;
}

export function createAnnotationInspectorStore(): AnnotationInspectorStore {
  return { state: signal<InspectorState>({ kind: 'closed' }) };
}

export function inspectorEditingState(
  record: TextAnnotationRecord,
  presets: readonly StylePreset[],
): InspectorState {
  return {
    draft: {
      body: record.body ?? '',
      dirty: false,
      markKind: record.mark?.kind ?? 'note',
      record,
      styleId: record.mark?.styleId ?? presets[0]?.id ?? '',
      tags: record.tags.join(', '),
    },
    feedback: '',
    kind: 'editing',
    save: { kind: 'idle' },
    successfulAction: null,
  };
}
