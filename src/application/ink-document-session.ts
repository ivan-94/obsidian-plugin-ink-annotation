import type { InkModeState } from '../domain/ink-mode-state';
import type { InkPoint, InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { splitInkStrokeIntoSurfaceFragments } from '../domain/ink-surface-layout';
import {
  InkSurfaceSession,
  type InkPersistenceState,
  type InkSurfaceSessionSnapshot,
  type InkSurfaceWriter,
} from './ink-surface-session';

interface BoundedSession {
  endY: number;
  readonly session: InkSurfaceSession;
  readonly startY: number;
  readonly surfaceId: string;
}

interface InkDocumentCommand {
  readonly after: ReadonlyMap<string, readonly InkStroke[]>;
  readonly before: ReadonlyMap<string, readonly InkStroke[]>;
}

export interface InkDocumentRecoverySnapshot {
  readonly expectedBases: readonly InkSurfaceRecord[];
  readonly pendingAttempts: readonly (InkSurfaceRecord | null)[];
  readonly records: readonly InkSurfaceRecord[];
  readonly requiresRecovery: boolean;
}

/**
 * Adapts independently persisted bounded surfaces to the single continuous canvas contract.
 * Surface boundaries remain an internal storage detail and never become visible UI tiles.
 */
export class InkDocumentSession {
  private readonly bounded: readonly BoundedSession[];
  private readonly onChange: (snapshot: InkSurfaceSessionSnapshot) => void;
  private readonly redoStack: InkDocumentCommand[] = [];
  private readonly selectedStrokeIdsSet = new Set<string>();
  private selectionMovePreview: { readonly dx: number; readonly dy: number } | null = null;
  private readonly undoStack: InkDocumentCommand[] = [];

  constructor(input: {
    readonly debounceMs?: number;
    readonly now?: () => string;
    readonly onChange?: (snapshot: InkSurfaceSessionSnapshot) => void;
    readonly surfaces: readonly InkSurfaceRecord[];
    readonly writer: InkSurfaceWriter;
  }) {
    if (input.surfaces.length === 0) {
      throw new Error('A continuous Ink document requires at least one bounded surface.');
    }
    if (input.surfaces.length > 1 && input.writer.updateSurfacesAtomically === undefined) {
      throw new Error('A multi-chunk Ink document requires an atomic persistence writer.');
    }
    const surfaces = input.surfaces.every((surface) => surface.schemaVersion === 2)
      ? [...input.surfaces].sort(
          (left, right) => (left.layout.originY as number) - (right.layout.originY as number),
        )
      : input.surfaces;
    const logicalWidth = surfaces[0]?.layout.logicalWidth;
    if (
      logicalWidth === undefined ||
      surfaces.some((surface) => surface.layout.logicalWidth !== logicalWidth)
    ) {
      throw new Error('All bounded Ink surfaces must share one fixed logical width.');
    }
    this.onChange = input.onChange ?? (() => undefined);
    const writer = new CoalescingInkSurfaceWriter(input.writer);
    let startY = 0;
    this.bounded = surfaces.map((surface) => {
      if (surface.schemaVersion === 2) startY = surface.layout.originY as number;
      const bounded: BoundedSession = {
        endY: startY + surface.layout.logicalHeight,
        session: new InkSurfaceSession({
          ...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
          ...(input.now === undefined ? {} : { now: input.now }),
          onChange: () => this.emit(),
          repository: writer,
          surface,
        }),
        startY,
        surfaceId: surface.id,
      };
      startY = bounded.endY;
      return bounded;
    });
  }

  snapshot(): InkSurfaceSessionSnapshot {
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const surface = compositeSurface(this.bounded, snapshots);
    return {
      persistence: aggregatePersistence(snapshots),
      state: aggregateState(snapshots),
      surface:
        this.selectionMovePreview === null
          ? surface
          : translateSelectedStrokes(surface, this.selectedStrokeIdsSet, this.selectionMovePreview),
    };
  }

  recoverySnapshot(): InkDocumentRecoverySnapshot {
    const recoveryStates = this.bounded.map(({ session }) => session.recoveryState());
    return {
      expectedBases: recoveryStates.map(({ expectedBase }) => expectedBase),
      pendingAttempts: recoveryStates.map(({ pendingAttempt }) => pendingAttempt),
      records: recoveryStates.map(({ record }) => record),
      requiresRecovery: recoveryStates.some(({ pendingAttempt }) => pendingAttempt !== null),
    };
  }

  /** Re-enters every retained bounded surface as one logical document. */
  enter(): void {
    if (this.bounded.some(({ session }) => session.snapshot().state.kind === 'saving')) {
      throw new Error('Cannot enter Ink Mode while a bounded local save is still running.');
    }
    for (const bounded of this.bounded) bounded.session.enter();
    this.emit();
  }

  ensureMinimumHeight(minimumHeight: number): boolean {
    if (!Number.isFinite(minimumHeight) || minimumHeight <= 0) {
      throw new Error('Continuous Ink canvas height must be finite and positive.');
    }
    const requiredHeight = Math.ceil(minimumHeight);
    const final = this.bounded.at(-1);
    if (final === undefined || requiredHeight <= final.endY) return false;
    final.endY = requiredHeight;
    final.session.extendLogicalHeightTransiently(requiredHeight - final.startY);
    return true;
  }

  addStroke(stroke: InkStroke): void {
    const before = this.captureStrokeSets();
    const active = this.bounded.filter(
      (bounded) => bounded.session.snapshot().surface.status === 'active',
    );
    const fragments = splitInkStrokeIntoSurfaceFragments({
      color: stroke.color,
      linkedStrokeId: stroke.id,
      points: stroke.points,
      surfaces: active.map(({ endY, startY, surfaceId }) => ({
        endY,
        id: surfaceId,
        startY,
      })),
      tool: stroke.tool,
      width: stroke.width,
    });
    for (const fragment of fragments) {
      active
        .find((bounded) => bounded.surfaceId === fragment.surfaceId)
        ?.session.addStroke(fragment.stroke);
    }
    if (fragments.length > 0) {
      this.undoStack.push({ after: this.captureStrokeSets(), before });
      this.redoStack.length = 0;
    }
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  selectStrokeAt(point: InkPoint, tolerance: number, additive = false): readonly string[] {
    const strokeId = this.strokeIdAt(point, tolerance);
    this.selectionMovePreview = null;
    if (!additive) this.selectedStrokeIdsSet.clear();
    if (strokeId === null) {
      this.selectedStrokeIdsSet.clear();
    } else if (additive && this.selectedStrokeIdsSet.has(strokeId)) {
      this.selectedStrokeIdsSet.delete(strokeId);
    } else {
      this.selectedStrokeIdsSet.add(strokeId);
    }
    this.emit();
    return this.selectedStrokeIds();
  }

  selectedStrokeIds(): readonly string[] {
    return [...this.selectedStrokeIdsSet];
  }

  strokeIdAt(point: InkPoint, tolerance: number): string | null {
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new Error('Ink selection tolerance must be non-negative.');
    }
    return (
      this.snapshot()
        .surface.strokes.filter((candidate) => candidate.tool !== 'eraser')
        .find(
          (candidate) =>
            distanceToStroke(point, candidate.points) <= tolerance + candidate.width / 2,
        )?.id ?? null
    );
  }

  clearSelection(): boolean {
    if (this.selectedStrokeIdsSet.size === 0 && this.selectionMovePreview === null) return false;
    this.selectedStrokeIdsSet.clear();
    this.selectionMovePreview = null;
    this.emit();
    return true;
  }

  previewSelectionMove(dx: number, dy: number): { readonly dx: number; readonly dy: number } {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error('Ink selection translation must be finite.');
    }
    if (this.selectedStrokeIdsSet.size === 0) {
      throw new Error('Select at least one Ink stroke before moving it.');
    }
    const surface = compositeSurface(
      this.bounded,
      this.bounded.map((bounded) => bounded.session.snapshot()),
    );
    const points = surface.strokes
      .filter((stroke) => this.selectedStrokeIdsSet.has(stroke.id))
      .flatMap((stroke) => stroke.points);
    if (points.length === 0) {
      throw new Error('The selected Ink strokes are no longer available.');
    }
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    this.selectionMovePreview = {
      dx,
      dy: clamp(dy, -minY, surface.layout.logicalHeight - maxY),
    };
    this.emit();
    return this.selectionMovePreview;
  }

  cancelSelectionMove(): boolean {
    if (this.selectionMovePreview === null) return false;
    this.selectionMovePreview = null;
    this.emit();
    return true;
  }

  commitSelectionMove(): boolean {
    const delta = this.selectionMovePreview;
    if (delta === null) return false;
    this.selectionMovePreview = null;
    if (delta.dx === 0 && delta.dy === 0) {
      this.emit();
      return false;
    }

    const before = this.captureStrokeSets();
    const committed = compositeSurface(
      this.bounded,
      this.bounded.map((bounded) => bounded.session.snapshot()),
    );
    const translated = translateSelectedStrokes(committed, this.selectedStrokeIdsSet, delta);
    const next = new Map<string, InkStroke[]>();
    for (const bounded of this.bounded) {
      const retained = bounded.session
        .snapshot()
        .surface.strokes.filter(
          (stroke) => !this.selectedStrokeIdsSet.has(stroke.linkedStrokeId ?? stroke.id),
        );
      next.set(bounded.surfaceId, [...retained]);
    }
    for (const stroke of translated.strokes.filter((candidate) =>
      this.selectedStrokeIdsSet.has(candidate.id),
    )) {
      const fragments = splitInkStrokeIntoSurfaceFragments({
        color: stroke.color,
        linkedStrokeId: stroke.id,
        points: stroke.points,
        surfaces: this.bounded.map(({ endY, startY, surfaceId }) => ({
          endY,
          id: surfaceId,
          startY,
        })),
        tool: stroke.tool,
        width: stroke.width,
      });
      for (const fragment of fragments) next.get(fragment.surfaceId)?.push(fragment.stroke);
    }
    this.applyStrokeSets(next);
    this.undoStack.push({ after: this.captureStrokeSets(), before });
    this.redoStack.length = 0;
    this.emit();
    return true;
  }

  undo(): boolean {
    const command = this.undoStack.pop();
    if (command === undefined) return false;
    this.applyStrokeSets(command.before);
    this.redoStack.push(command);
    this.emit();
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.pop();
    if (command === undefined) return false;
    this.applyStrokeSets(command.after);
    this.undoStack.push(command);
    this.emit();
    return true;
  }

  eraseStrokeAt(point: InkPoint, radius: number): string | null {
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new Error('Ink eraser radius must be positive.');
    }
    const stroke = this.snapshot()
      .surface.strokes.filter((candidate) => candidate.tool !== 'eraser')
      .find(
        (candidate) => distanceToStroke(point, candidate.points) <= radius + candidate.width / 2,
      );
    if (stroke === undefined) return null;

    const before = this.captureStrokeSets();
    for (const bounded of this.bounded) {
      const current = bounded.session.snapshot().surface.strokes;
      const retained = current.filter(
        (candidate) => (candidate.linkedStrokeId ?? candidate.id) !== stroke.id,
      );
      if (retained.length !== current.length) bounded.session.replaceStrokes(retained);
    }
    this.undoStack.push({ after: this.captureStrokeSets(), before });
    this.redoStack.length = 0;
    this.emit();
    return stroke.id;
  }

  async background(): Promise<void> {
    await settleAll(this.bounded.map((bounded) => bounded.session.background()));
    this.emit();
  }

  async exit(): Promise<void> {
    await settleAll(this.bounded.map((bounded) => bounded.session.exit()));
    this.emit();
  }

  async retry(): Promise<void> {
    const failed = this.bounded.filter((bounded) => {
      const state = bounded.session.snapshot().state;
      return state.kind === 'ink-mode' && state.saveError !== null;
    });
    if (failed.length === 0) {
      throw new Error('There is no failed bounded Ink save to retry.');
    }
    await settleAll(failed.map((bounded) => bounded.session.retry()));
    this.emit();
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }

  private captureStrokeSets(): ReadonlyMap<string, readonly InkStroke[]> {
    return new Map(
      this.bounded.map((bounded) => [
        bounded.surfaceId,
        [...bounded.session.snapshot().surface.strokes],
      ]),
    );
  }

  private applyStrokeSets(strokeSets: ReadonlyMap<string, readonly InkStroke[]>): void {
    for (const bounded of this.bounded) {
      const strokes = strokeSets.get(bounded.surfaceId);
      if (
        strokes !== undefined &&
        !sameStrokeSets(strokes, bounded.session.snapshot().surface.strokes)
      ) {
        bounded.session.replaceStrokes(strokes);
      }
    }
  }
}

