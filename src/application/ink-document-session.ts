import type { InkModeState } from '../domain/ink-mode-state';
import { logicalStrokeIdsCoveredByPolygon } from '../domain/ink-closed-loop-erase';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import {
  assertInkStrokeBrushMetadata,
  type InkPoint,
  type InkStroke,
  type InkSurfaceRecord,
} from '../domain/ink-surface';
import {
  joinInkStrokeSurfaceFragments,
  splitInkStrokeIntoSurfaceFragments,
} from '../domain/ink-surface-layout';
import { orderPositionedInkSurfaceRecords } from '../domain/ink-surface-migration';
import { InkBoundsIndex, type InkBoundsRect } from '../domain/ink-bounds-index';
import {
  InkSurfaceSession,
  type InkPersistenceState,
  type InkSurfaceSessionSnapshot,
  type InkSurfaceWriter,
} from './ink-surface-session';
import type { InkDraftOperation } from './ink-draft-store';
import type { InkDocumentDraftStore } from './ink-document-draft-store';

const SHARED_INK_GEOMETRY = new SharedInkStrokeGeometry();
const DEFAULT_INACTIVITY_MS = 60_000;
const MINIMUM_INACTIVITY_MS = 30_000;
const COLD_WORK_CHUNK_BUDGET_MS = 1;
const IN_MEMORY_ONLY_SURFACE_WRITER: InkSurfaceWriter = Object.freeze({
  updateSurface: (record: InkSurfaceRecord) => Promise.resolve(record),
  updateSurfacesAtomically: (records: readonly InkSurfaceRecord[]) => Promise.resolve(records),
});

export interface InkColdWorkScheduler {
  now(): number;
  yieldToHost(): Promise<void>;
}

const DEFAULT_COLD_WORK_SCHEDULER: InkColdWorkScheduler = Object.freeze({
  now: () => performance.now(),
  yieldToHost: yieldInkColdWorkToHost,
});

interface BoundedSession {
  endY: number;
  logicalHeight: number;
  readonly session: InkSurfaceSession;
  readonly startY: number;
  readonly surfaceId: string;
}

interface InkDocumentHistoryEntry {
  readonly logicalAfter: readonly InkRenderableStrokeRef[];
  readonly logicalBefore: readonly InkRenderableStrokeRef[];
}

export type InkLogicalRect = InkBoundsRect;

export interface InkRenderableStrokeRef {
  readonly bounds: InkLogicalRect;
  readonly id: string;
  readonly order: number;
  readonly stroke: InkStroke;
}

/** Hot-path geometry identity plus incrementally accumulated bounds; no contours or digests. */
export interface InkPreparedStrokeGeometry {
  readonly bounds: InkLogicalRect;
  readonly color: string;
  readonly logicalStrokeId: string;
  readonly tool: InkStroke['tool'];
  readonly version: NonNullable<InkStroke['brushRenderVersion']> | undefined;
}

export interface InkDocumentReadView {
  readonly documentId: string;
  readonly generation: number;
  readonly indexBytes: number;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly persistence: InkPersistenceState;
  readonly selection: readonly string[];
  readonly state: InkModeState;
  readonly strokeCount: number;
  readonly strokes: readonly InkRenderableStrokeRef[];
}

export interface InkDocumentChange {
  readonly addedIds: readonly string[];
  readonly bounds: readonly {
    readonly id: string;
    readonly newBounds: InkLogicalRect | null;
    readonly oldBounds: InkLogicalRect | null;
  }[];
  readonly commandId: string;
  readonly generation: number;
  readonly persistenceDelta: {
    readonly next: InkPersistenceState;
    readonly previous: InkPersistenceState;
  } | null;
  readonly removedIds: readonly string[];
  readonly selectionDelta: {
    readonly next: readonly string[];
    readonly previous: readonly string[];
  } | null;
  readonly updatedIds: readonly string[];
}

export type InkDocumentCommand =
  | { readonly id: string; readonly kind: 'add'; readonly stroke: InkStroke }
  | { readonly id: string; readonly ids: readonly string[]; readonly kind: 'erase' }
  | {
      readonly dx: number;
      readonly dy: number;
      readonly id: string;
      readonly ids: readonly string[];
      readonly kind: 'move';
    }
  | {
      readonly id: string;
      readonly ids: readonly string[];
      readonly kind: 'restyle';
      readonly style: Partial<Pick<InkStroke, 'color' | 'tool' | 'width'>>;
    }
  | { readonly id: string; readonly kind: 'redo' | 'undo' };

export type InkDocumentApplyResult = {
  readonly change: InkDocumentChange;
  readonly kind: 'committed';
};

export interface InkLiveDocumentInstrumentation {
  beginPersistenceSpan?(kind: 'canonical-submit'): (accepted: boolean) => void;
  onAuditGuard?(guard: 'canonical-cold-materialization'): void;
  onColdMaterialization?(measurement: {
    readonly intent: 'explicit-cold' | 'legacy-snapshot';
  }): void;
  onInteractionActiveChanged?(active: boolean): void;
  onUserInteraction?(): void;
  onPersistenceWork?(measurement: {
    readonly kind: 'canonical-encode' | 'canonical-storage-write' | 'cold-snapshot';
    readonly phase: 'cold' | 'completion';
  }): void;
  onQuery?(measurement: { readonly resultCount: number; readonly visitedNodeCount: number }): void;
}

/**
 * Adapts independently persisted bounded surfaces to the single continuous canvas contract.
 * Surface boundaries remain an internal storage detail and never become visible UI tiles.
 */
export class InkLiveDocument {
  private readonly boundsIndex = new InkBoundsIndex<InkRenderableStrokeRef>();
  private readonly authorsVersionedLegacyStroke: boolean;
  private readonly bounded: readonly BoundedSession[];
  private boundedMutationDepth = 0;
  private readonly coldWorkScheduler: InkColdWorkScheduler;
  private readonly draftStore: InkDocumentDraftStore | undefined;
  private readonly committedCommands = new Map<string, InkDocumentApplyResult>();
  private readonly dirtyLogicalStrokeRevision = new Map<string, number>();
  private readonly instrumentation: InkLiveDocumentInstrumentation;
  private readonly inactivityMs: number;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly logicalRefsById = new Map<string, InkRenderableStrokeRef>();
  private readonly onChange: (read: InkDocumentReadView, change: InkDocumentChange | null) => void;
  private readonly onPersistenceIssue: (error: unknown) => void;
  private readonly noteKey: string;
  private readonly now: () => string;
  private readonly persistencePolicy: 'explicit-exit' | 'legacy-idle-and-exit';
  private readonly snapshotStore:
    { readonly replace: (snapshot: InkSurfaceRecord) => Promise<void> } | undefined;
  private explicitPersistence: InkPersistenceState = { kind: 'idle' };
  private explicitSaveError: unknown = null;
  private explicitState: InkModeState = { dirty: false, kind: 'ink-mode', saveError: null };
  private lastSavedSnapshot: InkSurfaceRecord | null = null;
  private orderedProjectionCache: readonly InkRenderableStrokeRef[] = Object.freeze([]);
  private orderedProjectionCacheRevision = -1;
  private orderedProjectionRevision = 0;
  private readonly orderedStrokeProjection = createLazyInkStrokeProjection(() =>
    this.materializeOrderedStrokeProjection(),
  );
  private interactionActive = false;
  private interactionEpoch = 0;
  private readonly interactionIdleWaiters = new Set<() => void>();
  private liveDirtyRevision = 0;
  private liveFlushPromise: Promise<void> | null = null;
  private livePersistedRevision = 0;
  private readonly persistenceWriter: CoalescingInkSurfaceWriter | null;
  private readonly projectedSurfaceIdsByLogicalStrokeId = new Map<string, Set<string>>();
  private readView: InkDocumentReadView;
  private readonly redoStack: InkDocumentHistoryEntry[] = [];
  private nextStrokeOrder = 0;
  private readonly selectedStrokeIdsSet = new Set<string>();
  private selectionMovePreview: { readonly dx: number; readonly dy: number } | null = null;
  private selectionPreviewBaseRefs: ReadonlyMap<string, InkRenderableStrokeRef> | null = null;
  private systemChangeSequence = 0;
  private readonly undoStack: InkDocumentHistoryEntry[] = [];

