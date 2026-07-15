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
      .setName('Diagnostics')
      .setDesc(
        'Keep local timing samples. Annotation text, ink points, and file paths are never logged.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.getSettings().diagnosticsEnabled)
          .onChange(async (enabled) => this.plugin.setDiagnosticsEnabled(enabled));
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
