interface TrailingTaskState {
  dirty: boolean;
  promise: Promise<void>;
  task: () => Promise<void>;
}

/** Runs at most one task per key and collapses any in-flight burst into one trailing pass. */
export class KeyedTrailingTaskQueue<Key> {
  private readonly states = new Map<Key, TrailingTaskState>();

  schedule(key: Key, task: () => Promise<void>): Promise<void> {
    const existing = this.states.get(key);
    if (existing !== undefined) {
      existing.dirty = true;
      existing.task = task;
      return existing.promise;
    }

    const state: TrailingTaskState = {
      dirty: false,
      promise: Promise.resolve(),
      task,
    };
    const promise = Promise.resolve()
      .then(async () => {
        do {
          state.dirty = false;
          await state.task();
        } while (state.dirty);
      })
      .finally(() => {
        if (this.states.get(key) === state) this.states.delete(key);
      });
    state.promise = promise;
    this.states.set(key, state);
    return promise;
  }

  clear(): void {
    this.states.clear();
  }
}
