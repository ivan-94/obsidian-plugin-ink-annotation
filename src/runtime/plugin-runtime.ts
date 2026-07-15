export interface PluginRuntimeSnapshot {
  readonly active: boolean;
  readonly disposerCount: number;
  readonly generation: number;
}

export class PluginRuntime {
  private active = false;
  private readonly disposers: Array<() => void> = [];
  private generation = 0;

  start(): void {
    if (this.active) {
      return;
    }

    this.active = true;
    this.generation += 1;
  }

  registerDisposer(disposer: () => void): void {
    if (!this.active) {
      throw new Error('Plugin runtime must be active before registering work.');
    }

    this.disposers.push(disposer);
  }

  stop(): readonly Error[] {
    if (!this.active) {
      return [];
    }

    this.active = false;
    const errors: Error[] = [];

    for (const disposer of this.disposers.splice(0).reverse()) {
      try {
        disposer();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return errors;
  }

  snapshot(): PluginRuntimeSnapshot {
    return {
      active: this.active,
      disposerCount: this.disposers.length,
      generation: this.generation,
    };
  }
}
