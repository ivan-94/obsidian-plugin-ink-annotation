import { PluginSettingTab, Setting, type App } from 'obsidian';

import type InkstoneAnnotationsPlugin from './main';

export class InkstoneSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: InkstoneAnnotationsPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName('Show Ink preview by default')
      .setDesc(
        'Open notes with saved Ink in a read-only fixed-width preview. Turn this off to keep Obsidian Reading View raw until Ink editing starts.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.getSettings().showInkPreviewByDefault)
          .onChange(async (enabled) => this.plugin.setShowInkPreviewByDefault(enabled));
      });

    new Setting(this.containerEl)
      .setName('Diagnostics')
      .setDesc(
        'Keep local timing samples. Annotation text, ink points, and file paths are never logged.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.getSettings().diagnosticsEnabled)
          .onChange(async (enabled) => this.plugin.setDiagnosticsEnabled(enabled));
      });

    new Setting(this.containerEl)
      .setName('Ink presentation renderer')
      .setDesc(
        'Main Canvas 2D is the verified fallback. Worker OffscreenCanvas 2D is an experimental S27 bake-off Adapter and applies after reloading the plugin.',
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption('main-canvas-2d', 'Main Canvas 2D')
          .addOption('worker-offscreen-2d', 'Worker OffscreenCanvas 2D (experimental)')
          .setValue(this.plugin.getSettings().inkPresentationAdapter)
          .onChange(async (value) =>
            this.plugin.setInkPresentationAdapter(
              value === 'worker-offscreen-2d' ? 'worker-offscreen-2d' : 'main-canvas-2d',
            ),
          );
      });

    for (const preset of this.plugin.getSettings().stylePresets) {
      new Setting(this.containerEl)
        .setName(preset.name ?? preset.id)
        .setDesc(`Stable style ID: ${preset.id}`)
        .addText((text) => {
          text
            .setPlaceholder('Preset name')
            .setValue(preset.name ?? '')
            .onChange(async (name) => this.plugin.updateStylePreset(preset.id, { name }));
        })
        .addColorPicker((picker) => {
          picker
            .setValue(preset.color)
            .onChange(async (color) => this.plugin.updateStylePreset(preset.id, { color }));
        });
    }
  }
}
