import { describe, expect, it } from 'vitest';

import { DEFAULT_STYLE_PRESETS } from './domain/style-preset';
import { DEFAULT_SETTINGS, ensureDeviceId, parseSettings } from './settings';

describe('parseSettings', () => {
  it('fails closed when persisted diagnostics settings are missing or malformed', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ diagnosticsEnabled: 'yes' })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ diagnosticsEnabled: true, ignored: 'value' })).toEqual({
      deviceId: '',
      diagnosticsEnabled: true,
      stylePresets: DEFAULT_STYLE_PRESETS,
    });
  });

  it('ignores retired document Ink settings during upgrade', () => {
    expect(
      parseSettings({
        diagnosticsEnabled: false,
        inkPresentationAdapter: 'worker-offscreen-2d',
        showInkPreviewByDefault: false,
      }),
    ).toEqual({
      deviceId: '',
      diagnosticsEnabled: false,
      stylePresets: DEFAULT_STYLE_PRESETS,
    });
  });

  it('restores valid renamed/recolored presets while rejecting malformed catalogs', () => {
    const customized = DEFAULT_STYLE_PRESETS.map((preset) =>
      preset.id === 'highlight-sky' ? { ...preset, color: '#1264a3', name: 'Focus' } : preset,
    );

    expect(
      parseSettings({ diagnosticsEnabled: false, stylePresets: customized }).stylePresets,
    ).toEqual(customized);
    expect(
      parseSettings({
        diagnosticsEnabled: false,
        stylePresets: [{ color: '', id: 'broken', name: 'Broken' }],
      }).stylePresets,
    ).toEqual(DEFAULT_STYLE_PRESETS);
  });

  it('preserves a stable device ID and creates one only for legacy settings', () => {
    const legacy = parseSettings({ diagnosticsEnabled: false });
    expect(ensureDeviceId(legacy, () => 'generated-device')).toEqual({
      ...legacy,
      deviceId: 'generated-device',
    });

    const persisted = parseSettings({
      deviceId: 'persisted-device',
      diagnosticsEnabled: false,
    });
    expect(ensureDeviceId(persisted, () => 'must-not-be-used').deviceId).toBe('persisted-device');
  });
});