  constructor(input: {
    readonly coldWorkScheduler?: InkColdWorkScheduler;
    readonly debounceMs?: number;
    readonly draftOperations?: readonly InkDraftOperation[];
    readonly draftStore?: InkDocumentDraftStore;
    readonly inactivityMs?: number;
    readonly initialDraftRevision?: number;
    readonly instrumentation?: InkLiveDocumentInstrumentation;
    readonly now?: () => string;
    readonly onChange?: (read: InkDocumentReadView, change: InkDocumentChange | null) => void;
    readonly onPersistenceIssue?: (error: unknown) => void;
    readonly persistencePolicy?: 'explicit-exit' | 'legacy-idle-and-exit';
    readonly snapshotStore?: {
      readonly replace: (snapshot: InkSurfaceRecord) => Promise<void>;
    };
    readonly surfaces: readonly InkSurfaceRecord[];
    readonly writer?: InkSurfaceWriter;
  }) {
    if (input.surfaces.length === 0) {
      throw new Error('A continuous Ink document requires at least one bounded surface.');
    }
    if (input.snapshotStore === undefined && input.writer === undefined) {
      throw new Error('An Ink document requires a snapshot store or a legacy surface writer.');
    }
    if (
      input.snapshotStore === undefined &&
      input.surfaces.length > 1 &&
      input.writer?.updateSurfacesAtomically === undefined
    ) {
      throw new Error('A multi-chunk Ink document requires an atomic persistence writer.');
    }
    const activeSchemaVersions = new Set(
      input.surfaces
        .filter((surface) => surface.status === 'active')
        .map((surface) => surface.schemaVersion),
    );
    if (
      activeSchemaVersions.has(3) &&
      [...activeSchemaVersions].some((schemaVersion) => schemaVersion !== 3)
    ) {
      throw new Error('Mixed Ink schema v1/v2 and v3 active surfaces are a semantic conflict.');
    }
    this.authorsVersionedLegacyStroke =
      activeSchemaVersions.size === 1 && activeSchemaVersions.has(3);
    const surfaces = orderPositionedInkSurfaceRecords(input.surfaces);
    this.noteKey = surfaces[0]?.filePath ?? '';
    const logicalWidth = surfaces[0]?.layout.logicalWidth;
    if (
      logicalWidth === undefined ||
      surfaces.some((surface) => surface.layout.logicalWidth !== logicalWidth)
    ) {
      throw new Error('All bounded Ink surfaces must share one fixed logical width.');
    }
    this.onChange = input.onChange ?? (() => undefined);
    this.onPersistenceIssue = input.onPersistenceIssue ?? (() => undefined);
    this.instrumentation = input.instrumentation ?? {};
    this.coldWorkScheduler = input.coldWorkScheduler ?? DEFAULT_COLD_WORK_SCHEDULER;
    this.inactivityMs = input.inactivityMs ?? DEFAULT_INACTIVITY_MS;
    this.now = input.now ?? (() => new Date().toISOString());
    this.persistencePolicy = input.persistencePolicy ?? 'legacy-idle-and-exit';
    this.snapshotStore = input.snapshotStore;
    this.draftStore = input.draftStore;
    if (!Number.isFinite(this.inactivityMs) || this.inactivityMs < MINIMUM_INACTIVITY_MS) {
      throw new Error(
        `Ink sustained inactivity must be at least ${MINIMUM_INACTIVITY_MS} milliseconds.`,
      );
    }
    this.instrumentation.onAuditGuard?.('canonical-cold-materialization');
    this.persistenceWriter =
      input.snapshotStore === undefined && input.writer !== undefined
        ? new CoalescingInkSurfaceWriter(input.writer, () => this.waitForInteractionIdle())
        : null;
    const writer = this.persistenceWriter ?? IN_MEMORY_ONLY_SURFACE_WRITER;
    let startY = 0;
    this.bounded = surfaces.map((surface) => {
      if (surface.schemaVersion >= 2) startY = surface.layout.originY as number;
      const bounded: BoundedSession = {
        endY: startY + surface.layout.logicalHeight,
        logicalHeight: surface.layout.logicalHeight,
        session: new InkSurfaceSession({
          // The Live Document is the single owner of canonical scheduling. A bounded surface must
          // never create an independent timer that can bypass the contact/frame-debt fence.
          autoFlush: false,
          ...(input.now === undefined ? {} : { now: input.now }),
          onChange: () => this.handleBoundedChange(),
          repository: writer,
          surface,
        }),
        startY,
        surfaceId: surface.id,
      };
      startY = bounded.endY;
      return bounded;
    });
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    this.explicitPersistence = aggregatePersistence(snapshots);
    this.explicitState = aggregateState(snapshots);
    this.rebuildProjectedSurfaceIndex(snapshots);
    const logicalStrokes = compositeSurface(this.bounded, snapshots).strokes.filter(
      (stroke) => stroke.tool !== 'eraser',
    );
    const strokes = Object.freeze(
      logicalStrokes.map((stroke, order) =>
        Object.freeze({
          bounds: conservativeStrokeBounds(stroke),
          id: stroke.id,
          order,
          stroke,
        }),
      ),
    );
    this.nextStrokeOrder = strokes.length;
    for (const ref of strokes) {
      this.boundsIndex.set(ref.id, ref.bounds, ref);
      this.logicalRefsById.set(ref.id, ref);
    }
    this.invalidateOrderedStrokeProjection();
    this.readView = Object.freeze({
      documentId: `document:${snapshots.map(({ surface }) => surface.id).join(':')}`,
      generation: 0,
      indexBytes: this.boundsIndex.byteSizeEstimate,
      logicalHeight: this.bounded.at(-1)?.endY ?? surfaces[0]?.layout.logicalHeight ?? 1,
      logicalWidth,
      persistence: aggregatePersistence(snapshots),
      selection: Object.freeze([]),
      state: aggregateState(snapshots),
      strokeCount: this.logicalRefsById.size,
      strokes: this.orderedStrokeProjection,
    });
    this.replayDraftOperations(input.draftOperations ?? []);
    if (input.initialDraftRevision !== undefined) {
      if (!Number.isSafeInteger(input.initialDraftRevision) || input.initialDraftRevision <= 0) {
        throw new Error('Ink recovered Draft revision must be a positive safe integer.');
      }
      this.liveDirtyRevision = Math.max(this.liveDirtyRevision, input.initialDraftRevision);
      this.explicitState = { dirty: true, kind: 'ink-mode', saveError: null };
      this.readView = Object.freeze({ ...this.readView, state: this.explicitState });
    }
    this.scheduleSustainedInactivitySave();
  }

  read(): InkDocumentReadView {
    return this.readView;
  }

  /** O(1) command/Gate seam; ordered history is deliberately not materialized. */
  firstRenderableStrokeRef(): InkRenderableStrokeRef | undefined {
    return this.logicalRefsById.values().next().value;
  }

  query(viewport: InkLogicalRect): readonly InkRenderableStrokeRef[] {
    const result = this.boundsIndex.query(viewport);
    this.instrumentation.onQuery?.({
      resultCount: result.values.length,
      visitedNodeCount: result.visitedNodeCount,
    });
    return Object.freeze([...result.values]);
  }

  apply(
    command: InkDocumentCommand,
    preparedGeometry?: InkPreparedStrokeGeometry,
  ): InkDocumentApplyResult {
    const normalized = this.normalizeCommandAtLiveBoundary(command);
    const committed = this.committedCommands.get(normalized.id);
    if (committed !== undefined) return committed;
    if (preparedGeometry !== undefined) {
      if (normalized.kind !== 'add') {
        throw new Error('Prepared Ink geometry is only valid for an Add command.');
      }
      assertPreparedGeometryMatchesStroke(normalized.stroke, preparedGeometry);
    }
    const change = this.applyLiveCommand(normalized, preparedGeometry);
    if (change === null) {
      throw new Error(
        'Ink document command ' + normalized.id + ' did not intersect an active surface.',
      );
    }
    this.liveDirtyRevision += 1;
    this.markDirtyChange(change, this.liveDirtyRevision);
    if (this.persistencePolicy === 'explicit-exit') {
      this.explicitSaveError = null;
      this.explicitPersistence = { kind: 'idle' };
      this.explicitState = { dirty: true, kind: 'ink-mode', saveError: null };
      this.readView = Object.freeze({
        ...this.readView,
        persistence: this.explicitPersistence,
        state: this.explicitState,
      });
    }
    this.noteUserInteraction();
    const result = Object.freeze({ change, kind: 'committed' as const });
    this.committedCommands.set(normalized.id, result);
    return result;
  }

  /**
   * Fences the cold persistence lane behind both input ownership and its final presentation frame.
   * The Canvas controller releases the fence from its render-settled callback, never from pen-up.
   */
  setInteractionActive(active: boolean): void {
    if (active === this.interactionActive) return;
    this.interactionActive = active;
    this.instrumentation.onInteractionActiveChanged?.(active);
    if (active) {
      this.interactionEpoch += 1;
      this.clearInactivityTimer();
      return;
    }
    for (const resolve of this.interactionIdleWaiters) resolve();
    this.interactionIdleWaiters.clear();
    this.scheduleSustainedInactivitySave();
  }

  /** Resets the product-level sustained-inactivity window without authorizing immediate work. */
  noteUserInteraction(): void {
    this.interactionEpoch += 1;
    this.instrumentation.onUserInteraction?.();
    this.clearInactivityTimer();
    this.scheduleSustainedInactivitySave();
  }

  private normalizeCommandAtLiveBoundary(command: InkDocumentCommand): InkDocumentCommand {
    if (command.kind !== 'add' || command.stroke.tool === 'eraser') return command;
    if (
      !this.authorsVersionedLegacyStroke ||
      command.stroke.brushRenderVersion !== undefined ||
      command.stroke.inputProfile !== undefined
    ) {
      return command;
    }
    return Object.freeze({
      ...command,
      stroke: Object.freeze({
        ...command.stroke,
        brushRenderVersion: 'legacy-round-v1' as const,
        inputProfile: Object.freeze({
          pressure: 'legacy-unknown' as const,
          tilt: 'legacy-unknown' as const,
        }),
      }),
    });
  }

  private applyLiveCommand(
    command: InkDocumentCommand,
    preparedGeometry?: InkPreparedStrokeGeometry,
  ): InkDocumentChange | null {
    let change: InkDocumentChange | null;
    switch (command.kind) {
      case 'add':
        change = this.applyAddedStroke(command.stroke, command.id, preparedGeometry);
        break;
      case 'erase':
        change = this.applyErasedLogicalStrokeIds(command.ids, command.id).change;
        break;
      case 'move':
        change = this.applyMovedLogicalStrokes(command.ids, command.dx, command.dy, command.id);
        break;
      case 'restyle':
        change = this.applyRestyledLogicalStrokes(command.ids, command.style, command.id);
        break;
      case 'redo':
        change = this.applyRedo(command.id);
        break;
      case 'undo':
        change = this.applyUndo(command.id);
        break;
    }
    return change;
  }