class CoalescingInkSurfaceWriter implements InkSurfaceWriter {
  private draining = false;
  private pending = new Map<
    string,
    {
      expectedBase: InkSurfaceRecord | undefined;
      record: InkSurfaceRecord;
      readonly waiters: Array<{
        readonly reject: (reason?: unknown) => void;
        readonly resolve: () => void;
      }>;
    }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly target: InkSurfaceWriter) {}

  updateSurface(record: InkSurfaceRecord, expectedBase?: InkSurfaceRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const existing = this.pending.get(record.id);
      if (existing === undefined) {
        this.pending.set(record.id, { expectedBase, record, waiters: [{ reject, resolve }] });
      } else {
        existing.expectedBase = expectedBase;
        existing.record = record;
        existing.waiters.push({ reject, resolve });
      }
      this.scheduleDrain();
    });
  }

  private scheduleDrain(): void {
    if (this.draining || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, 0);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.size > 0) {
        // One macrotask is a document-level commit barrier: sessions released by the previous
        // write can publish every fragment of their next logical command before this snapshot.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const pending = [...this.pending.values()];
        this.pending.clear();
        const records = pending.map(({ record }) => record);
        const expectedBases = pending.map(({ expectedBase }) => expectedBase);
        const hasEveryExpectedBase = expectedBases.every(
          (expectedBase): expectedBase is InkSurfaceRecord => expectedBase !== undefined,
        );
        try {
          if (records.length > 1 && this.target.updateSurfacesAtomically !== undefined) {
            await this.target.updateSurfacesAtomically(
              records,
              hasEveryExpectedBase ? expectedBases : undefined,
            );
          } else {
            await Promise.all(
              records.map((record, index) =>
                this.target.updateSurface(record, expectedBases[index]),
              ),
            );
          }
          for (const item of pending) {
            for (const waiter of item.waiters) waiter.resolve();
          }
        } catch (error) {
          const blocked = [...this.pending.values()];
          this.pending.clear();
          for (const item of [...pending, ...blocked]) {
            for (const waiter of item.waiters) waiter.reject(error);
          }
        }
      }
    } finally {
      this.draining = false;
      if (this.pending.size > 0) this.scheduleDrain();
    }
  }
}

