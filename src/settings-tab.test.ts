// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const notices: string[] = [];

vi.mock('obsidian', () => {
  class PluginSettingTab {
    readonly containerEl = document.createElement('div');

    constructor(
      readonly app: unknown,
      readonly plugin: unknown,
    ) {
      Object.assign(this.containerEl, {
        empty: () => this.containerEl.replaceChildren(),
      });
    }
  }

  class Setting {
    private readonly row: HTMLElement;

    constructor(container: HTMLElement) {
      this.row = document.createElement('div');
      container.append(this.row);
    }

    setName(name: string): this {
      this.row.dataset.name = name;
      return this;
    }

    setDesc(description: string): this {
      this.row.dataset.description = description;
      return this;
    }

    addToggle(callback: (toggle: ToggleComponent) => void): this {
      callback(new ToggleComponent());
      return this;
    }

    addButton(callback: (button: ButtonComponent) => void): this {
      const element = document.createElement('button');
      this.row.append(element);
      callback(new ButtonComponent(element));
      return this;
    }
  }

  class ToggleComponent {
    setValue(): this {
      return this;
    }

    onChange(): this {
      return this;
    }
  }

  class ButtonComponent {
    constructor(private readonly element: HTMLButtonElement) {}

    setButtonText(label: string): this {
      this.element.textContent = label;
      this.element.setAttribute('aria-label', label);
      return this;
    }

    setDisabled(disabled: boolean): this {
      this.element.disabled = disabled;
      return this;
    }

    setWarning(): this {
      this.element.dataset.warning = 'true';
      return this;
    }

    onClick(callback: () => void | Promise<void>): this {
      this.element.addEventListener('click', () => void callback());
      return this;
    }
  }

  class Notice {
    constructor(message: string) {
      notices.push(message);
    }
  }

  return { Notice, PluginSettingTab, Setting };
});

import { InkstoneSettingTab } from './settings-tab';

describe('Inkstone settings cache cleanup', () => {
  beforeEach(() => {
    notices.length = 0;
    vi.restoreAllMocks();
  });

  it('previews and confirms permanent text tombstone cleanup behind the novice label', async () => {
    const plugin = {
      clearCache: vi.fn(() =>
        Promise.resolve({
          failedTextAnnotations: 0,
          heldTextAnnotations: 1,
          removedTextAnnotations: 2,
        }),
      ),
      getSettings: () => ({
        deviceId: 'device-a',
        diagnosticsEnabled: false,
        stylePresets: [],
      }),
      previewCacheCleanup: vi.fn(() =>
        Promise.resolve({
          eligibleTextAnnotations: 2,
          heldTextAnnotations: 1,
        }),
      ),
      setDiagnosticsEnabled: vi.fn(),
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tab = new InkstoneSettingTab({} as never, plugin as never);

    tab.display();
    const button = tab.containerEl.querySelector<HTMLButtonElement>(
      'button[aria-label="清理缓存"]',
    );
    expect(button).not.toBeNull();
    button?.click();

    await vi.waitFor(() => expect(plugin.clearCache).toHaveBeenCalledOnce());
    expect(plugin.previewCacheCleanup).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 条已删除的文字标注'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('无法撤销'));
    expect(notices).toContain('缓存清理完成：已永久删除 2 条文字标注；1 条因冲突或损坏而保留。');
  });
});
