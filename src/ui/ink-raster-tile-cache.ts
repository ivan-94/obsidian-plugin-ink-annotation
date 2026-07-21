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

export type InkRasterTileResidency =
  'building' | 'cold' | 'dirty' | 'near-visible' | 'ready' | 'stale' | 'visible';

interface InkRasterTileInvalidationOptions {
  readonly evictPresented?: boolean;
}

interface InkRasterTileEntry<Value> {
  readonly bounds: InkRasterTileBounds;
  readonly byteSize: number;
  lastAccess: number;
  residency: InkRasterTileResidency;
  readonly value: Value;
}

/** Bounded non-DOM LRU for disposable committed raster tiles. */
export class InkRasterTileCache<Value> implements InkDisposableMemoryParticipant {
  private bytes = 0;
  private disposed = false;
  private readonly entries = new Map<string, InkRasterTileEntry<Value>>();
  private evictionCount = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private maxBytes: number,
    private readonly disposeValue: (value: Value) => void,
    private readonly coordinator: InkGeometryCacheCoordinator = GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR,
  ) {
    assertBudget(maxBytes);
    this.coordinator.register(this);
  }

  get disposableBytes(): number {
    return this.bytes;
  }

  get(key: string): Value | null {
    this.assertUsable();
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount += 1;
      return null;
    }
    entry.lastAccess = this.coordinator.nextUse();
    this.hitCount += 1;
    return entry.value;
  }

  /** Transfers one retained value to another owner without disposing its backing resource. */
  take(key: string): Value | null {
    this.assertUsable();
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    this.entries.delete(key);
    this.bytes -= entry.byteSize;
    return entry.value;
  }

  put(
    key: string,
    value: Value,
    bounds: InkRasterTileBounds,
    byteSize: number,
    residency: InkRasterTileResidency = 'cold',
  ): boolean {
    this.assertUsable();
    assertBounds(bounds);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error('Ink raster tile byte size must be a non-negative safe integer.');
    }
    this.delete(key, false);
    if (byteSize > this.maxBytes) {
      this.disposeValue(value);
      return false;
    }
    this.entries.set(key, {
      bounds,
      byteSize,
      lastAccess: this.coordinator.nextUse(),
      residency,
      value,
    });
    this.bytes += byteSize;
    this.evictToBudget();
    this.coordinator.enforce();
    return this.entries.has(key);
  }

  setMaxBytes(maxBytes: number): void {
    this.assertUsable();
    assertBudget(maxBytes);
    this.maxBytes = maxBytes;
    this.evictToBudget();
  }

  setResidency(key: string, residency: InkRasterTileResidency): boolean {
    this.assertUsable();
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    entry.residency = residency;
    entry.lastAccess = this.coordinator.nextUse();
    return true;
  }

  invalidate(bounds: InkRasterTileBounds, options: InkRasterTileInvalidationOptions = {}): void {
    this.assertUsable();
    assertBounds(bounds);
    for (const [key, entry] of this.entries) {
      if (!intersects(entry.bounds, bounds)) continue;
      if (
        options.evictPresented !== true &&
        (entry.residency === 'visible' || entry.residency === 'dirty')
      ) {
        entry.residency = 'dirty';
        entry.lastAccess = this.coordinator.nextUse();
        continue;
      }
      this.delete(key, false);
    }
  }

  invalidateAll(options: InkRasterTileInvalidationOptions = {}): void {
    this.assertUsable();
    for (const [key, entry] of this.entries) {
      if (
        options.evictPresented !== true &&
        (entry.residency === 'visible' || entry.residency === 'dirty')
      ) {
        entry.residency = 'dirty';
        entry.lastAccess = this.coordinator.nextUse();
        continue;
      }
      this.delete(key, false);
    }
  }

  markResidency(bounds: InkRasterTileBounds, residency: InkRasterTileResidency): void {
    this.assertUsable();
    assertBounds(bounds);
    for (const entry of this.entries.values()) {
      if (!intersects(entry.bounds, bounds)) continue;
      entry.residency = residency;
      entry.lastAccess = this.coordinator.nextUse();
    }
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.delete(key, false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.coordinator.unregister(this);
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

  evictionCandidate(): InkDisposableMemoryEvictionCandidate | null {
    if (this.disposed) return null;
    let selectedKey: string | null = null;
    let selected: InkRasterTileEntry<Value> | null = null;
    for (const [key, entry] of this.entries) {
      // These entries are the pixels currently preserving presentation continuity. Their byte
      // budget is a lease, not an eviction hint: temporary over-budget retention is preferable
      // to exposing a blank tile while the replacement is being built.
      if (entry.residency === 'visible' || entry.residency === 'dirty') continue;
      if (
        selected === null ||
        residencyEvictionRank(entry.residency) < residencyEvictionRank(selected.residency) ||
        (entry.residency === selected.residency && entry.lastAccess < selected.lastAccess)
      ) {
        selectedKey = key;
        selected = entry;
      }
    }
    return selected === null || selectedKey === null
      ? null
      : {
          evict: () => this.delete(selectedKey, true),
          lastUsed: selected.lastAccess,
          visible: selected.residency === 'visible',
        };
  }

  private evictToBudget(): void {
    while (this.bytes > this.maxBytes && this.entries.size > 0) {
      const candidate = this.evictionCandidate();
      if (candidate === null) return;
      candidate.evict();
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

  private assertUsable(): void {
    if (this.disposed) throw new Error('Ink raster tile cache has been disposed.');
  }
}

function residencyEvictionRank(residency: InkRasterTileResidency): number {
  switch (residency) {
    case 'stale':
      return 0;
    case 'cold':
      return 1;
    case 'ready':
    case 'building':
      return 2;
    case 'near-visible':
      return 3;
    case 'dirty':
      return 4;
    case 'visible':
      return 5;
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
import {
  GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR,
  type InkDisposableMemoryEvictionCandidate,
  type InkDisposableMemoryParticipant,
  type InkGeometryCacheCoordinator,
} from './ink-geometry-cache';
