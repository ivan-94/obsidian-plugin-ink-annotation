import { DEFAULT_STYLE_PRESETS, StylePresetCatalog, type StylePreset } from './domain/style-preset';

export interface InkstoneSettings {
  readonly deviceId: string;
  readonly diagnosticsEnabled: boolean;
  readonly stylePresets: readonly StylePreset[];
}

export const DEFAULT_SETTINGS: InkstoneSettings = Object.freeze({
  deviceId: '',
  diagnosticsEnabled: false,
  stylePresets: DEFAULT_STYLE_PRESETS,
});

export function parseSettings(value: unknown): InkstoneSettings {
  if (!isRecord(value)) {
    return DEFAULT_SETTINGS;
  }

  const diagnosticsEnabled = value.diagnosticsEnabled;

  if (typeof diagnosticsEnabled !== 'boolean') {
    return DEFAULT_SETTINGS;
  }

  return {
    deviceId: typeof value.deviceId === 'string' ? value.deviceId : '',
    diagnosticsEnabled,
    stylePresets: parseStylePresets(value.stylePresets),
  };
}

export function ensureDeviceId(
  settings: InkstoneSettings,
  createId: () => string,
): InkstoneSettings {
  if (settings.deviceId.length > 0) {
    return settings;
  }
  const deviceId = createId();
  if (deviceId.length === 0) {
    throw new Error('Generated device ID must not be empty.');
  }
  return { ...settings, deviceId };
}

function parseStylePresets(value: unknown): readonly StylePreset[] {
  if (!Array.isArray(value)) {
    return DEFAULT_STYLE_PRESETS;
  }
  const presets: StylePreset[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.color !== 'string' ||
      (candidate.name !== undefined && typeof candidate.name !== 'string')
    ) {
      return DEFAULT_STYLE_PRESETS;
    }
    presets.push({
      color: candidate.color,
      id: candidate.id,
      ...(candidate.name === undefined ? {} : { name: candidate.name }),
    });
  }
  try {
    return new StylePresetCatalog(presets).list();
  } catch {
    return DEFAULT_STYLE_PRESETS;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
