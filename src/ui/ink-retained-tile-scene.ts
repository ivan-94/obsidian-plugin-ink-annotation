export interface InkRetainedTileLogicalBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InkRetainedTileCamera {
  readonly height: number;
  readonly logicalLeft: number;
  readonly logicalTop: number;
  readonly scale: number;
  readonly width: number;
}

interface InkRetainedTileNode {
  readonly bounds: InkRetainedTileLogicalBounds;
  readonly byteSize: number;
  readonly canvas: HTMLCanvasElement;
  readonly key: string;
  lastUsed: number;
  presented: boolean;
  visible: boolean;
}

/** Bounded DOM presentation of individually retained complete tiles under one Camera. */
export class InkRetainedTileScene implements InkDisposableMemoryParticipant {
  private bytes = 0;
  private readonly coordinator: InkGeometryCacheCoordinator;
  private disposed = false;
  private readonly maximumNodeCount: number;
  private readonly nodes = new Map<string, InkRetainedTileNode>();
  private readonly root: HTMLElement;

  constructor(input: {
    readonly document: Document;
    readonly host: HTMLElement;
    readonly maximumNodeCount?: number;
    readonly memoryCoordinator?: InkGeometryCacheCoordinator;
  }) {
    this.maximumNodeCount = input.maximumNodeCount ?? 64;
    if (!Number.isSafeInteger(this.maximumNodeCount) || this.maximumNodeCount <= 0) {
      throw new Error('Ink retained tile node limit must be a positive safe integer.');
    }
    this.coordinator = input.memoryCoordinator ?? GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR;
    this.coordinator.register(this);
    this.root = input.document.createElement('div');
    this.root.className = 'inkstone-ink-retained-tile-scene';
    this.root.dataset.inkstoneRetainedTileScene = 'true';
    this.root.hidden = true;
    this.root.style.inset = '0';
    this.root.style.overflow = 'visible';
    this.root.style.pointerEvents = 'none';
    this.root.style.position = 'absolute';
    this.root.style.transformOrigin = '0 0';
    this.root.style.willChange = 'transform';
    input.host.append(this.root);
  }

  get hasPresentation(): boolean {
    return !this.root.hidden && this.nodes.size > 0;
  }

  get disposableBytes(): number {
    return this.bytes;
  }

  adopt(input: {
    readonly backingHeight: number;
    readonly backingWidth: number;
    readonly key: string;
    readonly logicalBounds: InkRetainedTileLogicalBounds;
    readonly presented?: boolean;
    readonly source: CanvasImageSource;
  }): boolean {
    this.assertUsable();
    assertTileInput(input);
    const retained = this.nodes.get(input.key);
    if (retained !== undefined) {
      retained.lastUsed = this.coordinator.nextUse();
      return true;
    }
    this.evictForAdmission();
    const canvas = this.root.ownerDocument.createElement('canvas');
    canvas.dataset.inkstoneRetainedTile = input.key;
    const presented = input.presented ?? true;
    canvas.hidden = !presented;
    canvas.style.height = `${input.logicalBounds.height}px`;
    canvas.style.position = 'absolute';
    canvas.style.transform = `translate3d(${input.logicalBounds.x}px, ${input.logicalBounds.y}px, 0)`;
    canvas.style.transformOrigin = '0 0';
    canvas.style.width = `${input.logicalBounds.width}px`;
    canvas.width = input.backingWidth;
    canvas.height = input.backingHeight;
    const context = canvas.getContext('2d');
    if (context === null) {
      canvas.width = 0;
      canvas.height = 0;
      return false;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(input.source, 0, 0, canvas.width, canvas.height);
    const node: InkRetainedTileNode = {
      bounds: Object.freeze({ ...input.logicalBounds }),
      byteSize: input.backingWidth * input.backingHeight * 4,
      canvas,
      key: input.key,
      lastUsed: this.coordinator.nextUse(),
      presented,
      visible: false,
    };
    this.nodes.set(input.key, node);
    this.bytes += node.byteSize;
    this.root.append(canvas);
    this.coordinator.enforce();
    return this.nodes.has(input.key);
  }

  has(key: string): boolean {
    return !this.disposed && this.nodes.has(key);
  }

  project(camera: InkRetainedTileCamera): void {
    this.assertUsable();
    assertCamera(camera);
    this.root.hidden = false;
    this.root.style.transform = `matrix(${camera.scale}, 0, 0, ${camera.scale}, ${-camera.logicalLeft * camera.scale}, ${-camera.logicalTop * camera.scale})`;
    for (const node of this.nodes.values()) {
      const left = (node.bounds.x - camera.logicalLeft) * camera.scale;
      const top = (node.bounds.y - camera.logicalTop) * camera.scale;
      const width = node.bounds.width * camera.scale;
      const height = node.bounds.height * camera.scale;
      node.visible =
        node.presented &&
        left < camera.width &&
        left + width > 0 &&
        top < camera.height &&
        top + height > 0;
      if (!node.visible) continue;
      node.lastUsed = this.coordinator.nextUse();
    }
  }

  /** Switches complete compatible coverage without removing retained fallback resources. */
  presentOnly(keys: ReadonlySet<string>): void {
    this.assertUsable();
    for (const node of this.nodes.values()) {
      const presented = keys.has(node.key);
      if (node.presented === presented) continue;
      node.presented = presented;
      node.canvas.hidden = !presented;
      if (!presented) node.visible = false;
    }
  }

  hide(): void {
    if (this.disposed) return;
    this.root.hidden = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const node of this.nodes.values()) releaseNode(node);
    this.nodes.clear();
    this.bytes = 0;
    this.coordinator.unregister(this);
    this.root.remove();
  }

