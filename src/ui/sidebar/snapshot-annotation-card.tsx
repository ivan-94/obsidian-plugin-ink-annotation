import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { SnapshotAnnotationSummary } from '../../domain/snapshot-annotation-summary';
import { EllipsisMenuTrigger } from '../primitives/ellipsis-menu-trigger';
import { ObsidianIcon } from '../primitives/obsidian-icon';

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
      className={`inkstone-snapshot-card${className.length === 0 ? '' : ` ${className}`}${active ? ' is-active' : ''}`}
      style={style}
      {...dataAttributes}
    >
      <button
        aria-label={`Preview Snapshot captured ${summary.capturedAt}`}
        className="inkstone-snapshot-card__thumbnail"
        onClick={() => onPreview(summary)}
        ref={thumbnail}
        type="button"
      >
        {source === null ? (
          <ObsidianIcon icon="camera" />
        ) : (
          <img alt="" aria-hidden="true" src={source} />
        )}
      </button>
      <span
        aria-label={`${summary.strokeCount} strokes, ${summary.linkState}`}
        className="inkstone-snapshot-card__summary"
        data-inkstone-snapshot-strokes=""
      >
        <ObsidianIcon icon={summary.linkState === 'linked' ? 'link-2' : 'link-2-off'} />
        <strong>{summary.strokeCount} strokes</strong>
      </span>
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
    </article>
  );
}
