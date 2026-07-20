import { InkBoundsIndex } from '../domain/ink-bounds-index';
import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { joinInkStrokeSurfaceFragments } from '../domain/ink-surface-layout';
import { orderPositionedInkSurfaceRecords } from '../domain/ink-surface-migration';
import type { InkLogicalRect, InkRenderableStrokeRef } from './ink-document-session';

export interface InkPreviewProjectionReadView {
  readonly documentId: string;
  readonly indexBytes: number;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly strokeCount: number;
}

interface PositionedInkSurface {
  readonly endY: number;
  readonly index: number;
  readonly orderOffset: number;
  readonly record: InkSurfaceRecord;
  readonly startY: number;
}

interface PositionedInkFragment {
  readonly endY: number;
  readonly logicalHeight: number;
  readonly order: number;
  readonly schemaVersion: InkSurfaceRecord['schemaVersion'];
  readonly startY: number;
  readonly stroke: InkStroke;
  readonly surfaceId: string;
}

interface PreviewSurfaceIndexState {
  complete: boolean;
  readonly index: InkBoundsIndex<InkRenderableStrokeRef>;
  nextStrokeIndex: number;
}

export interface InkPreviewQueryWork {
  result(): readonly InkRenderableStrokeRef[];
  readonly unitKinds: readonly string[];
  readonly units: readonly (() => void)[];
}

const PREVIEW_SURFACE_OVERDRAW = 64;
const PREVIEW_INDEX_STROKES_PER_UNIT = 4;

/** Canonical read-only projection for Preview; it intentionally owns no editing or persistence API. */
export class InkPreviewProjection {
  readonly #logicalRefs = new Map<string, InkRenderableStrokeRef>();
  readonly #positioned: readonly PositionedInkSurface[];
  readonly #readBase: Omit<InkPreviewProjectionReadView, 'indexBytes'>;
  readonly #surfaceIndexes = new Map<number, PreviewSurfaceIndexState>();
  #indexBytes = 0;