  private appendLogicalStroke(
    stroke: InkStroke,
    commandId: string,
    bounds: InkLogicalRect,
  ): InkDocumentChange {
    if (this.logicalRefsById.has(stroke.id)) {
      throw new Error(`Ink Logical Stroke ID ${stroke.id} already exists in this document.`);
    }
    const previous = this.readView;
    const ref = Object.freeze({
      bounds,
      id: stroke.id,
      order: this.nextStrokeOrder,
      stroke,
    });
    this.nextStrokeOrder += 1;
    this.boundsIndex.set(ref.id, ref.bounds, ref);
    this.logicalRefsById.set(ref.id, ref);
    this.invalidateOrderedStrokeProjection();
    const persistence = previous.persistence;
    const generation = previous.generation + 1;
    this.readView = Object.freeze({
      documentId: previous.documentId,
      generation,
      indexBytes: this.boundsIndex.byteSizeEstimate,
      logicalHeight: this.bounded.at(-1)?.endY ?? previous.logicalHeight,
      logicalWidth: previous.logicalWidth,
      persistence,
      selection: previous.selection,
      state: previous.state,
      strokeCount: this.logicalRefsById.size,
      strokes: this.orderedStrokeProjection,
    });
    return Object.freeze({
      addedIds: Object.freeze([stroke.id]),
      bounds: Object.freeze([Object.freeze({ id: stroke.id, newBounds: bounds, oldBounds: null })]),
      commandId,
      generation,
      persistenceDelta: samePersistenceState(previous.persistence, persistence)
        ? null
        : Object.freeze({ next: persistence, previous: previous.persistence }),
      removedIds: Object.freeze([]),
      selectionDelta: null,
      updatedIds: Object.freeze([]),
    });
  }

  /** Invalidates the cold ordered projection after the O(k) Map/index mutation is complete. */
  private mutateOrderedStrokeProjection(
    sourceRefs: readonly InkRenderableStrokeRef[],
    targetRefs: readonly InkRenderableStrokeRef[],
  ): readonly InkRenderableStrokeRef[] {
    void sourceRefs;
    void targetRefs;
    this.invalidateOrderedStrokeProjection();
    return this.orderedStrokeProjection;
  }

  private invalidateOrderedStrokeProjection(): void {
    this.orderedProjectionRevision += 1;
  }

  private materializeOrderedStrokeProjection(): readonly InkRenderableStrokeRef[] {
    if (this.orderedProjectionCacheRevision === this.orderedProjectionRevision) {
      return this.orderedProjectionCache;
    }
    this.orderedProjectionCache = Object.freeze(
      [...this.logicalRefsById.values()].sort((left, right) => left.order - right.order),
    );
    this.orderedProjectionCacheRevision = this.orderedProjectionRevision;
    return this.orderedProjectionCache;
  }

  snapshot(): InkSurfaceSessionSnapshot {
    return this.materializeCompositeSnapshot('legacy-snapshot');
  }

  private materializeCompositeSnapshot(
    intent: 'explicit-cold' | 'legacy-snapshot',
  ): InkSurfaceSessionSnapshot {
    this.recordPersistenceWork('cold-snapshot');
    this.instrumentation.onColdMaterialization?.({ intent });
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const persistedSurface = compositeSurface(this.bounded, snapshots);
    const refs = intent === 'explicit-cold' ? this.committedLogicalRefs() : this.readView.strokes;
    const historicalErasers = persistedSurface.strokes.filter(({ tool }) => tool === 'eraser');
    const surface = {
      ...persistedSurface,
      strokes: [...historicalErasers, ...refs.map(({ stroke }) => stroke)],
    };
    return {
      persistence: this.effectivePersistence(snapshots),
      state: aggregateState(snapshots),
      surface,
    };
  }

  /** Explicit cold canonical materialization for save/export/fixture paths. */
  materializeColdSnapshot(): InkSurfaceSessionSnapshot {
    return this.materializeCompositeSnapshot('explicit-cold');
  }

  /** Exact bounded canonical projection after Done; shares immutable records and owns no editor. */
  canonicalProjectionRecords(): readonly InkSurfaceRecord[] {
    if (this.persistencePolicy === 'explicit-exit' && this.lastSavedSnapshot !== null) {
      return Object.freeze([this.lastSavedSnapshot]);
    }
    return Object.freeze(this.bounded.map(({ session }) => session.snapshot().surface));
  }

  retry(): Promise<void> {
    return this.retryPersistence();
  }

  /** Re-enters every retained bounded surface as one logical document. */
  enter(): void {
    if (this.bounded.some(({ session }) => session.snapshot().state.kind === 'saving')) {
      throw new Error('Cannot enter Ink Mode while a bounded local save is still running.');
    }
    this.mutateBounded(() => {
      for (const bounded of this.bounded) bounded.session.enter();
    });
    this.emit();
  }

  ensureMinimumHeight(minimumHeight: number): boolean {
    if (!Number.isFinite(minimumHeight) || minimumHeight <= 0) {
      throw new Error('Continuous Ink canvas height must be finite and positive.');
    }
    const requiredHeight = Math.ceil(minimumHeight);
    const final = this.bounded.at(-1);
    if (final === undefined || requiredHeight <= final.endY) return false;
    const logicalHeight = Math.ceil(requiredHeight - final.startY);
    final.logicalHeight = logicalHeight;
    final.endY = final.startY + logicalHeight;
    if (!final.session.extendLogicalHeightTransiently(logicalHeight)) this.emit();
    return true;
  }

  addStroke(stroke: InkStroke): void {
    this.apply({ id: `legacy-add:${stroke.id}`, kind: 'add', stroke });
  }

  private applyAddedStroke(
    stroke: InkStroke,
    commandId: string,
    preparedGeometry?: InkPreparedStrokeGeometry,
  ): InkDocumentChange | null {
    if (this.readView.state.kind === 'reading') {
      throw new Error('Cannot add an Ink stroke outside Ink Mode.');
    }
    const bounds = preparedStrokeBounds(stroke, preparedGeometry);
    if (bounds.y > this.readView.logicalHeight || bounds.y + bounds.height < 0) {
      return null;
    }
    const change = this.appendLogicalStroke(stroke, commandId, bounds);
    const addedId = change.addedIds[0];
    const addedRef = addedId === undefined ? undefined : this.logicalRefsById.get(addedId);
    this.undoStack.push({
      logicalAfter: addedRef === undefined ? [] : [addedRef],
      logicalBefore: [],
    });
    this.redoStack.length = 0;
    this.publishChange(change);
    return change;
  }

  private replayDraftOperations(operations: readonly InkDraftOperation[]): void {
    if (operations.length === 0) return;
    const ordered = [...operations].sort((left, right) => left.revision - right.revision);
    for (const operation of ordered) {
      if (operation.noteKey !== this.noteKey) {
        throw new Error(`Ink draft ${operation.revision} belongs to another note.`);
      }
      if (!Number.isSafeInteger(operation.revision) || operation.revision <= 0) {
        throw new Error('Ink draft revision must be a positive safe integer.');
      }
      this.liveDirtyRevision = Math.max(this.liveDirtyRevision, operation.revision);
      const normalized = this.normalizeCommandAtLiveBoundary(operation.command);
      if (normalized.kind !== 'add') {
        throw new Error(`Unsupported startup Ink draft command: ${normalized.kind}.`);
      }
      if (this.logicalRefsById.has(normalized.stroke.id)) continue;
      if (this.committedCommands.has(normalized.id)) continue;
      const change = this.applyLiveCommand(normalized);
      if (change === null) {
        throw new Error(`Ink draft ${operation.revision} could not be replayed.`);
      }
      this.markDirtyChange(change, operation.revision);
      this.committedCommands.set(
        normalized.id,
        Object.freeze({ change, kind: 'committed' as const }),
      );
    }
    this.redoStack.length = 0;
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
    const candidates = this.query({
      height: tolerance * 2,
      width: tolerance * 2,
      x: point.x - tolerance,
      y: point.y - tolerance,
    });
    let matched: InkRenderableStrokeRef | null = null;
    for (const candidate of candidates) {
      if (
        candidate.stroke.tool !== 'eraser' &&
        SHARED_INK_GEOMETRY.hitTest(candidate.stroke, point, tolerance) &&
        (matched === null || candidate.order < matched.order)
      ) {
        matched = candidate;
      }
    }
    return matched?.id ?? null;
  }

  clearSelection(): boolean {
    if (this.selectedStrokeIdsSet.size === 0 && this.selectionMovePreview === null) return false;
    this.discardSelectionPreviewToBase();
    this.selectedStrokeIdsSet.clear();
    this.emit();
    return true;
  }

  deleteSelectedStrokes(): readonly string[] {
    const selectedStrokeIds = this.selectedStrokeIds();
    if (selectedStrokeIds.length === 0) return [];
    this.discardSelectionPreviewToBase();
    this.selectedStrokeIdsSet.clear();
    const deletedStrokeIds = this.eraseLogicalStrokeIds(selectedStrokeIds);
    if (deletedStrokeIds.length === 0) this.emit();
    return deletedStrokeIds;
  }