function compositeSurface(
  bounded: readonly BoundedSession[],
  snapshots: readonly InkSurfaceSessionSnapshot[],
): InkSurfaceRecord {
  const first = snapshots[0]?.surface;
  if (first === undefined) {
    throw new Error('A continuous Ink document lost all bounded surfaces.');
  }
  const strokes = joinFragments(
    bounded.flatMap((item, index) => {
      const surface = snapshots[index]?.surface;
      if (surface === undefined || (surface.schemaVersion === 1 && surface.status !== 'active')) {
        return [];
      }
      return surface.strokes.map((stroke) => ({ startY: item.startY, stroke }));
    }),
  );
  return {
    createdAt: snapshots.map(({ surface }) => surface.createdAt).sort()[0] ?? first.createdAt,
    ...(first.deviceId === undefined ? {} : { deviceId: first.deviceId }),
    filePath: first.filePath,
    id: `document:${snapshots.map(({ surface }) => surface.id).join(':')}`,
    layout: {
      blockFingerprints: snapshots.flatMap(({ surface }) => surface.layout.blockFingerprints),
      fontFamily: first.layout.fontFamily,
      fontSize: first.layout.fontSize,
      lineHeight: first.layout.lineHeight,
      logicalHeight: bounded.at(-1)?.endY ?? first.layout.logicalHeight,
      logicalWidth: first.layout.logicalWidth,
      sourceRevision: snapshots.map(({ surface }) => surface.layout.sourceRevision).join(':'),
      themeMode: first.layout.themeMode,
    },
    noteId: first.noteId,
    revision: Math.max(...snapshots.map(({ surface }) => surface.revision)),
    schemaVersion: 1,
    status: 'active',
    strokes,
    updatedAt:
      snapshots
        .map(({ surface }) => surface.updatedAt)
        .sort()
        .at(-1) ?? first.updatedAt,
  };
}

