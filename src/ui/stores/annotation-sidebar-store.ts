import { signal, type Signal } from '@preact/signals';

import type { CurrentFileAnnotationList } from '../../domain/current-file-annotation-list';
import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { SnapshotAnnotationSummary } from '../../domain/snapshot-annotation-summary';
import type {
  VaultAnnotationFilters,
  VaultAnnotationQueryResult,
} from '../../domain/vault-annotation-index';
import type { VaultBulkDialog } from '../sidebar/vault-sidebar-types';
import type { CurrentBulkDialog } from '../sidebar/current-bulk-selection-types';

export type SidebarScope = 'current-file' | 'entire-vault';

export interface RecentDeletionReceipt {
  readonly count: number;
  readonly error: string | null;
  readonly expiresAt: number;
  readonly pending: boolean;
}

export interface CurrentFileSidebarStore {
  readonly activeAnnotationId: Signal<string | null>;
  readonly activeSnapshotId: Signal<string | null>;
  readonly bulkDialog: Signal<CurrentBulkDialog>;
  readonly bulkFeedback: Signal<string | null>;
  readonly bulkPending: Signal<boolean>;
  readonly errorMessage: Signal<string | null>;
  readonly filePath: Signal<string | null>;
  readonly inkSummaries: Signal<readonly InkSurfaceSummary[]>;
  readonly snapshotSummaries: Signal<readonly SnapshotAnnotationSummary[]>;
  readonly model: Signal<CurrentFileAnnotationList>;
  readonly pendingInkDelete: Signal<{
    readonly expectedRevision: number;
    readonly id: string;
    readonly title: string;
  } | null>;
  readonly restoreDeadline: Signal<number | null>;
  readonly scrollOffset: Signal<number>;
  readonly searchQuery: Signal<string>;
  readonly selectedKeys: Signal<ReadonlySet<string>>;
  readonly selectionMode: Signal<boolean>;
  readonly status: Signal<'error' | 'idle' | 'loading' | 'ready'>;
  readonly storageHealth: Signal<{
    readonly conflictCount: number;
    readonly readIssueCount: number;
  }>;
}

export function createCurrentFileSidebarStore(): CurrentFileSidebarStore {
  return {
    activeAnnotationId: signal(null),
    activeSnapshotId: signal(null),
    bulkDialog: signal(null),
    bulkFeedback: signal(null),
    bulkPending: signal(false),
    errorMessage: signal(null),
    filePath: signal(null),
    inkSummaries: signal([]),
    snapshotSummaries: signal([]),
    model: signal({ groups: [], total: 0 }),
    pendingInkDelete: signal(null),
    restoreDeadline: signal(null),
    scrollOffset: signal(0),
    searchQuery: signal(''),
    selectedKeys: signal(new Set()),
    selectionMode: signal(false),
    status: signal('idle'),
    storageHealth: signal({ conflictCount: 0, readIssueCount: 0 }),
  };
}

export interface VaultSidebarStore {
  readonly buildingProgress: Signal<{ readonly completed: number; readonly total: number }>;
  readonly bulkDialog: Signal<VaultBulkDialog>;
  readonly bulkFeedback: Signal<string | null>;
  readonly bulkPending: Signal<boolean>;
  readonly bulkSelectionMode: Signal<boolean>;
  readonly collapsedGroups: Signal<ReadonlySet<string>>;
  readonly filters: Signal<VaultAnnotationFilters>;
  readonly indexVersion: Signal<number>;
  readonly queryResult: Signal<VaultAnnotationQueryResult>;
  readonly scrollOffset: Signal<number>;
  readonly searchInput: Signal<string>;
  readonly searchQuery: Signal<string>;
  readonly selectedKeys: Signal<ReadonlySet<string>>;
  readonly sort: Signal<'document' | 'updated'>;
  readonly status: Signal<'building' | 'idle' | 'ready' | 'restoring' | 'unavailable'>;
  readonly unavailableMessage: Signal<string>;
}

export function createVaultSidebarStore(): VaultSidebarStore {
  return {
    buildingProgress: signal({ completed: 0, total: 0 }),
    bulkDialog: signal(null),
    bulkFeedback: signal(null),
    bulkPending: signal(false),
    bulkSelectionMode: signal(false),
    collapsedGroups: signal(new Set()),
    filters: signal({}),
    indexVersion: signal(0),
    queryResult: signal({ groups: [], state: 'no-annotations', total: 0 }),
    scrollOffset: signal(0),
    searchInput: signal(''),
    searchQuery: signal(''),
    selectedKeys: signal(new Set()),
    sort: signal('document'),
    status: signal('idle'),
    unavailableMessage: signal('Index unavailable'),
  };
}

export class AnnotationSidebarStore {
  readonly current = createCurrentFileSidebarStore();

  readonly recentDeletion = signal<RecentDeletionReceipt | null>(null);

  readonly scope = signal<SidebarScope>('current-file');

  readonly vault = createVaultSidebarStore();

  setScope(scope: SidebarScope): void {
    this.scope.value = scope;
  }
}