  previewSelectionMove(dx: number, dy: number): { readonly dx: number; readonly dy: number } {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error('Ink selection translation must be finite.');
    }
    if (this.selectedStrokeIdsSet.size === 0) {
      throw new Error('Select at least one Ink stroke before moving it.');
    }
    this.selectionPreviewBaseRefs ??= new Map(
      [...this.selectedStrokeIdsSet].flatMap((id) => {
        const ref = this.logicalRefsById.get(id);
        return ref === undefined ? [] : [[id, ref] as const];
      }),
    );
    const baseRefs = [...this.selectionPreviewBaseRefs.values()];
    const points = baseRefs.flatMap(({ stroke }) => stroke.points);
    if (points.length === 0) {
      throw new Error('The selected Ink strokes are no longer available.');
    }
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    this.selectionMovePreview = {
      dx,
      dy: clamp(dy, -minY, this.readView.logicalHeight - maxY),
    };
    const previous = this.readView;
    const replacementById = new Map<string, InkRenderableStrokeRef>();
    const currentRefs: InkRenderableStrokeRef[] = [];
    const boundsChanges: InkDocumentChange['bounds'][number][] = [];
    for (const baseRef of baseRefs) {
      const stroke = translateStroke(baseRef.stroke, this.selectionMovePreview);
      const bounds = conservativeStrokeBounds(stroke);
      const ref = Object.freeze({ bounds, id: stroke.id, order: baseRef.order, stroke });
      replacementById.set(ref.id, ref);
      this.boundsIndex.set(ref.id, ref.bounds, ref);
      const current = this.logicalRefsById.get(ref.id) ?? baseRef;
      currentRefs.push(current);
      this.logicalRefsById.set(ref.id, ref);
      boundsChanges.push(
        Object.freeze({ id: ref.id, newBounds: ref.bounds, oldBounds: current.bounds }),
      );
    }
    const generation = previous.generation + 1;
    const strokes = this.mutateOrderedStrokeProjection(currentRefs, [...replacementById.values()]);
    this.readView = Object.freeze({ ...previous, generation, strokes });
    this.systemChangeSequence += 1;
    this.publishChange(
      Object.freeze({
        addedIds: Object.freeze([]),
        bounds: Object.freeze(boundsChanges),
        commandId: `selection-preview:${this.systemChangeSequence}`,
        generation,
        persistenceDelta: null,
        removedIds: Object.freeze([]),
        selectionDelta: null,
        updatedIds: Object.freeze(baseRefs.map(({ id }) => id)),
      }),
    );
    return this.selectionMovePreview;
  }

  cancelSelectionMove(): boolean {
    if (this.selectionMovePreview === null || this.selectionPreviewBaseRefs === null) return false;
    const previous = this.readView;
    const baseRefs = [...this.selectionPreviewBaseRefs.values()];
    const currentRefs: InkRenderableStrokeRef[] = [];
    const boundsChanges = baseRefs.map((ref) => {
      const current = this.logicalRefsById.get(ref.id) ?? ref;
      currentRefs.push(current);
      this.boundsIndex.set(ref.id, ref.bounds, ref);
      this.logicalRefsById.set(ref.id, ref);
      return Object.freeze({ id: ref.id, newBounds: ref.bounds, oldBounds: current.bounds });
    });
    this.selectionMovePreview = null;
    this.selectionPreviewBaseRefs = null;
    const generation = previous.generation + 1;
    const strokes = this.mutateOrderedStrokeProjection(currentRefs, baseRefs);
    this.readView = Object.freeze({ ...previous, generation, strokes });
    this.systemChangeSequence += 1;
    this.publishChange(
      Object.freeze({
        addedIds: Object.freeze([]),
        bounds: Object.freeze(boundsChanges),
        commandId: `selection-cancel:${this.systemChangeSequence}`,
        generation,
        persistenceDelta: null,
        removedIds: Object.freeze([]),
        selectionDelta: null,
        updatedIds: Object.freeze(baseRefs.map(({ id }) => id)),
      }),
    );
    return true;
  }

  commitSelectionMove(): boolean {
    const delta = this.selectionMovePreview;
    if (delta === null) return false;
    const selectedIds = [...this.selectedStrokeIdsSet];
    this.discardSelectionPreviewToBase();
    if (delta.dx === 0 && delta.dy === 0) {
      this.emit();
      return false;
    }
    this.systemChangeSequence += 1;
    return (
      this.apply({
        dx: delta.dx,
        dy: delta.dy,
        id: `selection-move:${this.systemChangeSequence}`,
        ids: selectedIds,
        kind: 'move',
      }).kind === 'committed'
    );
  }

  private discardSelectionPreviewToBase(): void {
    const base = this.selectionPreviewBaseRefs;
    this.selectionMovePreview = null;
    this.selectionPreviewBaseRefs = null;
    if (base === null) return;
    const currentRefs: InkRenderableStrokeRef[] = [];
    for (const ref of base.values()) {
      currentRefs.push(this.logicalRefsById.get(ref.id) ?? ref);
      this.boundsIndex.set(ref.id, ref.bounds, ref);
      this.logicalRefsById.set(ref.id, ref);
    }
    this.readView = Object.freeze({
      ...this.readView,
      strokes: this.mutateOrderedStrokeProjection(currentRefs, [...base.values()]),
    });
  }

  undo(): boolean {
    this.systemChangeSequence += 1;
    if (!this.canUndo()) return false;
    return (
      this.apply({ id: `legacy-undo:${this.systemChangeSequence}`, kind: 'undo' }).kind ===
      'committed'
    );
  }

  redo(): boolean {
    this.systemChangeSequence += 1;
    if (!this.canRedo()) return false;
    return (
      this.apply({ id: `legacy-redo:${this.systemChangeSequence}`, kind: 'redo' }).kind ===
      'committed'
    );
  }

  private applyUndo(commandId: string): InkDocumentChange | null {
    const command = this.undoStack.pop();
    if (command === undefined) return null;
    try {
      const change = this.applyHistoryEntry(command.logicalBefore, command.logicalAfter, commandId);
      this.redoStack.push(command);
      this.publishChange(change);
      return change;
    } catch (error) {
      this.undoStack.push(command);
      throw error;
    }
  }

  private applyRedo(commandId: string): InkDocumentChange | null {
    const command = this.redoStack.pop();
    if (command === undefined) return null;
    try {
      const change = this.applyHistoryEntry(command.logicalAfter, command.logicalBefore, commandId);
      this.undoStack.push(command);
      this.publishChange(change);
      return change;
    } catch (error) {
      this.redoStack.push(command);
      throw error;
    }
  }

  private applyHistoryEntry(
    targetRefs: readonly InkRenderableStrokeRef[],
    sourceRefs: readonly InkRenderableStrokeRef[],
    commandId: string,
  ): InkDocumentChange {
    const previous = this.readView;
    const affectedIds = new Set([...targetRefs, ...sourceRefs].map(({ id }) => id));
    const targetById = new Map(targetRefs.map((ref) => [ref.id, ref]));
    const previousById = new Map(sourceRefs.map((ref) => [ref.id, ref]));
    for (const id of affectedIds) this.boundsIndex.delete(id);
    for (const id of affectedIds) this.logicalRefsById.delete(id);
    for (const ref of targetRefs) {
      this.boundsIndex.set(ref.id, ref.bounds, ref);
      this.logicalRefsById.set(ref.id, ref);
    }
    const strokes = this.mutateOrderedStrokeProjection(sourceRefs, targetRefs);
    for (const id of affectedIds) {
      if (!targetById.has(id)) this.selectedStrokeIdsSet.delete(id);
    }
    const selection = Object.freeze([...this.selectedStrokeIdsSet]);
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const persistence = this.effectivePersistence(snapshots);
    const generation = previous.generation + 1;
    this.readView = Object.freeze({
      ...previous,
      generation,
      indexBytes: this.boundsIndex.byteSizeEstimate,
      persistence,
      selection,
      state: aggregateState(snapshots),
      strokeCount: this.logicalRefsById.size,
      strokes,
    });
    const orderedIds = [...affectedIds].sort(
      (left, right) =>
        (targetById.get(left)?.order ?? previousById.get(left)?.order ?? 0) -
        (targetById.get(right)?.order ?? previousById.get(right)?.order ?? 0),
    );
    const addedIds = orderedIds.filter((id) => !previousById.has(id) && targetById.has(id));
    const removedIds = orderedIds.filter((id) => previousById.has(id) && !targetById.has(id));
    const updatedIds = orderedIds.filter((id) => previousById.has(id) && targetById.has(id));
    const change: InkDocumentChange = Object.freeze({
      addedIds: Object.freeze(addedIds),
      bounds: Object.freeze(
        orderedIds.map((id) =>
          Object.freeze({
            id,
            newBounds: targetById.get(id)?.bounds ?? null,
            oldBounds: previousById.get(id)?.bounds ?? null,
          }),
        ),
      ),
      commandId,
      generation,
      persistenceDelta: samePersistenceState(previous.persistence, persistence)
        ? null
        : Object.freeze({ next: persistence, previous: previous.persistence }),
      removedIds: Object.freeze(removedIds),
      selectionDelta: sameStringSequence(previous.selection, selection)
        ? null
        : Object.freeze({ next: selection, previous: previous.selection }),
      updatedIds: Object.freeze(updatedIds),
    });
    return change;
  }

  eraseStrokeAt(point: InkPoint, radius: number): string | null {
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new Error('Ink eraser radius must be positive.');
    }
    const strokeId = this.strokeIdAt(point, radius);
    if (strokeId === null) return null;
    this.eraseLogicalStrokeIds([strokeId]);
    return strokeId;
  }

  eraseStrokesInPolygon(polygon: readonly InkPoint[]): readonly string[] {
    if (polygon.length === 0) return [];
    const minimumX = Math.min(...polygon.map(({ x }) => x));
    const minimumY = Math.min(...polygon.map(({ y }) => y));
    const maximumX = Math.max(...polygon.map(({ x }) => x));
    const maximumY = Math.max(...polygon.map(({ y }) => y));
    const candidates = [
      ...this.query({
        height: maximumY - minimumY,
        width: maximumX - minimumX,
        x: minimumX,
        y: minimumY,
      }),
    ].sort((left, right) => left.order - right.order);
    const strokeIds = logicalStrokeIdsCoveredByPolygon(
      candidates.map(({ stroke }) => stroke),
      polygon,
    );
    return this.eraseLogicalStrokeIds(strokeIds);
  }

  private eraseLogicalStrokeIds(strokeIds: readonly string[]): readonly string[] {
    const ids = [...new Set(strokeIds)];
    if (ids.length === 0) return [];
    const result = this.apply({ id: `legacy-erase:${ids.join(':')}`, ids, kind: 'erase' });
    return result.kind === 'committed' ? result.change.removedIds : [];
  }

  private applyErasedLogicalStrokeIds(
    strokeIds: readonly string[],
    commandId: string,
  ): { readonly change: InkDocumentChange | null; readonly deletedIds: readonly string[] } {
    const uniqueStrokeIds = [...new Set(strokeIds)];
    if (uniqueStrokeIds.length === 0) return { change: null, deletedIds: [] };
    const removed = uniqueStrokeIds.flatMap((id) => {
      const ref = this.logicalRefsById.get(id);
      return ref === undefined ? [] : [ref];
    });
    if (removed.length === 0) return { change: null, deletedIds: [] };
    const removedIds = removed.map(({ id }) => id);
    this.boundsIndex.deleteMany(removedIds);
    for (const id of removedIds) this.logicalRefsById.delete(id);
    const previous = this.readView;
    const previousSelection = Object.freeze([...previous.selection]);
    for (const id of removedIds) this.selectedStrokeIdsSet.delete(id);
    if (this.selectedStrokeIdsSet.size === 0) this.selectionMovePreview = null;
    const selection = Object.freeze([...this.selectedStrokeIdsSet]);
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const persistence = this.effectivePersistence(snapshots);
    const generation = previous.generation + 1;
    const strokes = this.mutateOrderedStrokeProjection(removed, []);
    this.readView = Object.freeze({
      documentId: previous.documentId,
      generation,
      indexBytes: this.boundsIndex.byteSizeEstimate,
      logicalHeight: this.bounded.at(-1)?.endY ?? previous.logicalHeight,
      logicalWidth: previous.logicalWidth,
      persistence,
      selection,
      state: aggregateState(snapshots),
      strokeCount: this.logicalRefsById.size,
      strokes,
    });
    const change: InkDocumentChange = Object.freeze({
      addedIds: Object.freeze([]),
      bounds: Object.freeze(
        removed.map((ref) => Object.freeze({ id: ref.id, newBounds: null, oldBounds: ref.bounds })),
      ),
      commandId,
      generation,
      persistenceDelta: samePersistenceState(previous.persistence, persistence)
        ? null
        : Object.freeze({ next: persistence, previous: previous.persistence }),
      removedIds: Object.freeze(removedIds),
      selectionDelta: sameStringSequence(previousSelection, selection)
        ? null
        : Object.freeze({ next: selection, previous: previousSelection }),
      updatedIds: Object.freeze([]),
    });
    this.undoStack.push({
      logicalAfter: [],
      logicalBefore: removed,
    });
    this.redoStack.length = 0;
    this.publishChange(change);
    return { change, deletedIds: removedIds };
  }

  private applyMovedLogicalStrokes(
    strokeIds: readonly string[],
    dx: number,
    dy: number,
    commandId: string,
  ): InkDocumentChange | null {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw new Error('Ink selection translation must be finite.');
    }
    const uniqueIds = [...new Set(strokeIds)];
    const previous = this.readView;
    const existing = uniqueIds.flatMap((id) => {
      const ref = this.logicalRefsById.get(id);
      return ref === undefined ? [] : [ref];
    });
    if (existing.length === 0) return null;
    const minimumY = Math.min(...existing.flatMap(({ stroke }) => stroke.points.map(({ y }) => y)));
    const maximumY = Math.max(...existing.flatMap(({ stroke }) => stroke.points.map(({ y }) => y)));
    const clampedDy = clamp(dy, -minimumY, previous.logicalHeight - maximumY);
    if (dx === 0 && clampedDy === 0) return null;

    const moved = existing.map(({ stroke }) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        x: point.x + dx,
        y: point.y + clampedDy,
      })),
    }));
    const movedById = new Map(moved.map((stroke) => [stroke.id, stroke]));
    const replacementById = new Map<string, InkRenderableStrokeRef>();
    const boundsChanges: InkDocumentChange['bounds'][number][] = [];
    for (const oldRef of existing) {
      const stroke = movedById.get(oldRef.id);
      if (stroke === undefined) continue;
      const bounds = conservativeStrokeBounds(stroke);
      const ref = Object.freeze({ bounds, id: stroke.id, order: oldRef.order, stroke });
      replacementById.set(stroke.id, ref);
      this.boundsIndex.set(stroke.id, bounds, ref);
      this.logicalRefsById.set(stroke.id, ref);
      boundsChanges.push(
        Object.freeze({ id: stroke.id, newBounds: bounds, oldBounds: oldRef.bounds }),
      );
    }
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const persistence = this.effectivePersistence(snapshots);
    const generation = previous.generation + 1;
    const strokes = this.mutateOrderedStrokeProjection(existing, [...replacementById.values()]);
    this.readView = Object.freeze({
      documentId: previous.documentId,
      generation,
      indexBytes: this.boundsIndex.byteSizeEstimate,
      logicalHeight: this.bounded.at(-1)?.endY ?? previous.logicalHeight,
      logicalWidth: previous.logicalWidth,
      persistence,
      selection: previous.selection,
      state: aggregateState(snapshots),
      strokeCount: this.logicalRefsById.size,
      strokes,
    });
    const change: InkDocumentChange = Object.freeze({
      addedIds: Object.freeze([]),
      bounds: Object.freeze(boundsChanges),
      commandId,
      generation,
      persistenceDelta: samePersistenceState(previous.persistence, persistence)
        ? null
        : Object.freeze({ next: persistence, previous: previous.persistence }),
      removedIds: Object.freeze([]),
      selectionDelta: null,
      updatedIds: Object.freeze(existing.map(({ id }) => id)),
    });
    this.undoStack.push({
      logicalAfter: [...replacementById.values()],
      logicalBefore: existing,
    });
    this.redoStack.length = 0;
    this.publishChange(change);
    return change;
  }

  private applyRestyledLogicalStrokes(
    strokeIds: readonly string[],
    style: Partial<Pick<InkStroke, 'color' | 'tool' | 'width'>>,
    commandId: string,
  ): InkDocumentChange | null {
    if (style.color !== undefined && style.color.length === 0) {
      throw new Error('Ink stroke color must not be empty.');
    }
    if (style.width !== undefined && (!Number.isFinite(style.width) || style.width <= 0)) {
      throw new Error('Ink stroke width must be finite and positive.');
    }
    const existing = [...new Set(strokeIds)].flatMap((id) => {
      const ref = this.logicalRefsById.get(id);
      return ref === undefined ? [] : [ref];
    });
    if (existing.length === 0) return null;
    const changed = existing.filter(
      ({ stroke }) =>
        (style.color !== undefined && style.color !== stroke.color) ||
        (style.tool !== undefined && style.tool !== stroke.tool) ||
        (style.width !== undefined && style.width !== stroke.width),
    );
    if (changed.length === 0) return null;

    const previous = this.readView;
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const schemaVersion = highestInkSchemaVersion(snapshots);
    const replacementById = new Map<string, InkRenderableStrokeRef>();
    const bounds: InkDocumentChange['bounds'][number][] = [];
    for (const oldRef of changed) {
      const stroke = restyleInkStroke(oldRef.stroke, style, schemaVersion);
      const nextBounds = conservativeStrokeBounds(stroke);
      const ref = Object.freeze({ bounds: nextBounds, id: oldRef.id, order: oldRef.order, stroke });
      replacementById.set(ref.id, ref);
      this.logicalRefsById.set(ref.id, ref);
      this.boundsIndex.set(ref.id, ref.bounds, ref);
      bounds.push(Object.freeze({ id: ref.id, newBounds: ref.bounds, oldBounds: oldRef.bounds }));
    }
    const persistence = this.effectivePersistence(snapshots);
    const generation = previous.generation + 1;
    const strokes = this.mutateOrderedStrokeProjection(changed, [...replacementById.values()]);
    this.readView = Object.freeze({
      ...previous,
      generation,
      indexBytes: this.boundsIndex.byteSizeEstimate,
      persistence,
      state: aggregateState(snapshots),
      strokes,
    });
    const change: InkDocumentChange = Object.freeze({
      addedIds: Object.freeze([]),
      bounds: Object.freeze(bounds),
      commandId,
      generation,
      persistenceDelta: samePersistenceState(previous.persistence, persistence)
        ? null
        : Object.freeze({ next: persistence, previous: previous.persistence }),
      removedIds: Object.freeze([]),
      selectionDelta: null,
      updatedIds: Object.freeze(changed.map(({ id }) => id)),
    });
    this.undoStack.push({
      logicalAfter: [...replacementById.values()],
      logicalBefore: changed,
    });
    this.redoStack.length = 0;
    this.publishChange(change);
    return change;
  }

  async background(): Promise<void> {
    if (this.persistencePolicy === 'explicit-exit') {
      await this.persistLatestDraft();
      return;
    }
    await this.flushLiveDocument('background', this.interactionEpoch);
  }

  private async persistLatestDraft(): Promise<void> {
    if (
      this.draftStore === undefined ||
      this.liveDirtyRevision <= this.livePersistedRevision ||
      this.interactionActive
    ) {
      return;
    }
    await this.waitForInteractionIdle();
    if (this.interactionActive || this.liveDirtyRevision <= this.livePersistedRevision) return;
    try {
      const snapshot = {
        ...this.materializeColdSnapshot().surface,
        updatedAt: this.now(),
      };
      await this.draftStore.replace({
        noteKey: this.noteKey,
        revision: this.liveDirtyRevision,
        snapshot,
      });
    } catch (error) {
      this.onPersistenceIssue(error);
    }
  }

  async exit(): Promise<void> {
    if (this.persistencePolicy === 'explicit-exit' && this.snapshotStore !== undefined) {
      await this.persistExplicitSnapshot();
      return;
    }
    await this.flushLiveDocument('exit', null);
  }

  private async persistExplicitSnapshot(): Promise<void> {
    await this.waitForInteractionIdle();
    this.clearInactivityTimer();
    if (this.liveDirtyRevision <= this.livePersistedRevision) {
      this.explicitState = { kind: 'reading' };
      this.emit();
      return;
    }

    this.explicitState = { intent: 'exit', kind: 'saving' };
    this.explicitPersistence = { kind: 'saving' };
    this.emit();
    const finish = this.instrumentation.beginPersistenceSpan?.('canonical-submit');
    try {
      this.recordPersistenceWork('cold-snapshot');
      const snapshot = {
        ...this.materializeColdSnapshot().surface,
        updatedAt: this.now(),
      };
      this.recordPersistenceWork('canonical-encode');
      this.recordPersistenceWork('canonical-storage-write');
      await this.snapshotStore?.replace(snapshot);
      this.lastSavedSnapshot = snapshot;
      this.livePersistedRevision = this.liveDirtyRevision;
      this.dirtyLogicalStrokeRevision.clear();
      this.explicitSaveError = null;
      this.explicitState = { kind: 'reading' };
      this.explicitPersistence = { kind: 'saved-locally' };
      void this.draftStore?.discard(this.noteKey).catch(this.onPersistenceIssue);
      finish?.(true);
      this.emit();
    } catch (error) {
      this.explicitSaveError = error;
      this.explicitState = {
        dirty: true,
        kind: 'ink-mode',
        pendingIntent: 'exit',
        saveError: "Couldn't save Ink locally. Retry.",
      };
      this.explicitPersistence = {
        error,
        kind: 'error',
        message: "Couldn't save Ink locally. Retry.",
      };
      finish?.(false);
      this.emit();
      throw error;
    }
  }

  private async flushLiveDocument(
    intent: 'background' | 'exit',
    authorizedInteractionEpoch: number | null,
  ): Promise<void> {
    await this.waitForInteractionIdle();
    if (!this.coldSaveStillAuthorized(authorizedInteractionEpoch)) return;
    this.clearInactivityTimer();
    if (this.liveFlushPromise !== null) {
      await this.liveFlushPromise;
      if (this.liveDirtyRevision > this.livePersistedRevision) {
        await this.flushLiveDocument(intent, authorizedInteractionEpoch);
      } else if (intent === 'exit') {
        await settleAll(this.bounded.map((bounded) => bounded.session.exit()));
        this.emit();
      }
      return;
    }
    const flush = this.persistLiveDocumentUntilCurrent(intent, authorizedInteractionEpoch);
    this.liveFlushPromise = flush;
    try {
      await flush;
    } finally {
      if (this.liveFlushPromise === flush) this.liveFlushPromise = null;
    }
  }

  private async persistLiveDocumentUntilCurrent(
    intent: 'background' | 'exit',
    authorizedInteractionEpoch: number | null,
  ): Promise<void> {
    do {
      await this.waitForInteractionIdle();
      if (!this.coldSaveStillAuthorized(authorizedInteractionEpoch)) return;
      const revision = this.liveDirtyRevision;
      let persistenceRequests: Promise<void>[];
      if (revision > this.livePersistedRevision) {
        const finish = this.instrumentation.beginPersistenceSpan?.('canonical-submit');
        try {
          this.recordPersistenceWork('cold-snapshot');
          const materialized = await this.materializeLiveDocumentIntoBoundedSurfaces(
            [...this.dirtyLogicalStrokeRevision]
              .filter(([, dirtyRevision]) => dirtyRevision <= revision)
              .map(([strokeId]) => strokeId),
            () => this.coldSaveStillAuthorized(authorizedInteractionEpoch),
          );
          if (!materialized) {
            finish?.(false);
            return;
          }
          await this.waitForInteractionIdle();
          if (!this.coldSaveStillAuthorized(authorizedInteractionEpoch)) {
            finish?.(false);
            return;
          }
          this.recordPersistenceWork('canonical-encode');
          this.recordPersistenceWork('canonical-storage-write');
          persistenceRequests = this.bounded.map((bounded) =>
            intent === 'exit' ? bounded.session.exit() : bounded.session.background(),
          );
          finish?.(true);
        } catch (error) {
          finish?.(false);
          throw error;
        }
      } else {
        persistenceRequests = this.bounded.map((bounded) =>
          intent === 'exit' ? bounded.session.exit() : bounded.session.background(),
        );
      }
      await settleAll(persistenceRequests);
      this.livePersistedRevision = revision;
      for (const [strokeId, dirtyRevision] of this.dirtyLogicalStrokeRevision) {
        if (dirtyRevision <= revision) this.dirtyLogicalStrokeRevision.delete(strokeId);
      }
    } while (
      this.liveDirtyRevision > this.livePersistedRevision &&
      this.coldSaveStillAuthorized(authorizedInteractionEpoch)
    );
    if (
      this.liveDirtyRevision > this.livePersistedRevision ||
      !this.coldSaveStillAuthorized(authorizedInteractionEpoch)
    ) {
      return;
    }
    const canonicalMerge = this.adoptCanonicalAppendMerge();
    if (canonicalMerge === null) this.emit();
    else this.publishChange(canonicalMerge);
  }

  /**
   * Cold-path only: an iCloud append merge may add canonical stroke IDs unknown to this process.
   * Existing-ID divergence already fails closed in the repository, so equal ID sets preserve the
   * live objects and promoted geometry without a redraw.
   */
  private adoptCanonicalAppendMerge(): InkDocumentChange | null {
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const canonicalStrokes = compositeSurface(this.bounded, snapshots).strokes.filter(
      ({ tool }) => tool !== 'eraser',
    );
    const canonicalIds = new Set(canonicalStrokes.map(({ id }) => id));
    const liveIds = new Set(this.logicalRefsById.keys());
    if (canonicalIds.size === liveIds.size && [...canonicalIds].every((id) => liveIds.has(id))) {
      return null;
    }

    const previous = this.readView;
    const previousById = new Map(previous.strokes.map((ref) => [ref.id, ref]));
    const refs = canonicalStrokes.map((stroke, order) =>
      Object.freeze({
        bounds: conservativeStrokeBounds(stroke),
        id: stroke.id,
        order,
        stroke,
      }),
    );
    const nextById = new Map(refs.map((ref) => [ref.id, ref]));
    this.boundsIndex.deleteMany([...this.logicalRefsById.keys()]);
    this.logicalRefsById.clear();
    for (const ref of refs) {
      this.boundsIndex.set(ref.id, ref.bounds, ref);
      this.logicalRefsById.set(ref.id, ref);
    }
    this.rebuildProjectedSurfaceIndex(snapshots);
    this.invalidateOrderedStrokeProjection();
    this.nextStrokeOrder = refs.length;
    this.selectionMovePreview = null;
    this.selectionPreviewBaseRefs = null;
    for (const id of this.selectedStrokeIdsSet) {
      if (!nextById.has(id)) this.selectedStrokeIdsSet.delete(id);
    }
    const selection = Object.freeze([...this.selectedStrokeIdsSet]);
    const persistence = this.effectivePersistence(snapshots);
    const state = aggregateState(snapshots);
    const generation = previous.generation + 1;
    this.readView = Object.freeze({
      ...previous,
      generation,
      indexBytes: this.boundsIndex.byteSizeEstimate,
      persistence,
      selection,
      state,
      strokeCount: refs.length,
      strokes: this.orderedStrokeProjection,
    });
    const addedIds = refs.filter(({ id }) => !previousById.has(id)).map(({ id }) => id);
    const removedIds = previous.strokes.filter(({ id }) => !nextById.has(id)).map(({ id }) => id);
    const updatedIds = refs.filter(({ id }) => previousById.has(id)).map(({ id }) => id);
    const affectedIds = new Set([...previousById.keys(), ...nextById.keys()]);
    this.systemChangeSequence += 1;
    return Object.freeze({
      addedIds: Object.freeze(addedIds),
      bounds: Object.freeze(
        [...affectedIds].map((id) =>
          Object.freeze({
            id,
            newBounds: nextById.get(id)?.bounds ?? null,
            oldBounds: previousById.get(id)?.bounds ?? null,
          }),
        ),
      ),
      commandId: `canonical-append-merge:${this.systemChangeSequence}`,
      generation,
      persistenceDelta: samePersistenceState(previous.persistence, persistence)
        ? null
        : Object.freeze({ next: persistence, previous: previous.persistence }),
      removedIds: Object.freeze(removedIds),
      selectionDelta: sameStringSequence(previous.selection, selection)
        ? null
        : Object.freeze({ next: selection, previous: previous.selection }),
      updatedIds: Object.freeze(updatedIds),
    });
  }

  private async materializeLiveDocumentIntoBoundedSurfaces(
    dirtyLogicalStrokeIds: readonly string[],
    stillAuthorized: () => boolean,
  ): Promise<boolean> {
    if (dirtyLogicalStrokeIds.length === 0) return stillAuthorized();
    const dirty = new Set(dirtyLogicalStrokeIds);
    const active = this.bounded.filter(
      (bounded) => bounded.session.snapshot().surface.status === 'active',
    );
    const surfaceSpecs = active.map(({ endY, logicalHeight, startY, surfaceId }) => ({
      endY,
      id: surfaceId,
      logicalHeight,
      startY,
    }));
    const affectedSurfaceIds = new Set<string>();
    const addedFragmentsBySurface = new Map<string, InkStroke[]>();
    const projectedSurfaceUpdates = new Map<string, Set<string>>();
    let chunkStartedAt = this.coldWorkScheduler.now();
    let processedStrokeCount = 0;
    for (const strokeId of dirty) {
      if (!stillAuthorized()) return false;
      await this.waitForInteractionIdle();
      if (!stillAuthorized()) return false;
      for (const surfaceId of this.projectedSurfaceIdsByLogicalStrokeId.get(strokeId) ?? []) {
        affectedSurfaceIds.add(surfaceId);
      }
      const ref =
        this.selectionPreviewBaseRefs?.get(strokeId) ?? this.logicalRefsById.get(strokeId);
      if (ref === undefined) {
        projectedSurfaceUpdates.set(strokeId, new Set());
        continue;
      }
      const { stroke } = ref;
      const splitFragments = splitInkStrokeIntoSurfaceFragments({
        stroke,
        surfaces: surfaceSpecs,
      });
      const fragments =
        splitFragments.length === 1
          ? splitFragments.map((fragment) => ({
              ...fragment,
              stroke: retainSingleFragmentLogicalIdentity(stroke, fragment.stroke),
            }))
          : splitFragments;
      joinBoundedStrokeFragments(fragments, active);
      const nextSurfaceIds = new Set<string>();
      for (const fragment of fragments) {
        nextSurfaceIds.add(fragment.surfaceId);
        affectedSurfaceIds.add(fragment.surfaceId);
        const surfaceFragments = addedFragmentsBySurface.get(fragment.surfaceId);
        if (surfaceFragments === undefined) {
          addedFragmentsBySurface.set(fragment.surfaceId, [fragment.stroke]);
        } else {
          surfaceFragments.push(fragment.stroke);
        }
      }
      projectedSurfaceUpdates.set(strokeId, nextSurfaceIds);
      processedStrokeCount += 1;
      if (
        processedStrokeCount < dirty.size &&
        this.coldWorkScheduler.now() - chunkStartedAt >= COLD_WORK_CHUNK_BUDGET_MS
      ) {
        await this.coldWorkScheduler.yieldToHost();
        if (!stillAuthorized()) return false;
        await this.waitForInteractionIdle();
        if (!stillAuthorized()) return false;
        chunkStartedAt = this.coldWorkScheduler.now();
      }
    }
    if (!stillAuthorized()) return false;
    await this.waitForInteractionIdle();
    if (!stillAuthorized()) return false;
    this.mutateBounded(() => {
      for (const bounded of this.bounded) {
        if (!affectedSurfaceIds.has(bounded.surfaceId)) continue;
        const current = bounded.session.snapshot().surface.strokes;
        const erasers = current.filter(({ tool }) => tool === 'eraser');
        const visible = [
          ...current.filter(
            (stroke) => stroke.tool !== 'eraser' && !dirty.has(stroke.linkedStrokeId ?? stroke.id),
          ),
          ...(addedFragmentsBySurface.get(bounded.surfaceId) ?? []),
        ].sort(
          (left, right) =>
            (this.logicalRefsById.get(left.linkedStrokeId ?? left.id)?.order ?? 0) -
            (this.logicalRefsById.get(right.linkedStrokeId ?? right.id)?.order ?? 0),
        );
        const strokes = [...erasers, ...visible];
        if (!sameStrokeSets(strokes, current)) {
          bounded.session.replaceStrokes(strokes);
        }
      }
    });
    for (const [strokeId, surfaceIds] of projectedSurfaceUpdates) {
      if (surfaceIds.size === 0) this.projectedSurfaceIdsByLogicalStrokeId.delete(strokeId);
      else this.projectedSurfaceIdsByLogicalStrokeId.set(strokeId, surfaceIds);
    }
    return true;
  }

  private coldSaveStillAuthorized(authorizedInteractionEpoch: number | null): boolean {
    return (
      authorizedInteractionEpoch === null || authorizedInteractionEpoch === this.interactionEpoch
    );
  }

  private markDirtyChange(change: InkDocumentChange, revision: number): void {
    for (const strokeId of new Set([
      ...change.addedIds,
      ...change.removedIds,
      ...change.updatedIds,
      ...change.bounds.map(({ id }) => id),
    ])) {
      this.dirtyLogicalStrokeRevision.set(strokeId, revision);
    }
  }

  private rebuildProjectedSurfaceIndex(snapshots: readonly InkSurfaceSessionSnapshot[]): void {
    this.projectedSurfaceIdsByLogicalStrokeId.clear();
    for (const [index, snapshot] of snapshots.entries()) {
      const surfaceId = this.bounded[index]?.surfaceId;
      if (surfaceId === undefined) continue;
      for (const stroke of snapshot.surface.strokes) {
        if (stroke.tool === 'eraser') continue;
        const logicalStrokeId = stroke.linkedStrokeId ?? stroke.id;
        const surfaceIds = this.projectedSurfaceIdsByLogicalStrokeId.get(logicalStrokeId);
        if (surfaceIds === undefined) {
          this.projectedSurfaceIdsByLogicalStrokeId.set(logicalStrokeId, new Set([surfaceId]));
        } else {
          surfaceIds.add(surfaceId);
        }
      }
    }
  }

  private committedLogicalRefs(): readonly InkRenderableStrokeRef[] {
    const previewBase = this.selectionPreviewBaseRefs;
    if (previewBase === null) return this.readView.strokes;
    return this.readView.strokes.map((ref) => previewBase.get(ref.id) ?? ref);
  }

  private scheduleSustainedInactivitySave(): void {
    if (
      this.inactivityTimer !== null ||
      this.interactionActive ||
      this.liveDirtyRevision <= this.livePersistedRevision
    ) {
      return;
    }
    this.inactivityTimer = setTimeout(() => {
      this.inactivityTimer = null;
      if (this.interactionActive || this.liveDirtyRevision <= this.livePersistedRevision) return;
      void this.background().catch(() => undefined);
    }, this.inactivityMs);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer === null) return;
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private waitForInteractionIdle(): Promise<void> {
    if (!this.interactionActive) return Promise.resolve();
    return new Promise((resolve) => this.interactionIdleWaiters.add(resolve));
  }

  private recordPersistenceWork(
    kind: 'canonical-encode' | 'canonical-storage-write' | 'cold-snapshot',
  ): void {
    this.instrumentation.onPersistenceWork?.({
      kind,
      phase: this.interactionActive ? 'completion' : 'cold',
    });
  }

  private async retryPersistence(): Promise<void> {
    if (this.persistencePolicy === 'explicit-exit' && this.snapshotStore !== undefined) {
      if (this.explicitSaveError === null) {
        throw new Error('There is no failed Ink snapshot save to retry.');
      }
      await this.persistExplicitSnapshot();
      return;
    }
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
    const change = this.refreshPassiveReadState();
    if (change !== null) this.onChange(this.readView, change);
  }

  private publishChange(change: InkDocumentChange): void {
    this.onChange(this.readView, change);
  }

  private handleBoundedChange(): void {
    if (this.boundedMutationDepth > 0) return;
    this.emit();
  }

  private mutateBounded<T>(mutation: () => T): T {
    this.boundedMutationDepth += 1;
    try {
      return mutation();
    } finally {
      this.boundedMutationDepth -= 1;
    }
  }

  private refreshPassiveReadState(): InkDocumentChange | null {
    const previous = this.readView;
    const snapshots = this.bounded.map((bounded) => bounded.session.snapshot());
    const persistence = this.effectivePersistence(snapshots);
    const state =
      this.persistencePolicy === 'explicit-exit' ? this.explicitState : aggregateState(snapshots);
    const logicalHeight = this.bounded.at(-1)?.endY ?? previous.logicalHeight;
    const selection = Object.freeze([...this.selectedStrokeIdsSet]);
    if (
      samePersistenceState(previous.persistence, persistence) &&
      sameInkModeState(previous.state, state) &&
      previous.logicalHeight === logicalHeight &&
      sameStringSequence(previous.selection, selection)
    ) {
      return null;
    }
    const generation = previous.generation + 1;
    this.readView = Object.freeze({
      ...previous,
      generation,
      logicalHeight,
      persistence,
      selection,
      state,
    });
    this.systemChangeSequence += 1;
    return Object.freeze({
      addedIds: Object.freeze([]),
      bounds: Object.freeze([]),
      commandId: `system:${this.systemChangeSequence}`,
      generation,
      persistenceDelta: samePersistenceState(previous.persistence, persistence)
        ? null
        : Object.freeze({ next: persistence, previous: previous.persistence }),
      removedIds: Object.freeze([]),
      selectionDelta: sameStringSequence(previous.selection, selection)
        ? null
        : Object.freeze({ next: selection, previous: previous.selection }),
      updatedIds: Object.freeze([]),
    });
  }

  private effectivePersistence(
    snapshots: readonly InkSurfaceSessionSnapshot[],
  ): InkPersistenceState {
    if (this.persistencePolicy === 'explicit-exit') return this.explicitPersistence;
    const boundedPersistence = aggregatePersistence(snapshots);
    return boundedPersistence;
  }
}

