export interface InkRasterTileBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InkRasterTileCacheStats {
  readonly bytes: number;
  readonly entryCount: number;
  readonly evictionCount: number;
  readonly hitCount: number;
  readonly missCount: number;
}

interface InkRasterTileEntry<Value> {
  readonly bounds: InkRasterTileBounds;
  readonly byteSize: number;
  lastAccess: number;
  readonly value: Value;
}

/** Bounded non-DOM LRU for disposable committed raster tiles. */
export class InkRasterTileCache<Value> {
  private bytes = 0;
  private clock = 0;
  private readonly entries = new Map<string, InkRasterTileEntry<Value>>();
  private evictionCount = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private maxBytes: number,
    private readonly disposeValue: (value: Value) => void,
  ) {
    assertBudget(maxBytes);
  }

  get(key: string): Value | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount += 1;
      return null;
    }
    entry.lastAccess = ++this.clock;
    this.hitCount += 1;
    return entry.value;
  }

  put(key: string, value: Value, bounds: InkRasterTileBounds, byteSize: number): boolean {
    assertBounds(bounds);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error('Ink raster tile byte size must be a non-negative safe integer.');
    }
    this.delete(key, false);
    if (byteSize > this.maxBytes) {
      this.disposeValue(value);
      return false;
    }
    this.entries.set(key, { bounds, byteSize, lastAccess: ++this.clock, value });
    this.bytes += byteSize;
    this.evictToBudget();
    return this.entries.has(key);
  }

  setMaxBytes(maxBytes: number): void {
    assertBudget(maxBytes);
    this.maxBytes = maxBytes;
    this.evictToBudget();
  }

  invalidate(bounds: InkRasterTileBounds): void {
    assertBounds(bounds);
    for (const [key, entry] of this.entries) {
      if (intersects(entry.bounds, bounds)) this.delete(key, false);
    }
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.delete(key, false);
  }

  stats(): InkRasterTileCacheStats {
    return Object.freeze({
      bytes: this.bytes,
      entryCount: this.entries.size,
      evictionCount: this.evictionCount,
      hitCount: this.hitCount,
      missCount: this.missCount,
    });
  }

  private evictToBudget(): void {
    while (this.bytes > this.maxBytes && this.entries.size > 0) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastAccess < oldestAccess) {
          oldestAccess = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.delete(oldestKey, true);
    }
  }

  private delete(key: string, eviction: boolean): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.byteSize;
    if (eviction) this.evictionCount += 1;
    this.disposeValue(entry.value);
  }
}

function assertBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Ink raster tile cache budget must be a non-negative safe integer.');
  }
}

function assertBounds(bounds: InkRasterTileBounds): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 0 ||
    bounds.height < 0
  ) {
    throw new Error('Ink raster tile bounds must be finite and non-negative.');
  }
}

function intersects(left: InkRasterTileBounds, right: InkRasterTileBounds): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}
