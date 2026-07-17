import { useLayoutEffect, useRef } from 'preact/hooks';

import type { StylePreset } from '../../domain/style-preset';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import {
  observeAnchoredElement,
  observeViewportBottomActionBar,
} from '../runtime/anchored-layer-position';
import { registerDismissibleLayer } from '../runtime/dismissible-layer';
import type {
  QuickToolbarAction,
  QuickToolbarLayout,
  QuickToolbarShowInput,
  QuickToolbarUnavailableInput,
} from '../quick-highlight-toolbar';
import type { QuickToolbarStore } from '../stores/quick-toolbar-store';

export type QuickHighlightToolbarModel =
  | ({ readonly kind: 'actions' } & QuickToolbarShowInput)
  | ({ readonly kind: 'unavailable' } & QuickToolbarUnavailableInput);

export interface QuickHighlightToolbarAppProps {
  readonly document: Document;
  readonly layout: QuickToolbarLayout;
  readonly model: QuickHighlightToolbarModel;
  readonly onAction: (action: QuickToolbarAction) => Promise<void>;
  readonly onDismiss: () => void;
  readonly onError: (error: unknown) => void;
  readonly store: QuickToolbarStore;
}

export function QuickHighlightToolbarApp({
  document,
  layout,
  model,
  onAction,
  onDismiss,
  onError,
  store,
}: QuickHighlightToolbarAppProps) {
  const toolbar = useRef<HTMLDivElement>(null);
  const errorMessage = store.errorMessage.value;
  const pendingAction = store.pendingAction.value;

  useLayoutEffect(() => {
    const element = toolbar.current;
    if (element === null) return;
    if (layout === 'mobile-action-bar') {
      return registerMobileSelectionLayer(document, element, onDismiss);
    }
    return registerDismissibleLayer(document, {
      dismissOnScroll: true,
      element,
      onDismiss: () => {
        onDismiss();
      },
    });
  }, [document, layout, onDismiss]);

  useLayoutEffect(() => {
    const element = toolbar.current;
    if (element === null) return;
    if (layout === 'mobile-action-bar') {
      return observeViewportBottomActionBar({ document, element });
    }
    return observeAnchoredElement({
      anchorRect: model.anchorRect,
      document,
      element,
      preferredPlacement: 'above',
    });
  }, [document, layout, model.anchorRect]);

  useLayoutEffect(() => {
    const element = toolbar.current;
    if (element === null) return;
    if (layout === 'mobile-action-bar') return;
    if (model.kind === 'actions') {
      element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    } else {
      element.focus({ preventScroll: true });
    }
  }, [layout, model.kind]);

  const toolbarClassName = `inkstone-quick-toolbar${
    layout === 'mobile-action-bar' ? ' inkstone-quick-toolbar--mobile-action-bar' : ''
  }`;

  if (model.kind === 'unavailable') {
    return (
      <div
        aria-label="Annotation actions"
        className={`${toolbarClassName} inkstone-quick-toolbar--unavailable`}
        data-inkstone-quick-toolbar=""
        ref={toolbar}
        role="status"
        tabIndex={-1}
      >
        <span className="inkstone-quick-toolbar__reason">{model.message}</span>
      </div>
    );
  }

  const recentStyleId = resolveRecentStyleId(model.presets, model.recentStyleId);
  const commit = async (
    action: QuickToolbarAction,
    actionKey: string,
    button: HTMLButtonElement,
  ): Promise<void> => {
    store.errorMessage.value = null;
    store.pendingAction.value = actionKey;
    try {
      await onAction(action);
      onDismiss();
    } catch (error) {
      onError(error);
      store.errorMessage.value = "Couldn't save locally. Retry.";
      store.pendingAction.value = null;
      button.focus({ preventScroll: true });
    }
  };

  return (
    <div
      aria-label="Annotation actions"
      className={toolbarClassName}
      data-inkstone-quick-toolbar=""
      onKeyDown={(event) => handleRovingFocus(event, document)}
      ref={toolbar}
      role="toolbar"
    >
      {model.presets.map((preset, index) => {
        const actionKey = `highlight:${preset.id}`;
        const label = `Highlight: ${preset.name ?? preset.id}`;
        const recent = preset.id === recentStyleId;
        return (
          <button
            aria-label={label}
            aria-pressed={recent}
            className={`inkstone-quick-toolbar__action inkstone-quick-toolbar__color-action${recent ? ' is-recent' : ''}`}
            disabled={pendingAction === actionKey}
            key={preset.id}
            onClick={(event) =>
              void commit({ kind: 'highlight', styleId: preset.id }, actionKey, event.currentTarget)
            }
            onPointerDown={(event) => event.preventDefault()}
            style={{ '--inkstone-preset-color': preset.color }}
            tabIndex={index === 0 ? 0 : -1}
            title={label}
            type="button"
          >
            <span aria-hidden="true" className="inkstone-quick-toolbar__swatch" />
          </button>
        );
      })}
      <ToolbarIconAction
        action={{ kind: 'underline', styleId: recentStyleId }}
        actionKey="underline"
        className="inkstone-quick-toolbar__underline"
        commit={commit}
        icon="underline"
        label="Underline"
        pendingAction={pendingAction}
      />
      <ToolbarIconAction
        action={{ kind: 'add-note' }}
        actionKey="add-note"
        commit={commit}
        icon="message-square-plus"
        label="Add note"
        pendingAction={pendingAction}
      />
      <ToolbarIconAction
        action={{ kind: 'more' }}
        actionKey="more"
        className="inkstone-quick-toolbar__details"
        commit={commit}
        icon="square-pen"
        label="Open annotation details"
        pendingAction={pendingAction}
      />
      {errorMessage === null ? null : (
        <span className="inkstone-quick-toolbar__error" role="alert">
          {errorMessage}
        </span>
      )}
    </div>
  );
}