function yieldInkColdWorkToHost(): Promise<void> {
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { readonly timeout?: number }) => number;
    scheduler?: {
      postTask?: (callback: () => void, options?: { readonly priority?: string }) => Promise<void>;
    };
  };
  if (typeof host.scheduler?.postTask === 'function') {
    return host.scheduler.postTask(() => undefined, { priority: 'background' });
  }
  return new Promise((resolve) => {
    if (typeof host.requestIdleCallback === 'function') {
      host.requestIdleCallback(resolve, { timeout: 16 });
      return;
    }
    if (typeof globalThis.MessageChannel === 'function') {
      const channel = new globalThis.MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
      return;
    }
    globalThis.queueMicrotask(resolve);
  });
}

function retainSingleFragmentLogicalIdentity(logical: InkStroke, fragment: InkStroke): InkStroke {
  const record = { ...fragment } as Record<string, unknown>;
  delete record.linkedStrokeId;
  record.id = logical.id;
  record.points = fragment.points.map((point) => {
    const canonical = { ...point } as Record<string, unknown>;
    delete canonical.fragmentBoundary;
    delete canonical.fragmentBoundaryEdge;
    delete canonical.fragmentBoundaryId;
    delete canonical.fragmentGlobalY;
    delete canonical.fragmentTraceOrder;
    return canonical as unknown as InkPoint;
  });
  return record as unknown as InkStroke;
}