  constructor(input: readonly InkSurfaceRecord[]) {
    if (input.length === 0) throw new Error('Ink Preview requires at least one canonical surface.');
    const records = orderPositionedInkSurfaceRecords(input);
    this.#positioned = positionSurfaces(records);
    this.#readBase = Object.freeze({
      documentId: `preview:${records.map(({ id, revision }) => `${id}@${revision}`).join(':')}`,
      logicalHeight: this.#positioned.at(-1)?.endY ?? records[0]?.layout.logicalHeight ?? 1,
      logicalWidth: records[0]?.layout.logicalWidth ?? 1,
      // This is a cheap physical upper bound. Exact logical de-duplication is deliberately deferred
      // with the visible surface instead of scanning a 10k history before an exact cache lookup.
      strokeCount: records.reduce((count, record) => count + record.strokes.length, 0),
    });
  }

  read(): InkPreviewProjectionReadView {
    return Object.freeze({ ...this.#readBase, indexBytes: this.#indexBytes });
  }

  query(viewport: InkLogicalRect): readonly InkRenderableStrokeRef[] {
    const work = this.prepareQuery(viewport);
    for (const unit of work.units) unit();
    return work.result();
  }

  /** Cooperative cache-miss query; each unit indexes at most a small bounded stroke batch. */
  prepareQuery(viewport: InkLogicalRect): InkPreviewQueryWork {
    assertViewport(viewport);
    const bottom = viewport.y + viewport.height;
    const surfaces = this.#positioned.filter(
      (surface) =>
        surface.endY >= viewport.y - PREVIEW_SURFACE_OVERDRAW &&
        surface.startY <= bottom + PREVIEW_SURFACE_OVERDRAW,
    );
    const units: (() => void)[] = [];
    const unitKinds: string[] = [];
    for (const surface of surfaces) {
      const state = this.#surfaceIndexState(surface);
      const remaining = Math.max(0, surface.record.strokes.length - state.nextStrokeIndex);
      const unitCount = Math.ceil(remaining / PREVIEW_INDEX_STROKES_PER_UNIT);
      for (let index = 0; index < unitCount; index += 1) {
        units.push(() => this.#materializeSurfaceChunk(surface, state));
        unitKinds.push('preview-query-index');
      }
    }
    let result: readonly InkRenderableStrokeRef[] = Object.freeze([]);
    const visible = new Map<string, InkRenderableStrokeRef>();
    for (const surface of surfaces) {
      units.push(() => {
        const state = this.#surfaceIndexState(surface);
        if (!state.complete) return;
        for (const ref of state.index.query(viewport).values) visible.set(ref.id, ref);
      });
      unitKinds.push('preview-query-collect');
    }
    units.push(() => {
      result = Object.freeze([...visible.values()].sort((left, right) => left.order - right.order));
    });
    unitKinds.push('preview-query-sort');
    return Object.freeze({
      result: () => result,
      unitKinds: Object.freeze(unitKinds),
      units: Object.freeze(units),
    });
  }

  #surfaceIndexState(surface: PositionedInkSurface): PreviewSurfaceIndexState {
    const existing = this.#surfaceIndexes.get(surface.index);
    if (existing !== undefined) return existing;
    const created: PreviewSurfaceIndexState = {
      complete: surface.record.strokes.length === 0,
      index: new InkBoundsIndex<InkRenderableStrokeRef>(),
      nextStrokeIndex: 0,
    };
    this.#surfaceIndexes.set(surface.index, created);
    return created;
  }

  #materializeSurfaceChunk(surface: PositionedInkSurface, state: PreviewSurfaceIndexState): void {
    if (state.complete) return;
    const initialBytes = state.index.byteSizeEstimate;
    const end = Math.min(
      surface.record.strokes.length,
      state.nextStrokeIndex + PREVIEW_INDEX_STROKES_PER_UNIT,
    );
    while (state.nextStrokeIndex < end) {
      const strokeIndex = state.nextStrokeIndex;
      state.nextStrokeIndex += 1;
      const stroke = surface.record.strokes[strokeIndex];
      if (stroke === undefined) continue;
      if (stroke.tool === 'eraser') continue;
      const identity = stroke.linkedStrokeId ?? stroke.id;
      let ref = this.#logicalRefs.get(identity);
      if (ref === undefined) {
        const fragments =
          stroke.linkedStrokeId === undefined
            ? [positionFragment(surface, strokeIndex, stroke)]
            : this.#collectLinkedFragments(identity, surface.index);
        const joined = joinInkStrokeSurfaceFragments(fragments);
        const logical = joined[0];
        if (logical === undefined || joined.length !== 1) {
          throw new Error(`Ink Preview could not materialize Logical Stroke ${identity}.`);
        }
        ref = Object.freeze({
          bounds: previewStrokeBounds(logical),
          id: logical.id,
          order: Math.min(...fragments.map(({ order }) => order)),
          stroke: logical,
        });
        this.#logicalRefs.set(identity, ref);
      }
      state.index.set(ref.id, ref.bounds, ref);
    }
    state.complete = state.nextStrokeIndex >= surface.record.strokes.length;
    this.#indexBytes += state.index.byteSizeEstimate - initialBytes;
  }

  #collectLinkedFragments(identity: string, sourceIndex: number): readonly PositionedInkFragment[] {
    const fragments: PositionedInkFragment[] = [];
    const collect = (surface: PositionedInkSurface): number => {
      let count = 0;
      for (const [strokeIndex, stroke] of surface.record.strokes.entries()) {
        if (stroke.linkedStrokeId !== identity) continue;
        fragments.push(positionFragment(surface, strokeIndex, stroke));
        count += 1;
      }
      return count;
    };
    const source = this.#positioned[sourceIndex];
    if (source === undefined || collect(source) === 0) {
      throw new Error(`Ink Preview lost source fragment for Logical Stroke ${identity}.`);
    }
    for (let index = sourceIndex - 1; index >= 0; index -= 1) {
      const surface = this.#positioned[index] as PositionedInkSurface;
      if (collect(surface) === 0) break;
    }
    for (let index = sourceIndex + 1; index < this.#positioned.length; index += 1) {
      const surface = this.#positioned[index] as PositionedInkSurface;
      if (collect(surface) === 0) break;
    }
    return fragments.sort((left, right) => left.order - right.order);
  }
}

function positionSurfaces(records: readonly InkSurfaceRecord[]): readonly PositionedInkSurface[] {
  let cursor = 0;
  let orderOffset = 0;
  return records.map((record, index) => {
    const startY = record.schemaVersion >= 2 ? (record.layout.originY ?? cursor) : cursor;
    const endY = startY + record.layout.logicalHeight;
    const positioned = { endY, index, orderOffset, record, startY };
    cursor = endY;
    orderOffset += record.strokes.length;
    return positioned;
  });
}

function positionFragment(
  surface: PositionedInkSurface,
  strokeIndex: number,
  stroke: InkStroke,
): PositionedInkFragment {
  return {
    endY: surface.endY,
    logicalHeight: surface.record.layout.logicalHeight,
    order: surface.orderOffset + strokeIndex,
    schemaVersion: surface.record.schemaVersion,
    startY: surface.startY,
    stroke,
    surfaceId: surface.record.id,
  };
}

/** Cheap conservative index bounds; exact Brush Geometry is compiled only for visible pixels. */
function previewStrokeBounds(stroke: InkStroke): InkLogicalRect {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const point of stroke.points) {
    minimumX = Math.min(minimumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumX = Math.max(maximumX, point.x);
    maximumY = Math.max(maximumY, point.y);
  }
  if (!Number.isFinite(minimumX)) return Object.freeze({ height: 0, width: 0, x: 0, y: 0 });
  // Physical nib tilt and legacy round caps stay within this deliberately generous envelope.
  const expansion = Math.max(16, stroke.width * 4);
  return Object.freeze({
    height: maximumY - minimumY + expansion * 2,
    width: maximumX - minimumX + expansion * 2,
    x: minimumX - expansion,
    y: minimumY - expansion,
  });
}

function assertViewport(viewport: InkLogicalRect): void {
  if (
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width < 0 ||
    viewport.height < 0
  ) {
    throw new Error('Ink viewport bounds must be finite and non-negative.');
  }
}
