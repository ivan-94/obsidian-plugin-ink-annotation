import type { CompiledInkStroke } from '../domain/ink-stroke-geometry';

export const INK_GEOMETRY_CACHE_BYTES_PER_MOUNT = 32 * 1024 * 1024;
export const INK_GEOMETRY_CACHE_BYTES_PLUGIN_WIDE = 64 * 1024 * 1024;

interface InkGeometryCacheEntry {
  readonly geometry: CompiledInkStroke;
  readonly key: string;
  lastUsed: number;
  visible: boolean;
}

interface EvictionCandidate {
  readonly cache: InkGeometryCache;
  readonly key: string;
  readonly lastUsed: number;
  readonly visible: boolean;
}

export class InkGeometryCacheCoordinator {
  private readonly caches = new Set<InkGeometryCache>();
  private clock = 0;

  constructor(readonly maximumBytes = INK_GEOMETRY_CACHE_BYTES_PLUGIN_WIDE) {
    assertBudget(maximumBytes, 'plugin-wide Ink geometry cache');
  }

  get byteSize(): number {
    let bytes = 0;
    for (const cache of this.caches) bytes += cache.disposableBytes;
    return bytes;
  }

  nextUse(): number {
    this.clock += 1;
    return this.clock;
  }

  register(cache: InkGeometryCache): void {
    this.caches.add(cache);
  }

  unregister(cache: InkGeometryCache): void {
    this.caches.delete(cache);
  }

  enforce(): void {
    while (this.byteSize > this.maximumBytes) {
      const candidate = this.oldestCandidate();
      if (candidate === null) return;
      candidate.cache.evictKey(candidate.key);
    }
  }

  private oldestCandidate(): EvictionCandidate | null {
    let selected: EvictionCandidate | null = null;
    for (const cache of this.caches) {
      const candidate = cache.evictionCandidate();
      if (
        candidate !== null &&
        (selected === null ||
          Number(candidate.visible) < Number(selected.visible) ||
          (candidate.visible === selected.visible && candidate.lastUsed < selected.lastUsed))
      ) {
        selected = candidate;
      }
    }
    return selected;
  }
}

export const GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR = new InkGeometryCacheCoordinator();

export class InkGeometryCache {
  private bytes = 0;
  private readonly coordinator: InkGeometryCacheCoordinator;
  private readonly entries = new Map<string, InkGeometryCacheEntry>();
  private indexByteSize = 0;
  private readonly maximumBytes: number;

  constructor(
    input: {
      readonly coordinator?: InkGeometryCacheCoordinator;
      readonly maximumBytes?: number;
    } = {},
  ) {
    this.coordinator = input.coordinator ?? GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR;
    this.maximumBytes = input.maximumBytes ?? INK_GEOMETRY_CACHE_BYTES_PER_MOUNT;
    assertBudget(this.maximumBytes, 'mounted Ink geometry cache');
    this.coordinator.register(this);
  }

  get geometryBytes(): number {
    return this.bytes;
  }

  get disposableBytes(): number {
    return this.bytes + this.indexByteSize;
  }

  get(key: string): CompiledInkStroke | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    entry.lastUsed = this.coordinator.nextUse();
    return entry.geometry;
  }

  put(key: string, geometry: CompiledInkStroke, visible: boolean): void {
    if (!Number.isFinite(geometry.byteSizeEstimate) || geometry.byteSizeEstimate < 0) {
      throw new Error('Ink geometry cache entry size must be finite and non-negative.');
    }
    const previous = this.entries.get(key);
    if (previous !== undefined) this.bytes -= previous.geometry.byteSizeEstimate;
    this.entries.set(key, {
      geometry,
      key,
      lastUsed: this.coordinator.nextUse(),
      visible,
    });
    this.bytes += geometry.byteSizeEstimate;
    this.enforceLocal();
    this.coordinator.enforce();
  }

  setVisibleStrokeIds(strokeIds: ReadonlySet<string>): void {
    for (const entry of this.entries.values()) {
      entry.visible = strokeIds.has(entry.geometry.strokeId);
    }
  }

  setIndexBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error('Ink geometry cache index bytes must be finite and non-negative.');
    }
    this.indexByteSize = bytes;
    this.enforceLocal();
    this.coordinator.enforce();
  }

  invalidateStrokeIds(strokeIds: readonly string[]): number {
    const ids = new Set(strokeIds);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (!ids.has(entry.geometry.strokeId)) continue;
      this.evictKey(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  dispose(): void {
    this.clear();
    this.coordinator.unregister(this);
  }

  stats(): {
    readonly bytes: number;
    readonly entryCount: number;
    readonly indexBytes: number;
    readonly maximumBytes: number;
  } {
    return Object.freeze({
      bytes: this.bytes,
      entryCount: this.entries.size,
      indexBytes: this.indexByteSize,
      maximumBytes: this.maximumBytes,
    });
  }

  evictionCandidate(): EvictionCandidate | null {
    let selected: InkGeometryCacheEntry | null = null;
    for (const entry of this.entries.values()) {
      if (
        selected === null ||
        Number(entry.visible) < Number(selected.visible) ||
        (entry.visible === selected.visible && entry.lastUsed < selected.lastUsed)
      ) {
        selected = entry;
      }
    }
    return selected === null
      ? null
      : {
          cache: this,
          key: selected.key,
          lastUsed: selected.lastUsed,
          visible: selected.visible,
        };
  }

  evictKey(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    this.bytes -= entry.geometry.byteSizeEstimate;
    return true;
  }

  private enforceLocal(): void {
    while (this.bytes + this.indexByteSize > this.maximumBytes) {
      const candidate = this.evictionCandidate();
      if (candidate === null) return;
      this.evictKey(candidate.key);
    }
  }
}

function assertBudget(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} budget must be positive.`);
}
