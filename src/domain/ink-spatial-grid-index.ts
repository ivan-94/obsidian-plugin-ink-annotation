import type { InkBoundsRect } from './ink-bounds-index';

const CELL_ESTIMATED_BYTES = 96;
const ENTRY_BASE_ESTIMATED_BYTES = 160;
const ENTRY_CELL_REFERENCE_ESTIMATED_BYTES = 32;

export interface InkSpatialGridQuery<T> {
  readonly values: readonly T[];
  readonly visitedEntryCount: number;
}

interface InkSpatialGridEntry<T> {
  readonly bounds: InkBoundsRect;
  readonly cellKeys: readonly string[];
  readonly id: string;
  readonly sequence: number;
  readonly value: T;
}

/**
 * A transient two-dimensional index for active geometry. Unlike the document's Y-ordered index,
 * a horizontal tail query does not visit every already-painted segment.
 */
export class InkSpatialGridIndex<T> {
  private estimatedBytes = 0;
  private readonly cells = new Map<string, Map<string, InkSpatialGridEntry<T>>>();
  private readonly entries = new Map<string, InkSpatialGridEntry<T>>();
  private nextSequence = 0;

  constructor(private readonly cellSize = 64) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error('Ink spatial grid cell size must be finite and positive.');
    }
  }

  get byteSizeEstimate(): number {
    return this.estimatedBytes;
  }

  set(id: string, bounds: InkBoundsRect, value: T): void {
    if (id.length === 0) throw new Error('Ink spatial grid requires a non-empty ID.');
    if (!validRect(bounds)) throw new Error(`Ink spatial grid entry ${id} has invalid bounds.`);
    this.delete(id);
    this.nextSequence += 1;
    const cellKeys = keysForRect(bounds, this.cellSize);
    const entry = { bounds, cellKeys, id, sequence: this.nextSequence, value };
    this.entries.set(id, entry);
    this.estimatedBytes += estimateEntryBytes(id, cellKeys.length);
    for (const key of cellKeys) {
      const existingCell = this.cells.get(key);
      const cell = existingCell ?? new Map<string, InkSpatialGridEntry<T>>();
      if (existingCell === undefined) this.estimatedBytes += CELL_ESTIMATED_BYTES;
      cell.set(id, entry);
      this.cells.set(key, cell);
    }
  }

  delete(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.entries.delete(id);
    this.estimatedBytes -= estimateEntryBytes(entry.id, entry.cellKeys.length);
    for (const key of entry.cellKeys) {
      const cell = this.cells.get(key);
      if (cell === undefined) continue;
      cell.delete(id);
      if (cell.size === 0) {
        this.cells.delete(key);
        this.estimatedBytes -= CELL_ESTIMATED_BYTES;
      }
    }
    return true;
  }

  query(viewport: InkBoundsRect): InkSpatialGridQuery<T> {
    if (!validRect(viewport)) {
      throw new Error('Ink spatial grid viewport must be finite and non-negative.');
    }
    const candidates = new Map<string, InkSpatialGridEntry<T>>();
    for (const key of keysForRect(viewport, this.cellSize)) {
      const cell = this.cells.get(key);
      if (cell === undefined) continue;
      for (const [id, entry] of cell) candidates.set(id, entry);
    }
    const ordered = [...candidates.values()].sort((left, right) => left.sequence - right.sequence);
    return {
      values: ordered
        .filter(({ bounds }) => intersects(bounds, viewport))
        .map(({ value }) => value),
      visitedEntryCount: ordered.length,
    };
  }
}

function estimateEntryBytes(id: string, cellCount: number): number {
  return (
    ENTRY_BASE_ESTIMATED_BYTES + id.length * 2 + cellCount * ENTRY_CELL_REFERENCE_ESTIMATED_BYTES
  );
}

function keysForRect(rect: InkBoundsRect, cellSize: number): readonly string[] {
  const minimumColumn = Math.floor(rect.x / cellSize);
  const maximumColumn = Math.floor((rect.x + rect.width) / cellSize);
  const minimumRow = Math.floor(rect.y / cellSize);
  const maximumRow = Math.floor((rect.y + rect.height) / cellSize);
  const keys: string[] = [];
  for (let row = minimumRow; row <= maximumRow; row += 1) {
    for (let column = minimumColumn; column <= maximumColumn; column += 1) {
      keys.push(`${column}:${row}`);
    }
  }
  return keys;
}

function intersects(left: InkBoundsRect, right: InkBoundsRect): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

function validRect(rect: InkBoundsRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}
