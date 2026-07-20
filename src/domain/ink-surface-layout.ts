import {
  assertInkStrokeBrushMetadata,
  type InkPhysicalPoint,
  type InkPoint,
  type InkStroke,
  type InkSurfaceRecord,
} from './ink-surface';

export interface InkLayoutObservation {
  readonly fontAvailable: boolean;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly sourceRevision: string;
  readonly themeMode: 'dark' | 'light';
  readonly viewportWidth: number;
}

export interface InkSurfaceSection {
  readonly blockFingerprints: readonly string[];
  readonly headingPath: readonly string[];
  readonly sectionFingerprint: string;
  readonly sourceEnd: number;
  readonly sourceStart: number;
}

export interface InkMarkdownBlock {
  readonly fingerprint: string;
  readonly headingPath: readonly string[];
  readonly kind: 'block' | 'heading';
  readonly sourceEnd: number;
  readonly sourceStart: number;
}

export interface InkSurfacePartition extends InkSurfaceSection {
  readonly fullNoteFallback: boolean;
}

export function partitionInkBlocks(
  blocks: readonly InkMarkdownBlock[],
  options: { readonly maxBlocks: number },
): readonly InkSurfacePartition[] {
  if (!Number.isInteger(options.maxBlocks) || options.maxBlocks < 1) {
    throw new Error('Ink surface maxBlocks must be a positive integer.');
  }
  if (blocks.length === 0) {
    return [];
  }
  const groups: InkMarkdownBlock[][] = [];
  let current: InkMarkdownBlock[] = [];
  for (const block of blocks) {
    const startsHeading = block.kind === 'heading' && current.length > 0;
    if (startsHeading || current.length >= options.maxBlocks) {
      groups.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups.map((group) => {
    const first = group[0] as InkMarkdownBlock;
    const last = group.at(-1) as InkMarkdownBlock;
    const blockFingerprints = group.map((block) => block.fingerprint);
    return {
      blockFingerprints,
      fullNoteFallback: false,
      headingPath: first.headingPath,
      sectionFingerprint: stableSectionFingerprint(first.headingPath, blockFingerprints),
      sourceEnd: last.sourceEnd,
      sourceStart: first.sourceStart,
    };
  });
}

export function splitInkStrokeIntoSurfaceFragments(input: {
  readonly stroke: InkStroke;
  readonly surfaces: readonly {
    readonly endY: number;
    readonly id: string;
    readonly logicalHeight: number;
    readonly startY: number;
  }[];
}): readonly { readonly surfaceId: string; readonly stroke: InkStroke }[] {
  const fragments: Array<{ surfaceId: string; stroke: InkStroke }> = [];
  const linkedStrokeId = input.stroke.linkedStrokeId ?? input.stroke.id;
  const internalBoundaries = sharedSurfaceBoundaries(input.surfaces);
  for (const surface of input.surfaces) {
    if (
      !Number.isFinite(surface.startY) ||
      !Number.isFinite(surface.endY) ||
      !Number.isFinite(surface.logicalHeight) ||
      surface.logicalHeight <= 0 ||
      surface.endY !== surface.startY + surface.logicalHeight
    ) {
      throw new Error(`Ink surface ${surface.id} has invalid bounds.`);
    }
    const globalPoints: InkPoint[] = [];
    if (input.stroke.points.length === 1) {
      const only = input.stroke.points[0];
      if (only !== undefined && only.y >= surface.startY && only.y <= surface.endY) {
        globalPoints.push(
          decoratePhysicalFragmentPoint(
            withPhysicalFragmentTraceOrder(only, 0),
            internalBoundaries,
            linkedStrokeId,
            surface.startY,
            surface.endY,
          ),
        );
      }
    }
    for (let index = 1; index < input.stroke.points.length; index += 1) {
      const rawStart = input.stroke.points[index - 1];
      const rawEnd = input.stroke.points[index];
      const start =
        rawStart === undefined ? undefined : withPhysicalFragmentTraceOrder(rawStart, index - 1);
      const end = rawEnd === undefined ? undefined : withPhysicalFragmentTraceOrder(rawEnd, index);
      if (start === undefined || end === undefined) continue;
      const clipped = clipSegment(start, end, surface.startY, surface.endY);
      if (clipped === null) continue;
      appendUnique(
        globalPoints,
        decoratePhysicalFragmentPoint(
          clipped[0],
          internalBoundaries,
          linkedStrokeId,
          surface.startY,
          surface.endY,
        ),
      );
      appendUnique(
        globalPoints,
        decoratePhysicalFragmentPoint(
          clipped[1],
          internalBoundaries,
          linkedStrokeId,
          surface.startY,
          surface.endY,
        ),
      );
    }
    if (globalPoints.length > 0) {
      fragments.push({
        surfaceId: surface.id,
        stroke: {
          ...input.stroke,
          id: `${linkedStrokeId}-${surface.id}`,
          linkedStrokeId,
          points: globalPoints.map((point) => localizeFragmentPoint(point, surface)),
        },
      });
    }
  }
  return fragments;
}

function localizeFragmentPoint(
  point: InkPoint,
  surface: {
    readonly endY: number;
    readonly logicalHeight: number;
    readonly startY: number;
  },
): InkPoint {
  if (isPhysicalInkPoint(point)) {
    if (point.fragmentBoundary !== undefined) {
      if (point.fragmentBoundaryEdge === 'start') return { ...point, y: 0 };
      if (point.fragmentBoundaryEdge === 'end') {
        return { ...point, y: surface.logicalHeight };
      }
      throw new Error('Physical Ink fragment boundary is missing its persisted surface edge.');
    }
    if (point.y === surface.startY) return { ...point, y: 0 };
    if (point.y === surface.endY) return { ...point, y: surface.logicalHeight };
  }
  return { ...point, y: point.y - surface.startY };
}

function sharedSurfaceBoundaries(
  surfaces: readonly { readonly endY: number; readonly startY: number }[],
): ReadonlySet<number> {
  const starts = new Set(surfaces.map(({ startY }) => startY));
  return new Set(surfaces.map(({ endY }) => endY).filter((endY) => starts.has(endY)));
}

function withPhysicalFragmentTraceOrder(point: InkPoint, order: number): InkPoint {
  if (!isPhysicalInkPoint(point)) return point;
  const ordered: InkPhysicalPoint = { ...point, fragmentTraceOrder: order };
  return ordered;
}

function decoratePhysicalFragmentPoint(
  point: InkPoint,
  internalBoundaries: ReadonlySet<number>,
  linkedStrokeId: string,
  surfaceStartY: number,
  surfaceEndY: number,
): InkPoint {
  if (!isPhysicalInkPoint(point)) return point;
  const order = point.fragmentTraceOrder;
  if (order === undefined) {
    throw new Error('Physical Ink fragment point lost its trace order.');
  }
  const globallyProvenanced: InkPhysicalPoint = { ...point, fragmentGlobalY: point.y };
  const boundary =
    point.fragmentBoundary === 'synthetic-clip'
      ? 'synthetic-clip'
      : internalBoundaries.has(point.y)
        ? 'authored-copy'
        : undefined;
  if (boundary === undefined) return globallyProvenanced;
  const fragmentBoundaryEdge =
    point.y === surfaceStartY ? 'start' : point.y === surfaceEndY ? 'end' : undefined;
  if (fragmentBoundaryEdge === undefined) {
    throw new Error('Physical Ink fragment boundary is not on a surface edge.');
  }
  const decorated: InkPhysicalPoint = {
    ...globallyProvenanced,
    fragmentBoundary: boundary,
    fragmentBoundaryEdge,
    fragmentBoundaryId: `${linkedStrokeId}:boundary:${canonicalFragmentOrder(order)}`,
  };
  return decorated;
}

function canonicalFragmentOrder(order: number): string {
  if (!Number.isFinite(order) || order < 0) {
    throw new Error('Physical Ink fragment trace order must be finite and non-negative.');
  }
  return order.toString();
}

export interface InkStrokeSurfaceFragment {
  readonly endY: number;
  readonly logicalHeight: number;
  readonly schemaVersion: InkSurfaceRecord['schemaVersion'];
  readonly startY: number;
  readonly stroke: InkStroke;
  readonly surfaceId: string;
}

interface InkGlobalFragmentRun {
  readonly endY: number;
  readonly points: readonly InkPoint[];
  readonly startY: number;
  readonly strokeId: string;
  readonly surfaceId: string;
}

export function joinInkStrokeSurfaceFragments(
  fragments: readonly InkStrokeSurfaceFragment[],
): readonly InkStroke[] {
  const joined = new Map<
    string,
    {
      readonly identity: string;
      readonly runs: InkGlobalFragmentRun[];
      readonly stroke: InkStroke;
    }
  >();
  for (const fragment of fragments) {
    assertInkStrokeBrushMetadata(fragment.stroke, fragment.schemaVersion);
    const { endY, logicalHeight, startY, stroke, surfaceId } = fragment;
    if (
      !Number.isFinite(startY) ||
      !Number.isFinite(endY) ||
      !Number.isFinite(logicalHeight) ||
      logicalHeight <= 0 ||
      endY !== startY + logicalHeight
    ) {
      throw new Error(`Ink surface ${surfaceId} has invalid join bounds.`);
    }
    const identity = stroke.linkedStrokeId ?? stroke.id;
    const globalPoints = stroke.points.map((point) =>
      globalizeFragmentPoint(point, startY, endY, logicalHeight),
    );
    const run = { endY, points: globalPoints, startY, strokeId: stroke.id, surfaceId };
    const existing = joined.get(identity);
    if (existing === undefined) {
      joined.set(identity, { identity, runs: [run], stroke });
      continue;
    }
    if (!hasSameCompleteBrushIdentity(existing.stroke, stroke)) {
      throw new Error(`Ink Logical Stroke ${identity} has inconsistent brush identity fragments.`);
    }
    existing.runs.push(run);
  }
  return [...joined.values()].map(({ identity, runs, stroke }) => {
    const { linkedStrokeId: _linkedStrokeId, ...unlinkedStroke } = stroke;
    void _linkedStrokeId;
    const physicalFragment =
      stroke.linkedStrokeId !== undefined &&
      (stroke.brushRenderVersion === 'pen-physical-v1' ||
        stroke.brushRenderVersion === 'highlighter-chisel-v1');
    const ordered = physicalFragment
      ? joinPhysicalFragmentTrace(identity, runs)
      : orderFragmentTracePoints(runs.map(({ points }) => points));
    if (ordered.length === 0) {
      throw new Error(`Ink Logical Stroke ${identity} contains only synthetic clip samples.`);
    }
    return { ...unlinkedStroke, id: identity, points: ordered };
  });
}

function joinPhysicalFragmentTrace(
  identity: string,
  runs: readonly InkGlobalFragmentRun[],
): readonly InkPoint[] {
  const surfaceIds = new Set<string>();
  const strokeIds = new Set<string>();
  const connections = new Map(runs.map((run) => [run, new Set<InkGlobalFragmentRun>()] as const));
  const boundaries = new Map<
    string,
    Array<{ readonly point: InkPhysicalPoint; readonly run: InkGlobalFragmentRun }>
  >();
  const canonicalByOrder = new Map<number, InkPhysicalPoint>();
  for (const run of runs) {
    if (surfaceIds.has(run.surfaceId) || strokeIds.has(run.strokeId)) {
      throw new Error(`Ink Logical Stroke ${identity} has duplicate physical fragment identity.`);
    }
    surfaceIds.add(run.surfaceId);
    strokeIds.add(run.strokeId);
    let previousFragmentOrder = Number.NEGATIVE_INFINITY;
    for (const candidate of run.points) {
      if (!isPhysicalInkPoint(candidate) || candidate.fragmentTraceOrder === undefined) {
        throw new Error(`Ink Logical Stroke ${identity} is missing physical fragment trace order.`);
      }
      if (candidate.fragmentTraceOrder <= previousFragmentOrder) {
        throw new Error(
          `Ink Logical Stroke ${identity} has non-monotonic physical fragment trace order.`,
        );
      }
      previousFragmentOrder = candidate.fragmentTraceOrder;
      if (candidate.fragmentBoundary === undefined) {
        addCanonicalPhysicalPoint(identity, canonicalByOrder, candidate);
        continue;
      }
      const boundaryId = candidate.fragmentBoundaryId;
      if (boundaryId === undefined) {
        throw new Error(`Ink Logical Stroke ${identity} has boundary provenance without identity.`);
      }
      if (
        boundaryId !==
        `${identity}:boundary:${canonicalFragmentOrder(candidate.fragmentTraceOrder)}`
      ) {
        throw new Error(`Ink Logical Stroke ${identity} has invalid physical boundary identity.`);
      }
      const occurrences = boundaries.get(boundaryId) ?? [];
      occurrences.push({ point: candidate, run });
      boundaries.set(boundaryId, occurrences);
    }
  }
  for (const [boundaryId, occurrences] of boundaries) {
    if (occurrences.length !== 2) {
      throw new Error(
        `Ink Logical Stroke ${identity} has an incomplete physical fragment boundary ${boundaryId}.`,
      );
    }
    const first = occurrences[0] as (typeof occurrences)[number];
    const second = occurrences[1] as (typeof occurrences)[number];
    if (!isOppositeBoundaryPair(first, second)) {
      throw new Error(
        `Ink Logical Stroke ${identity} has an invalid physical fragment boundary ${boundaryId}.`,
      );
    }
    connections.get(first.run)?.add(second.run);
    connections.get(second.run)?.add(first.run);
    if (
      first.point.fragmentBoundary !== second.point.fragmentBoundary ||
      physicalFragmentPayloadKey(first.point) !== physicalFragmentPayloadKey(second.point)
    ) {
      throw new Error(
        `Ink Logical Stroke ${identity} has divergent physical fragment boundary ${boundaryId}.`,
      );
    }
    if (first.point.fragmentBoundary === 'authored-copy') {
      addCanonicalPhysicalPoint(identity, canonicalByOrder, first.point);
    }
  }
  if (!hasConnectedPhysicalFragmentRuns(runs, connections)) {
    throw new Error(`Ink Logical Stroke ${identity} has an incomplete physical fragment set.`);
  }
  const canonical = [...canonicalByOrder.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, point]) => stripPhysicalFragmentProvenance(point));
  for (let index = 1; index < canonical.length; index += 1) {
    if (
      (canonical[index] as InkPhysicalPoint).time < (canonical[index - 1] as InkPhysicalPoint).time
    ) {
      throw new Error(`Ink Logical Stroke ${identity} has non-monotonic canonical physical time.`);
    }
  }
  return canonical;
}

