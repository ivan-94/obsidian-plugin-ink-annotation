import { digestInkBrushGolden } from '../domain/ink-brush-contract';
import type { InkStroke } from '../domain/ink-surface';

export const INK_TILE_WORKER_PROTOCOL_VERSION = 'ink-tile-worker-v1';

/** Exact canonical digest acknowledged before a demand-first projection mirror becomes buildable. */
export function digestInkTileProjectionSlice(strokes: readonly InkStroke[]): string {
  return digestInkBrushGolden(strokes);
}