function joinFragments(
  fragments: readonly { readonly startY: number; readonly stroke: InkStroke }[],
): readonly InkStroke[] {
  const joined = new Map<
    string,
    { readonly identity: string; readonly points: InkPoint[]; readonly stroke: InkStroke }
  >();
  for (const { startY, stroke } of fragments) {
    const identity = stroke.linkedStrokeId ?? stroke.id;
    const globalPoints = stroke.points.map((point) => ({ ...point, y: point.y + startY }));
    const existing = joined.get(identity);
    if (existing === undefined) {
      joined.set(identity, { identity, points: globalPoints, stroke });
      continue;
    }
    existing.points.push(...globalPoints);
  }
  return [...joined.values()].map(({ identity, points, stroke }) => {
    const { linkedStrokeId: _linkedStrokeId, ...unlinkedStroke } = stroke;
    void _linkedStrokeId;
    const ordered = points
      .map((point, index) => ({ index, point }))
      .sort((left, right) => left.point.time - right.point.time || left.index - right.index)
      .map(({ point }) => point)
      .filter((point, index, all) => {
        const previous = all[index - 1];
        return (
          previous === undefined ||
          previous.x !== point.x ||
          previous.y !== point.y ||
          previous.time !== point.time
        );
      });
    return { ...unlinkedStroke, id: identity, points: ordered };
  });
}

