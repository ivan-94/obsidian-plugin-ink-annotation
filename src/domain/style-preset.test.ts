import { describe, expect, it } from 'vitest';

import { DEFAULT_STYLE_PRESETS, StylePresetCatalog } from './style-preset';

describe('style preset catalog', () => {
  it('ships five named presets and keeps stable IDs across rename and recolor', () => {
    expect(DEFAULT_STYLE_PRESETS.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'highlight-sun', name: 'Sun' },
      { id: 'highlight-mint', name: 'Mint' },
      { id: 'highlight-sky', name: 'Sky' },
      { id: 'highlight-rose', name: 'Rose' },
      { id: 'highlight-violet', name: 'Violet' },
    ]);
    const catalog = new StylePresetCatalog(DEFAULT_STYLE_PRESETS);
    const annotationStyleId = 'highlight-sky';

    catalog.update(annotationStyleId, { color: '#1264a3', name: 'Focus' });

    expect(catalog.get(annotationStyleId)).toEqual({
      color: '#1264a3',
      id: 'highlight-sky',
      name: 'Focus',
    });
    expect(annotationStyleId).toBe('highlight-sky');
  });
});
