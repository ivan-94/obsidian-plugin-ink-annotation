import { describe, expect, it } from 'vitest';

import { LocalInkToolPreferenceStore, resolveInkToolStyles } from './local-ink-tool-preference';

describe('local Ink tool preference', () => {
  it('isolates preference by local vault/device key and fails closed on malformed data', () => {
    const storage = new MemoryStorage();
    const desktop = new LocalInkToolPreferenceStore(storage, 'Vault A', 'desktop');
    const ipad = new LocalInkToolPreferenceStore(storage, 'Vault A', 'ipad');

    desktop.save({
      color: '#123456',
      hintShown: true,
      interaction: 'select',
      multiple: true,
      optionsVisible: true,
      tool: 'highlighter',
      toolbarPosition: { left: 24, top: 48 },
      width: 12,
      zoomMode: 'manual',
      zoomScale: 0.7,
    });

    expect(desktop.load()).toEqual({
      color: '#123456',
      hintShown: true,
      interaction: 'select',
      multiple: true,
      optionsVisible: true,
      tool: 'highlighter',
      toolbarPosition: { left: 24, top: 48 },
      width: 12,
      zoomMode: 'manual',
      zoomScale: 0.7,
    });
    expect(ipad.load()).toEqual(LocalInkToolPreferenceStore.DEFAULT);
    storage.setItem(
      ipad.key,
      JSON.stringify({
        color: '#123456',
        hintShown: true,
        tool: 'pen',
        width: 4,
      }),
    );
    expect(ipad.load()).toEqual({
      color: '#123456',
      hintShown: true,
      tool: 'pen',
      width: 4,
    });
    storage.setItem(ipad.key, '{');
    expect(ipad.load()).toEqual(LocalInkToolPreferenceStore.DEFAULT);
    storage.setItem(
      ipad.key,
      JSON.stringify({
        color: '#123456',
        hintShown: true,
        tool: 'pen',
        toolbarPosition: { left: 'outside', top: 20 },
        width: 4,
      }),
    );
    expect(ipad.load()).toEqual(LocalInkToolPreferenceStore.DEFAULT);
  });

  it('round-trips independent color and width slots for every drawing tool', () => {
    const storage = new MemoryStorage();
    const store = new LocalInkToolPreferenceStore(storage, 'Vault A', 'ipad');
    const preference = {
      ...LocalInkToolPreferenceStore.DEFAULT,
      color: '#445566',
      tool: 'highlighter' as const,
      toolStyles: {
        eraser: { color: '#778899', width: 2 },
        highlighter: { color: '#445566', width: 16 },
        pen: { color: '#112233', width: 8 },
      },
      width: 16,
    };

    store.save(preference);

    expect(store.load()).toEqual(preference);
  });

  it('derives independent slots from a legacy shared-style preference', () => {
    expect(
      resolveInkToolStyles({
        color: '#123456',
        hintShown: true,
        tool: 'highlighter',
        width: 8,
      }),
    ).toEqual({
      eraser: { color: '#123456', width: 16 },
      highlighter: { color: '#123456', width: 8 },
      pen: { color: '#123456', width: 4 },
    });
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
