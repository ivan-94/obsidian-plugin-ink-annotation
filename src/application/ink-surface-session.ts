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

export interface InkSurfaceWriter {
  updateSurface(record: InkSurfaceRecord): Promise<void>;
}

export interface InkSurfaceSessionSnapshot {
  readonly persistence: InkPersistenceState;
  readonly state: InkModeState;
  readonly surface: InkSurfaceRecord;
}

/** Owns the live vector model; persistence never blocks drawing or discards unsaved strokes. */
export class InkSurfaceSession {
  private readonly debounceMs: number;
  private dirty = false;
  private flushPromise: Promise<void> | null = null;
  private readonly now: () => string;
  private readonly onChange: (snapshot: InkSurfaceSessionSnapshot) => void;
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
  }

  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence: this.persistence,
      state: this.state,
      surface: this.surface,
    };
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
    this.persistence = { kind: 'idle' };
    if (this.state.kind === 'ink-mode') {
      this.state = reduceInkModeState(this.state, { type: 'stroke-changed' });
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
        const strokes = this.surface.strokes;
        const candidate: InkSurfaceRecord = {
          ...this.surface,
          revision: this.surface.revision + 1,
          strokes,
          updatedAt: this.now(),
        };
        this.dirty = false;
        await this.repository.updateSurface(candidate);
        // Drawing may have continued while bytes were in flight. Advance the persisted
        // revision while retaining the newer live stroke array for the next loop.
        this.surface = { ...candidate, strokes: this.surface.strokes };
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