/** @deprecated Use InkLiveDocument; retained temporarily while downstream adapters migrate. */
export { InkLiveDocument as InkDocumentSession };

class CoalescingInkSurfaceWriter implements InkSurfaceWriter {
  private draining = false;
  private pending = new Map<
    string,
    {
      expectedBase: InkSurfaceRecord | undefined;
      record: InkSurfaceRecord;
      readonly waiters: Array<{
        readonly reject: (reason?: unknown) => void;
        readonly resolve: (record?: InkSurfaceRecord) => void;
      }>;
    }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly target: InkSurfaceWriter,
    private readonly waitForIdle: () => Promise<void>,
  ) {}

  updateSurface(
    record: InkSurfaceRecord,
    expectedBase?: InkSurfaceRecord,
  ): Promise<InkSurfaceRecord | void> {
    return new Promise<InkSurfaceRecord | void>((resolve, reject) => {
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
        await this.waitForIdle();
        // One macrotask is a document-level commit barrier: sessions released by the previous
        // write can publish every fragment of their next logical command before this snapshot.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        // A Pencil contact may start while the barrier yields to the host. Re-check before taking
        // ownership of pending records so repository/encode work cannot overlap that contact.
        await this.waitForIdle();
        const pending = [...this.pending.values()];
        this.pending.clear();
        const records = pending.map(({ record }) => record);
        const expectedBases = pending.map(({ expectedBase }) => expectedBase);
        const hasEveryExpectedBase = expectedBases.every(
          (expectedBase): expectedBase is InkSurfaceRecord => expectedBase !== undefined,
        );
        try {
          let committed: readonly (InkSurfaceRecord | undefined)[];
          if (records.length > 1 && this.target.updateSurfacesAtomically !== undefined) {
            const batch = await this.target.updateSurfacesAtomically(
              records,
              hasEveryExpectedBase ? expectedBases : undefined,
              this.waitForIdle,
            );
            const byId = new Map(batch?.map((record) => [record.id, record]) ?? []);
            committed = records.map(({ id }) => byId.get(id));
          } else {
            const results = await Promise.all(
              records.map((record, index) =>
                this.target.updateSurface(record, expectedBases[index], this.waitForIdle),
              ),
            );
            committed = results.map((result) => result ?? undefined);
          }
          for (const [index, item] of pending.entries()) {
            for (const waiter of item.waiters) waiter.resolve(committed[index]);
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
  const strokes = joinInkStrokeSurfaceFragments(
    bounded.flatMap((item, index) => {
      const surface = snapshots[index]?.surface;
      if (surface === undefined || (surface.schemaVersion === 1 && surface.status !== 'active')) {
        return [];
      }
      return surface.strokes.map((stroke) => ({
        endY: item.endY,
        logicalHeight: item.logicalHeight,
        schemaVersion: surface.schemaVersion,
        startY: item.startY,
        stroke,
        surfaceId: item.surfaceId,
      }));
    }),
  );
  const schemaVersion = highestInkSchemaVersion(snapshots);
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
      ...(schemaVersion === 1 ? {} : { originY: 0 }),
      sourceRevision: snapshots.map(({ surface }) => surface.layout.sourceRevision).join(':'),
      themeMode: first.layout.themeMode,
    },
    noteId: first.noteId,
    revision: Math.max(...snapshots.map(({ surface }) => surface.revision)),
    schemaVersion,
    status: 'active',
    strokes,
    updatedAt:
      snapshots
        .map(({ surface }) => surface.updatedAt)
        .sort()
        .at(-1) ?? first.updatedAt,
  };
}

function translateStroke(
  stroke: InkStroke,
  delta: { readonly dx: number; readonly dy: number },
): InkStroke {
  return {
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      x: point.x + delta.dx,
      y: point.y + delta.dy,
    })),
  };
}

