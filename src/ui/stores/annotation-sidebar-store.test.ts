import { describe, expect, it } from 'vitest';

import { AnnotationSidebarStore } from './annotation-sidebar-store';

describe('AnnotationSidebarStore', () => {
  it('preserves independent Current and Vault state across scope switches per leaf', () => {
    const firstLeaf = new AnnotationSidebarStore();
    const secondLeaf = new AnnotationSidebarStore();

    firstLeaf.current.searchQuery.value = 'current query';
    firstLeaf.vault.searchQuery.value = 'vault query';
    firstLeaf.vault.scrollOffset.value = 640;
    firstLeaf.setScope('entire-vault');
    firstLeaf.setScope('current-file');
    firstLeaf.setScope('entire-vault');

    expect(firstLeaf.current.searchQuery.value).toBe('current query');
    expect(firstLeaf.vault.searchQuery.value).toBe('vault query');
    expect(firstLeaf.vault.scrollOffset.value).toBe(640);
    expect(firstLeaf.scope.value).toBe('entire-vault');
    expect(secondLeaf.scope.value).toBe('current-file');
    expect(secondLeaf.vault.searchQuery.value).toBe('');
  });
});
