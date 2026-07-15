import { describe, expect, it } from 'vitest';

import { PluginRuntime } from './plugin-runtime';

describe('PluginRuntime', () => {
  it('starts, disposes registered work once, and can start again', () => {
    const runtime = new PluginRuntime();
    const disposed: string[] = [];

    runtime.start();
    runtime.registerDisposer(() => disposed.push('first run'));
    runtime.stop();
    runtime.stop();

    expect(runtime.snapshot()).toEqual({ active: false, disposerCount: 0, generation: 1 });
    expect(disposed).toEqual(['first run']);

    runtime.start();

    expect(runtime.snapshot()).toEqual({ active: true, disposerCount: 0, generation: 2 });
  });

  it('continues cleanup when one disposer fails', () => {
    const runtime = new PluginRuntime();
    const disposed: string[] = [];

    runtime.start();
    runtime.registerDisposer(() => disposed.push('last'));
    runtime.registerDisposer(() => {
      throw new Error('cleanup failed');
    });
    runtime.registerDisposer(() => disposed.push('first'));

    const errors = runtime.stop();

    expect(disposed).toEqual(['first', 'last']);
    expect(errors.map((error) => error.message)).toEqual(['cleanup failed']);
    expect(runtime.snapshot()).toEqual({ active: false, disposerCount: 0, generation: 1 });
  });
});