function restyleInkStroke(
  stroke: InkStroke,
  style: Partial<Pick<InkStroke, 'color' | 'tool' | 'width'>>,
  schemaVersion: InkSurfaceRecord['schemaVersion'],
): InkStroke {
  const restyled = { ...stroke, ...style };
  assertInkStrokeBrushMetadata(restyled, schemaVersion);
  return restyled;
}

function joinBoundedStrokeFragments(
  fragments: readonly { readonly surfaceId: string; readonly stroke: InkStroke }[],
  boundedSurfaces: readonly BoundedSession[],
): readonly InkStroke[] {
  const boundedById = new Map(boundedSurfaces.map((bounded) => [bounded.surfaceId, bounded]));
  return joinInkStrokeSurfaceFragments(
    fragments.map((fragment) => {
      const bounded = boundedById.get(fragment.surfaceId);
      if (bounded === undefined) {
        throw new Error(`Ink fragment references missing bounded surface ${fragment.surfaceId}.`);
      }
      return {
        endY: bounded.endY,
        logicalHeight: bounded.logicalHeight,
        schemaVersion: bounded.session.snapshot().surface.schemaVersion,
        startY: bounded.startY,
        stroke: fragment.stroke,
        surfaceId: bounded.surfaceId,
      };
    }),
  );
}

