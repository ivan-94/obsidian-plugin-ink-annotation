import {
  reduceInkModeState,
  type InkModeState,
  type InkSaveIntent,
} from '../domain/ink-mode-state';
import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';

export type InkPersistenceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved-locally' }
  | { readonly error: unknown; readonly kind: 'error'; readonly message: string };

export type InkColdLaneCheckpoint = () => Promise<void>;

export interface InkSurfaceWriter {
  updateSurface(
    record: InkSurfaceRecord,
    expectedBase?: InkSurfaceRecord,
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<InkSurfaceRecord | void>;
  updateSurfacesAtomically?(
    records: readonly InkSurfaceRecord[],
    expectedBases?: readonly InkSurfaceRecord[],
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<readonly InkSurfaceRecord[] | void>;
}

export interface InkSurfaceSessionSnapshot {
  readonly persistence: InkPersistenceState;
  readonly state: InkModeState;
  readonly surface: InkSurfaceRecord;
}

/** Owns the live vector model; persistence never blocks drawing or discards unsaved strokes. */
export class InkSurfaceSession {
  private appendStrokes: InkStroke[] | null = null;
  private readonly autoFlush: boolean;
  private confirmedBase: InkSurfaceRecord;
  private readonly debounceMs: number;
  private dirty = false;
  private flushPromise: Promise<void> | null = null;
  private readonly now: () => string;
  private readonly onChange: (snapshot: InkSurfaceSessionSnapshot) => void;
  private pendingAttempt: InkSurfaceRecord | null = null;
  private pendingAttemptContentVersion: number | null = null;
  private pendingAttemptStarted = false;
  private persistence: InkPersistenceState = { kind: 'idle' };
  private readonly repository: InkSurfaceWriter;
  private state: InkModeState = { dirty: false, kind: 'ink-mode', saveError: null };
  private strokeIds: Set<string>;
  private surface: InkSurfaceRecord;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private workingContentVersion = 0;

  constructor(input: {
    readonly autoFlush?: boolean;
    readonly debounceMs?: number;
    readonly now?: () => string;
    readonly onChange?: (snapshot: InkSurfaceSessionSnapshot) => void;
    readonly repository: InkSurfaceWriter;
    readonly surface: InkSurfaceRecord;
  }) {
    this.autoFlush = input.autoFlush ?? true;
    this.debounceMs = input.debounceMs ?? 500;
    this.now = input.now ?? (() => new Date().toISOString());
    this.onChange = input.onChange ?? (() => undefined);
    this.repository = input.repository;
    this.surface = input.surface;
    this.confirmedBase = input.surface;
    this.strokeIds = new Set(input.surface.strokes.map(({ id }) => id));
  }

  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence: this.persistence,
      state: this.state,
      surface: this.surface,
    };
  }

  /** Re-opens a Reading/Preview session without disturbing dirty in-memory state. */
  enter(): void {
    if (this.state.kind === 'saving') {
      throw new Error('Cannot enter Ink Mode while a local save is still running.');
    }
    if (this.state.kind === 'reading') {
      this.state = reduceInkModeState(this.state, { type: 'enter' });
      this.emit();
    }
  }

  /** Extends the live canvas model without making a passive layout observation persistable. */
  extendLogicalHeightTransiently(minimumHeight: number): boolean {
    if (!Number.isFinite(minimumHeight) || minimumHeight <= 0) {
      throw new Error('Ink surface height must be finite and positive.');
    }
    const height = Math.ceil(minimumHeight);
    if (height <= this.surface.layout.logicalHeight) return false;
    this.surface = {
      ...this.surface,
      layout: { ...this.surface.layout, logicalHeight: height },
    };
    this.emit();
    return true;
  }