function globalizeFragmentPoint(
  point: InkPoint,
  startY: number,
  endY: number,
  logicalHeight: number,
): InkPoint {
  if (isPhysicalInkPoint(point) && point.fragmentGlobalY !== undefined) {
    const globalY = point.fragmentGlobalY;
    if (point.fragmentBoundary !== undefined) {
      if (point.fragmentBoundaryEdge === 'start' && point.y === 0 && globalY === startY) {
        return { ...point, y: globalY };
      }
      if (point.fragmentBoundaryEdge === 'end' && point.y === logicalHeight && globalY === endY) {
        return { ...point, y: globalY };
      }
      throw new Error('Physical Ink fragment boundary does not match its persisted surface edge.');
    }
    if (
      (globalY === startY && point.y === 0) ||
      (globalY === endY && point.y === logicalHeight) ||
      point.y === globalY - startY ||
      startY + point.y === globalY
    ) {
      return { ...point, y: globalY };
    }
    throw new Error('Physical Ink fragment global provenance does not match its local projection.');
  }
  return { ...point, y: point.y + startY };
}

function hasConnectedPhysicalFragmentRuns(
  runs: readonly InkGlobalFragmentRun[],
  connections: ReadonlyMap<InkGlobalFragmentRun, ReadonlySet<InkGlobalFragmentRun>>,
): boolean {
  const first = runs[0];
  if (first === undefined) return true;
  const visited = new Set<InkGlobalFragmentRun>();
  const pending = [first];
  while (pending.length > 0) {
    const current = pending.pop() as InkGlobalFragmentRun;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const adjacent of connections.get(current) ?? []) pending.push(adjacent);
  }
  return visited.size === runs.length;
}

