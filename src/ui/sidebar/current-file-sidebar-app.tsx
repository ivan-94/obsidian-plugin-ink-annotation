import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import {
  mapCurrentInkAnnotation,
  mapCurrentTextAnnotation,
} from '../models/annotation-list-item-model';
import { EmptyState } from '../primitives/empty-state';
import { EllipsisMenuTrigger } from '../primitives/ellipsis-menu-trigger';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { StatusBanner } from '../primitives/status-banner';
import type { CurrentFileSidebarStore } from '../stores/annotation-sidebar-store';
import { ExternalRoot } from '../runtime/external-root';
import { AnnotationGroupHeader } from './annotation-group-header';
import { BulkActionDock } from './bulk-action-dock';
import { BulkActionDialog } from './bulk-action-dialog';
import type { CurrentBulkOutcome, CurrentBulkSelectionEntry } from './current-bulk-selection-types';
import { InkAnnotationListItem } from './ink-annotation-list-item';
import { SelectionModeHeaderActions } from './selection-mode-header-actions';
import { TextAnnotationListItem } from './text-annotation-list-item';
import type { SelectOption } from './vault-sidebar-types';

export interface CurrentFileSidebarAppProps {
  readonly document: Document;
  readonly headerContainer?: HTMLElement;
  readonly onBulkAddTags: (
    selection: readonly CurrentBulkSelectionEntry[],
    tags: readonly string[],
  ) => Promise<CurrentBulkOutcome>;
  readonly onBulkChangeStyle: (
    selection: readonly CurrentBulkSelectionEntry[],
    styleId: string,
  ) => Promise<CurrentBulkOutcome>;
  readonly onBulkCopy: (selection: readonly CurrentBulkSelectionEntry[]) => Promise<void>;
  readonly onBulkDelete: (
    selection: readonly CurrentBulkSelectionEntry[],
  ) => Promise<CurrentBulkOutcome>;
  readonly onBulkExport: (
    selection: readonly CurrentBulkSelectionEntry[],
    invoker: HTMLElement,
  ) => Promise<void>;
  readonly onDeleteAnnotation: (annotationId: string, expectedRevision: number) => void;
  readonly onDeleteInk: (surfaceId: string, expectedRevision: number) => void;
  readonly onEditInk: (surfaceId: string) => void;
  readonly onEntireVault: () => void | Promise<void>;
  readonly onExportCurrentFile: (invoker: HTMLElement) => void;
  readonly onExportInkPng: (surfaceId: string) => void;
  readonly onExportInkReport: () => void;
  readonly onExportInkSvg: (surfaceId: string) => void;
  readonly onInspect: (annotationId: string, invoker: HTMLElement) => void;
  readonly onRepairAnnotation?: (annotationId: string, invoker: HTMLElement) => void;
  readonly onRetry: () => void;
  readonly onReviewConflicts: (invoker: HTMLElement) => void;
  readonly onRestoreAnnotation: (annotationId: string, expectedRevision: number) => void;
  readonly onRestoreInk: (surfaceId: string, expectedRevision: number) => void;
  readonly onSelect: (annotationId: string) => void;
  readonly onSelectInk: (summary: InkSurfaceSummary) => void;
  readonly showScope: boolean;
  readonly state: CurrentFileSidebarStore;
  readonly styleOptions: readonly SelectOption[];
}

