export type InkWorkLane = 'cold' | 'interactive' | 'visible';
export type InkWorkOutcome = 'cancelled' | 'completed';

interface InkQueuedWork {
  readonly interactionEpoch: number;
  readonly isCurrent: () => boolean;
  readonly lane: InkWorkLane;
  nextUnit: number;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (outcome: InkWorkOutcome) => void;
  readonly units: readonly (() => unknown)[];
  readonly unitKinds: readonly string[];
}

/** Cooperative three-lane scheduler shared by Preview, save, cache, and interactive work. */
export class InkWorkScheduler {
  private activeInteractions = 0;
  private draining = false;
  private interactionEpoch = 0;
  private readonly now: () => number;
  private readonly onUnitOverrun: (input: {
    readonly durationMs: number;
    readonly lane: Exclude<InkWorkLane, 'interactive'>;
    readonly unitKind?: string;
  }) => void;
  private readonly onUnitMeasured: (input: {
    readonly durationMs: number;
    readonly lane: Exclude<InkWorkLane, 'interactive'>;
    readonly unitKind?: string;
  }) => void;
  private readonly queues: Record<InkWorkLane, InkQueuedWork[]> = {
    cold: [],
    interactive: [],
    visible: [],
  };
  private readonly yieldToHost: (lane: Exclude<InkWorkLane, 'interactive'>) => Promise<void>;

  constructor(
    input: {
      readonly now?: () => number;
      readonly onUnitMeasured?: (input: {
        readonly durationMs: number;
        readonly lane: Exclude<InkWorkLane, 'interactive'>;
        readonly unitKind?: string;
      }) => void;
      readonly onUnitOverrun?: (input: {
        readonly durationMs: number;
        readonly lane: Exclude<InkWorkLane, 'interactive'>;
        readonly unitKind?: string;
      }) => void;
      readonly yieldToHost?: (lane: Exclude<InkWorkLane, 'interactive'>) => Promise<void>;
    } = {},
  ) {
    this.now = input.now ?? (() => performance.now());
    this.onUnitMeasured = input.onUnitMeasured ?? (() => undefined);
    this.onUnitOverrun = input.onUnitOverrun ?? (() => undefined);
    this.yieldToHost = input.yieldToHost ?? defaultInkHostYield;
  }

  beginInteraction(): () => void {
    this.interactionEpoch += 1;
    this.activeInteractions += 1;
    this.kick();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeInteractions = Math.max(0, this.activeInteractions - 1);
      this.kick();
    };
  }

  schedule(input: {
    readonly isCurrent?: () => boolean;
    readonly lane: InkWorkLane;
    readonly unitKinds?: readonly string[];
    readonly units: readonly (() => unknown)[];
  }): Promise<InkWorkOutcome> {
    if (input.units.length === 0) return Promise.resolve('completed');
    const result = new Promise<InkWorkOutcome>((resolve, reject) => {
      this.queues[input.lane].push({
        interactionEpoch: this.interactionEpoch,
        isCurrent: input.isCurrent ?? (() => true),
        lane: input.lane,
        nextUnit: 0,
        reject,
        resolve,
        units: input.units,
        unitKinds: input.unitKinds ?? [],
      });
    });
    this.kick();
    return result;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (true) {
        this.cancelStaleQueuedWork();
        const task = this.takeNext();
        if (task === null) return;
        if (task.lane !== 'interactive') {
          await this.yieldToHost(task.lane);
          if (!this.isRunnable(task)) {
            task.resolve('cancelled');
            continue;
          }
        }
        const unit = task.units[task.nextUnit];
        if (unit === undefined) {
          task.resolve('completed');
          continue;
        }
        const startedAt = this.now();
        let completion: unknown;
        try {
          completion = unit();
        } catch (error) {
          task.reject(error);
          continue;
        }
        const durationMs = this.now() - startedAt;
        if (task.lane !== 'interactive') {
          const unitKind = task.unitKinds[task.nextUnit];
          const measurement = {
            durationMs,
            lane: task.lane,
            ...(unitKind === undefined ? {} : { unitKind }),
          };
          this.onUnitMeasured(measurement);
          if (durationMs > 1) this.onUnitOverrun(measurement);
        }
        try {
          await completion;
        } catch (error) {
          task.reject(error);
          continue;
        }
        task.nextUnit += 1;
        if (!this.isRunnable(task)) {
          task.resolve('cancelled');
        } else if (task.nextUnit >= task.units.length) {
          task.resolve('completed');
        } else {
          this.queues[task.lane].push(task);
        }
      }
    } finally {
      this.draining = false;
      if (this.hasRunnableWork()) this.kick();
    }
  }

  private takeNext(): InkQueuedWork | null {
    const interactive = this.queues.interactive.shift();
    if (interactive !== undefined) return interactive;
    if (this.activeInteractions > 0) return null;
    return this.queues.visible.shift() ?? this.queues.cold.shift() ?? null;
  }

  private isRunnable(task: InkQueuedWork): boolean {
    return (
      task.isCurrent() &&
      (task.lane === 'interactive' ||
        (this.activeInteractions === 0 && task.interactionEpoch === this.interactionEpoch))
    );
  }

  private cancelStaleQueuedWork(): void {
    for (const lane of ['visible', 'cold'] as const) {
      const retained: InkQueuedWork[] = [];
      for (const task of this.queues[lane]) {
        if (this.isRunnable(task)) retained.push(task);
        else task.resolve('cancelled');
      }
      this.queues[lane] = retained;
    }
  }

  private hasRunnableWork(): boolean {
    return (
      this.queues.interactive.length > 0 ||
      (this.activeInteractions === 0 &&
        (this.queues.visible.length > 0 || this.queues.cold.length > 0))
    );
  }
}

function defaultInkHostYield(lane: 'cold' | 'visible'): Promise<void> {
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { readonly timeout?: number }) => number;
    scheduler?: {
      postTask?: (callback: () => void, options?: { readonly priority?: string }) => Promise<void>;
    };
  };
  if (typeof host.scheduler?.postTask === 'function') {
    return host.scheduler.postTask(() => undefined, {
      priority: lane === 'visible' ? 'user-visible' : 'background',
    });
  }
  if (lane === 'cold' && typeof host.requestIdleCallback === 'function') {
    return new Promise((resolve) => host.requestIdleCallback?.(resolve, { timeout: 100 }));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    requestAnimationFrame(() => channel.port2.postMessage(undefined));
  });
}
