import { describe, expect, it } from 'vitest';

import { createNoteComposerStore, parseNoteTags } from './note-composer-store';

describe('NoteComposerStore', () => {
  it('owns editable draft and persistence state for one composer', () => {
    const store = createNoteComposerStore({ body: 'Draft', tags: ['one'] });

    store.body.value = 'Updated';
    store.tags.value = ['one', 'two'];
    store.persistence.value = { kind: 'saving' };

    expect(store.body.value).toBe('Updated');
    expect(store.tags.value).toEqual(['one', 'two']);
    expect(store.persistence.value).toEqual({ kind: 'saving' });
  });

  it('normalizes comma-separated tags without duplicates', () => {
    expect(parseNoteTags('one, two，one,  ')).toEqual(['one', 'two']);
  });
});
