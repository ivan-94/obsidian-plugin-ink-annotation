import { signal, type Signal } from '@preact/signals';

import type { DraftPersistenceState } from '../../application/annotation-draft-session';

export interface NoteComposerStore {
  readonly body: Signal<string>;
  readonly persistence: Signal<DraftPersistenceState>;
  readonly tags: Signal<readonly string[]>;
}

export function createNoteComposerStore(input: {
  readonly body?: string | null;
  readonly tags: readonly string[];
}): NoteComposerStore {
  return {
    body: signal(input.body ?? ''),
    persistence: signal({ kind: 'idle' }),
    tags: signal(input.tags),
  };
}

export function parseNoteTags(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/u)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
