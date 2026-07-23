import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';

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

    new Setting(this.containerEl)
      .setName('清理缓存')
      .setDesc(
        '永久清理已删除的高亮和文字笔记。冲突或损坏的数据会保留；Ink 与截图标注暂不包含在本次清理中。',
      )
      .addButton((button) => {
        button
          .setButtonText('清理缓存')
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true).setButtonText('正在扫描…');
            try {
              const preview = await this.plugin.previewCacheCleanup();
              if (preview.eligibleTextAnnotations === 0) {
                new Notice(
                  preview.heldTextAnnotations === 0
                    ? '没有可清理的文字标注缓存。'
                    : `${preview.heldTextAnnotations} 条文字标注因冲突或损坏而保留。`,
                );
                return;
              }
              const held =
                preview.heldTextAnnotations === 0
                  ? ''
                  : `\n\n另有 ${preview.heldTextAnnotations} 条冲突或损坏数据会被保留。`;
              const confirmed =
                this.containerEl.ownerDocument.defaultView?.confirm(
                  `将永久删除 ${preview.eligibleTextAnnotations} 条已删除的文字标注。此操作无法撤销。${held}`,
                ) ?? false;
              if (!confirmed) return;
              button.setButtonText('正在清理…');
              const result = await this.plugin.clearCache();
              const retained = result.heldTextAnnotations + result.failedTextAnnotations;
              new Notice(
                `缓存清理完成：已永久删除 ${result.removedTextAnnotations} 条文字标注；${retained} 条因冲突或损坏而保留。`,
              );
            } catch (error) {
              new Notice(
                error instanceof Error ? `缓存清理失败：${error.message}` : '缓存清理失败。',
              );
            } finally {
              button.setDisabled(false).setButtonText('清理缓存');
            }
          });
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
