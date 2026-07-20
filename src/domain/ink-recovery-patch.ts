import { digestInkBrushGolden, resolveInkBrushContract } from './ink-brush-contract';
import {
  assertInkSurfaceRecord,
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkPhysicalHighlighterStroke,
  type InkPhysicalPenStroke,
  type InkPhysicalPoint,
  type InkStroke,
  type InkSurfaceRecord,
} from './ink-surface';
import { joinInkStrokeSurfaceFragments } from './ink-surface-layout';

export type InkRecoveryCommandKind = 'add' | 'erase' | 'move' | 'redo' | 'restyle' | 'undo';

export interface InkPreparedDeletedStroke {
  readonly digest: string;
  readonly id: string;
}

export interface InkPreparedUpsertedStroke {
  readonly index: number;
  readonly previousDigest: string | null;
  readonly stroke: InkStroke;
}

export interface InkPreparedSurfacePatch {
  readonly deleted: readonly InkPreparedDeletedStroke[];
  readonly surfaceId: string;
  readonly upserted: readonly InkPreparedUpsertedStroke[];
}

export interface InkPreparedCommandPatch {
  readonly commandId: string;
  readonly commandKind: InkRecoveryCommandKind;
  readonly documentGeneration: number;
  readonly formatVersion: 1;
  readonly surfacePatches: readonly InkPreparedSurfacePatch[];
}

export interface InkPreparedPhysicalSchemaPlanCore {
  readonly candidateCanonicalBytes: readonly string[];
  readonly candidateDigest: string;
  readonly formatVersion: 1;
  readonly kind: 'ink-schema-v3-preparation';
  readonly readGeneration: number;
  readonly sourceBaseDigest: string;
  readonly sourceCanonicalBytes: readonly string[];
}

export interface InkPreparedPhysicalSchemaPlan extends InkPreparedPhysicalSchemaPlanCore {
  readonly planDigest: string;
  readonly planReference: string;
}

export type InkPreparedPhysicalStroke = InkPhysicalHighlighterStroke | InkPhysicalPenStroke;

export interface InkPreparedPhysicalFragment {
  readonly stroke: InkPreparedPhysicalStroke;
  readonly surfaceId: string;
}

export interface InkPreparedPhysicalSchemaActivation {
  readonly commandId: string;
  readonly formatVersion: 1;
  readonly fragments: readonly InkPreparedPhysicalFragment[];
  readonly kind: 'activate-physical-schema-v3';
  readonly planDigest: string;
  readonly planReference: string;
  readonly readGeneration: number;
  readonly sourceBaseDigest: string;
}

/**
 * Cold, validated schema-plan runtime. The Recovery adapter keeps this disposable object in
 * memory so first pen-up never reparses or rescans the complete historical candidate.
 */
interface InkPreparedPhysicalSchemaActivationRuntime {
  readonly candidateSurfaces: readonly InkSurfaceRecord[];
  readonly historicalLogicalStrokeIds: ReadonlySet<string>;
  readonly historicalStrokeIds: ReadonlySet<string>;
  readonly planDigest: string;
  readonly planReference: string;
  readonly readGeneration: number;
  readonly sourceBaseDigest: string;
}

