import { describe, expect, it, vi } from 'vitest';

import { refreshAlreadyOpenReadingViews } from './reading-view-startup';

describe('Reading View startup recovery', () => {
  it('fully rerenders already-open Preview views after the annotation postprocessor is ready', () => {
    const rerenderPreview = vi.fn();
    const rerenderSource = vi.fn();

    refreshAlreadyOpenReadingViews([
      { mode: 'preview', rerender: rerenderPreview },
      { mode: 'source', rerender: rerenderSource },
    ]);

    expect(rerenderPreview).toHaveBeenCalledWith(true);
    expect(rerenderSource).not.toHaveBeenCalled();
  });
});