function highestInkSchemaVersion(
  snapshots: readonly InkSurfaceSessionSnapshot[],
): InkSurfaceRecord['schemaVersion'] {
  let highest: InkSurfaceRecord['schemaVersion'] = 1;
  for (const { surface } of snapshots) {
    if (surface.schemaVersion > highest) highest = surface.schemaVersion;
  }
  return highest;
}

function sameStrokeSets(left: readonly InkStroke[], right: readonly InkStroke[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((stroke, index) => stroke === right[index]);
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

function samePersistenceState(left: InkPersistenceState, right: InkPersistenceState): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind !== 'error' ||
    right.kind !== 'error' ||
    (left.error === right.error && left.message === right.message)
  );
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameInkModeState(left: InkModeState, right: InkModeState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'reading' || right.kind === 'reading') return true;
  if (left.kind === 'saving' || right.kind === 'saving') {
    return left.kind === 'saving' && right.kind === 'saving' && left.intent === right.intent;
  }
  return (
    left.dirty === right.dirty &&
    left.pendingIntent === right.pendingIntent &&
    left.saveError === right.saveError
  );
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

function createLazyInkStrokeProjection(
  read: () => readonly InkRenderableStrokeRef[],
): readonly InkRenderableStrokeRef[] {
  const target: InkRenderableStrokeRef[] = [];
  return new Proxy(target, {
    defineProperty: () => false,
    deleteProperty: () => false,
    get: (_target, property) => {
      const current = read();
      const value: unknown = Reflect.get(current, property, current);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => Reflect.apply(method, current, args);
    },
    has: (_target, property) => Reflect.has(read(), property),
    set: () => false,
  });
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

function conservativeStrokeBounds(stroke: InkStroke): InkLogicalRect {
  return SHARED_INK_GEOMETRY.bounds(stroke);
}

function preparedStrokeBounds(
  stroke: InkStroke,
  preparedGeometry: InkPreparedStrokeGeometry | undefined,
): InkLogicalRect {
  if (preparedGeometry === undefined) return conservativeStrokeBounds(stroke);
  assertPreparedGeometryMatchesStroke(stroke, preparedGeometry);
  return Object.freeze({ ...preparedGeometry.bounds });
}

function assertPreparedGeometryMatchesStroke(
  stroke: InkStroke,
  preparedGeometry: InkPreparedStrokeGeometry,
): void {
  const bounds = preparedGeometry.bounds;
  if (
    preparedGeometry.logicalStrokeId !== stroke.id ||
    (preparedGeometry.version ?? 'legacy-round-v1') !==
      (stroke.brushRenderVersion ?? 'legacy-round-v1') ||
    preparedGeometry.tool !== stroke.tool ||
    preparedGeometry.color !== stroke.color ||
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 0 ||
    bounds.height < 0
  ) {
    throw new Error(`Prepared Ink geometry does not match Logical Stroke ${stroke.id}.`);
  }
}