function isOppositeBoundaryPair(
  first: { readonly point: InkPhysicalPoint; readonly run: InkGlobalFragmentRun },
  second: { readonly point: InkPhysicalPoint; readonly run: InkGlobalFragmentRun },
): boolean {
  if (first.run.strokeId === second.run.strokeId || first.run.surfaceId === second.run.surfaceId) {
    return false;
  }
  return (
    (first.point.fragmentBoundaryEdge === 'end' &&
      second.point.fragmentBoundaryEdge === 'start' &&
      first.run.endY === second.run.startY) ||
    (second.point.fragmentBoundaryEdge === 'end' &&
      first.point.fragmentBoundaryEdge === 'start' &&
      second.run.endY === first.run.startY)
  );
}

function addCanonicalPhysicalPoint(
  identity: string,
  points: Map<number, InkPhysicalPoint>,
  point: InkPhysicalPoint,
): void {
  const order = point.fragmentTraceOrder;
  if (order === undefined) {
    throw new Error(`Ink Logical Stroke ${identity} lost physical fragment trace order.`);
  }
  const existing = points.get(order);
  if (existing !== undefined) {
    const kind =
      physicalFragmentPayloadKey(existing) === physicalFragmentPayloadKey(point)
        ? 'duplicate'
        : 'divergent';
    throw new Error(`Ink Logical Stroke ${identity} has ${kind} physical trace order ${order}.`);
  }
  points.set(order, point);
}

