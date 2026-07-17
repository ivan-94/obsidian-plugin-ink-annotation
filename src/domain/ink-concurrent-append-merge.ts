import type { InkStroke, InkSurfaceRecord } from './ink-surface';

export type InkConcurrentAppendConflictReason =
  | 'existing-strokes-changed'
  | 'identity-or-layout-changed'
  | 'not-independent-appends'
  | 'revision-chain-changed'
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
  if (
    mergeInvariant(base) !== mergeInvariant(local) ||
    mergeInvariant(base) !== mergeInvariant(remote) ||
    local.layout.logicalHeight < base.layout.logicalHeight ||
    remote.layout.logicalHeight < base.layout.logicalHeight
  ) {
    return { kind: 'conflict', reason: 'identity-or-layout-changed' };
  }
  if (
    !preservesBaseStrokes(base.strokes, local.strokes) ||
    !preservesBaseStrokes(base.strokes, remote.strokes)
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
    if (existing !== undefined && !sameStroke(existing, stroke)) {
      return { kind: 'conflict', reason: 'stroke-id-collision' };
    }
    additions.set(stroke.id, stroke);
  }
  const remoteById = new Map(remote.strokes.map((stroke) => [stroke.id, stroke]));
  const alreadyMerged = localAppends.every((stroke) => {
    const remoteStroke = remoteById.get(stroke.id);
    return remoteStroke !== undefined && sameStroke(remoteStroke, stroke);
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
  const {
    deviceId: _deviceId,
    layout,
    revision: _revision,
    strokes: _strokes,
    updatedAt: _updatedAt,
    ...identity
  } = record;
  const { logicalHeight: _logicalHeight, ...fixedLayout } = layout;
  void _deviceId;
  void _revision;
  void _strokes;
  void _updatedAt;
  void _logicalHeight;
  return JSON.stringify({ ...identity, layout: fixedLayout });
}

function preservesBaseStrokes(
  base: readonly InkStroke[],
  candidate: readonly InkStroke[],
): boolean {
  if (candidate.length < base.length) return false;
  const byId = new Map(candidate.map((stroke) => [stroke.id, stroke]));
  return base.every((stroke) => {
    const other = byId.get(stroke.id);
    return other !== undefined && sameStroke(stroke, other);
  });
}

function sameStroke(left: InkStroke, right: InkStroke): boolean {
  return encodeStrokeForMerge(left) === encodeStrokeForMerge(right);
}

function encodeStrokeForMerge(stroke: InkStroke): string {
  return JSON.stringify({
    color: stroke.color,
    id: stroke.id,
    linkedStrokeId: stroke.linkedStrokeId ?? null,
    points: stroke.points.map((point) => ({
      pressure: point.pressure,
      tiltX: point.tiltX ?? null,
      tiltY: point.tiltY ?? null,
      time: point.time,
      x: point.x,
      y: point.y,
    })),
    tool: stroke.tool,
    width: stroke.width,
  });
}
