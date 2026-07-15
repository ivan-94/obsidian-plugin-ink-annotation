import { describe, expect, it } from 'vitest';

import { LocalInkToolPreferenceStore } from './local-ink-tool-preference';

describe('local Ink tool preference', () => {
  it('isolates preference by local vault/device key and fails closed on malformed data', () => {
    const storage = new MemoryStorage();
    const desktop = new LocalInkToolPreferenceStore(storage, 'Vault A', 'desktop');
    const ipad = new LocalInkToolPreferenceStore(storage, 'Vault A', 'ipad');

    desktop.save({ color: '#123456', hintShown: true, tool: 'highlighter', width: 12 });

    expect(desktop.load()).toEqual({
      color: '#123456',
      hintShown: true,
      tool: 'highlighter',
      width: 12,
    });
    expect(ipad.load()).toEqual(LocalInkToolPreferenceStore.DEFAULT);
    storage.setItem(ipad.key, '{');
    expect(ipad.load()).toEqual(LocalInkToolPreferenceStore.DEFAULT);
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