function assertInkPreparedPhysicalFragmentSetAgainstHistory(
  fragments: readonly InkPreparedPhysicalFragment[],
  surfaces: readonly InkSurfaceRecord[],
  historicalLogicalStrokeIds: ReadonlySet<string>,
): void {
  if (fragments.length === 0 || surfaces.length === 0) {
    throw new Error('Physical Ink activation requires a complete fragment and surface set.');
  }
  const surfacesById = new Map<string, InkSurfaceRecord>();
  for (const surface of surfaces) {
    if (surfacesById.has(surface.id)) {
      throw new Error(`Physical Ink activation has duplicate surface identity ${surface.id}.`);
    }
    surfacesById.set(surface.id, surface);
  }
  const surfaceStarts = new Set(
    surfaces.flatMap((surface) =>
      surface.layout.originY === undefined ? [] : [surface.layout.originY],
    ),
  );
  const internalBoundaries = new Set(
    surfaces.flatMap((surface) => {
      const startY = surface.layout.originY;
      if (startY === undefined) return [];
      const endY = startY + surface.layout.logicalHeight;
      return surfaceStarts.has(endY) ? [endY] : [];
    }),
  );
  const fragmentIds = new Set<string>();
  let linkedStrokeId: string | null = null;
  for (const fragment of fragments) {
    const surface = surfacesById.get(fragment.surfaceId);
    const stroke = fragment.stroke as InkStroke;
    if (
      surface === undefined ||
      typeof stroke?.id !== 'string' ||
      stroke.id.length === 0 ||
      fragmentIds.has(stroke.id) ||
      typeof stroke.linkedStrokeId !== 'string' ||
      stroke.linkedStrokeId.length === 0 ||
      historicalLogicalStrokeIds.has(stroke.linkedStrokeId) ||
      (linkedStrokeId !== null && stroke.linkedStrokeId !== linkedStrokeId) ||
      !(
        (stroke.tool === 'pen' && stroke.brushRenderVersion === 'pen-physical-v1') ||
        (stroke.tool === 'highlighter' && stroke.brushRenderVersion === 'highlighter-chisel-v1')
      )
    ) {
      throw new Error('Physical Ink activation contains an invalid physical fragment identity.');
    }
    const brush = resolveInkBrushContract({
      color: stroke.color,
      inputProfile: stroke.inputProfile,
      tool: stroke.tool,
      version: stroke.brushRenderVersion,
    });
    if (brush.kind === 'unsupported' || brush.publication !== 'reserved') {
      throw new Error('Physical Ink activation requires a reserved physical brush contract.');
    }
    if (
      (stroke.points as readonly InkPhysicalPoint[]).some(
        (point) =>
          point.fragmentGlobalY !== undefined &&
          internalBoundaries.has(point.fragmentGlobalY) &&
          point.fragmentBoundary === undefined,
      )
    ) {
      throw new Error('Physical Ink activation omitted internal boundary provenance.');
    }
    assertInkSurfaceRecord({ ...surface, strokes: [stroke] });
    fragmentIds.add(stroke.id);
    linkedStrokeId ??= stroke.linkedStrokeId;
  }
  const joined = joinInkStrokeSurfaceFragments(
    fragments.map((fragment) => {
      const surface = surfacesById.get(fragment.surfaceId);
      const startY = surface?.layout.originY;
      if (
        surface === undefined ||
        surface.schemaVersion !== 3 ||
        startY === undefined ||
        !Number.isFinite(startY)
      ) {
        throw new Error(`Physical Ink fragment references invalid surface ${fragment.surfaceId}.`);
      }
      return {
        endY: startY + surface.layout.logicalHeight,
        logicalHeight: surface.layout.logicalHeight,
        schemaVersion: surface.schemaVersion,
        startY,
        stroke: fragment.stroke,
        surfaceId: surface.id,
      };
    }),
  );
  if (joined.length !== 1) {
    throw new Error('Physical Ink activation must contain one complete Logical Stroke.');
  }
}

function inkPhysicalSchemaPlanDigest(plan: InkPreparedPhysicalSchemaPlanCore): string {
  return digestInkBrushGolden({
    candidateSurfaceBytes: plan.candidateCanonicalBytes,
    formatVersion: plan.formatVersion,
    kind: plan.kind,
    readGeneration: plan.readGeneration,
    sourceBaseDigest: plan.sourceBaseDigest,
    sourceSurfaceBytes: plan.sourceCanonicalBytes,
  });
}

export function assertInkPreparedPhysicalSchemaPlan(plan: InkPreparedPhysicalSchemaPlan): void {
  if (
    plan.formatVersion !== 1 ||
    plan.kind !== 'ink-schema-v3-preparation' ||
    plan.sourceCanonicalBytes.length === 0 ||
    plan.sourceCanonicalBytes.length !== plan.candidateCanonicalBytes.length ||
    plan.planDigest !== inkPhysicalSchemaPlanDigest(plan) ||
    plan.planReference !== `ink-schema-v3-plan:${plan.planDigest}` ||
    digestInkBrushGolden({ sourceSurfaceBytes: plan.sourceCanonicalBytes }) !==
      plan.sourceBaseDigest ||
    digestInkBrushGolden({ candidateSurfaceBytes: plan.candidateCanonicalBytes }) !==
      plan.candidateDigest
  ) {
    throw new Error('Physical Ink schema preparation plan identity is invalid.');
  }
  const sources = plan.sourceCanonicalBytes.map(decodeInkSurfaceRecord);
  const candidates = plan.candidateCanonicalBytes.map(decodeInkSurfaceRecord);
  if (
    candidates.some(
      (candidate, index) =>
        candidate.schemaVersion !== 3 ||
        candidate.id !== sources[index]?.id ||
        candidate.filePath !== sources[index]?.filePath,
    )
  ) {
    throw new Error('Physical Ink schema preparation candidate surface set is invalid.');
  }
}

