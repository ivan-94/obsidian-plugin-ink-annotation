import type { InkStroke } from '../domain/ink-surface';

export interface InkToolPreference {
  readonly color: string;
  readonly hintShown: boolean;
  readonly tool: InkStroke['tool'];
  readonly width: number;
}

/** Device-local by construction: browser Storage is not part of the iCloud Vault sidecar. */
export class LocalInkToolPreferenceStore {
  static readonly DEFAULT: InkToolPreference = Object.freeze({
    color: '#4f46d8',
    hintShown: false,
    tool: 'pen',
    width: 4,
  });

  readonly key: string;

  constructor(
    private readonly storage: Storage,
    vaultName: string,
    deviceId: string,
  ) {
    this.key = `inkstone:${encodeURIComponent(vaultName)}:${encodeURIComponent(deviceId)}:ink-tool-v1`;
  }

  load(): InkToolPreference {
    const contents = this.storage.getItem(this.key);
    if (contents === null) return LocalInkToolPreferenceStore.DEFAULT;
    try {
      const value: unknown = JSON.parse(contents);
      return isPreference(value) ? value : LocalInkToolPreferenceStore.DEFAULT;
    } catch {
      return LocalInkToolPreferenceStore.DEFAULT;
    }
  }

  save(preference: InkToolPreference): void {
    if (!isPreference(preference)) throw new Error('Ink tool preference is invalid.');
    this.storage.setItem(this.key, JSON.stringify(preference));
  }
}

function isPreference(value: unknown): value is InkToolPreference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tool' in value &&
    (value.tool === 'pen' || value.tool === 'highlighter' || value.tool === 'eraser') &&
    'color' in value &&
    typeof value.color === 'string' &&
    /^#[0-9a-f]{6}$/iu.test(value.color) &&
    'width' in value &&
    typeof value.width === 'number' &&
    Number.isFinite(value.width) &&
    value.width >= 1 &&
    value.width <= 64 &&
    'hintShown' in value &&
    typeof value.hintShown === 'boolean'
  );
}
