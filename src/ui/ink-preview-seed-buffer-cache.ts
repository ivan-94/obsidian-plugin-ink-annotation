import type { InkPreviewCacheTile } from '../storage/indexeddb-ink-preview-cache';
import {
  GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR,
  type InkDisposableMemoryEvictionCandidate,
  type InkDisposableMemoryParticipant,
  type InkGeometryCacheCoordinator,
} from './ink-geometry-cache';

interface InkPreviewSeedBufferEntry {
  readonly key: string;
  lastUsed: number;
  readonly tile: InkPreviewCacheTile;
}

/** Disposable encoded Preview seeds sharing the plugin-wide pixel/cache byte ceiling. */
export class InkPreviewSeedBufferCache implements InkDisposableMemoryParticipant {
  private bytes = 0;
  private readonly entries = new Map<string, InkPreviewSeedBufferEntry>();
  private disposed = false;

  constructor(
    private readonly coordinator: InkGeometryCacheCoordinator = GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR,
  ) {
    this.coordinator.register(this);
  }

  get disposableBytes(): number {
    return this.bytes;
  }

  merge(tiles: readonly InkPreviewCacheTile[]): void {
    this.assertUsable();
    for (const tile of tiles) {
      if (tile.byteLength !== tile.bytes.byteLength || tile.byteLength <= 0) {
        throw new Error('Ink Preview seed byte length must match its owned buffer.');
      }
      const key = coordinateKey(tile);
      const previous = this.entries.get(key);
      if (previous !== undefined) this.bytes -= previous.tile.byteLength;
      this.entries.set(key, { key, lastUsed: this.coordinator.nextUse(), tile });
      this.bytes += tile.byteLength;
    }
    this.coordinator.enforce();
  }

  replace(tiles: readonly InkPreviewCacheTile[]): void {
    this.assertUsable();
    this.entries.clear();
    this.bytes = 0;
    this.merge(tiles);
  }

  snapshot(): readonly InkPreviewCacheTile[] {
    this.assertUsable();
    return Object.freeze([...this.entries.values()].map(({ tile }) => tile));
  }

  evictionCandidate(): InkDisposableMemoryEvictionCandidate | null {
    if (this.disposed) return null;
    let selected: InkPreviewSeedBufferEntry | null = null;
    for (const entry of this.entries.values()) {
      if (selected === null || entry.lastUsed < selected.lastUsed) selected = entry;
    }
    return selected === null
      ? null
      : {
          evict: () => this.remove(selected.key),
          lastUsed: selected.lastUsed,
          visible: false,
        };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.bytes = 0;
    this.coordinator.unregister(this);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.tile.byteLength;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Ink Preview seed buffer cache has been disposed.');
  }
}

function coordinateKey(tile: InkPreviewCacheTile): string {
  return `${tile.lod}:${tile.x}:${tile.y}`;
}