function ToolbarIconAction({
  action,
  actionKey,
  className = '',
  commit,
  icon,
  label,
  pendingAction,
}: {
  readonly action: QuickToolbarAction;
  readonly actionKey: string;
  readonly className?: string;
  readonly commit: (
    action: QuickToolbarAction,
    actionKey: string,
    button: HTMLButtonElement,
  ) => Promise<void>;
  readonly icon: string;
  readonly label: string;
  readonly pendingAction: string | null;
}) {
  return (
    <button
      aria-label={label}
      className={`inkstone-quick-toolbar__action ${className}`.trim()}
      data-inkstone-icon={icon}
      disabled={pendingAction === actionKey}
      onClick={(event) => void commit(action, actionKey, event.currentTarget)}
      onPointerDown={(event) => event.preventDefault()}
      tabIndex={-1}
      title={label}
      type="button"
    >
      <ObsidianIcon icon={icon} />
    </button>
  );
}

function resolveRecentStyleId(presets: readonly StylePreset[], recentStyleId: string): string {
  const resolved = presets.some((preset) => preset.id === recentStyleId)
    ? recentStyleId
    : presets[0]?.id;
  if (resolved === undefined) {
    throw new Error('Quick annotation toolbar requires at least one style preset.');
  }
  return resolved;
}

function handleRovingFocus(event: KeyboardEvent, document: Document): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const toolbar = event.currentTarget as HTMLElement;
  const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (buttons.length === 0) return;
  event.preventDefault();
  const currentIndex = Math.max(
    0,
    buttons.findIndex((button) => button === document.activeElement),
  );
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowRight'
          ? (currentIndex + 1) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length;
  buttons.forEach((button, index) => {
    button.tabIndex = index === nextIndex ? 0 : -1;
  });
  buttons[nextIndex]?.focus({ preventScroll: true });
}

function registerMobileSelectionLayer(
  document: Document,
  element: HTMLElement,
  onDismiss: () => void,
): () => void {
  const movementThreshold = 8;
  let outsideGesture:
    | {
        readonly pointerId: number;
        readonly startX: number;
        readonly startY: number;
        moved: boolean;
      }
    | undefined;
  const NodeConstructor = document.defaultView?.Node;
  const isInside = (target: EventTarget | null): boolean =>
    NodeConstructor !== undefined && target instanceof NodeConstructor && element.contains(target);
  const handlePointerDown = (event: PointerEvent): void => {
    outsideGesture = isInside(event.target)
      ? undefined
      : {
          moved: false,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
        };
  };
  const handlePointerMove = (event: PointerEvent): void => {
    const gesture = outsideGesture;
    if (gesture === undefined || gesture.pointerId !== event.pointerId) return;
    if (
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > movementThreshold
    ) {
      gesture.moved = true;
    }
  };
  const handlePointerUp = (event: PointerEvent): void => {
    const gesture = outsideGesture;
    if (gesture === undefined || gesture.pointerId !== event.pointerId) return;
    outsideGesture = undefined;
    if (!gesture.moved && !isInside(event.target)) onDismiss();
  };
  const handlePointerCancel = (): void => {
    outsideGesture = undefined;
  };
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onDismiss();
  };
  const handleScroll = (): void => onDismiss();
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('pointercancel', handlePointerCancel, true);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('scroll', handleScroll, true);
  return () => {
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('pointerup', handlePointerUp, true);
    document.removeEventListener('pointercancel', handlePointerCancel, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('scroll', handleScroll, true);
  };
}
