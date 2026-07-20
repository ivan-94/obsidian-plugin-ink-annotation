import type { InkPhysicalPoint, InkStroke, InkSurfaceRecord } from './ink-surface';

export type InkConcurrentAppendConflictReason =
  | 'existing-strokes-changed'
  | 'identity-or-layout-changed'
  | 'not-independent-appends'
  | 'revision-chain-changed'
  | 'schema-version-mismatch'
  | 'stroke-id-collision'
  | 'surface-is-not-active';

export type InkConcurrentAppendMergePlan =
  | {
      readonly kind: 'already-merged';
      readonly record: InkSurfaceRecord;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: InkConcurrentAppendConflictReason;
    }
  | {
      readonly kind: 'merge';
      readonly record: InkSurfaceRecord;
    };

/**
 * Reconciles only exact-common-base append-only Ink branches.
 *
 * Existing strokes and semantic/layout identity are immutable at this boundary. Destructive or
 * spatial edits remain explicit conflicts rather than being guessed from whole-record snapshots.
 */
export function planConcurrentInkAppendMerge(input: {
  readonly base: InkSurfaceRecord;
  readonly local: InkSurfaceRecord;
  readonly remote: InkSurfaceRecord;
}): InkConcurrentAppendMergePlan {
  const { base, local, remote } = input;
  if (
    base.status !== 'active' ||
    local.status !== 'active' ||
    remote.status !== 'active' ||
    base.deletedAt !== undefined ||
    local.deletedAt !== undefined ||
    remote.deletedAt !== undefined
  ) {
    return { kind: 'conflict', reason: 'surface-is-not-active' };
  }
  if (
    local.revision !== base.revision + 1 ||
    remote.revision <= base.revision ||
    remote.revision >= Number.MAX_SAFE_INTEGER
  ) {
    return { kind: 'conflict', reason: 'revision-chain-changed' };
  }
  if (local.schemaVersion !== base.schemaVersion || remote.schemaVersion !== base.schemaVersion) {
    return { kind: 'conflict', reason: 'schema-version-mismatch' };
  }
  if (
    mergeInvariant(base) !== mergeInvariant(local) ||
    mergeInvariant(base) !== mergeInvariant(remote) ||
    local.layout.logicalHeight < base.layout.logicalHeight ||
    remote.layout.logicalHeight < base.layout.logicalHeight
  ) {
    return { kind: 'conflict', reason: 'identity-or-layout-changed' };
  }
  if (
    !preservesBaseStrokes(base.strokes, local.strokes, base.schemaVersion, local.schemaVersion) ||
    !preservesBaseStrokes(base.strokes, remote.strokes, base.schemaVersion, remote.schemaVersion)
  ) {
    return { kind: 'conflict', reason: 'existing-strokes-changed' };
  }

  const baseIds = new Set(base.strokes.map(({ id }) => id));
  const localAppends = local.strokes.filter(({ id }) => !baseIds.has(id));
  const remoteAppends = remote.strokes.filter(({ id }) => !baseIds.has(id));
  if (localAppends.length === 0 || remoteAppends.length === 0) {
    return { kind: 'conflict', reason: 'not-independent-appends' };
  }
  const additions = new Map<string, InkStroke>();
  for (const stroke of [...remoteAppends, ...localAppends]) {
    const existing = additions.get(stroke.id);
    if (
      existing !== undefined &&
      !sameStroke(existing, stroke, remote.schemaVersion, local.schemaVersion)
    ) {
      return { kind: 'conflict', reason: 'stroke-id-collision' };
    }
    additions.set(stroke.id, stroke);
  }
  const remoteById = new Map(remote.strokes.map((stroke) => [stroke.id, stroke]));
  const alreadyMerged = localAppends.every((stroke) => {
    const remoteStroke = remoteById.get(stroke.id);
    return (
      remoteStroke !== undefined &&
      sameStroke(remoteStroke, stroke, remote.schemaVersion, local.schemaVersion)
    );
  });
  if (alreadyMerged && remote.layout.logicalHeight >= local.layout.logicalHeight) {
    return { kind: 'already-merged', record: remote };
  }
  const remoteIds = new Set(remote.strokes.map(({ id }) => id));
  const localOnly = localAppends
    .filter(({ id }) => !remoteIds.has(id))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    kind: 'merge',
    record: {
      ...remote,
      ...(local.deviceId === undefined ? {} : { deviceId: local.deviceId }),
      layout: {
        ...remote.layout,
        logicalHeight: Math.max(
          base.layout.logicalHeight,
          local.layout.logicalHeight,
          remote.layout.logicalHeight,
        ),
      },
      revision: remote.revision + 1,
      strokes: [...remote.strokes, ...localOnly],
      updatedAt: local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
    },
  };
}