export function CurrentFileSidebarApp(props: CurrentFileSidebarAppProps) {
  const { state } = props;
  const [clock, setClock] = useState(() => Date.now());
  const deadline = state.restoreDeadline.value;
  useLayoutEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(
      () => {
        state.restoreDeadline.value = null;
        setClock(Date.now());
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [deadline, state]);

  if (state.status.value === 'error') {
    return (
      <StatusBanner
        action={{ label: 'Retry annotations', onSelect: props.onRetry }}
        kind="error"
        message={`${state.errorMessage.value ?? "Couldn't read annotations locally."} Cloud status remains unknown.`}
      />
    );
  }

  const now = Math.max(clock, Date.now());
  const groups = state.model.value.groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => visibleUntil(row.deletedAt, now)),
    }))
    .filter((group) => group.rows.length > 0);
  const inkSummaries = state.inkSummaries.value.filter(
    (summary) => summary.strokeCount > 0 && visibleUntil(summary.deletedAt, now),
  );
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0) + inkSummaries.length;
  const query = state.searchQuery.value.trim().toLocaleLowerCase();
  const matches = (value: string): boolean =>
    query.length === 0 || value.toLocaleLowerCase().includes(query);
  const selectableKeys = [
    ...inkSummaries
      .filter((summary) => matches(inkSearchText(summary)))
      .map((summary) => currentSelectionKey('ink', summary.id)),
    ...groups.flatMap((group) =>
      group.rows
        .filter((row) => matches(textSearchText(row)))
        .map((row) => currentSelectionKey('text', row.id)),
    ),
  ];
  const filePath = state.filePath.value ?? inkSummaries[0]?.filePath ?? '';
  const bulkEntries: readonly CurrentBulkSelectionEntry[] = [
    ...inkSummaries
      .filter((summary) => matches(inkSearchText(summary)))
      .map((summary) => ({
        body: `${summary.strokeCount} ${summary.strokeCount === 1 ? 'stroke' : 'strokes'}`,
        expectedRevision: summary.revision,
        filePath: summary.filePath,
        id: summary.id,
        key: currentSelectionKey('ink', summary.id),
        quote: `Ink · ${summary.headingPath.join(' › ') || 'Document'}`,
        type: 'ink' as const,
      })),
    ...groups.flatMap((group) =>
      group.rows
        .filter((row) => matches(textSearchText(row)))
        .map((row) => ({
          ...(row.notePreview === null ? {} : { body: row.notePreview }),
          expectedRevision: row.revision,
          filePath,
          id: row.id,
          key: currentSelectionKey('text', row.id),
          quote: row.quote,
          type: row.marker.kind === 'note' ? ('note' as const) : row.marker.kind,
        })),
    ),
  ];
  const selectedEntries = bulkEntries.filter((entry) => state.selectedKeys.value.has(entry.key));
  const header = (
    <CurrentHeader
      annotationCount={total}
      document={props.document}
      onEntireVault={props.onEntireVault}
      onExportCurrentFile={props.onExportCurrentFile}
      onExportInkReport={props.onExportInkReport}
      onRetry={props.onRetry}
      selectableKeys={selectableKeys}
      showScope={props.showScope}
      state={state}
    />
  );

  return (
    <>
      {props.headerContainer === undefined ? (
        header
      ) : (
        <ExternalRoot host={props.headerContainer}>{header}</ExternalRoot>
      )}
      <div className="inkstone-current-file-scroll">
        <StorageHealth
          health={state.storageHealth.value}
          onReviewConflicts={props.onReviewConflicts}
        />
        <SearchField state={state} />
        {total === 0 ? (
          <div className="inkstone-sidebar__empty">
            <EmptyState
              description="Select text in Reading View or start Ink Mode."
              icon="bookmark-plus"
              title="No annotations yet"
            />
          </div>
        ) : (
          <>
            {inkSummaries.length === 0 ? null : (
              <section
                className="inkstone-sidebar-group inkstone-sidebar-group--ink"
                hidden={!inkSummaries.some((summary) => matches(inkSearchText(summary)))}
              >
                <AnnotationGroupHeader count={inkSummaries.length} kind="ink" title="Ink" />
                {inkSummaries.map((summary) => {
                  const model = mapCurrentInkAnnotation(summary);
                  const selectionKey = currentSelectionKey('ink', summary.id);
                  return (
                    <div hidden={!matches(inkSearchText(summary))} key={model.key}>
                      <InkAnnotationListItem
                        model={model}
                        onDeleteRequest={() => {
                          state.pendingInkDelete.value = {
                            expectedRevision: summary.revision,
                            id: summary.id,
                            title: model.title,
                          };
                        }}
                        onEdit={() => props.onEditInk(summary.id)}
                        onExportPng={() => props.onExportInkPng(summary.id)}
                        onExportSvg={() => props.onExportInkSvg(summary.id)}
                        onRestore={() => props.onRestoreInk(summary.id, summary.revision)}
                        onSelect={() => props.onSelectInk(summary)}
                        {...(state.selectionMode.value
                          ? {
                              selection: {
                                onToggle: () => toggleCurrentSelection(state, selectionKey),
                                selected: state.selectedKeys.value.has(selectionKey),
                              },
                            }
                          : {})}
                      />
                    </div>
                  );
                })}
              </section>
            )}
            {groups.map((group) => {
              const visible = group.rows.some((row) => matches(textSearchText(row)));
              return (
                <section
                  className={`inkstone-sidebar-group inkstone-sidebar-group--${group.kind}`}
                  hidden={!visible}
                  key={`${group.kind}:${group.title}`}
                >
                  <AnnotationGroupHeader
                    count={group.rows.length}
                    kind={group.kind}
                    title={group.title}
                  />
                  {group.rows.map((row) => {
                    const model = mapCurrentTextAnnotation(row, {
                      active: state.activeAnnotationId.value === row.id,
                    });
                    const selectionKey = currentSelectionKey('text', row.id);
                    return (
                      <div hidden={!matches(textSearchText(row))} key={model.key}>
                        <TextAnnotationListItem
                          model={model}
                          onDelete={() => props.onDeleteAnnotation(row.id, row.revision)}
                          onInspect={(invoker) => props.onInspect(row.id, invoker)}
                          {...(props.onRepairAnnotation === undefined
                            ? {}
                            : {
                                onRepair: (invoker: HTMLElement) =>
                                  props.onRepairAnnotation?.(row.id, invoker),
                              })}
                          onRestore={() => props.onRestoreAnnotation(row.id, row.revision)}
                          onSelect={() => {
                            state.activeAnnotationId.value = row.id;
                            props.onSelect(row.id);
                          }}
                          {...(state.selectionMode.value
                            ? {
                                selection: {
                                  onToggle: () => toggleCurrentSelection(state, selectionKey),
                                  selected: state.selectedKeys.value.has(selectionKey),
                                },
                              }
                            : {})}
                        />
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </>
        )}
      </div>
      {state.selectionMode.value ? (
        <CurrentBulkActionDock entries={selectedEntries} {...props} />
      ) : null}
      <CurrentBulkDialog entries={selectedEntries} {...props} />
      <InkDeleteDialog {...props} />
    </>
  );
}

function InkDeleteDialog({ onDeleteInk, state }: CurrentFileSidebarAppProps) {
  const pending = state.pendingInkDelete.value;
  if (pending === null) return null;
  const close = (): void => {
    state.pendingInkDelete.value = null;
  };
  return (
    <BulkActionDialog
      ariaLabel="Confirm Ink deletion"
      confirmAriaLabel="Confirm delete Ink surface"
      confirmLabel="Delete"
      danger
      description="This deletes the entire Ink surface. You can restore it briefly afterward."
      feedback={null}
      icon="trash-2"
      onCancel={close}
      onConfirm={() => {
        close();
        onDeleteInk(pending.id, pending.expectedRevision);
      }}
      pending={false}
      title={`Delete ${pending.title}?`}
    />
  );
}

function CurrentBulkActionDock({
  entries,
  onBulkCopy,
  onBulkExport,
  state,
}: CurrentFileSidebarAppProps & {
  readonly entries: readonly CurrentBulkSelectionEntry[];
}) {
  const open = (kind: 'delete' | 'style' | 'tags'): void => {
    state.bulkDialog.value = { entries, kind };
    state.bulkFeedback.value = null;
  };
  const runTransient = (operation: Promise<void>): void => {
    state.bulkFeedback.value = null;
    void operation.catch((error) => {
      state.bulkFeedback.value = error instanceof Error ? error.message : String(error);
    });
  };
  const copy = (): void => {
    state.bulkFeedback.value = 'Copying…';
    void onBulkCopy(entries).then(
      () => {
        state.bulkFeedback.value = 'Copied';
      },
      (error) => {
        state.bulkFeedback.value = error instanceof Error ? error.message : String(error);
      },
    );
  };
  return (
    <BulkActionDock
      copyFeedback={state.bulkFeedback.value}
      hasInk={entries.some((entry) => entry.type === 'ink')}
      onCopy={copy}
      onDelete={() => open('delete')}
      onExport={(invoker) => runTransient(onBulkExport(entries, invoker))}
      onStyle={() => open('style')}
      onTags={() => open('tags')}
      selectedCount={entries.length}
    />
  );
}

function CurrentBulkDialog({
  onBulkAddTags,
  onBulkChangeStyle,
  onBulkDelete,
  state,
  styleOptions,
}: CurrentFileSidebarAppProps & {
  readonly entries: readonly CurrentBulkSelectionEntry[];
}) {
  const dialog = state.bulkDialog.value;
  const input = useRef<HTMLInputElement>(null);
  const style = useRef<HTMLSelectElement>(null);
  if (dialog === null) return null;
  const close = (): void => {
    state.bulkDialog.value = null;
    state.bulkFeedback.value = null;
  };
  const run = (operation: Promise<CurrentBulkOutcome>): void => {
    state.bulkPending.value = true;
    state.bulkFeedback.value = null;
    void operation.then(
      (outcome) => {
        state.selectedKeys.value = new Set(outcome.failed.map((entry) => entry.key));
        state.selectionMode.value = outcome.failed.length > 0;
        state.bulkPending.value = false;
        state.bulkDialog.value = null;
        if (outcome.failed.length > 0) {
          state.bulkFeedback.value = `${outcome.failed.length} selected annotations could not be updated.`;
        }
      },
      (error) => {
        state.bulkPending.value = false;
        state.bulkFeedback.value = error instanceof Error ? error.message : String(error);
      },
    );
  };
  return (
    <BulkActionDialog
      ariaLabel={
        dialog.kind === 'delete'
          ? 'Confirm bulk deletion'
          : dialog.kind === 'tags'
            ? 'Add tags to selected annotations'
            : 'Change style for selected annotations'
      }
      confirmAriaLabel={
        dialog.kind === 'delete'
          ? 'Confirm bulk delete'
          : dialog.kind === 'tags'
            ? 'Apply bulk tags'
            : 'Apply bulk style'
      }
      confirmLabel={dialog.kind === 'delete' ? 'Delete' : 'Apply'}
      danger={dialog.kind === 'delete'}
      description={
        dialog.kind === 'delete'
          ? 'Deleted annotations can be restored for a short time.'
          : undefined
      }
      feedback={state.bulkFeedback.value}
      icon={dialog.kind === 'delete' ? 'trash-2' : dialog.kind === 'tags' ? 'tag' : 'scan-text'}
      onCancel={close}
      onConfirm={() => {
        if (dialog.kind === 'delete') run(onBulkDelete(dialog.entries));
        else if (dialog.kind === 'tags') {
          const tags = (input.current?.value ?? '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
          if (tags.length > 0) run(onBulkAddTags(dialog.entries, tags));
        } else {
          const styleId = style.current?.value ?? '';
          if (styleId.length > 0) run(onBulkChangeStyle(dialog.entries, styleId));
        }
      }}
      pending={state.bulkPending.value}
      title={
        dialog.kind === 'delete'
          ? `Delete ${dialog.entries.length} ${dialog.entries.length === 1 ? 'annotation' : 'annotations'}?`
          : dialog.kind === 'tags'
            ? 'Add tags'
            : 'Change style'
      }
    >
      {dialog.kind === 'delete' ? undefined : dialog.kind === 'tags' ? (
        <input
          aria-label="Bulk tags"
          placeholder="Tags, separated by commas"
          ref={input}
          type="text"
        />
      ) : (
        <select aria-label="Bulk style" ref={style}>
          {styleOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      )}
    </BulkActionDialog>
  );
}

function CurrentHeader({
  annotationCount,
  document,
  onEntireVault,
  onExportCurrentFile,
  onExportInkReport,
  onRetry,
  selectableKeys,
  showScope,
  state,
}: {
  readonly annotationCount: number;
  readonly document: Document;
  readonly onEntireVault: () => void | Promise<void>;
  readonly onExportCurrentFile: (invoker: HTMLElement) => void;
  readonly onExportInkReport: () => void;
  readonly onRetry: () => void;
  readonly selectableKeys: readonly string[];
  readonly showScope: boolean;
  readonly state: CurrentFileSidebarStore;
}) {
  const actions = state.selectionMode.value ? (
    <SelectionModeHeaderActions
      onDeselectAll={() => {
        state.selectedKeys.value = new Set();
      }}
      onDone={() => {
        state.selectionMode.value = false;
        state.selectedKeys.value = new Set();
      }}
      onSelectAll={() => {
        state.selectedKeys.value = new Set(selectableKeys);
      }}
      selectedCount={state.selectedKeys.value.size}
      totalCount={selectableKeys.length}
    />
  ) : (
    <>
      <div className="inkstone-sidebar__header-actions">
        <span
          aria-label="Sync status unavailable"
          className="inkstone-visually-hidden"
          data-inkstone-cloud-status=""
        >
          <ObsidianIcon icon="cloud-off" />
          Sync status unavailable
        </span>
        <button
          aria-label="Refresh annotations"
          className="inkstone-icon-button"
          onClick={onRetry}
          type="button"
        >
          <ObsidianIcon icon="refresh-cw" />
        </button>
        <EllipsisMenuTrigger
          items={(trigger) => [
            {
              disabled: annotationCount === 0,
              icon: 'list-checks',
              id: 'select-multiple',
              onSelect: () => {
                state.selectionMode.value = true;
                state.selectedKeys.value = new Set();
              },
              section: 'selection',
              title: 'Select multiple…',
            },
            {
              disabled: annotationCount === 0,
              icon: 'share',
              id: 'export-current-file',
              onSelect: () => onExportCurrentFile(trigger),
              section: 'export',
              title: 'Export current file…',
            },
            {
              disabled: annotationCount === 0,
              icon: 'file-down',
              id: 'export-ink-report',
              onSelect: onExportInkReport,
              section: 'export',
              title: 'Export Ink report…',
            },
          ]}
          label="More actions"
        />
      </div>
    </>
  );
  if (!showScope) return actions;
  return (
    <header className="inkstone-sidebar__header">
      <div aria-label="Annotation scope" className="inkstone-sidebar__scope" role="tablist">
        <button
          aria-label="Current file"
          aria-pressed="true"
          aria-selected="true"
          role="tab"
          type="button"
        >
          <ObsidianIcon className="inkstone-sidebar__scope-icon" icon="file-text" />
          <span className="inkstone-sidebar__scope-label">Current file</span>
        </button>
        <button
          aria-label="Entire Vault"
          aria-pressed="false"
          aria-selected="false"
          onClick={() => {
            void Promise.resolve(onEntireVault()).then(() =>
              document
                .querySelector<HTMLButtonElement>(
                  '.inkstone-sidebar__scope button[aria-pressed="true"]',
                )
                ?.focus({ preventScroll: true }),
            );
          }}
          role="tab"
          type="button"
        >
          <ObsidianIcon className="inkstone-sidebar__scope-icon" icon="library" />
          <span className="inkstone-sidebar__scope-label">Entire Vault</span>
        </button>
      </div>
      {actions}
    </header>
  );
}

function SearchField({ state }: { readonly state: CurrentFileSidebarStore }) {
  return (
    <label className="inkstone-sidebar__search">
      <ObsidianIcon icon="search" />
      <input
        aria-label="Search current file annotations"
        disabled={state.selectionMode.value}
        onInput={(event) => {
          state.searchQuery.value = event.currentTarget.value;
        }}
        placeholder="Search annotations"
        type="search"
        value={state.searchQuery.value}
      />
    </label>
  );
}

function StorageHealth({
  health,
  onReviewConflicts,
}: {
  readonly health: { readonly conflictCount: number; readonly readIssueCount: number };
  readonly onReviewConflicts: (invoker: HTMLElement) => void;
}) {
  if (health.conflictCount === 0 && health.readIssueCount === 0) return null;
  const messages = [
    ...(health.conflictCount === 0
      ? []
      : [
          `${health.conflictCount} ${health.conflictCount === 1 ? 'conflict needs' : 'conflicts need'} repair`,
        ]),
    ...(health.readIssueCount === 0
      ? []
      : [
          `${health.readIssueCount} ${health.readIssueCount === 1 ? "file couldn't" : "files couldn't"} be read`,
        ]),
  ];
  return (
    <div className="inkstone-sidebar__storage-alert" role="alert">
      {messages.join('. ')}. Canonical artifacts were preserved.
      {health.conflictCount === 0 ? null : (
        <button
          aria-label="Review annotation conflicts"
          onClick={(event) => onReviewConflicts(event.currentTarget)}
          type="button"
        >
          Review conflicts
        </button>
      )}
    </div>
  );
}

function visibleUntil(deletedAt: string | undefined, now: number): boolean {
  if (deletedAt === undefined) return true;
  const timestamp = Date.parse(deletedAt);
  return Number.isFinite(timestamp) && now < timestamp + 5_000;
}

function currentSelectionKey(kind: 'ink' | 'text', id: string): string {
  return `${kind}:${id}`;
}

function toggleCurrentSelection(state: CurrentFileSidebarStore, key: string): void {
  const selected = new Set(state.selectedKeys.value);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  state.selectedKeys.value = selected;
}

function textSearchText(row: {
  readonly notePreview: string | null;
  readonly quote: string;
  readonly status: string;
  readonly tags: readonly string[];
}): string {
  return [row.quote, row.notePreview ?? '', row.status, ...row.tags].join(' ');
}

function inkSearchText(summary: InkSurfaceSummary): string {
  return [summary.headingPath.join(' '), summary.status, `${summary.strokeCount} strokes`].join(
    ' ',
  );
}