function physicalFragmentPayloadKey(point: InkPhysicalPoint): string {
  return JSON.stringify({
    fragmentTraceOrder: point.fragmentTraceOrder,
    fragmentGlobalY: point.fragmentGlobalY,
    orientation:
      point.orientation.kind === 'unavailable'
        ? { kind: 'unavailable' }
        : {
            altitude: point.orientation.altitude,
            azimuth: point.orientation.azimuth,
            kind: 'measured',
            reliable: point.orientation.reliable,
          },
    pressure: point.pressure,
    pressureKind: point.pressureKind,
    time: point.time,
    x: point.x,
    y: point.y,
  });
}

function stripPhysicalFragmentProvenance(point: InkPhysicalPoint): InkPhysicalPoint {
  const {
    fragmentBoundary: _fragmentBoundary,
    fragmentBoundaryEdge: _fragmentBoundaryEdge,
    fragmentBoundaryId: _fragmentBoundaryId,
    fragmentGlobalY: _fragmentGlobalY,
    fragmentTraceOrder: _fragmentTraceOrder,
    ...canonical
  } = point;
  void _fragmentBoundary;
  void _fragmentBoundaryEdge;
  void _fragmentBoundaryId;
  void _fragmentGlobalY;
  void _fragmentTraceOrder;
  return canonical;
}

function hasSameCompleteBrushIdentity(left: InkStroke, right: InkStroke): boolean {
  return (
    left.linkedStrokeId === right.linkedStrokeId &&
    left.tool === right.tool &&
    left.color === right.color &&
    left.width === right.width &&
    left.brushRenderVersion === right.brushRenderVersion &&
    left.inputProfile?.pressure === right.inputProfile?.pressure &&
    left.inputProfile?.tilt === right.inputProfile?.tilt
  );
}

export type InkSurfaceReconciliation =
  | { readonly kind: 'active'; readonly record: InkSurfaceRecord }
  | { readonly kind: 'relocated'; readonly record: InkSurfaceRecord }
  | { readonly kind: 'needs-rebase'; readonly record: InkSurfaceRecord }
  | { readonly kind: 'unanchored'; readonly record: InkSurfaceRecord };

export function reconcileInkSurface(
  record: InkSurfaceRecord,
  sections: readonly InkSurfaceSection[],
  layout: InkLayoutObservation,
): InkSurfaceReconciliation {
  const binding = record.binding;
  if (binding === undefined) {
    return transitioned(record, 'unanchored');
  }
  const exact = sections.find(
    (section) => section.sectionFingerprint === binding.sectionFingerprint,
  );
  if (exact !== undefined) {
    if (!layoutMatches(record, layout)) {
      if (record.strokes.length === 0 && layout.fontAvailable) {
        return { kind: 'active', record: updateBinding(record, exact, layout, 'active') };
      }
      return transitioned(record, 'needs-rebase');
    }
    if (exact.sourceStart === binding.sourceStart && exact.sourceEnd === binding.sourceEnd) {
      return {
        kind: 'active',
        record:
          record.status === 'active'
            ? record
            : { ...record, revision: record.revision + 1, status: 'active' },
      };
    }
    return {
      kind: 'relocated',
      record: updateBinding(record, exact, layout, 'active'),
    };
  }
  const sameHeading = sections.find(
    (section) => JSON.stringify(section.headingPath) === JSON.stringify(binding.headingPath),
  );
  return sameHeading === undefined
    ? transitioned(record, 'unanchored')
    : transitioned(record, 'needs-rebase');
}

export interface InkRebasePreview {
  readonly baseRevision: number;
  readonly record: InkSurfaceRecord;
  readonly surfaceId: string;
}

export interface InkDocumentRebaseTarget {
  readonly endY: number;
  readonly layout: InkLayoutObservation;
  readonly section: InkSurfaceSection;
  readonly startY: number;
  readonly surfaceId: string;
}