  addStroke(stroke: InkStroke): void {
    if (this.state.kind === 'reading') {
      throw new Error('Cannot add an Ink stroke outside Ink Mode.');
    }
    if (this.strokeIds.has(stroke.id)) {
      throw new Error(`Ink stroke ID ${stroke.id} already exists in this surface.`);
    }
    // The first append after a canonical/replace boundary owns one copy. Consecutive live-first
    // appends then mutate that private buffer in O(1). If persistence is in flight, fork first so
    // the exact cold candidate being encoded can never change underneath I/O.
    if (this.appendStrokes !== this.surface.strokes || this.pendingAttemptStarted) {
      this.appendStrokes = [...this.surface.strokes];
    }
    this.appendStrokes.push(stroke);
    this.strokeIds.add(stroke.id);
    this.replaceWorkingStrokes(this.appendStrokes);
  }

  replaceStrokes(strokes: readonly InkStroke[]): void {
    if (this.state.kind === 'reading') {
      throw new Error('Cannot change Ink strokes outside Ink Mode.');
    }
    if (new Set(strokes.map((stroke) => stroke.id)).size !== strokes.length) {
      throw new Error('Ink stroke replacement contains duplicate IDs.');
    }
    const replacement = [...strokes];
    this.appendStrokes = replacement;
    this.strokeIds = new Set(replacement.map(({ id }) => id));
    this.replaceWorkingStrokes(replacement);
  }

  private replaceWorkingStrokes(strokes: InkStroke[]): void {
    this.workingContentVersion += 1;
    this.dirty = true;
    this.surface = { ...this.surface, strokes };
    if (this.pendingAttempt !== null && !this.pendingAttemptStarted) {
      this.pendingAttempt = {
        ...this.surface,
        revision: this.confirmedBase.revision + 1,
        updatedAt: this.pendingAttempt.updatedAt,
      };
      this.pendingAttemptContentVersion = this.workingContentVersion;
    }
    this.persistence = { kind: 'idle' };
    if (this.state.kind === 'ink-mode') {
      this.state =
        this.state.saveError === null
          ? reduceInkModeState(this.state, { type: 'stroke-changed' })
          : { ...this.state, dirty: true };
    }
    this.emit();
    if (this.state.kind === 'ink-mode') this.scheduleFlush();
  }

  background(): Promise<void> {
    return this.flush('background');
  }

  exit(): Promise<void> {
    return this.flush('exit');
  }

  async retry(): Promise<void> {
    if (this.state.kind !== 'ink-mode' || this.state.saveError === null) {
      throw new Error('There is no failed Ink save to retry.');
    }
    this.clearTimer();
    const next = reduceInkModeState(this.state, { type: 'retry-save' });
    if (next.kind !== 'saving') {
      throw new Error('Retry did not enter the expected Ink saving state.');
    }
    this.state = next;
    this.emit();
    await this.startPersistence();
  }

  private async flush(intent: InkSaveIntent): Promise<void> {
    this.clearTimer();
    if (this.flushPromise !== null) {
      await this.flushPromise;
      if (this.dirty || (intent === 'exit' && this.state.kind !== 'reading')) {
        await this.flush(intent);
      }
      return;
    }

    if (!this.dirty) {
      if (intent === 'exit' && this.state.kind === 'ink-mode') {
        this.state = reduceInkModeState(this.state, { type: 'request-exit' });
        this.emit();
      }
      return;
    }
    if (this.state.kind !== 'ink-mode') {
      throw new Error(`Cannot begin an Ink save while state is ${this.state.kind}.`);
    }
    this.state = reduceInkModeState(this.state, {
      type: intent === 'exit' ? 'request-exit' : 'background',
    });
    this.emit();
    await this.startPersistence();
  }

