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
  readonly endY: number;
  readonly session: InkSurfaceSession;
  readonly startY: number;
  readonly surfaceId: string;
}

interface InkDocumentCommand {
  readonly after: ReadonlyMap<string, readonly InkStroke[]>;
  readonly before: ReadonlyMap<string, readonly InkStroke[]>;
}

/**
 * Adapts independently persisted bounded surfaces to the single continuous canvas contract.
 * Surface boundaries remain an internal storage detail and never become visible UI tiles.
 */
export class InkDocumentSession {
  private readonly bounded: readonly BoundedSession[];
  private readonly onChange: (snapshot: InkSurfaceSessionSnapshot) => void;
  private readonly redoStack: InkDocumentCommand[] = [];
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
    const logicalWidth = input.surfaces[0]?.layout.logicalWidth;
    if (
      logicalWidth === undefined ||
      input.surfaces.some((surface) => surface.layout.logicalWidth !== logicalWidth)
    ) {
      throw new Error('All bounded Ink surfaces must share one fixed logical width.');
    }
    this.onChange = input.onChange ?? (() => undefined);
    let startY = 0;
    this.bounded = input.surfaces.map((surface) => {
      const bounded: BoundedSession = {
        endY: startY + surface.layout.logicalHeight,
        session: new InkSurfaceSession({
          ...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
          ...(input.now === undefined ? {} : { now: input.now }),
          onChange: () => this.emit(),
          repository: input.writer,
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
    return {
      persistence: aggregatePersistence(snapshots),
      state: aggregateState(snapshots),
      surface: compositeSurface(this.bounded, snapshots),
    };
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
      if (strokes !== undefined) bounded.session.replaceStrokes(strokes);
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
      if (surface === undefined || surface.status !== 'active') {
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
  const joined = new Map<string, InkStroke>();
  for (const { startY, stroke } of fragments) {
    const identity = stroke.linkedStrokeId ?? stroke.id;
    const globalPoints = stroke.points.map((point) => ({ ...point, y: point.y + startY }));
    const existing = joined.get(identity);
    if (existing === undefined) {
      const { linkedStrokeId: _linkedStrokeId, ...unlinkedStroke } = stroke;
      void _linkedStrokeId;
      joined.set(identity, { ...unlinkedStroke, id: identity, points: globalPoints });
      continue;
    }
    joined.set(identity, {
      ...existing,
      points: appendWithoutDuplicateBoundary(existing.points, globalPoints),
    });
  }
  return [...joined.values()];
}

function appendWithoutDuplicateBoundary(
  before: readonly InkPoint[],
  after: readonly InkPoint[],
): readonly InkPoint[] {
  const previous = before.at(-1);
  const next = after[0];
  return previous !== undefined &&
    next !== undefined &&
    previous.x === next.x &&
    previous.y === next.y
    ? [...before, ...after.slice(1)]
    : [...before, ...after];
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
