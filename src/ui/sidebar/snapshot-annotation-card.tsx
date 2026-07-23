import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { SnapshotAnnotationSummary } from '../../domain/snapshot-annotation-summary';
import { EllipsisMenuTrigger } from '../primitives/ellipsis-menu-trigger';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import type { ListItemSelection } from './list-item-frame';

export function SnapshotAnnotationCard({
  active = false,
  className = '',
  dataAttributes = {},
  document,
  loadThumbnail,
  onDelete,
  onEdit,
  onExport,
  onPreview,
  onRelink,
  onRestore,
  onSelectSource,
  selection,
  style,
  summary,
}: {
  readonly active?: boolean;
  readonly className?: string;
  readonly dataAttributes?: Readonly<Record<string, string>>;
  readonly document: Document;
  readonly loadThumbnail?: (summary: SnapshotAnnotationSummary) => Promise<string | null>;
  readonly onDelete: (summary: SnapshotAnnotationSummary) => void;
  readonly onEdit: (summary: SnapshotAnnotationSummary) => void;
  readonly onExport: (summary: SnapshotAnnotationSummary) => void;
  readonly onPreview: (summary: SnapshotAnnotationSummary) => void;
  readonly onRelink: (summary: SnapshotAnnotationSummary) => void;
  readonly onRestore: (summary: SnapshotAnnotationSummary) => void;
  readonly onSelectSource: (summary: SnapshotAnnotationSummary) => void;
  readonly selection?: ListItemSelection;
  readonly style?: JSX.CSSProperties;
  readonly summary: SnapshotAnnotationSummary;
}) {
  const thumbnail = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    const element = thumbnail.current;
    if (loadThumbnail === undefined || element === null) return;
    let cancelled = false;
    const request = (): void => {
      void loadThumbnail(summary).then(
        (value) => {
          if (!cancelled && value !== null) setSource(value);
        },
        () => undefined,
      );
    };
    const IntersectionObserverConstructor = document.defaultView?.IntersectionObserver;
    if (IntersectionObserverConstructor === undefined) request();
    else {
      const observer = new IntersectionObserverConstructor((entries) => {
        if (!entries.some(({ isIntersecting }) => isIntersecting)) return;
        observer.disconnect();
        request();
      });
      observer.observe(element);
      return () => {
        cancelled = true;
        observer.disconnect();
      };
    }
    return () => {
      cancelled = true;
    };
  }, [document, loadThumbnail, summary, summary.thumbnailKey]);

  return (
    <article
      aria-current={active ? 'true' : undefined}
      aria-selected={selection?.selected}
      className={`inkstone-snapshot-card${className.length === 0 ? '' : ` ${className}`}${active ? ' is-active' : ''}${selection?.selected === true ? ' is-selected' : ''}`}
      data-inkstone-selection-mode={selection === undefined ? 'false' : 'true'}
      style={style}
      {...dataAttributes}
    >
      <button
        aria-label={
          selection === undefined
            ? `Preview Snapshot captured ${summary.capturedAt}`
            : selection.label
        }
        className="inkstone-snapshot-card__thumbnail"
        onClick={() => (selection === undefined ? onPreview(summary) : selection.onToggle())}
        ref={thumbnail}
        type="button"
      >
        {source === null ? (
          <ObsidianIcon icon="camera" />
        ) : (
          <img alt="" aria-hidden="true" src={source} />
        )}
      </button>
      <button
        aria-label={
          selection === undefined
            ? summary.linkState === 'unanchored'
              ? `${summary.strokeCount} strokes, source unavailable`
              : `Go to source for ${summary.strokeCount} strokes`
            : selection.label
        }
        className="inkstone-snapshot-card__summary"
        data-inkstone-snapshot-strokes=""
        disabled={selection === undefined && summary.linkState === 'unanchored'}
        onClick={() => (selection === undefined ? onSelectSource(summary) : selection.onToggle())}
        type="button"
      >
        <ObsidianIcon icon={summary.linkState === 'linked' ? 'link-2' : 'unlink'} />
        <strong>{summary.strokeCount} strokes</strong>
      </button>
      {selection === undefined ? (
        <EllipsisMenuTrigger
          className="inkstone-snapshot-card__actions"
          dataAttributes={{ 'data-inkstone-snapshot-actions': summary.id }}
          items={[
            ...(summary.linkState === 'unanchored'
              ? []
              : [
                  {
                    icon: 'locate-fixed',
                    id: 'go-to-snapshot-source',
                    onSelect: () => onSelectSource(summary),
                    title: 'Go to source',
                  },
                ]),
            ...(summary.deletedAt === undefined
              ? [
                  {
                    icon: 'square-pen',
                    id: 'edit-snapshot',
                    onSelect: () => onEdit(summary),
                    title: 'Edit Snapshot',
                  },
                  {
                    icon: 'download',
                    id: 'export-snapshot',
                    onSelect: () => onExport(summary),
                    title: 'Export Snapshot PNG',
                  },
                  ...(summary.linkState === 'unanchored'
                    ? [
                        {
                          icon: 'link',
                          id: 'relink-snapshot',
                          onSelect: () => onRelink(summary),
                          title: 'Relink Snapshot',
                        },
                      ]
                    : []),
                  {
                    icon: 'trash-2',
                    id: 'delete-snapshot',
                    onSelect: () => onDelete(summary),
                    title: 'Delete Snapshot',
                    warning: true,
                  },
                ]
              : [
                  {
                    icon: 'undo-2',
                    id: 'restore-snapshot',
                    onSelect: () => onRestore(summary),
                    title: 'Restore Snapshot',
                  },
                ]),
          ]}
          label={`Open actions for Snapshot captured ${summary.capturedAt}`}
        />
      ) : (
        <button
          aria-checked={selection.selected}
          aria-label={selection.label}
          className={`inkstone-snapshot-card__selection${selection.selected ? ' is-selected' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            selection.onToggle();
          }}
          role="checkbox"
          type="button"
        >
          <ObsidianIcon icon="check" />
        </button>
      )}
    </article>
  );
}
