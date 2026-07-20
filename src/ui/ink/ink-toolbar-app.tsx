import type { Signal } from '@preact/signals';

import type { InkStroke } from '../../domain/ink-surface';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import type { InkToolbarState } from '../stores/ink-toolbar-store';

export interface InkToolbarAppProps {
  readonly onColor: (color: string) => void;
  readonly onDeleteSelection: () => void;
  readonly onDone: () => void;
  readonly onDragKeyDown: (event: KeyboardEvent) => void;
  readonly onDragStart: (event: PointerEvent) => void;
  readonly onExportUnsaved: () => void;
  readonly onRedo: () => void;
  readonly onRetry: () => void;
  readonly onSelectMove: () => void;
  readonly onToggleMultiple: () => void;
  readonly onToggleOptions: () => void;
  readonly onTool: (tool: InkStroke['tool']) => void;
  readonly onUndo: () => void;
  readonly onWidth: (width: number) => void;
  readonly onZoomFit: () => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly state: Signal<InkToolbarState>;
}

export function InkToolbarApp(props: InkToolbarAppProps) {
  const state = props.state.value;
  const position = state.position;
  return (
    <div
      aria-label="Ink tools"
      className="inkstone-ink-controls"
      data-inkstone-ink-dragged={position?.dragged === true ? 'true' : undefined}
      data-inkstone-ink-toolbar-app=""
      role="toolbar"
      style={{
        ...(position === null
          ? {}
          : {
              bottom: 'auto',
              left: `${position.left}px`,
              right: 'auto',
              top: `${position.top}px`,
            }),
        display: state.active ? 'flex' : 'none',
      }}
    >
      <ToolbarButton
        className={`inkstone-ink-controls__drag-handle${state.dragging ? ' is-dragging' : ''}`}
        data={{ inkstoneInkDragHandle: 'true' }}
        disabled={state.committing}
        icon="grip-vertical"
        label="Move Ink toolbar"
        onKeyDown={props.onDragKeyDown}
        onPointerDown={props.onDragStart}
      />
      <ToolbarButton
        className="inkstone-ink-controls__done"
        data={{ inkstoneInkDone: 'true' }}
        disabled={state.committing}
        hidden={!state.active}
        icon="circle-check"
        label="Exit Ink Mode"
        onClick={props.onDone}
      />
      {(['pen', 'highlighter', 'eraser'] as const).map((tool) => (
        <ToolbarButton
          data={{ inkstoneInkTool: tool }}
          disabled={state.committing}
          icon={tool === 'pen' ? 'pen-line' : tool === 'highlighter' ? 'highlighter' : 'eraser'}
          key={tool}
          label={
            tool === 'pen'
              ? 'Pen'
              : tool === 'highlighter'
                ? 'Highlighter'
                : 'Stroke eraser: tap a stroke or circle strokes'
          }
          onClick={(event) => {
            const toolbar = (event.currentTarget as HTMLElement).closest('[role="toolbar"]');
            for (const button of toolbar?.querySelectorAll<HTMLElement>(
              '[data-inkstone-ink-tool]',
            ) ?? []) {
              button.setAttribute('aria-pressed', String(button.dataset.inkstoneInkTool === tool));
            }
            props.onTool(tool);
          }}
          pressed={state.interaction === 'draw' && state.tool === tool}
        />
      ))}
      <ToolbarButton
        data={{ inkstoneInkSelectMove: 'true' }}
        disabled={state.committing}
        icon="move"
        label="Select and move Ink"
        onClick={props.onSelectMove}
        pressed={state.interaction === 'select'}
      />
      <ToolbarButton
        data={{ inkstoneInkMultiple: 'true' }}
        disabled={state.committing}
        hidden={state.interaction !== 'select'}
        icon="list-checks"
        label="Select multiple Ink strokes"
        onClick={props.onToggleMultiple}
        pressed={state.multiple}
      />
      <ToolbarButton
        data={{ inkstoneInkDeleteSelection: 'true' }}
        disabled={state.committing}
        hidden={state.interaction !== 'select' || state.selectedCount === 0}
        icon="trash-2"
        label={`Delete ${state.selectedCount} selected Ink stroke${state.selectedCount === 1 ? '' : 's'}`}
        onClick={props.onDeleteSelection}
      />
      <input
        aria-label="Ink color"
        data-inkstone-ink-color="true"
        disabled={state.committing}
        hidden={!state.optionsVisible}
        onInput={(event) => props.onColor(event.currentTarget.value)}
        type="color"
        value={state.color}
      />
      <div
        aria-label="Ink width"
        className="inkstone-ink-controls__width"
        data-inkstone-ink-width-control="true"
        hidden={!state.optionsVisible}
        title={`Ink width: ${state.width} px`}
      >
        <span
          aria-hidden="true"
          className="inkstone-ink-controls__width-preview"
          style={{ height: `${Math.min(state.width, 8)}px` }}
        />
        <span aria-hidden="true" className="inkstone-ink-controls__width-value">
          {state.width}px
        </span>
        <ObsidianIcon icon="chevron-down" />
        <select
          aria-label="Ink width"
          data-inkstone-ink-width-select="true"
          disabled={state.committing}
          onChange={(event) => props.onWidth(Number(event.currentTarget.value))}
          value={state.width}
        >
          {widthOptions(state.width).map((width) => (
            <option key={width} value={width}>
              {width} px
            </option>
          ))}
        </select>
      </div>
      <ToolbarButton
        data={{ inkstoneInkZoomOut: 'true' }}
        disabled={state.committing}
        hidden={!state.optionsVisible}
        icon="zoom-out"
        label="Zoom Ink workspace out"
        onClick={props.onZoomOut}
      />
      <ToolbarButton
        className="inkstone-ink-controls__zoom-fit"
        data={{ inkstoneInkZoomFit: 'true' }}
        disabled={state.committing}
        hidden={!state.optionsVisible}
        icon="scan"
        label={`Fit Ink workspace to pane · ${Math.round(state.zoomScale * 100)}%`}
        onClick={props.onZoomFit}
        pressed={state.zoomMode === 'fit'}
        text={`${Math.round(state.zoomScale * 100)}%`}
      />
      <ToolbarButton
        data={{ inkstoneInkZoomIn: 'true' }}
        disabled={state.committing}
        hidden={!state.optionsVisible}
        icon="zoom-in"
        label="Zoom Ink workspace in"
        onClick={props.onZoomIn}
      />
      <ToolbarButton
        data={{ inkstoneInkUndo: 'true' }}
        disabled={state.committing || !state.canUndo}
        icon="undo-2"
        label="Undo Ink change"
        onClick={props.onUndo}
      />
      <ToolbarButton
        data={{ inkstoneInkRedo: 'true' }}
        disabled={state.committing || !state.canRedo}
        icon="redo-2"
        label="Redo Ink change"
        onClick={props.onRedo}
      />
      <ToolbarButton
        disabled={state.committing}
        expanded={state.optionsVisible}
        icon="ellipsis"
        label="Show or hide Ink options"
        onClick={props.onToggleOptions}
      />
      <ToolbarButton
        data={{ inkstoneInkRetry: 'true' }}
        disabled={state.committing}
        hidden={state.saveError === null}
        icon="refresh-cw"
        label="Retry local Ink save"
        onClick={props.onRetry}
        text="Retry"
      />
      <ToolbarButton
        data={{ inkstoneInkExportUnsaved: 'true' }}
        disabled={state.committing}
        hidden={state.saveError === null}
        icon="download"
        label="Export retained unsaved Ink as SVG"
        onClick={props.onExportUnsaved}
        text="Export"
      />
      <span
        aria-live="polite"
        data-inkstone-ink-error={state.saveError ?? undefined}
        data-inkstone-ink-status="true"
        hidden={!state.committing && state.saveError === null}
        role="status"
      >
        {state.statusText}
      </span>
    </div>
  );
}

function ToolbarButton({
  className = '',
  data = {},
  disabled = false,
  expanded,
  hidden = false,
  icon,
  label,
  onClick,
  onKeyDown,
  onPointerDown,
  pressed,
  text,
}: {
  readonly className?: string;
  readonly data?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly hidden?: boolean;
  readonly icon: string;
  readonly label: string;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly onPointerDown?: (event: PointerEvent) => void;
  readonly pressed?: boolean;
  readonly text?: string;
}) {
  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      aria-pressed={pressed}
      className={`inkstone-icon-button ${className}`.trim()}
      data-inkstone-icon={icon}
      disabled={disabled}
      hidden={hidden}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      ref={(button) => {
        if (button === null) return;
        for (const [key, value] of Object.entries(data)) button.dataset[key] = value;
      }}
      title={label}
      type="button"
    >
      <ObsidianIcon icon={icon} />
      {text === undefined ? null : <span className="inkstone-icon-button__label">{text}</span>}
    </button>
  );
}

function widthOptions(current: number): readonly number[] {
  return [...new Set([1, 2, 4, 8, 12, 16, current])].sort((left, right) => left - right);
}