export interface InkDocumentRebasePreview {
  readonly baseRevisions: readonly {
    readonly revision: number;
    readonly surfaceId: string;
  }[];
  readonly records: readonly InkSurfaceRecord[];
}

/**
 * Cold, explicit whole-document rebase. Linked physical fragments are first proved complete and
 * joined into their Logical Stroke, transformed once in note-global coordinates, then repartitioned
 * so every boundary provenance field is regenerated from the target surface set.
 */
export function previewInkDocumentRebase(
  records: readonly InkSurfaceRecord[],
  targets: readonly InkDocumentRebaseTarget[],
): InkDocumentRebasePreview {
  const sourceSurfaces = documentRebaseSourceSurfaces(records);
  const targetSurfaces = documentRebaseTargetSurfaces(records, targets);
  const sourceStartY = sourceSurfaces[0]?.startY as number;
  const sourceEndY = sourceSurfaces.at(-1)?.endY as number;
  const targetStartY = targetSurfaces[0]?.startY as number;
  const targetEndY = targetSurfaces.at(-1)?.endY as number;
  const sourceWidth = records[0]?.layout.logicalWidth as number;
  const targetWidth = targets[0]?.layout.logicalWidth as number;
  const scaleX = targetWidth / sourceWidth;
  const scaleY = (targetEndY - targetStartY) / (sourceEndY - sourceStartY);
  const logicalStrokes = joinInkStrokeSurfaceFragments(
    records.flatMap((record) => {
      const source = sourceSurfaces.find(
        ({ id }) => id === record.id,
      ) as (typeof sourceSurfaces)[0];
      return record.strokes.map((stroke) => ({
        endY: source.endY,
        logicalHeight: source.logicalHeight,
        schemaVersion: record.schemaVersion,
        startY: source.startY,
        stroke,
        surfaceId: record.id,
      }));
    }),
  ).map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      x: point.x * scaleX,
      y: targetStartY + (point.y - sourceStartY) * scaleY,
    })),
  }));
  const strokesBySurface = new Map<string, InkStroke[]>();
  for (const stroke of logicalStrokes) {
    const fragments = splitInkStrokeIntoSurfaceFragments({ stroke, surfaces: targetSurfaces });
    const projected =
      fragments.length === 1
        ? fragments.map((fragment) => ({
            ...fragment,
            stroke: retainSingleSurfaceLogicalIdentity(stroke, fragment.stroke),
          }))
        : fragments;
    for (const fragment of projected) {
      const strokes = strokesBySurface.get(fragment.surfaceId);
      if (strokes === undefined) {
        strokesBySurface.set(fragment.surfaceId, [fragment.stroke]);
      } else {
        strokes.push(fragment.stroke);
      }
    }
  }
  const targetById = new Map(targets.map((target) => [target.surfaceId, target] as const));
  return {
    baseRevisions: records.map(({ id, revision }) => ({ revision, surfaceId: id })),
    records: records.map((record) => {
      const target = targetById.get(record.id) as InkDocumentRebaseTarget;
      return {
        ...record,
        binding: { ...target.section },
        layout: {
          blockFingerprints: target.section.blockFingerprints,
          fontFamily: target.layout.fontFamily,
          fontSize: target.layout.fontSize,
          lineHeight: target.layout.lineHeight,
          logicalHeight: target.layout.logicalHeight,
          logicalWidth: target.layout.logicalWidth,
          originY: target.startY,
          sourceRevision: target.layout.sourceRevision,
          themeMode: target.layout.themeMode,
        },
        status: 'active',
        strokes: strokesBySurface.get(record.id) ?? [],
      };
    }),
  };
}

export function confirmInkDocumentRebase(
  current: readonly InkSurfaceRecord[],
  preview: InkDocumentRebasePreview,
  now: string,
): readonly InkSurfaceRecord[] {
  const baseById = new Map(
    preview.baseRevisions.map(({ revision, surfaceId }) => [surfaceId, revision] as const),
  );
  const previewById = new Map(preview.records.map((record) => [record.id, record] as const));
  const currentIds = new Set(current.map(({ id }) => id));
  if (
    current.length === 0 ||
    currentIds.size !== current.length ||
    baseById.size !== current.length ||
    previewById.size !== current.length ||
    current.some(
      (record) =>
        baseById.get(record.id) !== record.revision ||
        previewById.get(record.id)?.revision !== record.revision,
    )
  ) {
    throw new Error('Ink document changed after the preview; create a new rebase preview.');
  }
  return current.map((record) => {
    const rebased = previewById.get(record.id) as InkSurfaceRecord;
    if (
      rebased.filePath !== record.filePath ||
      rebased.noteId !== record.noteId ||
      rebased.schemaVersion !== record.schemaVersion
    ) {
      throw new Error('Ink document changed after the preview; create a new rebase preview.');
    }
    return { ...rebased, revision: record.revision + 1, updatedAt: now };
  });
}

export function previewInkRebase(
  record: InkSurfaceRecord,
  section: InkSurfaceSection,
  layout: InkLayoutObservation,
): InkRebasePreview {
  assertPerRecordInkRebaseSupported(record);
  const scaleX = layout.logicalWidth / record.layout.logicalWidth;
  const scaleY = layout.logicalHeight / record.layout.logicalHeight;
  const preview: InkSurfaceRecord = {
    ...updateBinding(record, section, layout, 'active'),
    revision: record.revision,
    strokes: record.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        x: point.x * scaleX,
        y: point.y * scaleY,
      })),
    })),
  };
  return { baseRevision: record.revision, record: preview, surfaceId: record.id };
}

