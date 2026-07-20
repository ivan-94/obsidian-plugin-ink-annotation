import type { InkStroke } from '../domain/ink-surface';

export interface InkToolStyle {
  readonly color: string;
  readonly width: number;
}

export type InkToolStyles = Readonly<Record<InkStroke['tool'], InkToolStyle>>;

export interface InkToolPreference {
  readonly color: string;
  readonly hintShown: boolean;
  readonly interaction?: 'draw' | 'select';
  readonly multiple?: boolean;
  readonly optionsVisible?: boolean;
  readonly tool: InkStroke['tool'];
  readonly toolbarPosition?: {
    readonly left: number;
    readonly top: number;
  };
  readonly toolStyles?: InkToolStyles;
  readonly width: number;
  readonly zoomMode?: 'fit' | 'manual';
  readonly zoomScale?: number;
}

/** Device-local by construction: browser Storage is not part of the iCloud Vault sidecar. */
export class LocalInkToolPreferenceStore {
  static readonly DEFAULT_TOOL_STYLES: InkToolStyles = Object.freeze({
    eraser: Object.freeze({ color: '#4f46d8', width: 16 }),
    highlighter: Object.freeze({ color: '#4f46d8', width: 12 }),
    pen: Object.freeze({ color: '#4f46d8', width: 4 }),
  });

  static readonly DEFAULT: InkToolPreference = Object.freeze({
    color: '#4f46d8',
    hintShown: false,
    interaction: 'draw',
    multiple: false,
    optionsVisible: false,
    tool: 'pen',
    toolStyles: LocalInkToolPreferenceStore.DEFAULT_TOOL_STYLES,
    width: 4,
    zoomMode: 'fit',
    zoomScale: 1,
  });

  readonly key: string;
  private persistentWritesAvailable = true;
  private volatilePreference: InkToolPreference | null = null;

  constructor(
    private readonly storage: Storage,
    vaultName: string,
    deviceId: string,
  ) {
    this.key = `inkstone:${encodeURIComponent(vaultName)}:${encodeURIComponent(deviceId)}:ink-tool-v1`;
  }

  load(): InkToolPreference {
    if (this.volatilePreference !== null) return this.volatilePreference;
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
    this.volatilePreference = preference;
    if (!this.persistentWritesAvailable) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(preference));
    } catch {
      // Tool preferences are non-canonical. A full legacy Recovery keyspace must not turn a
      // harmless color/width update into a repeating quota Notice or block Ink input.
      this.persistentWritesAvailable = false;
    }
  }
}

export function resolveInkToolStyles(preference: InkToolPreference): InkToolStyles {
  if (preference.toolStyles !== undefined) return preference.toolStyles;
  const styles: Record<InkStroke['tool'], InkToolStyle> = {
    eraser: { color: preference.color, width: 16 },
    highlighter: { color: preference.color, width: 12 },
    pen: { color: preference.color, width: 4 },
  };
  styles[preference.tool] = { color: preference.color, width: preference.width };
  return styles;
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
    typeof value.hintShown === 'boolean' &&
    (!('interaction' in value) || value.interaction === 'draw' || value.interaction === 'select') &&
    (!('multiple' in value) || typeof value.multiple === 'boolean') &&
    (!('optionsVisible' in value) || typeof value.optionsVisible === 'boolean') &&
    (!('toolbarPosition' in value) || isToolbarPosition(value.toolbarPosition)) &&
    (!('toolStyles' in value) || isToolStyles(value.toolStyles)) &&
    (!('zoomMode' in value) || value.zoomMode === 'fit' || value.zoomMode === 'manual') &&
    (!('zoomScale' in value) ||
      (typeof value.zoomScale === 'number' &&
        Number.isFinite(value.zoomScale) &&
        value.zoomScale >= 0.5 &&
        value.zoomScale <= 2))
  );
}

function isToolStyles(value: unknown): value is InkToolStyles {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pen' in value &&
    isToolStyle(value.pen) &&
    'highlighter' in value &&
    isToolStyle(value.highlighter) &&
    'eraser' in value &&
    isToolStyle(value.eraser)
  );
}

function isToolStyle(value: unknown): value is InkToolStyle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'color' in value &&
    typeof value.color === 'string' &&
    /^#[0-9a-f]{6}$/iu.test(value.color) &&
    'width' in value &&
    typeof value.width === 'number' &&
    Number.isFinite(value.width) &&
    value.width >= 1 &&
    value.width <= 64
  );
}

function isToolbarPosition(
  value: unknown,
): value is NonNullable<InkToolPreference['toolbarPosition']> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'left' in value &&
    typeof value.left === 'number' &&
    Number.isFinite(value.left) &&
    'top' in value &&
    typeof value.top === 'number' &&
    Number.isFinite(value.top)
  );
}