/**
 * Applies the frozen schema candidate and first physical fragments as one recovery operation.
 * Recovery is a cold path, so materializing the complete candidate here is intentional.
 */
export function applyPreparedInkPhysicalSchemaActivation(
  records: readonly InkSurfaceRecord[],
  plan: InkPreparedPhysicalSchemaPlan,
  command: InkPreparedPhysicalSchemaActivation,
): readonly InkSurfaceRecord[] {
  return applyPreparedInkPhysicalSchemaActivationRuntime(
    prepareInkPhysicalSchemaActivationRuntime(records, plan),
    command,
  );
}

/** Performs all whole-history validation and decoding before contact begins. */
function prepareInkPhysicalSchemaActivationRuntime(
  records: readonly InkSurfaceRecord[],
  plan: InkPreparedPhysicalSchemaPlan,
): InkPreparedPhysicalSchemaActivationRuntime {
  assertInkPreparedPhysicalSchemaPlan(plan);
  const sourceCanonicalBytes = records.map(encodeInkSurfaceRecord);
  if (
    sourceCanonicalBytes.length !== plan.sourceCanonicalBytes.length ||
    sourceCanonicalBytes.some(
      (canonicalBytes, index) => canonicalBytes !== plan.sourceCanonicalBytes[index],
    ) ||
    digestInkBrushGolden({ sourceSurfaceBytes: sourceCanonicalBytes }) !== plan.sourceBaseDigest ||
    digestInkBrushGolden({ candidateSurfaceBytes: plan.candidateCanonicalBytes }) !==
      plan.candidateDigest
  ) {
    throw new Error('Physical Ink schema activation source base is stale.');
  }
  const candidateSurfaces = Object.freeze(plan.candidateCanonicalBytes.map(decodeInkSurfaceRecord));
  if (
    candidateSurfaces.length !== records.length ||
    candidateSurfaces.some(
      (candidate, index) => candidate.schemaVersion !== 3 || candidate.id !== records[index]?.id,
    )
  ) {
    throw new Error('Physical Ink schema activation candidate surface set is invalid.');
  }
  return Object.freeze({
    candidateSurfaces,
    historicalLogicalStrokeIds: new Set(
      candidateSurfaces.flatMap((surface) =>
        surface.strokes.map((stroke) => stroke.linkedStrokeId ?? stroke.id),
      ),
    ),
    historicalStrokeIds: new Set(
      candidateSurfaces.flatMap((surface) => surface.strokes.map(({ id }) => id)),
    ),
    planDigest: plan.planDigest,
    planReference: plan.planReference,
    readGeneration: plan.readGeneration,
    sourceBaseDigest: plan.sourceBaseDigest,
  });
}

/** Applies only the first physical command to a prevalidated runtime; work is command-bounded. */
function applyPreparedInkPhysicalSchemaActivationRuntime(
  runtime: InkPreparedPhysicalSchemaActivationRuntime,
  command: InkPreparedPhysicalSchemaActivation,
): readonly InkSurfaceRecord[] {
  if (
    command.formatVersion !== 1 ||
    command.kind !== 'activate-physical-schema-v3' ||
    command.commandId.length === 0 ||
    command.fragments.length === 0 ||
    command.planDigest !== runtime.planDigest ||
    command.planReference !== runtime.planReference ||
    command.readGeneration !== runtime.readGeneration ||
    command.sourceBaseDigest !== runtime.sourceBaseDigest
  ) {
    throw new Error('Physical Ink schema activation does not match its frozen preparation plan.');
  }
  const candidates = runtime.candidateSurfaces;
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const additionsBySurface = new Map<string, InkPreparedPhysicalStroke[]>();
  const addedIds = new Set<string>();
  for (const fragment of command.fragments) {
    if (
      !candidatesById.has(fragment.surfaceId) ||
      runtime.historicalStrokeIds.has(fragment.stroke.id) ||
      addedIds.has(fragment.stroke.id)
    ) {
      throw new Error('Physical Ink schema activation contains an invalid fragment identity.');
    }
    const additions = additionsBySurface.get(fragment.surfaceId) ?? [];
    additions.push(fragment.stroke);
    additionsBySurface.set(fragment.surfaceId, additions);
    addedIds.add(fragment.stroke.id);
  }
  assertInkPreparedPhysicalFragmentSetAgainstHistory(
    command.fragments,
    candidates,
    runtime.historicalLogicalStrokeIds,
  );
  const materialized = candidates.map((candidate) => {
    const additions = additionsBySurface.get(candidate.id);
    if (additions === undefined) return candidate;
    const result = Object.freeze({
      ...candidate,
      strokes: Object.freeze([...candidate.strokes, ...additions]),
    });
    assertInkSurfaceRecord(result);
    return result;
  });
  return Object.freeze(materialized);
}