export function confirmInkRebase(
  current: InkSurfaceRecord,
  preview: InkRebasePreview,
  now: string,
): InkSurfaceRecord {
  assertPerRecordInkRebaseSupported(current);
  assertPerRecordInkRebaseSupported(preview.record);
  if (current.id !== preview.surfaceId || current.revision !== preview.baseRevision) {
    throw new Error('Ink surface changed after the preview; create a new rebase preview.');
  }
  return { ...preview.record, revision: current.revision + 1, updatedAt: now };
}

function assertPerRecordInkRebaseSupported(record: InkSurfaceRecord): void {
  if (
    record.strokes.some(
      (stroke) =>
        stroke.linkedStrokeId !== undefined &&
        (stroke.brushRenderVersion === 'pen-physical-v1' ||
          stroke.brushRenderVersion === 'highlighter-chisel-v1'),
    )
  ) {
    throw new Error(
      'Cross-surface physical Ink requires document-level rebase and cannot be rebased per surface.',
    );
  }
}

function documentRebaseSourceSurfaces(records: readonly InkSurfaceRecord[]): readonly {
  readonly endY: number;
  readonly id: string;
  readonly logicalHeight: number;
  readonly startY: number;
}[] {
  if (records.length === 0) throw new Error('Document-level Ink rebase requires surface records.');
  const first = records[0] as InkSurfaceRecord;
  if (new Set(records.map(({ id }) => id)).size !== records.length) {
    throw new Error('Document-level Ink rebase contains duplicate surface IDs.');
  }
  if (
    records.some(
      (record) =>
        record.filePath !== first.filePath ||
        record.noteId !== first.noteId ||
        record.layout.logicalWidth !== first.layout.logicalWidth ||
        record.schemaVersion === 1 ||
        record.layout.originY === undefined,
    )
  ) {
    throw new Error(
      'Document-level Ink rebase requires one schema-v2/v3 note with explicit, fixed-width origins.',
    );
  }
  return assertContiguousDocumentRebaseSurfaces(
    records.map((record) => ({
      endY: (record.layout.originY as number) + record.layout.logicalHeight,
      id: record.id,
      logicalHeight: record.layout.logicalHeight,
      startY: record.layout.originY as number,
    })),
    'source',
  );
}

function documentRebaseTargetSurfaces(
  records: readonly InkSurfaceRecord[],
  targets: readonly InkDocumentRebaseTarget[],
): readonly {
  readonly endY: number;
  readonly id: string;
  readonly logicalHeight: number;
  readonly startY: number;
}[] {
  const recordIds = new Set(records.map(({ id }) => id));
  const targetIds = new Set(targets.map(({ surfaceId }) => surfaceId));
  if (
    targets.length !== records.length ||
    targetIds.size !== targets.length ||
    [...recordIds].some((id) => !targetIds.has(id))
  ) {
    throw new Error('Document-level Ink rebase target set must exactly match the source surfaces.');
  }
  const firstWidth = targets[0]?.layout.logicalWidth;
  if (
    firstWidth === undefined ||
    !Number.isFinite(firstWidth) ||
    firstWidth <= 0 ||
    targets.some(
      (target) =>
        target.layout.logicalWidth !== firstWidth ||
        target.layout.logicalHeight !== target.endY - target.startY,
    )
  ) {
    throw new Error('Document-level Ink rebase targets require one valid fixed-width layout.');
  }
  return assertContiguousDocumentRebaseSurfaces(
    targets.map((target) => ({
      endY: target.endY,
      id: target.surfaceId,
      logicalHeight: target.layout.logicalHeight,
      startY: target.startY,
    })),
    'target',
  );
}

function assertContiguousDocumentRebaseSurfaces(
  surfaces: readonly {
    readonly endY: number;
    readonly id: string;
    readonly logicalHeight: number;
    readonly startY: number;
  }[],
  label: 'source' | 'target',
): readonly {
  readonly endY: number;
  readonly id: string;
  readonly logicalHeight: number;
  readonly startY: number;
}[] {
  const ordered = [...surfaces].sort(
    (left, right) => left.startY - right.startY || left.id.localeCompare(right.id),
  );
  for (const [index, surface] of ordered.entries()) {
    if (
      !Number.isFinite(surface.startY) ||
      surface.startY < 0 ||
      !Number.isFinite(surface.endY) ||
      !Number.isFinite(surface.logicalHeight) ||
      surface.logicalHeight <= 0 ||
      surface.endY !== surface.startY + surface.logicalHeight ||
      (index > 0 && ordered[index - 1]?.endY !== surface.startY)
    ) {
      throw new Error(`Document-level Ink rebase ${label} surfaces must be contiguous.`);
    }
  }
  return ordered;
}

function retainSingleSurfaceLogicalIdentity(logical: InkStroke, fragment: InkStroke): InkStroke {
  const points = fragment.points.map((point) => {
    if (!isPhysicalInkPoint(point)) return point;
    const {
      fragmentBoundary: _fragmentBoundary,
      fragmentBoundaryEdge: _fragmentBoundaryEdge,
      fragmentBoundaryId: _fragmentBoundaryId,
      fragmentGlobalY: _fragmentGlobalY,
      fragmentTraceOrder: _fragmentTraceOrder,
      ...canonical
    } = point;
    void _fragmentBoundary;
    void _fragmentBoundaryEdge;
    void _fragmentBoundaryId;
    void _fragmentGlobalY;
    void _fragmentTraceOrder;
    return canonical;
  });
  const { linkedStrokeId: _linkedStrokeId, ...unlinked } = fragment;
  void _linkedStrokeId;
  return { ...unlinked, id: logical.id, points };
}

