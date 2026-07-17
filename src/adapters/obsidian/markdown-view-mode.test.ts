import { describe, expect, it } from 'vitest';

import { shouldRefreshAnnotationSurfacesForModify } from './markdown-view-mode';

describe('Markdown annotation mode policy', () => {
  it('refreshes a modified active file only while that view is in Reading View', () => {
    expect(
      shouldRefreshAnnotationSurfacesForModify('Active.md', {
        file: { path: 'Active.md' },
        getMode: () => 'source',
      }),
    ).toBe(false);
    expect(
      shouldRefreshAnnotationSurfacesForModify('Active.md', {
        file: { path: 'Active.md' },
        getMode: () => 'preview',
      }),
    ).toBe(true);
    expect(
      shouldRefreshAnnotationSurfacesForModify('Other.md', {
        file: { path: 'Active.md' },
        getMode: () => 'preview',
      }),
    ).toBe(false);
    expect(shouldRefreshAnnotationSurfacesForModify('Active.md', null)).toBe(false);
  });
});
