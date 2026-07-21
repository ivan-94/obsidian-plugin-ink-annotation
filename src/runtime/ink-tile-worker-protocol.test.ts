import { describe, expect, it } from 'vitest';

import type { InkStroke } from '../domain/ink-surface';
import {
  digestInkTileProjectionSlice,
  INK_TILE_WORKER_PROTOCOL_VERSION,
} from './ink-tile-worker-protocol';

describe('Ink Tile Worker projection protocol', () => {
  it('has a stable protocol version and order-independent object digest', () => {
    const first: InkStroke = {
      color: '#101010',
      id: 'stroke',
      points: [{ pressure: 0.5, time: 0, x: -3, y: 9 }],
      tool: 'pen',
      width: 4,
    };
    const reordered = {
      width: 4,
      tool: 'pen',
      points: [{ y: 9, x: -3, time: 0, pressure: 0.5 }],
      id: 'stroke',
      color: '#101010',
    } as const satisfies InkStroke;

    expect(INK_TILE_WORKER_PROTOCOL_VERSION).toBe('ink-tile-worker-v1');
    expect(digestInkTileProjectionSlice([first])).toBe(digestInkTileProjectionSlice([reordered]));
    expect(digestInkTileProjectionSlice([first])).toMatch(/^[a-f0-9]{8}$/u);
  });
});