function updateBinding(
  record: InkSurfaceRecord,
  section: InkSurfaceSection,
  layout: InkLayoutObservation,
  status: InkSurfaceRecord['status'],
): InkSurfaceRecord {
  return {
    ...record,
    binding: { ...section },
    layout: {
      blockFingerprints: section.blockFingerprints,
      fontFamily: layout.fontFamily,
      fontSize: layout.fontSize,
      lineHeight: layout.lineHeight,
      logicalHeight: layout.logicalHeight,
      logicalWidth: layout.logicalWidth,
      ...(record.schemaVersion === 1 ? {} : { originY: record.layout.originY as number }),
      sourceRevision: layout.sourceRevision,
      themeMode: layout.themeMode,
    },
    revision: record.revision + 1,
    status,
  };
}

function transitioned(
  record: InkSurfaceRecord,
  status: 'needs-rebase' | 'unanchored',
): InkSurfaceReconciliation {
  return {
    kind: status,
    record:
      record.status === status ? record : { ...record, revision: record.revision + 1, status },
  };
}

function layoutMatches(record: InkSurfaceRecord, observed: InkLayoutObservation): boolean {
  return (
    observed.fontAvailable &&
    observed.fontFamily === record.layout.fontFamily &&
    observed.fontSize === record.layout.fontSize &&
    observed.lineHeight === record.layout.lineHeight &&
    observed.logicalHeight === record.layout.logicalHeight &&
    observed.logicalWidth === record.layout.logicalWidth &&
    observed.themeMode === record.layout.themeMode
  );
}

function stableSectionFingerprint(
  headingPath: readonly string[],
  blockFingerprints: readonly string[],
): string {
  return `${headingPath.join(' / ')}\u0000${blockFingerprints.join('\u0000')}`;
}

function clipSegment(
  start: InkPoint,
  end: InkPoint,
  minimumY: number,
  maximumY: number,
): readonly [InkPoint, InkPoint] | null {
  const dy = end.y - start.y;
  if (dy === 0) {
    return start.y >= minimumY && start.y <= maximumY ? [start, end] : null;
  }
  const firstBoundaryRatio = (minimumY - start.y) / dy;
  const secondBoundaryRatio = (maximumY - start.y) / dy;
  const entryRatio = Math.max(0, Math.min(firstBoundaryRatio, secondBoundaryRatio));
  const exitRatio = Math.min(1, Math.max(firstBoundaryRatio, secondBoundaryRatio));
  if (entryRatio > exitRatio) {
    return null;
  }
  return [
    interpolateClippedPoint(start, end, entryRatio, minimumY, maximumY),
    interpolateClippedPoint(start, end, exitRatio, minimumY, maximumY),
  ];
}

function interpolateClippedPoint(
  start: InkPoint,
  end: InkPoint,
  ratio: number,
  minimumY: number,
  maximumY: number,
): InkPoint {
  const point = interpolate(start, end, ratio);
  if (ratio === 0 || ratio === 1) return point;
  const boundary =
    Math.abs(point.y - minimumY) <= Math.abs(point.y - maximumY) ? minimumY : maximumY;
  return { ...point, y: boundary };
}

function interpolate(start: InkPoint, end: InkPoint, ratio: number): InkPoint {
  if (ratio === 0) return start;
  if (ratio === 1) return end;
  const startPhysical = isPhysicalInkPoint(start);
  const endPhysical = isPhysicalInkPoint(end);
  if (startPhysical !== endPhysical) {
    throw new Error('Ink stroke mixes legacy and physical control points.');
  }
  const common = {
    pressure: start.pressure + (end.pressure - start.pressure) * ratio,
    time: start.time + (end.time - start.time) * ratio,
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
  };
  if (startPhysical && endPhysical) {
    if (start.fragmentTraceOrder === undefined || end.fragmentTraceOrder === undefined) {
      throw new Error('Physical Ink interpolation requires fragment trace order.');
    }
    const physicalBoundary: InkPhysicalPoint = {
      ...common,
      fragmentBoundary: 'synthetic-clip',
      fragmentTraceOrder:
        start.fragmentTraceOrder + (end.fragmentTraceOrder - start.fragmentTraceOrder) * ratio,
      orientation: interpolatePhysicalOrientation(start.orientation, end.orientation, ratio),
      pressureKind:
        start.pressureKind === 'measured' && end.pressureKind === 'measured'
          ? 'measured'
          : 'unavailable',
    };
    return physicalBoundary;
  }
  return {
    ...common,
    ...(start.tiltX === undefined || end.tiltX === undefined
      ? {}
      : { tiltX: start.tiltX + (end.tiltX - start.tiltX) * ratio }),
    ...(start.tiltY === undefined || end.tiltY === undefined
      ? {}
      : { tiltY: start.tiltY + (end.tiltY - start.tiltY) * ratio }),
  };
}

function appendUnique(points: InkPoint[], point: InkPoint): void {
  const previous = points.at(-1);
  if (previous === undefined || !sameTracePoint(previous, point)) {
    points.push(point);
  }
}

