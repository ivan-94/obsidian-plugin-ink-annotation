import { describe, expect, it } from 'vitest';

import {
  mapCurrentInkAnnotation,
  mapCurrentTextAnnotation,
  mapVaultAnnotation,
} from './annotation-list-item-model';

describe('annotation list item presentation model', () => {
  it('maps a Current file text problem without leaking repository behavior', () => {
    const model = mapCurrentTextAnnotation({
      id: 'annotation-1',
      marker: { kind: 'underline', styleId: 'mint' },
      notePreview: 'Review this assumption',
      position: 42,
      quote: 'Architecture boundary',
      revision: 3,
      status: 'unanchored',
      tags: ['review'],
      updatedAt: '2026-07-15T08:09:00.000Z',
    });

    expect(model).toEqual({
      capabilities: ['open', 'edit', 'copy', 'export', 'delete'],
      id: 'annotation-1',
      key: 'annotation-1',
      kind: 'underline',
      leading: { icon: 'triangle-alert', kind: 'icon', styleId: 'mint' },
      metadata: [
        { kind: 'tag', label: '#review' },
        { kind: 'status', label: 'Unanchored', tone: 'warning' },
        { kind: 'time', label: '07-15 08:09' },
      ],
      revision: 3,
      secondary: 'Review this assumption',
      state: {
        active: false,
        conflict: false,
        deleted: false,
        unanchored: true,
      },
      title: 'Architecture boundary',
      tone: 'warning',
    });
  });

  it('maps a Current file Ink surface as one thumbnail item', () => {
    const model = mapCurrentInkAnnotation({
      filePath: 'Notes/Architecture.md',
      headingPath: ['Design', 'Runtime'],
      id: 'surface-1',
      logicalHeight: 600,
      logicalWidth: 960,
      position: 120,
      revision: 2,
      status: 'needs-rebase',
      strokeCount: 12,
      thumbnailSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      updatedAt: '2026-07-15T10:11:00.000Z',
    });

    expect(model).toMatchObject({
      capabilities: ['open', 'edit', 'export-svg', 'export-png', 'delete'],
      id: 'surface-1',
      key: 'surface-1',
      kind: 'ink',
      leading: { kind: 'thumbnail' },
      metadata: [
        { kind: 'type', label: '12 strokes' },
        { kind: 'status', label: 'Needs rebase', tone: 'warning' },
        { kind: 'time', label: '07-15 10:11' },
      ],
      revision: 2,
      secondary: '12 strokes',
      state: { active: false, conflict: false, deleted: false, unanchored: false },
      title: 'Runtime',
      tone: 'warning',
    });
    expect(model.leading.kind === 'thumbnail' ? model.leading.source : '').toContain(
      'data:image/svg+xml',
    );
  });

  it('maps a Vault entry with a globally stable key and shared metadata formatting', () => {
    const model = mapVaultAnnotation({
      body: 'Decision note',
      conflict: true,
      filePath: 'Notes/Architecture.md',
      id: 'annotation-1',
      noteId: 'note-architecture',
      position: 42,
      quote: 'Architecture boundary',
      revision: 4,
      status: 'active',
      styleId: 'highlight-sun',
      tags: ['review'],
      type: 'highlight',
      updatedAt: '2026-07-15T12:13:00.000Z',
    });

    expect(model).toEqual({
      capabilities: ['open', 'edit', 'copy', 'export', 'delete'],
      id: 'annotation-1',
      key: 'note-architecture\u0000annotation-1',
      kind: 'highlight',
      leading: { icon: 'triangle-alert', kind: 'icon', styleId: 'highlight-sun' },
      metadata: [
        { kind: 'type', label: 'Highlight' },
        { kind: 'tag', label: '#review' },
        { kind: 'status', label: 'Conflict', tone: 'warning' },
        { kind: 'time', label: '07-15 12:13' },
      ],
      revision: 4,
      secondary: 'Decision note',
      state: {
        active: false,
        conflict: true,
        deleted: false,
        unanchored: false,
      },
      title: 'Architecture boundary',
      tone: 'warning',
    });
  });
});
