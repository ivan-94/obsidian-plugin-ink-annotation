export interface StylePreset {
  readonly color: string;
  readonly id: string;
  readonly name?: string;
}

export const DEFAULT_STYLE_PRESETS: readonly StylePreset[] = Object.freeze([
  { color: '#f0c94b', id: 'highlight-sun', name: 'Sun' },
  { color: '#72c7a5', id: 'highlight-mint', name: 'Mint' },
  { color: '#71b7e6', id: 'highlight-sky', name: 'Sky' },
  { color: '#e88da2', id: 'highlight-rose', name: 'Rose' },
  { color: '#ac92e8', id: 'highlight-violet', name: 'Violet' },
]);

export class StylePresetCatalog {
  private readonly presets: Map<string, StylePreset>;

  constructor(presets: readonly StylePreset[]) {
    if (presets.length === 0 || presets.length > 5) {
      throw new Error('A style catalog must contain between one and five presets.');
    }
    this.presets = new Map();
    for (const preset of presets) {
      if (this.presets.has(preset.id) || preset.id.length === 0 || preset.color.length === 0) {
        throw new Error('Style preset IDs and colors must be non-empty and IDs must be unique.');
      }
      this.presets.set(preset.id, clonePreset(preset));
    }
  }

  get(id: string): StylePreset | null {
    const preset = this.presets.get(id);
    return preset === undefined ? null : clonePreset(preset);
  }

  list(): readonly StylePreset[] {
    return [...this.presets.values()].map(clonePreset);
  }

  update(id: string, patch: { readonly color?: string; readonly name?: string }): StylePreset {
    const current = this.presets.get(id);
    if (current === undefined) {
      throw new Error(`Unknown style preset ${id}.`);
    }
    const updated: StylePreset = {
      color: patch.color ?? current.color,
      id: current.id,
      ...(patch.name === undefined
        ? current.name === undefined
          ? {}
          : { name: current.name }
        : { name: patch.name }),
    };
    this.presets.set(id, updated);
    return clonePreset(updated);
  }
}

function clonePreset(preset: StylePreset): StylePreset {
  return {
    color: preset.color,
    id: preset.id,
    ...(preset.name === undefined ? {} : { name: preset.name }),
  };
}