function isPhysicalInkPoint(point: InkPoint): point is InkPhysicalPoint {
  return point.pressureKind !== undefined && point.orientation !== undefined;
}

function interpolatePhysicalOrientation(
  start: InkPhysicalPoint['orientation'],
  end: InkPhysicalPoint['orientation'],
  ratio: number,
): InkPhysicalPoint['orientation'] {
  if (start.kind !== 'measured' || end.kind !== 'measured') return { kind: 'unavailable' };
  const turn = Math.PI * 2;
  const delta = ((((end.azimuth - start.azimuth + Math.PI) % turn) + turn) % turn) - Math.PI;
  const azimuth = (start.azimuth + delta * ratio + turn) % turn;
  return {
    altitude: start.altitude + (end.altitude - start.altitude) * ratio,
    azimuth,
    kind: 'measured',
    reliable: start.reliable && end.reliable,
  };
}

interface TraceOrderNode {
  readonly fragmentKey: string;
  readonly index: number;
  readonly outgoing: Set<TraceOrderNode>;
  readonly point: InkPoint;
  incoming: number;
}

function orderFragmentTracePoints(runs: readonly (readonly InkPoint[])[]): readonly InkPoint[] {
  const nodesByRun = runs.map((points) => {
    const fragmentKey = points.map(tracePointKey).join('>');
    return points.map<TraceOrderNode>((point, index) => ({
      fragmentKey,
      incoming: 0,
      index,
      outgoing: new Set(),
      point,
    }));
  });
  for (const nodes of nodesByRun) {
    for (let index = 1; index < nodes.length; index += 1) {
      addTraceOrderEdge(nodes[index - 1] as TraceOrderNode, nodes[index] as TraceOrderNode);
    }
  }
  for (let leftIndex = 0; leftIndex < nodesByRun.length; leftIndex += 1) {
    const left = nodesByRun[leftIndex];
    if (left === undefined || left.length === 0) continue;
    for (let rightIndex = 0; rightIndex < nodesByRun.length; rightIndex += 1) {
      if (leftIndex === rightIndex) continue;
      const right = nodesByRun[rightIndex];
      if (right === undefined || right.length === 0) continue;
      const leftLast = left.at(-1) as TraceOrderNode;
      const rightFirst = right[0] as TraceOrderNode;
      if (!sameTracePoint(leftLast.point, rightFirst.point)) continue;
      const reciprocal = sameTracePoint(
        (right.at(-1) as TraceOrderNode).point,
        (left[0] as TraceOrderNode).point,
      );
      if (!reciprocal || leftLast.fragmentKey < rightFirst.fragmentKey) {
        addTraceOrderEdge(leftLast, rightFirst);
      }
    }
  }
  const all = nodesByRun.flat();
  const ready = all.filter(({ incoming }) => incoming === 0).sort(compareTraceOrderNodes);
  const ordered: InkPoint[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as TraceOrderNode;
    const previous = ordered.at(-1);
    if (previous === undefined || !sameTracePoint(previous, current.point)) {
      ordered.push(current.point);
    }
    for (const next of current.outgoing) {
      next.incoming -= 1;
      if (next.incoming === 0) {
        ready.push(next);
        ready.sort(compareTraceOrderNodes);
      }
    }
  }
  if (all.some(({ incoming }) => incoming > 0)) {
    throw new Error('Ink Logical Stroke fragments contain cyclic trace order.');
  }
  return ordered;
}

function addTraceOrderEdge(from: TraceOrderNode, to: TraceOrderNode): void {
  if (from === to || from.outgoing.has(to)) return;
  from.outgoing.add(to);
  to.incoming += 1;
}

function compareTraceOrderNodes(left: TraceOrderNode, right: TraceOrderNode): number {
  return (
    left.point.time - right.point.time ||
    left.fragmentKey.localeCompare(right.fragmentKey) ||
    left.index - right.index
  );
}

function sameTracePoint(left: InkPoint, right: InkPoint): boolean {
  return tracePointKey(left) === tracePointKey(right);
}

function tracePointKey(point: InkPoint): string {
  return JSON.stringify({
    fragmentBoundary:
      isPhysicalInkPoint(point) && point.fragmentBoundary !== undefined
        ? point.fragmentBoundary
        : null,
    fragmentBoundaryId:
      isPhysicalInkPoint(point) && point.fragmentBoundaryId !== undefined
        ? point.fragmentBoundaryId
        : null,
    fragmentBoundaryEdge:
      isPhysicalInkPoint(point) && point.fragmentBoundaryEdge !== undefined
        ? point.fragmentBoundaryEdge
        : null,
    fragmentGlobalY:
      isPhysicalInkPoint(point) && point.fragmentGlobalY !== undefined
        ? point.fragmentGlobalY
        : null,
    fragmentTraceOrder:
      isPhysicalInkPoint(point) && point.fragmentTraceOrder !== undefined
        ? point.fragmentTraceOrder
        : null,
    orientation:
      point.orientation === undefined
        ? null
        : point.orientation.kind === 'unavailable'
          ? { kind: 'unavailable' }
          : {
              altitude: point.orientation.altitude,
              azimuth: point.orientation.azimuth,
              kind: 'measured',
              reliable: point.orientation.reliable,
            },
    pressure: point.pressure,
    pressureKind: point.pressureKind ?? null,
    tiltX: point.tiltX ?? null,
    tiltY: point.tiltY ?? null,
    time: point.time,
    x: point.x,
    y: point.y,
  });
}