  private async startPersistence(): Promise<void> {
    this.flushPromise = this.persistUntilClean();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async persistUntilClean(): Promise<void> {
    // End the synchronous submit stack before canonical comparison, encoding, or repository work.
    // The Live Document has already fenced this cold task behind contact/frame idleness.
    await Promise.resolve();
    this.setPersistence({ kind: 'saving' });
    try {
      do {
        const candidate = this.preparePendingAttempt();
        const candidateContentVersion = this.pendingAttemptContentVersion;
        if (candidateContentVersion === null) {
          throw new Error('Ink canonical candidate is missing its working content version.');
        }
        this.pendingAttemptStarted = true;
        this.dirty = this.workingContentVersion !== candidateContentVersion;
        // Publish the exact cold candidate currently in flight before awaiting I/O. The in-memory
        // attempt remains stable across an ambiguous result so Retry can use the same base.
        if (!this.dirty) this.surface = candidate;
        this.emit();
        const committed =
          (await this.repository.updateSurface(candidate, this.confirmedBase)) ?? candidate;
        this.confirmedBase = committed;
        this.pendingAttempt = null;
        this.pendingAttemptContentVersion = null;
        this.pendingAttemptStarted = false;
        // Drawing may have continued while bytes were in flight. Advance the persisted
        // revision while retaining the newer live stroke array for the next loop.
        this.surface = this.dirty
          ? carryWorkingChangesForward(candidate, this.surface, committed)
          : committed;
        this.appendStrokes = null;
        this.strokeIds = new Set(this.surface.strokes.map(({ id }) => id));
        // Publish the advanced base immediately, including when a newer stroke arrived while
        // canonical bytes were in flight.
        this.emit();
      } while (this.dirty);

      this.state = reduceInkModeState(this.state, { type: 'save-succeeded' });
      this.setPersistence({ kind: 'saved-locally' });
    } catch (error) {
      this.dirty = true;
      const message = persistenceFailureMessage(error);
      this.state = reduceInkModeState(this.state, {
        message,
        type: 'save-failed',
      });
      this.setPersistence({
        error,
        kind: 'error',
        message,
      });
      throw error;
    }
  }

  private scheduleFlush(): void {
    if (!this.autoFlush) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush('background').catch(() => undefined);
    }, this.debounceMs);
  }

  private preparePendingAttempt(): InkSurfaceRecord {
    if (this.pendingAttempt === null) {
      this.pendingAttempt = {
        ...this.surface,
        revision: this.confirmedBase.revision + 1,
        updatedAt: this.now(),
      };
      this.pendingAttemptContentVersion = this.workingContentVersion;
    } else if (!this.pendingAttemptStarted) {
      this.pendingAttempt = {
        ...this.surface,
        revision: this.confirmedBase.revision + 1,
        updatedAt: this.pendingAttempt.updatedAt,
      };
      this.pendingAttemptContentVersion = this.workingContentVersion;
    }
    return this.pendingAttempt;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setPersistence(state: InkPersistenceState): void {
    this.persistence = state;
    this.emit();
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }
}

function persistenceFailureMessage(error: unknown): string {
  return error instanceof Error && error.name === 'InkSurfaceStaleBaseError'
    ? 'Another Ink version arrived. Your local strokes are safe.'
    : "Couldn't save Ink locally. Retry.";
}

function carryWorkingChangesForward(
  attempted: InkSurfaceRecord,
  working: InkSurfaceRecord,
  committed: InkSurfaceRecord,
): InkSurfaceRecord {
  const attemptedIds = new Set(attempted.strokes.map(({ id }) => id));
  const workingById = new Map(working.strokes.map((stroke) => [stroke.id, stroke]));
  const carried: InkStroke[] = [];
  const carriedIds = new Set<string>();
  for (const committedStroke of committed.strokes) {
    if (attemptedIds.has(committedStroke.id)) {
      const workingStroke = workingById.get(committedStroke.id);
      if (workingStroke !== undefined) {
        carried.push(workingStroke);
        carriedIds.add(workingStroke.id);
      }
      continue;
    }
    const collision = workingById.get(committedStroke.id);
    if (collision !== undefined && JSON.stringify(collision) !== JSON.stringify(committedStroke)) {
      throw new Error(
        `Ink stroke ${committedStroke.id} changed while a merged canonical save was in flight; local Ink is retained.`,
      );
    }
    carried.push(committedStroke);
    carriedIds.add(committedStroke.id);
  }
  for (const workingStroke of working.strokes) {
    if (!carriedIds.has(workingStroke.id)) carried.push(workingStroke);
  }
  return {
    ...working,
    layout: {
      ...working.layout,
      logicalHeight: Math.max(working.layout.logicalHeight, committed.layout.logicalHeight),
    },
    revision: committed.revision,
    strokes: carried,
    updatedAt: committed.updatedAt,
  };
}