function translateSelectedStrokes(
  surface: InkSurfaceRecord,
  selectedStrokeIds: ReadonlySet<string>,
  delta: { readonly dx: number; readonly dy: number },
): InkSurfaceRecord {
  return {
    ...surface,
    strokes: surface.strokes.map((stroke) =>
      selectedStrokeIds.has(stroke.id)
        ? {
            ...stroke,
            points: stroke.points.map((point) => ({
              ...point,
              x: point.x + delta.dx,
              y: point.y + delta.dy,
            })),
          }
        : stroke,
    ),
  };
}

function sameStrokeSets(left: readonly InkStroke[], right: readonly InkStroke[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function aggregatePersistence(
  snapshots: readonly InkSurfaceSessionSnapshot[],
): InkPersistenceState {
  const error = snapshots.find(({ persistence }) => persistence.kind === 'error')?.persistence;
  if (error?.kind === 'error') return error;
  if (snapshots.some(({ persistence }) => persistence.kind === 'saving')) return { kind: 'saving' };
  if (snapshots.some(({ persistence }) => persistence.kind === 'saved-locally')) {
    return { kind: 'saved-locally' };
  }
  return { kind: 'idle' };
}

function aggregateState(snapshots: readonly InkSurfaceSessionSnapshot[]): InkModeState {
  const errorState = snapshots
    .map(({ state }) => state)
    .find((state) => state.kind === 'ink-mode' && state.saveError !== null);
  if (errorState?.kind === 'ink-mode') return errorState;
  const saving = snapshots.map(({ state }) => state).find((state) => state.kind === 'saving');
  if (saving?.kind === 'saving') return saving;
  if (snapshots.every(({ state }) => state.kind === 'reading')) return { kind: 'reading' };
  return {
    dirty: snapshots.some(({ state }) => state.kind === 'ink-mode' && state.dirty),
    kind: 'ink-mode',
    saveError: null,
  };
}

async function settleAll(promises: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed !== undefined) {
    throw failed.reason;
  }
}

function distanceToStroke(point: InkPoint, points: readonly InkPoint[]): number {
  if (points.length === 1) {
    const only = points[0] as InkPoint;
    return Math.hypot(point.x - only.x, point.y - only.y);
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start === undefined || end === undefined) continue;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
          );
    minimum = Math.min(
      minimum,
      Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio)),
    );
  }
  return minimum;
}