function mergeInvariant(record: InkSurfaceRecord): string {
  return JSON.stringify({
    binding:
      record.binding === undefined
        ? null
        : {
            blockFingerprints: record.binding.blockFingerprints,
            headingPath: record.binding.headingPath,
            sectionFingerprint: record.binding.sectionFingerprint,
            sourceEnd: record.binding.sourceEnd,
            sourceStart: record.binding.sourceStart,
          },
    createdAt: record.createdAt,
    filePath: record.filePath,
    id: record.id,
    layout: {
      blockFingerprints: record.layout.blockFingerprints,
      fontFamily: record.layout.fontFamily,
      fontSize: record.layout.fontSize,
      lineHeight: record.layout.lineHeight,
      logicalWidth: record.layout.logicalWidth,
      originY: record.layout.originY ?? null,
      sourceRevision: record.layout.sourceRevision,
      themeMode: record.layout.themeMode,
    },
    noteId: record.noteId,
    schemaVersion: record.schemaVersion,
    status: record.status,
  });
}

function preservesBaseStrokes(
  base: readonly InkStroke[],
  candidate: readonly InkStroke[],
  baseSchemaVersion: InkSurfaceRecord['schemaVersion'],
  candidateSchemaVersion: InkSurfaceRecord['schemaVersion'],
): boolean {
  if (candidate.length < base.length) return false;
  const byId = new Map(candidate.map((stroke) => [stroke.id, stroke]));
  return base.every((stroke) => {
    const other = byId.get(stroke.id);
    return (
      other !== undefined && sameStroke(stroke, other, baseSchemaVersion, candidateSchemaVersion)
    );
  });
}

function sameStroke(
  left: InkStroke,
  right: InkStroke,
  leftSchemaVersion: InkSurfaceRecord['schemaVersion'],
  rightSchemaVersion: InkSurfaceRecord['schemaVersion'],
): boolean {
  return (
    encodeStrokeForMerge(left, leftSchemaVersion) ===
    encodeStrokeForMerge(right, rightSchemaVersion)
  );
}

function encodeStrokeForMerge(
  stroke: InkStroke,
  schemaVersion: InkSurfaceRecord['schemaVersion'],
): string {
  const visible = stroke.tool === 'pen' || stroke.tool === 'highlighter';
  const version =
    stroke.brushRenderVersion ?? (schemaVersion < 3 && visible ? 'legacy-round-v1' : null);
  const profile =
    stroke.inputProfile ??
    (schemaVersion < 3 && visible
      ? { pressure: 'legacy-unknown' as const, tilt: 'legacy-unknown' as const }
      : null);
  return JSON.stringify({
    brushRenderVersion: version,
    color: stroke.color,
    id: stroke.id,
    inputProfile: profile === null ? null : { pressure: profile.pressure, tilt: profile.tilt },
    linkedStrokeId: stroke.linkedStrokeId ?? null,
    points: stroke.points.map((point) =>
      point.pressureKind === undefined || point.orientation === undefined
        ? {
            pressure: point.pressure,
            tiltX: point.tiltX ?? null,
            tiltY: point.tiltY ?? null,
            time: point.time,
            x: point.x,
            y: point.y,
          }
        : {
            fragmentBoundary: (point as InkPhysicalPoint).fragmentBoundary ?? null,
            fragmentBoundaryEdge: (point as InkPhysicalPoint).fragmentBoundaryEdge ?? null,
            fragmentBoundaryId: (point as InkPhysicalPoint).fragmentBoundaryId ?? null,
            fragmentGlobalY: (point as InkPhysicalPoint).fragmentGlobalY ?? null,
            fragmentTraceOrder: (point as InkPhysicalPoint).fragmentTraceOrder ?? null,
            orientation:
              point.orientation.kind === 'unavailable'
                ? { kind: 'unavailable' }
                : {
                    altitude: point.orientation.altitude,
                    azimuth: point.orientation.azimuth,
                    kind: 'measured',
                    reliable: point.orientation.reliable,
                  },
            pressure: { kind: point.pressureKind, value: point.pressure },
            time: point.time,
            x: point.x,
            y: point.y,
          },
    ),
    tool: stroke.tool,
    width: stroke.width,
  });
}
