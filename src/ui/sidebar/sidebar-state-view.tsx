import type { AnnotationSidebarStore } from '../stores/annotation-sidebar-store';
import { EmptyState } from '../primitives/empty-state';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { StatusBanner } from '../primitives/status-banner';

export type SidebarStatePresentation =
  | { readonly kind: 'content' }
  | {
      readonly description: string;
      readonly icon: string;
      readonly kind: 'empty';
      readonly title: string;
    }
  | { readonly kind: 'error'; readonly message: string; readonly onRetry?: () => void }
  | { readonly kind: 'loading'; readonly message: string };

export function sidebarStatePresentation(
  store: AnnotationSidebarStore,
  retries: { readonly current?: () => void; readonly vault?: () => void } = {},
): SidebarStatePresentation {
  if (store.scope.value === 'current-file') {
    const status = store.current.status.value;
    if (status === 'error') {
      return {
        kind: 'error',
        message: "Couldn't read annotations locally.",
        ...(retries.current === undefined ? {} : { onRetry: retries.current }),
      };
    }
    if (status === 'idle' || status === 'loading') {
      return { kind: 'loading', message: 'Loading annotations…' };
    }
    void store.current.restoreDeadline.value;
    const hasVisibleInk = store.current.inkSummaries.value.some((summary) => {
      if (summary.strokeCount === 0) return false;
      if (summary.deletedAt === undefined) return true;
      return Date.now() < Date.parse(summary.deletedAt) + 5_000;
    });
    if (store.current.model.value.total === 0 && !hasVisibleInk) {
      return {
        description: 'Select text in Reading View or start Ink Mode.',
        icon: 'bookmark-plus',
        kind: 'empty',
        title: 'No annotations yet',
      };
    }
    return { kind: 'content' };
  }

  const status = store.vault.status.value;
  if (status === 'unavailable') {
    return {
      kind: 'error',
      message: 'Annotation index is unavailable.',
      ...(retries.vault === undefined ? {} : { onRetry: retries.vault }),
    };
  }
  if (status === 'idle' || status === 'restoring' || status === 'building') {
    return { kind: 'loading', message: 'Building annotation index…' };
  }
  const queryState = store.vault.queryResult.value.state;
  if (queryState === 'no-annotations') {
    return {
      description: 'Annotations from the entire Vault will appear here.',
      icon: 'library',
      kind: 'empty',
      title: 'No annotations',
    };
  }
  return { kind: 'content' };
}

export function SidebarStateView({
  presentation,
}: {
  readonly presentation: SidebarStatePresentation;
}) {
  switch (presentation.kind) {
    case 'content':
      return null;
    case 'empty':
      return (
        <div className="inkstone-sidebar__empty">
          <EmptyState
            description={presentation.description}
            icon={presentation.icon}
            title={presentation.title}
          />
        </div>
      );
    case 'error':
      return (
        <StatusBanner
          {...(presentation.onRetry === undefined
            ? {}
            : {
                action: { label: 'Retry annotations', onSelect: presentation.onRetry },
              })}
          kind="error"
          message={presentation.message}
        />
      );
    case 'loading':
      return <SidebarLoadingState message={presentation.message} />;
  }
}

function SidebarLoadingState({ message }: { readonly message: string }) {
  return (
    <div
      aria-label={message.replace(/…$/u, '')}
      aria-live="polite"
      className="inkstone-sidebar__loading"
      role="status"
    >
      <div className="inkstone-sidebar__loading-label">
        <ObsidianIcon className="inkstone-sidebar__loading-icon" icon="loader-circle" />
        <span>{message}</span>
      </div>
      <div aria-hidden="true" className="inkstone-sidebar__loading-list">
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
      </div>
    </div>
  );
}

function LoadingRow() {
  return (
    <div className="inkstone-sidebar__loading-row">
      <span className="inkstone-sidebar__loading-thumbnail" />
      <span className="inkstone-sidebar__loading-copy">
        <span className="inkstone-sidebar__loading-line inkstone-sidebar__loading-line--title" />
        <span className="inkstone-sidebar__loading-line inkstone-sidebar__loading-line--metadata" />
      </span>
    </div>
  );
}
