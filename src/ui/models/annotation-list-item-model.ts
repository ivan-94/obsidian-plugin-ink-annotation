import type { CompactAnnotationRow } from '../../domain/current-file-annotation-list';
import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { AnnotationIndexEntry } from '../../domain/vault-annotation-index';

export type AnnotationCapability =
  'copy' | 'delete' | 'edit' | 'export' | 'export-png' | 'export-svg' | 'open' | 'restore';

export interface MetadataToken {
  readonly kind: 'status' | 'tag' | 'time' | 'type';
  readonly label: string;
  readonly tone?: 'warning';
}

export interface AnnotationListItemModel {
  readonly capabilities: readonly AnnotationCapability[];
  readonly id: string;
  readonly key: string;
  readonly kind: 'highlight' | 'ink' | 'note' | 'snapshot' | 'underline';
  readonly leading:
    | { readonly icon: string; readonly kind: 'icon'; readonly styleId?: string }
    | { readonly kind: 'thumbnail'; readonly source: string };
  readonly metadata: readonly MetadataToken[];
  readonly revision: number;
  readonly secondary?: string;
  readonly state: {
    readonly active: boolean;
    readonly conflict: boolean;
    readonly deleted: boolean;
    readonly unanchored: boolean;
  };
  readonly title: string;
  readonly tone: 'default' | 'deleted' | 'warning';
}

export function mapCurrentTextAnnotation(
  row: CompactAnnotationRow,
  options: { readonly active?: boolean } = {},
): AnnotationListItemModel {
  const deleted = row.deletedAt !== undefined;
  const unanchored = row.status === 'unanchored';
  return {
    capabilities: deleted ? ['restore'] : ['open', 'edit', 'copy', 'export', 'delete'],
    id: row.id,
    key: row.id,
    kind: row.marker.kind,
    leading: {
      icon: unanchored ? 'triangle-alert' : markerIcon(row.marker.kind),
      kind: 'icon',
      ...(row.marker.kind === 'note' ? {} : { styleId: row.marker.styleId }),
    },
    metadata: [
      ...row.tags.map((tag) => ({ kind: 'tag' as const, label: `#${tag}` })),
      ...(row.status === 'active'
        ? []
        : [
            {
              kind: 'status' as const,
              label: formatAnnotationLabel(row.status),
              ...(unanchored ? { tone: 'warning' as const } : {}),
            },
          ]),
      { kind: 'time', label: formatAnnotationTimestamp(row.updatedAt) },
    ],
    revision: row.revision,
    ...(row.notePreview === null ? {} : { secondary: row.notePreview }),
    state: {
      active: options.active ?? false,
      conflict: false,
      deleted,
      unanchored,
    },
    title: row.quote,
    tone: deleted ? 'deleted' : unanchored ? 'warning' : 'default',
  };
}

export function mapCurrentInkAnnotation(
  summary: InkSurfaceSummary,
  options: { readonly active?: boolean } = {},
): AnnotationListItemModel {
  const conflict = summary.conflict ?? false;
  const deleted = summary.deletedAt !== undefined;
  const warning = conflict || summary.status !== 'active';
  const strokeLabel = `${summary.strokeCount} ${summary.strokeCount === 1 ? 'stroke' : 'strokes'}`;
  return {
    capabilities: deleted ? ['restore'] : ['open', 'edit', 'export-svg', 'export-png', 'delete'],
    id: summary.id,
    key: summary.id,
    kind: 'ink',
    leading: {
      kind: 'thumbnail',
      source: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(summary.thumbnailSvg)}`,
    },
    metadata: [
      { kind: 'type', label: strokeLabel },
      ...(conflict
        ? [{ kind: 'status' as const, label: 'Conflict', tone: 'warning' as const }]
        : []),
      ...(summary.status === 'active'
        ? []
        : [
            {
              kind: 'status' as const,
              label: formatAnnotationLabel(summary.status),
              tone: 'warning' as const,
            },
          ]),
      { kind: 'time', label: formatAnnotationTimestamp(summary.updatedAt) },
    ],
    revision: summary.revision,
    secondary: strokeLabel,
    state: {
      active: options.active ?? false,
      conflict,
      deleted,
      unanchored: summary.status === 'unanchored',
    },
    title: summary.headingPath.at(-1) ?? 'Document',
    tone: deleted ? 'deleted' : warning ? 'warning' : 'default',
  };
}

export function mapVaultAnnotation(
  entry: AnnotationIndexEntry,
  options: { readonly active?: boolean } = {},
): AnnotationListItemModel {
  const unanchored = entry.status === 'unanchored';
  const warning = entry.conflict || unanchored || entry.status === 'needs-rebase';
  return {
    capabilities:
      entry.type === 'ink'
        ? ['open', 'edit', 'export', 'delete']
        : ['open', 'edit', 'copy', 'export', 'delete'],
    id: entry.id,
    key: `${entry.noteId}\u0000${entry.id}`,
    kind: entry.type,
    leading: {
      icon: warning ? 'triangle-alert' : annotationKindIcon(entry.type),
      kind: 'icon',
      ...(entry.styleId === undefined ? {} : { styleId: entry.styleId }),
    },
    metadata: [
      ...(entry.type === 'ink'
        ? []
        : [{ kind: 'type' as const, label: formatAnnotationLabel(entry.type) }]),
      ...entry.tags.map((tag) => ({ kind: 'tag' as const, label: `#${tag}` })),
      ...(entry.conflict
        ? [{ kind: 'status' as const, label: 'Conflict', tone: 'warning' as const }]
        : []),
      ...(entry.status === 'active'
        ? []
        : [
            {
              kind: 'status' as const,
              label: formatAnnotationLabel(entry.status),
              ...(warning ? { tone: 'warning' as const } : {}),
            },
          ]),
      { kind: 'time', label: formatAnnotationTimestamp(entry.updatedAt) },
    ],
    revision: entry.revision,
    ...(entry.body === undefined ? {} : { secondary: entry.body }),
    state: {
      active: options.active ?? false,
      conflict: entry.conflict,
      deleted: false,
      unanchored,
    },
    title: entry.quote,
    tone: warning ? 'warning' : 'default',
  };
}

export function formatAnnotationLabel(value: string): string {
  const label = value.replaceAll('-', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function formatAnnotationTimestamp(value: string): string {
  const compactIso = /^(?:\d{4}-)?(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return compactIso === null ? value : `${compactIso[1]} ${compactIso[2]}`;
}

function markerIcon(kind: CompactAnnotationRow['marker']['kind']): string {
  switch (kind) {
    case 'highlight':
      return 'highlighter';
    case 'underline':
      return 'underline';
    case 'note':
      return 'message-square-text';
  }
}

function annotationKindIcon(kind: AnnotationIndexEntry['type']): string {
  switch (kind) {
    case 'highlight':
      return 'highlighter';
    case 'ink':
      return 'waves';
    case 'note':
      return 'message-square-text';
    case 'snapshot':
      return 'camera';
    case 'underline':
      return 'underline';
  }
}