  evictionCandidate(): InkDisposableMemoryEvictionCandidate | null {
    if (this.disposed) return null;
    const selected = this.evictionNode();
    return selected === null
      ? null
      : {
          evict: () => this.removeNode(selected),
          lastUsed: selected.lastUsed,
          visible: selected.visible,
        };
  }

  private evictForAdmission(): void {
    while (this.nodes.size >= this.maximumNodeCount) {
      const selected = this.evictionNode();
      if (selected === null) return;
      this.removeNode(selected);
    }
  }

  private evictionNode(): InkRetainedTileNode | null {
    let selected: InkRetainedTileNode | null = null;
    for (const node of this.nodes.values()) {
      if (
        selected === null ||
        Number(node.visible) < Number(selected.visible) ||
        (node.visible === selected.visible && node.lastUsed < selected.lastUsed)
      ) {
        selected = node;
      }
    }
    return selected;
  }

  private removeNode(node: InkRetainedTileNode): void {
    if (!this.nodes.delete(node.key)) return;
    this.bytes -= node.byteSize;
    releaseNode(node);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Ink retained tile scene has been disposed.');
  }
}

function releaseNode(node: InkRetainedTileNode): void {
  node.canvas.remove();
  node.canvas.width = 0;
  node.canvas.height = 0;
}

function assertTileInput(input: {
  readonly backingHeight: number;
  readonly backingWidth: number;
  readonly key: string;
  readonly logicalBounds: InkRetainedTileLogicalBounds;
}): void {
  if (input.key.length === 0) throw new Error('Ink retained tile key must not be empty.');
  if (
    !Number.isSafeInteger(input.backingWidth) ||
    input.backingWidth <= 0 ||
    !Number.isSafeInteger(input.backingHeight) ||
    input.backingHeight <= 0
  ) {
    throw new Error('Ink retained tile backing dimensions must be positive safe integers.');
  }
  const { height, width, x, y } = input.logicalBounds;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('Ink retained tile logical bounds must be finite and positive.');
  }
}

function assertCamera(camera: InkRetainedTileCamera): void {
  if (
    !Number.isFinite(camera.logicalLeft) ||
    !Number.isFinite(camera.logicalTop) ||
    !Number.isFinite(camera.scale) ||
    camera.scale <= 0 ||
    !Number.isFinite(camera.width) ||
    camera.width <= 0 ||
    !Number.isFinite(camera.height) ||
    camera.height <= 0
  ) {
    throw new Error('Ink retained tile Camera must be finite and positive.');
  }
}
import {
  GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR,
  type InkDisposableMemoryEvictionCandidate,
  type InkDisposableMemoryParticipant,
  type InkGeometryCacheCoordinator,
} from './ink-geometry-cache';
