import {
  reduceInkModeState,
  type InkModeState,
  type InkSaveIntent,
} from '../domain/ink-mode-state';
import {
  encodeInkSurfaceRecord,
  type InkStroke,
  type InkSurfaceRecord,
} from '../domain/ink-surface';

export type InkPersistenceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved-locally' }
  | { readonly error: unknown; readonly kind: 'error'; readonly message: string };

export interface InkSurfaceWriter {
  updateSurface(record: InkSurfaceRecord, expectedBase?: InkSurfaceRecord): Promise<void>;
  updateSurfacesAtomically?(
    records: readonly InkSurfaceRecord[],
    expectedBases?: readonly InkSurfaceRecord[],
  ): Promise<void>;
}

export interface InkSurfaceSessionSnapshot {
  readonly persistence: InkPersistenceState;
  readonly state: InkModeState;
  readonly surface: InkSurfaceRecord;
}

export interface InkSurfaceRecoveryState {
  readonly expectedBase: InkSurfaceRecord;
  readonly pendingAttempt: InkSurfaceRecord | null;
  readonly record: InkSurfaceRecord;
}

/** Owns the live vector model; persistence never blocks drawing or discards unsaved strokes. */
export class InkSurfaceSession {
  private confirmedBase: InkSurfaceRecord;
  private readonly debounceMs: number;
  private dirty = false;
  private flushPromise: Promise<void> | null = null;
  private readonly now: () => string;
  private readonly onChange: (snapshot: InkSurfaceSessionSnapshot) => void;
  private pendingAttempt: InkSurfaceRecord | null = null;
  private pendingAttemptStarted = false;
  private persistence: InkPersistenceState = { kind: 'idle' };
  private readonly repository: InkSurfaceWriter;
  private state: InkModeState = { dirty: false, kind: 'ink-mode', saveError: null };
  private surface: InkSurfaceRecord;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: {
    readonly debounceMs?: number;
    readonly now?: () => string;
    readonly onChange?: (snapshot: InkSurfaceSessionSnapshot) => void;
    readonly repository: InkSurfaceWriter;
    readonly surface: InkSurfaceRecord;
  }) {
    this.debounceMs = input.debounceMs ?? 500;
    this.now = input.now ?? (() => new Date().toISOString());
    this.onChange = input.onChange ?? (() => undefined);
    this.repository = input.repository;
    this.surface = input.surface;
    this.confirmedBase = input.surface;
  }

  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence: this.persistence,
      state: this.state,
      surface: this.surface,
    };
  }

  recoveryState(): InkSurfaceRecoveryState {
    const requiresRecovery =
      (this.state.kind === 'saving' && (this.dirty || this.pendingAttempt !== null)) ||
      (this.state.kind === 'ink-mode' && (this.state.dirty || this.state.saveError !== null));
    return {
      expectedBase: this.confirmedBase,
      pendingAttempt: requiresRecovery ? this.preparePendingAttempt() : null,
      record: this.surface,
    };
  }

  /** Re-opens a retained Reading/Preview session without disturbing dirty recovery state. */
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
    if (this.surface.strokes.some((candidate) => candidate.id === stroke.id)) {
      throw new Error(`Ink stroke ID ${stroke.id} already exists in this surface.`);
    }
    this.replaceStrokes([...this.surface.strokes, stroke]);
  }

  replaceStrokes(strokes: readonly InkStroke[]): void {
    if (this.state.kind === 'reading') {
      throw new Error('Cannot change Ink strokes outside Ink Mode.');
    }
    if (new Set(strokes.map((stroke) => stroke.id)).size !== strokes.length) {
      throw new Error('Ink stroke replacement contains duplicate IDs.');
    }
    this.dirty = true;
    this.surface = { ...this.surface, strokes: [...strokes] };
    if (this.pendingAttempt !== null && !this.pendingAttemptStarted) {
      this.pendingAttempt = {
        ...this.surface,
        revision: this.confirmedBase.revision + 1,
        updatedAt: this.pendingAttempt.updatedAt,
      };
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
    this.setPersistence({ kind: 'saving' });
    try {
      do {
        const candidate = this.preparePendingAttempt();
        this.pendingAttemptStarted = true;
        this.dirty = !sameWorkingContent(this.surface, candidate);
        // Publish the exact candidate currently in flight before awaiting I/O. A version-3 local
        // checkpoint keeps both this attempt and its confirmed base, including the ambiguous case
        // where the Vault write landed before an error.
        if (!this.dirty) this.surface = candidate;
        this.emit();
        await this.repository.updateSurface(candidate, this.confirmedBase);
        this.confirmedBase = candidate;
        this.pendingAttempt = null;
        this.pendingAttemptStarted = false;
        // Drawing may have continued while bytes were in flight. Advance the persisted
        // revision while retaining the newer live stroke array for the next loop.
        this.surface = {
          ...this.surface,
          revision: candidate.revision,
          updatedAt: candidate.updatedAt,
        };
        // A synchronous recovery checkpoint must advance its base revision as soon as the
        // canonical write does, including when a newer stroke arrived while bytes were in flight.
        this.emit();
      } while (this.dirty);

      this.state = reduceInkModeState(this.state, { type: 'save-succeeded' });
      this.setPersistence({ kind: 'saved-locally' });
    } catch (error) {
      this.dirty = true;
      this.state = reduceInkModeState(this.state, {
        message: error instanceof Error ? error.message : String(error),
        type: 'save-failed',
      });
      this.setPersistence({
        error,
        kind: 'error',
        message: "Couldn't save Ink locally. Retry.",
      });
      throw error;
    }
  }

  private scheduleFlush(): void {
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
    } else if (!this.pendingAttemptStarted) {
      this.pendingAttempt = {
        ...this.surface,
        revision: this.confirmedBase.revision + 1,
        updatedAt: this.pendingAttempt.updatedAt,
      };
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

function sameWorkingContent(working: InkSurfaceRecord, candidate: InkSurfaceRecord): boolean {
  return (
    encodeInkSurfaceRecord({
      ...working,
      revision: candidate.revision,
      updatedAt: candidate.updatedAt,
    }) === encodeInkSurfaceRecord(candidate)
  );
}
