export interface InkBoundsRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InkBoundsIndexQuery<T> {
  readonly values: readonly T[];
  readonly visitedNodeCount: number;
}

interface InkBoundsIndexEntry<T> {
  readonly bounds: InkBoundsRect;
  readonly id: string;
  readonly value: T;
}

interface InkBoundsIndexNode<T> {
  readonly entry: InkBoundsIndexEntry<T>;
  readonly left: InkBoundsIndexNode<T> | null;
  readonly maximumBottom: number;
  readonly minimumTop: number;
  readonly priority: number;
  readonly right: InkBoundsIndexNode<T> | null;
}

/** Incremental conservative-bounds index. Bounded-surface identity never leaks through it. */
export class InkBoundsIndex<T> {
  private bytes = 0;
  private readonly entries = new Map<string, InkBoundsIndexEntry<T>>();
  private root: InkBoundsIndexNode<T> | null = null;

  get byteSizeEstimate(): number {
    return this.bytes;
  }

  set(id: string, bounds: InkBoundsRect, value: T): void {
    if (id.length === 0) throw new Error('Ink bounds index requires a non-empty ID.');
    if (!validRect(bounds)) throw new Error(`Ink bounds index entry ${id} has invalid bounds.`);
    if (this.entries.has(id)) this.delete(id);
    const entry = { bounds, id, value };
    this.entries.set(id, entry);
    this.bytes += entryByteSize(id);
    this.root = insert(this.root, node(entry));
  }

  delete(id: string): boolean {
    const existing = this.entries.get(id);
    if (existing === undefined) return false;
    this.entries.delete(id);
    this.bytes -= entryByteSize(id);
    this.root = remove(this.root, existing);
    return true;
  }

  deleteMany(ids: readonly string[]): number {
    const entries = [...new Set(ids)].flatMap((id) => {
      const entry = this.entries.get(id);
      return entry === undefined ? [] : [entry];
    });
    if (entries.length === 0) return 0;
    if (entries.length <= 64) {
      for (const entry of entries) {
        this.entries.delete(entry.id);
        this.bytes -= entryByteSize(entry.id);
        this.root = remove(this.root, entry);
      }
      return entries.length;
    }
    for (const entry of entries) {
      this.entries.delete(entry.id);
      this.bytes -= entryByteSize(entry.id);
    }
    this.root = null;
    for (const entry of this.entries.values()) this.root = insert(this.root, node(entry));
    return entries.length;
  }

  query(viewport: InkBoundsRect): InkBoundsIndexQuery<T> {
    if (!validRect(viewport))
      throw new Error('Ink viewport bounds must be finite and non-negative.');
    const values: T[] = [];
    const stats = { visitedNodeCount: 0 };
    collect(this.root, viewport, values, stats);
    return { values, visitedNodeCount: stats.visitedNodeCount };
  }
}

function entryByteSize(id: string): number {
  return 128 + id.length * 2;
}

function node<T>(entry: InkBoundsIndexEntry<T>): InkBoundsIndexNode<T> {
  return makeNode(entry, null, null, priority(entry.id));
}

function insert<T>(
  root: InkBoundsIndexNode<T> | null,
  next: InkBoundsIndexNode<T>,
): InkBoundsIndexNode<T> {
  if (root === null) return next;
  if (compareEntries(next.entry, root.entry) < 0) {
    const left = insert(root.left, next);
    const updated = makeNode(root.entry, left, root.right, root.priority);
    return left.priority < updated.priority ? rotateRight(updated) : updated;
  }
  const right = insert(root.right, next);
  const updated = makeNode(root.entry, root.left, right, root.priority);
  return right.priority < updated.priority ? rotateLeft(updated) : updated;
}

function remove<T>(
  root: InkBoundsIndexNode<T> | null,
  entry: InkBoundsIndexEntry<T>,
): InkBoundsIndexNode<T> | null {
  if (root === null) return null;
  const compared = compareEntries(entry, root.entry);
  if (compared < 0) {
    return makeNode(root.entry, remove(root.left, entry), root.right, root.priority);
  }
  if (compared > 0) {
    return makeNode(root.entry, root.left, remove(root.right, entry), root.priority);
  }
  return merge(root.left, root.right);
}

function merge<T>(
  left: InkBoundsIndexNode<T> | null,
  right: InkBoundsIndexNode<T> | null,
): InkBoundsIndexNode<T> | null {
  if (left === null) return right;
  if (right === null) return left;
  if (left.priority < right.priority) {
    return makeNode(left.entry, left.left, merge(left.right, right), left.priority);
  }
  return makeNode(right.entry, merge(left, right.left), right.right, right.priority);
}

function rotateLeft<T>(root: InkBoundsIndexNode<T>): InkBoundsIndexNode<T> {
  const pivot = root.right;
  if (pivot === null) return root;
  const left = makeNode(root.entry, root.left, pivot.left, root.priority);
  return makeNode(pivot.entry, left, pivot.right, pivot.priority);
}

function rotateRight<T>(root: InkBoundsIndexNode<T>): InkBoundsIndexNode<T> {
  const pivot = root.left;
  if (pivot === null) return root;
  const right = makeNode(root.entry, pivot.right, root.right, root.priority);
  return makeNode(pivot.entry, pivot.left, right, pivot.priority);
}

function makeNode<T>(
  entry: InkBoundsIndexEntry<T>,
  left: InkBoundsIndexNode<T> | null,
  right: InkBoundsIndexNode<T> | null,
  nodePriority: number,
): InkBoundsIndexNode<T> {
  return {
    entry,
    left,
    maximumBottom: Math.max(
      bottom(entry.bounds),
      left?.maximumBottom ?? Number.NEGATIVE_INFINITY,
      right?.maximumBottom ?? Number.NEGATIVE_INFINITY,
    ),
    minimumTop: Math.min(
      entry.bounds.y,
      left?.minimumTop ?? Number.POSITIVE_INFINITY,
      right?.minimumTop ?? Number.POSITIVE_INFINITY,
    ),
    priority: nodePriority,
    right,
  };
}

function collect<T>(
  root: InkBoundsIndexNode<T> | null,
  viewport: InkBoundsRect,
  values: T[],
  stats: { visitedNodeCount: number },
): void {
  if (root === null) return;
  stats.visitedNodeCount += 1;
  const viewportBottom = bottom(viewport);
  if (root.maximumBottom < viewport.y || root.minimumTop > viewportBottom) return;
  collect(root.left, viewport, values, stats);
  if (intersects(root.entry.bounds, viewport)) values.push(root.entry.value);
  collect(root.right, viewport, values, stats);
}

function compareEntries<T>(left: InkBoundsIndexEntry<T>, right: InkBoundsIndexEntry<T>): number {
  return left.bounds.y - right.bounds.y || left.id.localeCompare(right.id);
}

function intersects(left: InkBoundsRect, right: InkBoundsRect): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

function bottom(rect: InkBoundsRect): number {
  return rect.y + rect.height;
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

function priority(id: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    value = Math.imul(value ^ id.charCodeAt(index), 0x01000193);
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}
