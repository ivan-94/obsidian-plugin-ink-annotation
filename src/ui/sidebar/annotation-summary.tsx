import type { AnnotationListItemModel } from '../models/annotation-list-item-model';
import { MetadataLine } from '../primitives/metadata-line';
import { ObsidianIcon } from '../primitives/obsidian-icon';

export function AnnotationSummary({
  context = 'current',
  disabled = false,
  model,
  onActivate,
  selectionMode = false,
  showSecondary = true,
}: {
  readonly context?: 'current' | 'vault';
  readonly disabled?: boolean;
  readonly model: AnnotationListItemModel;
  readonly onActivate: (button: HTMLButtonElement) => void;
  readonly selectionMode?: boolean;
  readonly showSecondary?: boolean;
}) {
  if (model.leading.kind === 'thumbnail') {
    const source = model.leading.source;
    return (
      <button
        aria-disabled={disabled || undefined}
        aria-label={`Ink in ${model.title}, ${model.secondary ?? 'Ink'}, ${model.state.deleted ? 'deleted' : model.tone}`}
        data-inkstone-ink-row={model.id}
        onClick={disabled || selectionMode ? undefined : (event) => onActivate(event.currentTarget)}
        tabIndex={selectionMode ? -1 : undefined}
        type="button"
      >
        <img alt="" data-inkstone-ink-thumbnail={model.id} src={source} />
        <span className="inkstone-sidebar-ink-row__content">
          <strong title={model.title}>{model.title}</strong>
          <MetadataLine tokens={model.metadata} />
        </span>
      </button>
    );
  }

  const leading = model.leading.kind === 'icon' ? model.leading : null;
  return (
    <button
      aria-current={model.state.active ? 'true' : undefined}
      aria-disabled={disabled || undefined}
      className="inkstone-sidebar-row__summary"
      data-annotation-id={model.id}
      data-inkstone-annotation-row=""
      onClick={disabled || selectionMode ? undefined : (event) => onActivate(event.currentTarget)}
      tabIndex={selectionMode ? -1 : undefined}
      type="button"
    >
      <ObsidianIcon
        className={`inkstone-sidebar-row__marker inkstone-sidebar-row__marker--${model.kind}${context === 'vault' ? ' inkstone-vault-row__type-icon' : ''}`}
        icon={leading?.icon ?? 'bookmark'}
        {...(leading?.styleId === undefined ? {} : { styleId: leading.styleId })}
      />
      <span className="inkstone-sidebar-row__content">
        <span
          className={`inkstone-sidebar-row__quote${context === 'vault' ? ' inkstone-vault-row__quote' : ''}`}
          title={model.title}
        >
          {model.title}
        </span>
        {!showSecondary || model.secondary === undefined ? null : (
          <span className="inkstone-sidebar-row__note" title={model.secondary}>
            {model.secondary}
          </span>
        )}
        <MetadataLine
          className={`inkstone-sidebar-row__metadata${context === 'vault' ? ' inkstone-vault-row__metadata' : ''}`}
          tokens={model.metadata}
        />
      </span>
    </button>
  );
}
