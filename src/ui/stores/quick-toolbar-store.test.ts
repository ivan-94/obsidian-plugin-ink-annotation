import { describe, expect, it } from 'vitest';

import { createQuickToolbarStore } from './quick-toolbar-store';

describe('QuickToolbarStore', () => {
  it('keeps transient async action state per toolbar instance', () => {
    const first = createQuickToolbarStore();
    const second = createQuickToolbarStore();

    first.pendingAction.value = 'highlight:yellow';
    first.errorMessage.value = "Couldn't save locally. Retry.";

    expect(first.pendingAction.value).toBe('highlight:yellow');
    expect(first.errorMessage.value).toContain('Retry');
    expect(second.pendingAction.value).toBeNull();
    expect(second.errorMessage.value).toBeNull();
  });
});