/** Applies one already-frozen patch. It never reruns split, move, erase, or brush algorithms. */
export function applyPreparedInkCommand(
  records: readonly InkSurfaceRecord[],
  command: InkPreparedCommandPatch,
): readonly InkSurfaceRecord[] {
  if (command.formatVersion !== 1) {
    throw new Error(`Unsupported prepared Ink command format ${String(command.formatVersion)}.`);
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const replacements = new Map<string, InkSurfaceRecord>();
  for (const patch of command.surfacePatches) {
    const record = byId.get(patch.surfaceId);
    if (record === undefined) {
      throw new Error(`Prepared Ink command surface ${patch.surfaceId} is unavailable.`);
    }
    const beforeById = new Map(record.strokes.map((stroke) => [stroke.id, stroke]));
    for (const deleted of patch.deleted) {
      const existing = beforeById.get(deleted.id);
      if (existing === undefined || inkRecoveryStrokeDigest(existing) !== deleted.digest) {
        throw new Error(
          `Prepared Ink command ${command.commandId} previous stroke digest changed for ${deleted.id}.`,
        );
      }
    }
    for (const upserted of patch.upserted) {
      const existing = beforeById.get(upserted.stroke.id);
      if (
        (upserted.previousDigest === null && existing !== undefined) ||
        (upserted.previousDigest !== null &&
          (existing === undefined || inkRecoveryStrokeDigest(existing) !== upserted.previousDigest))
      ) {
        throw new Error(
          `Prepared Ink command ${command.commandId} previous stroke digest changed for ${upserted.stroke.id}.`,
        );
      }
      if (!Number.isInteger(upserted.index) || upserted.index < 0) {
        throw new Error(`Prepared Ink command ${command.commandId} has an invalid stroke order.`);
      }
    }
    const removedIds = new Set([
      ...patch.deleted.map(({ id }) => id),
      ...patch.upserted.map(({ stroke }) => stroke.id),
    ]);
    const strokes = record.strokes.filter(({ id }) => !removedIds.has(id));
    for (const upserted of [...patch.upserted].sort((left, right) => left.index - right.index)) {
      strokes.splice(Math.min(upserted.index, strokes.length), 0, freezeStroke(upserted.stroke));
    }
    assertUniqueStrokeIds(strokes, record.id);
    replacements.set(record.id, Object.freeze({ ...record, strokes: Object.freeze(strokes) }));
  }
  return Object.freeze(records.map((record) => replacements.get(record.id) ?? record));
}

function inkRecoveryStrokeDigest(stroke: InkStroke): string {
  return hashRecoveryBytes(JSON.stringify(stroke));
}

export function hashRecoveryBytes(value: string): string {
  let digest = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    digest ^= value.charCodeAt(index);
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }
  return digest.toString(16).padStart(8, '0');
}

function freezeStroke(stroke: InkStroke): InkStroke {
  if (
    Object.isFrozen(stroke) &&
    Object.isFrozen(stroke.points) &&
    stroke.points.every((point) => Object.isFrozen(point))
  ) {
    return stroke;
  }
  return Object.freeze({
    ...stroke,
    points: Object.freeze(stroke.points.map((point) => Object.freeze({ ...point }))),
  });
}

function assertUniqueStrokeIds(strokes: readonly InkStroke[], surfaceId: string): void {
  if (new Set(strokes.map(({ id }) => id)).size !== strokes.length) {
    throw new Error(`Prepared Ink surface ${surfaceId} contains duplicate stroke IDs.`);
  }
}
