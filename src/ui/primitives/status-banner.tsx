import { IconButton } from './icon-button';
import { ObsidianIcon } from './obsidian-icon';

export interface StatusBannerProps {
  readonly action?: { readonly label: string; readonly onSelect: () => void };
  readonly kind: 'conflict' | 'error' | 'loading';
  readonly message: string;
}

export function StatusBanner({ action, kind, message }: StatusBannerProps) {
  const urgent = kind === 'conflict' || kind === 'error';
  return (
    <div
      aria-live={urgent ? 'assertive' : 'polite'}
      className={`inkstone-status-banner inkstone-status-banner--${kind}`}
      role={urgent ? 'alert' : 'status'}
    >
      <ObsidianIcon className="inkstone-status-banner__icon" icon={statusIcon(kind)} />
      <span>{message}</span>
      {action === undefined ? null : (
        <IconButton
          icon="refresh-cw"
          label={action.label}
          onClick={action.onSelect}
          text={action.label}
        />
      )}
    </div>
  );
}

function statusIcon(kind: StatusBannerProps['kind']): string {
  switch (kind) {
    case 'conflict':
      return 'triangle-alert';
    case 'error':
      return 'circle-alert';
    case 'loading':
      return 'loader-circle';
  }
}
