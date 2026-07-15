import { IconButton } from './icon-button';
import { ObsidianIcon } from './obsidian-icon';

export interface EmptyStateProps {
  readonly action?: {
    readonly icon: string;
    readonly label: string;
    readonly onSelect: () => void;
  };
  readonly description: string;
  readonly icon: string;
  readonly title: string;
}

export function EmptyState({ action, description, icon, title }: EmptyStateProps) {
  return (
    <section className="inkstone-empty-state">
      <ObsidianIcon className="inkstone-empty-state__icon" icon={icon} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action === undefined ? null : (
        <IconButton
          icon={action.icon}
          label={action.label}
          onClick={action.onSelect}
          text={action.label}
        />
      )}
    </section>
  );
}
