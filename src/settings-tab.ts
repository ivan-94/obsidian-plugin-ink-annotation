import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';

import type InkstoneAnnotationsPlugin from './main';
import type { I18n } from './ui/i18n/contract';

export class InkstoneSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: InkstoneAnnotationsPlugin,
    private readonly i18n: I18n,
  ) {
    super(app, plugin);
  }

  override display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl)
      .setName(this.i18n.t('settings.diagnostics.name'))
      .setDesc(this.i18n.t('settings.diagnostics.description'))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.getSettings().diagnosticsEnabled)
          .onChange(async (enabled) => this.plugin.setDiagnosticsEnabled(enabled));
      });

    new Setting(this.containerEl)
      .setName(this.i18n.t('settings.cleanup.name'))
      .setDesc(this.i18n.t('settings.cleanup.description'))
      .addButton((button) => {
        button
          .setButtonText(this.i18n.t('settings.cleanup.button'))
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true).setButtonText(this.i18n.t('settings.cleanup.scanning'));
            try {
              const preview = await this.plugin.previewCacheCleanup();
              if (preview.eligibleTextAnnotations === 0) {
                new Notice(
                  this.i18n.t('settings.cleanup.noEligible', {
                    heldCount: preview.heldTextAnnotations,
                  }),
                );
                return;
              }
              const confirmed =
                this.containerEl.ownerDocument.defaultView?.confirm(
                  this.i18n.t('settings.cleanup.confirm', {
                    eligibleCount: preview.eligibleTextAnnotations,
                    heldCount: preview.heldTextAnnotations,
                  }),
                ) ?? false;
              if (!confirmed) return;
              button.setButtonText(this.i18n.t('settings.cleanup.cleaning'));
              const result = await this.plugin.clearCache();
              const retained = result.heldTextAnnotations + result.failedTextAnnotations;
              new Notice(
                this.i18n.t('settings.cleanup.success', {
                  removedCount: result.removedTextAnnotations,
                  retainedCount: retained,
                }),
              );
            } catch (error) {
              console.warn('[Inkstone Annotations]', error);
              new Notice(this.i18n.t('settings.cleanup.failure'));
            } finally {
              button.setDisabled(false).setButtonText(this.i18n.t('settings.cleanup.button'));
            }
          });
      });

    for (const preset of this.plugin.getSettings().stylePresets) {
      new Setting(this.containerEl)
        .setName(preset.name ?? preset.id)
        .setDesc(this.i18n.t('settings.style.stableId', { id: preset.id }))
        .addText((text) => {
          text
            .setPlaceholder(this.i18n.t('settings.style.namePlaceholder'))
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
