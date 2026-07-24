import type { StylePreset } from '../domain/style-preset';
import {
  QuickHighlightToolbarApp,
  type QuickHighlightToolbarAppProps,
  type QuickHighlightToolbarModel,
} from './floating/quick-highlight-toolbar-app';
import type { I18n } from './i18n/contract';
import { createI18n } from './i18n/create-i18n';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import { createQuickToolbarStore, resetQuickToolbarStore } from './stores/quick-toolbar-store';

export type QuickToolbarAction =
  | { readonly kind: 'add-note' }
  | { readonly kind: 'highlight'; readonly styleId: string }
  | { readonly kind: 'more' }
  | { readonly kind: 'underline'; readonly styleId: string };

export type QuickToolbarLayout = 'anchored' | 'mobile-action-bar';

export interface QuickToolbarShowInput {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly presets: readonly StylePreset[];
  readonly recentStyleId: string;
}

export interface QuickToolbarUnavailableInput {
  readonly action?: {
    readonly label: string;
    readonly onActivate: () => Promise<void> | void;
  };
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly message: string;
}

export class QuickHighlightToolbar {
  private readonly document: Document;
  private host: HTMLDivElement | null = null;
  private readonly island: UiIsland<QuickHighlightToolbarAppProps>;
  private readonly onAction: (action: QuickToolbarAction) => Promise<void>;
  private readonly onDismiss: () => void;
  private readonly onError: (error: unknown) => void;
  private readonly layout: QuickToolbarLayout;
  private readonly store = createQuickToolbarStore();

  constructor(input: {
    readonly document: Document;
    readonly i18n?: I18n;
    readonly layout?: QuickToolbarLayout;
    readonly onAction: (action: QuickToolbarAction) => Promise<void>;
    readonly onDismiss: () => void;
    readonly onError?: (error: unknown) => void;
  }) {
    this.document = input.document;
    this.island = createPreactIsland(QuickHighlightToolbarApp, {
      i18n: input.i18n ?? createI18n('en'),
    });
    this.layout = input.layout ?? 'anchored';
    this.onAction = input.onAction;
    this.onDismiss = input.onDismiss;
    this.onError = input.onError ?? (() => undefined);
  }

  show(input: QuickToolbarShowInput): void {
    this.mount({ kind: 'actions', ...input });
  }

  showUnavailable(input: QuickToolbarUnavailableInput): void {
    this.mount({ kind: 'unavailable', ...input });
  }

  close(notify = true): void {
    if (this.host === null) return;
    this.island.unmount();
    this.host.remove();
    this.host = null;
    if (notify) this.onDismiss();
  }

  private mount(model: QuickHighlightToolbarModel): void {
    this.close(false);
    resetQuickToolbarStore(this.store);
    const host = this.document.createElement('div');
    host.dataset.inkstoneQuickToolbarHost = '';
    this.document.body.append(host);
    this.host = host;
    this.island.mount(host, {
      document: this.document,
      layout: this.layout,
      model,
      onAction: this.onAction,
      onDismiss: () => this.close(true),
      onError: this.onError,
      store: this.store,
    });
  }
}
