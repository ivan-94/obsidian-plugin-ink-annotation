import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import type {
  AnnotationIndexEntry,
  VaultAnnotationFilters,
  VaultAnnotationIndex,
} from '../../domain/vault-annotation-index';
import { mapVaultAnnotation } from '../models/annotation-list-item-model';
import { EmptyState } from '../primitives/empty-state';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { ExternalRoot } from '../runtime/external-root';
import type { VaultSidebarStore } from '../stores/annotation-sidebar-store';
import { BulkActionDock } from './bulk-action-dock';
import { BulkActionDialog } from './bulk-action-dialog';
import { GroupedVirtualList } from './grouped-virtual-list';
import { SelectionModeHeaderActions } from './selection-mode-header-actions';
import { useDismissibleMenu } from './use-dismissible-menu';
import {
  type BulkOutcome,
  type BulkSelectionSnapshot,
  type SelectOption,
  toBulkSnapshot,
  vaultEntryKey,
} from './vault-sidebar-types';

const VAULT_GROUP_HEIGHT = 42;
const VAULT_ROW_HEIGHT = 72;
const VAULT_ROW_CARD_HEIGHT = 66;

type VaultVirtualItem =
  | {
      readonly entries: readonly AnnotationIndexEntry[];
      readonly filePath: string;
      readonly kind: 'group';
      readonly total: number;
    }
  | { readonly entry: AnnotationIndexEntry; readonly kind: 'row' };

export interface VaultAnnotationSidebarAppProps {
  readonly document: Document;
  readonly headerContainer?: HTMLElement;
  readonly index: VaultAnnotationIndex;
  readonly onBulkAddTags: (
    selection: readonly BulkSelectionSnapshot[],
    tags: readonly string[],
  ) => Promise<BulkOutcome>;
  readonly onBulkChangeStyle: (
    selection: readonly BulkSelectionSnapshot[],
    styleId: string,
  ) => Promise<BulkOutcome>;
  readonly onBulkCopy: (entries: readonly AnnotationIndexEntry[]) => Promise<void>;
  readonly onBulkDelete: (selection: readonly BulkSelectionSnapshot[]) => Promise<BulkOutcome>;
  readonly onCurrentFile: () => void | Promise<void>;
  readonly onEdit?: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
  readonly onExport: (entries: readonly AnnotationIndexEntry[], invoker: HTMLElement) => void;
  readonly onOpen: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
  readonly onRenderNow: () => void;
  readonly onRequestFrame: () => void;
  readonly onResetSearchAndFilters: () => void;
  readonly onSearch: (value: string) => void;
  readonly showScope: boolean;
  readonly state: VaultSidebarStore;
  readonly styleOptions: readonly SelectOption[];
}

export function VaultAnnotationSidebarApp(props: VaultAnnotationSidebarAppProps) {
  const { state } = props;
  if (state.status.value === 'building') {
    const { completed, total } = state.buildingProgress.value;
    return (
      <>
        {props.showScope ? <VaultScope {...props} /> : null}
        <p data-inkstone-vault-state="building">
          Index building {completed} of {total}
        </p>
      </>
    );
  }
  if (state.status.value === 'unavailable') {
    return (
      <>
        {props.showScope ? <VaultScope {...props} /> : null}
        <p data-inkstone-vault-state="unavailable" role="alert">
          {state.unavailableMessage.value}
        </p>
      </>
    );
  }
  if (state.status.value !== 'ready') return null;
  return <VaultReadyApp {...props} />;
}

function VaultReadyApp(props: VaultAnnotationSidebarAppProps) {
  const { state } = props;
  const result = props.index.query({
    filters: state.filters.value,
    text: state.searchQuery.value,
  });
  state.queryResult.value = result;
  const header = <VaultHeader entries={flattenResult(result)} {...props} />;
  const sortedGroups = useMemo(
    () => sortGroups(result.groups, state.sort.value),
    [result.groups, state.sort.value],
  );
  const items = useMemo(
    () =>
      sortedGroups.flatMap((group) => [
        {
          entries: group.rows,
          filePath: group.filePath,
          kind: 'group' as const,
          total: group.rows.length,
        },
        ...(state.collapsedGroups.value.has(group.filePath)
          ? []
          : group.rows.map((entry) => ({ entry, kind: 'row' as const }))),
      ]),
    [sortedGroups, state.collapsedGroups.value],
  );
  const selectedEntries = props.index
    .snapshot()
    .filter((entry) => state.selectedKeys.value.has(vaultEntryKey(entry)));

  return (
    <>
      {props.headerContainer === undefined ? (
        header
      ) : (
        <ExternalRoot host={props.headerContainer}>{header}</ExternalRoot>
      )}
      <VaultToolbar {...props} />
      <FilterChips {...props} />
      <div className="inkstone-vault-results" data-inkstone-vault-results="">
        {result.state === 'ready' ? (
          <GroupedVirtualList
            itemHeight={virtualItemHeight}
            itemKey={virtualItemKey}
            items={items}
            onScrollOffsetChange={(offset) => {
              state.scrollOffset.value = offset;
              props.onRequestFrame();
            }}
            overscanPx={180}
            renderItem={(item) =>
              item.kind === 'group' ? (
                <VaultGroupHeader
                  entries={item.entries}
                  filePath={item.filePath}
                  total={item.total}
                  {...props}
                />
              ) : (
                <VaultAnnotationRow entry={item.entry} {...props} />
              )
            }
            scrollOffset={state.scrollOffset.value}
          />
        ) : (
          <div className="inkstone-sidebar__empty" data-inkstone-vault-state={result.state}>
            <EmptyState
              {...(result.state === 'no-matches'
                ? {
                    action: {
                      icon: 'rotate-ccw',
                      label: 'Clear search and filters',
                      onSelect: props.onResetSearchAndFilters,
                    },
                  }
                : {})}
              description={
                result.state === 'no-annotations'
                  ? 'Annotations from the entire Vault will appear here.'
                  : 'Edit the search above or clear the current search and filters.'
              }
              icon={result.state === 'no-annotations' ? 'library' : 'search-x'}
              title={result.state === 'no-annotations' ? 'No annotations' : 'No matching results'}
            />
          </div>
        )}
      </div>
      <BulkActionBar entries={selectedEntries} {...props} />
      <VaultBulkDialog entries={selectedEntries} {...props} />
    </>
  );
}

function VaultHeader({
  document,
  entries,
  onExport,
  onRenderNow,
  showScope,
  state,
  ...props
}: VaultAnnotationSidebarAppProps & { readonly entries: readonly AnnotationIndexEntry[] }) {
  const dismissible = useDismissibleMenu(document);
  const actions = state.bulkSelectionMode.value ? (
    <SelectionModeHeaderActions
      onDeselectAll={() => {
        state.selectedKeys.value = new Set();
        onRenderNow();
      }}
      onDone={() => {
        state.bulkSelectionMode.value = false;
        state.selectedKeys.value = new Set();
        onRenderNow();
      }}
      onSelectAll={() => {
        state.selectedKeys.value = new Set(entries.map(vaultEntryKey));
        onRenderNow();
      }}
      selectedCount={state.selectedKeys.value.size}
      totalCount={entries.length}
    />
  ) : (
    <>
      <div className="inkstone-sidebar__header-actions">
        <span aria-label="Sync status unavailable" className="inkstone-visually-hidden">
          <ObsidianIcon icon="cloud-off" />
          Sync status unavailable
        </span>
        <button
          aria-label="Refresh annotation index"
          className="inkstone-icon-button"
          onClick={onRenderNow}
          type="button"
        >
          <ObsidianIcon icon="refresh-cw" />
        </button>
        <button
          aria-expanded="false"
          aria-haspopup="menu"
          aria-label="More actions"
          className="inkstone-icon-button"
          onClick={() => dismissible.controller.current?.toggle()}
          ref={dismissible.trigger}
          type="button"
        >
          <ObsidianIcon icon="ellipsis" />
        </button>
      </div>
      <div className="inkstone-sidebar__overflow-menu" hidden ref={dismissible.menu} role="menu">
        <button
          aria-label={state.bulkSelectionMode.value ? 'Exit bulk mode' : 'Enter bulk mode'}
          className="inkstone-icon-button"
          onClick={() => {
            dismissible.controller.current?.close();
            state.bulkSelectionMode.value = !state.bulkSelectionMode.value;
            if (!state.bulkSelectionMode.value) state.selectedKeys.value = new Set();
            onRenderNow();
          }}
          role="menuitem"
          type="button"
        >
          <ObsidianIcon icon="list-checks" />
          <span className="inkstone-icon-button__label">
            {state.bulkSelectionMode.value ? 'Done selecting' : 'Select multiple…'}
          </span>
        </button>
        <button
          aria-label="Export current results"
          className="inkstone-icon-button"
          onClick={(event) => {
            dismissible.controller.current?.close();
            onExport(entries, event.currentTarget);
          }}
          role="menuitem"
          type="button"
        >
          <ObsidianIcon icon="share" />
          <span className="inkstone-icon-button__label">Export results…</span>
        </button>
      </div>
    </>
  );
  if (!showScope) return actions;
  return (
    <header className="inkstone-sidebar__header">
      <VaultScope onCurrentFile={props.onCurrentFile} />
      {actions}
    </header>
  );
}

function VaultScope({ onCurrentFile }: { readonly onCurrentFile: () => void | Promise<void> }) {
  return (
    <div aria-label="Annotation scope" className="inkstone-sidebar__scope" role="tablist">
      <button
        aria-pressed="false"
        aria-selected="false"
        onClick={(event) => {
          const root = event.currentTarget.closest('.inkstone-sidebar');
          void Promise.resolve(onCurrentFile()).then(() =>
            root
              ?.querySelector<HTMLButtonElement>(
                '.inkstone-sidebar__scope button[aria-pressed="true"]',
              )
              ?.focus({ preventScroll: true }),
          );
        }}
        role="tab"
        type="button"
      >
        Current file
      </button>
      <button aria-pressed="true" aria-selected="true" role="tab" type="button">
        Entire Vault
      </button>
    </div>
  );
}

function VaultToolbar(props: VaultAnnotationSidebarAppProps) {
  const { index, onRenderNow, onSearch, state } = props;
  const facets = index.facets();
  const dismissible = useDismissibleMenu(props.document);
  const activeFilters = filterChips(state.filters.value, facets);
  return (
    <>
      <div className="inkstone-vault-toolbar">
        <label className="inkstone-vault-search">
          <ObsidianIcon icon="search" />
          <input
            aria-label="Search annotations"
            disabled={state.bulkSelectionMode.value}
            onInput={(event) => onSearch(event.currentTarget.value)}
            placeholder={`Search ${index.snapshot().length.toLocaleString()} ${index.snapshot().length === 1 ? 'annotation' : 'annotations'}…`}
            type="search"
            value={state.searchInput.value}
          />
        </label>
        <button
          aria-expanded="false"
          aria-haspopup="true"
          aria-label="Filter annotations"
          className="inkstone-icon-button inkstone-vault-filter-toggle"
          onClick={() => {
            if (dismissible.controller.current?.toggle() === true) {
              dismissible.menu.current?.querySelector<HTMLElement>('select')?.focus();
            }
          }}
          ref={dismissible.trigger}
          type="button"
        >
          <ObsidianIcon icon="list-filter" />
          <span className="inkstone-icon-button__label">
            {activeFilters.length === 0
              ? 'All'
              : activeFilters.length === 1 && activeFilters[0]?.name === 'type'
                ? activeFilters[0].valueLabel
                : `${activeFilters.length} filters`}
          </span>
        </button>
        <button
          aria-label={state.sort.value === 'updated' ? 'Sort: Updated' : 'Sort: Document order'}
          className="inkstone-icon-button"
          onClick={() => {
            state.sort.value = state.sort.value === 'updated' ? 'document' : 'updated';
            onRenderNow();
          }}
          title={state.sort.value === 'updated' ? 'Sort: Updated' : 'Sort: Document order'}
          type="button"
        >
          <ObsidianIcon icon="arrow-up-down" />
        </button>
      </div>
      <VaultFilterMenu dismissible={dismissible} facets={facets} {...props} />
    </>
  );
}

function VaultFilterMenu({
  dismissible,
  facets,
  onRenderNow,
  state,
}: VaultAnnotationSidebarAppProps & {
  readonly dismissible: ReturnType<typeof useDismissibleMenu>;
  readonly facets: ReturnType<VaultAnnotationIndex['facets']>;
}) {
  const filters = state.filters.value;
  const update = (key: string, value: string): void => {
    state.filters.value = updateFilter(filters, key, value);
    state.scrollOffset.value = 0;
    onRenderNow();
  };
  return (
    <div
      aria-label="Annotation filters"
      className="inkstone-vault-filters inkstone-vault-filters--popover"
      hidden
      ref={dismissible.menu}
      role="group"
    >
      <FilterSelect
        label="Filter by type"
        onChange={(value) => update('types', value)}
        options={[
          ['', 'All types'],
          ['highlight', 'Highlight'],
          ['underline', 'Underline'],
          ['note', 'Note'],
          ['ink', 'Ink'],
        ]}
        value={filters.types?.[0] ?? ''}
      />
      <FilterSelect
        label="Filter by tag"
        onChange={(value) => update('tags', value)}
        options={[['', 'All tags'], ...facets.tags.map((tag) => [tag, tag] as const)]}
        value={filters.tags?.[0] ?? ''}
      />
      <FilterSelect
        label="Filter by status"
        onChange={(value) => update('statuses', value)}
        options={[
          ['', 'All statuses'],
          ['active', 'Active'],
          ['draft', 'Draft'],
          ['resolved', 'Resolved'],
          ['unanchored', 'Unanchored'],
          ['needs-rebase', 'Needs rebase'],
        ]}
        value={filters.statuses?.[0] ?? ''}
      />
      <FilterSelect
        label="Filter by style"
        onChange={(value) => update('styleIds', value)}
        options={[['', 'All styles'], ...facets.styles.map(({ id, name }) => [id, name] as const)]}
        value={filters.styleIds?.[0] ?? ''}
      />
      <FilterSelect
        label="Filter by folder"
        onChange={(value) => update('folders', value)}
        options={[
          ['', 'All folders'],
          ...facets.folders.map((folder) => [folder, folder] as const),
        ]}
        value={filters.folders?.[0] ?? ''}
      />
      <FilterSelect
        label="Filter by note"
        onChange={(value) => update('noteIds', value)}
        options={[
          ['', 'All notes'],
          ...facets.notes.map(({ filePath, noteId }) => [noteId, filePath] as const),
        ]}
        value={filters.noteIds?.[0] ?? ''}
      />
      <input
        aria-label="Updated after"
        onChange={(event) => update('updatedAfter', event.currentTarget.value)}
        type="date"
        value={filters.updatedAfter?.slice(0, 10) ?? ''}
      />
      <input
        aria-label="Updated before"
        onChange={(event) => update('updatedBefore', event.currentTarget.value)}
        type="date"
        value={filters.updatedBefore?.slice(0, 10) ?? ''}
      />
    </div>
  );
}

function FilterSelect({
  label,
  onChange,
  options,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly value: string;
}) {
  return (
    <select
      aria-label={label}
      onChange={(event) => onChange(event.currentTarget.value)}
      value={value}
    >
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>
          {optionLabel}
        </option>
      ))}
    </select>
  );
}

function FilterChips({ index, onRenderNow, state }: VaultAnnotationSidebarAppProps) {
  const chips = filterChips(state.filters.value, index.facets());
  return (
    <div className="inkstone-vault-filter-chips">
      {chips.map((chip) => (
        <button
          aria-label={`Remove ${chip.name} filter`}
          key={chip.name}
          onClick={() => {
            state.filters.value = updateFilter(state.filters.value, chip.key, '');
            state.scrollOffset.value = 0;
            onRenderNow();
          }}
          type="button"
        >
          {chip.label}: {chip.valueLabel} ×
        </button>
      ))}
    </div>
  );
}

function VaultGroupHeader({
  entries,
  filePath,
  onRenderNow,
  state,
  total,
}: VaultAnnotationSidebarAppProps & {
  readonly entries: readonly AnnotationIndexEntry[];
  readonly filePath: string;
  readonly total: number;
}) {
  const expanded = !state.collapsedGroups.value.has(filePath);
  const keys = entries.map(vaultEntryKey);
  const selectedCount = keys.filter((key) => state.selectedKeys.value.has(key)).length;
  const allSelected = total > 0 && selectedCount === total;
  const toggleExpanded = (): void => {
    const collapsed = new Set(state.collapsedGroups.value);
    if (collapsed.has(filePath)) collapsed.delete(filePath);
    else collapsed.add(filePath);
    state.collapsedGroups.value = collapsed;
    onRenderNow();
  };
  return (
    <div
      aria-expanded={expanded}
      className="inkstone-vault-group-header"
      data-note-group={filePath}
      style={{ height: `${VAULT_GROUP_HEIGHT}px` }}
    >
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${filePath}`}
        className="inkstone-vault-group-header__toggle"
        onClick={toggleExpanded}
        type="button"
      >
        <ObsidianIcon icon="file-text" />
        <strong title={filePath}>{filePath}</strong>
      </button>
      {state.bulkSelectionMode.value ? (
        <GroupSelectionCheckbox
          allSelected={allSelected}
          filePath={filePath}
          partiallySelected={selectedCount > 0 && !allSelected}
          onToggle={() => {
            const selected = new Set(state.selectedKeys.value);
            if (allSelected) keys.forEach((key) => selected.delete(key));
            else keys.forEach((key) => selected.add(key));
            state.selectedKeys.value = selected;
            onRenderNow();
          }}
        />
      ) : null}
      <span className="inkstone-vault-group-header__count">{total}</span>
      <button
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${filePath}`}
        className="inkstone-vault-group-header__collapse"
        onClick={toggleExpanded}
        type="button"
      >
        <ObsidianIcon icon="chevron-down" />
      </button>
    </div>
  );
}

function GroupSelectionCheckbox({
  allSelected,
  filePath,
  onToggle,
  partiallySelected,
}: {
  readonly allSelected: boolean;
  readonly filePath: string;
  readonly onToggle: () => void;
  readonly partiallySelected: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (input.current !== null) input.current.indeterminate = partiallySelected;
  }, [partiallySelected]);
  return (
    <input
      aria-label={`${allSelected ? 'Deselect' : 'Select'} all annotations in ${filePath}`}
      checked={allSelected}
      className="inkstone-vault-group-header__selection"
      onClick={onToggle}
      ref={input}
      type="checkbox"
    />
  );
}

function VaultAnnotationRow(
  props: VaultAnnotationSidebarAppProps & {
    readonly entry: AnnotationIndexEntry;
  },
) {
  const { document, entry, onEdit, onExport, onOpen, onRenderNow, state } = props;
  const dismissible = useDismissibleMenu(document);
  const model = mapVaultAnnotation(entry);
  const selected = state.selectedKeys.value.has(vaultEntryKey(entry));
  const metadata = model.metadata;
  const toggleSelection = (): void => {
    const key = vaultEntryKey(entry);
    const keys = new Set(state.selectedKeys.value);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    state.selectedKeys.value = keys;
    onRenderNow();
  };
  return (
    <div
      aria-selected={state.bulkSelectionMode.value ? selected : undefined}
      className="inkstone-vault-row"
      data-inkstone-bulk-selection={state.bulkSelectionMode.value ? 'true' : 'false'}
      data-inkstone-entry-status={entry.conflict ? 'conflict' : entry.status}
      data-inkstone-entry-type={entry.type}
      data-note-group={entry.filePath}
      onClick={state.bulkSelectionMode.value ? toggleSelection : undefined}
      onKeyDown={
        state.bulkSelectionMode.value
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              toggleSelection();
            }
          : undefined
      }
      style={{ height: `${VAULT_ROW_CARD_HEIGHT}px` }}
      tabIndex={state.bulkSelectionMode.value ? 0 : undefined}
    >
      <ObsidianIcon
        className="inkstone-vault-row__type-icon"
        icon={model.leading.kind === 'icon' ? model.leading.icon : 'waves'}
      />
      <button
        className="inkstone-sidebar-row__summary"
        data-annotation-id={entry.id}
        onClick={
          state.bulkSelectionMode.value ? undefined : (event) => onOpen(entry, event.currentTarget)
        }
        tabIndex={state.bulkSelectionMode.value ? -1 : undefined}
        type="button"
      >
        <span className="inkstone-vault-row__quote" title={model.title}>
          {model.title}
        </span>
        <span
          className="inkstone-vault-row__metadata"
          title={metadata.map((token) => token.label).join(' · ')}
        >
          {metadata.map((token, index) => (
            <span
              className={
                token.tone === 'warning' ? 'inkstone-vault-row__metadata--warning' : undefined
              }
              key={`${token.kind}:${token.label}:${index}`}
            >
              {token.label}
            </span>
          ))}
        </span>
      </button>
      {state.bulkSelectionMode.value ? (
        <input
          aria-label={`Select annotation ${entry.id}`}
          checked={selected}
          onClick={(event) => {
            event.stopPropagation();
            toggleSelection();
          }}
          type="checkbox"
        />
      ) : (
        <>
          <button
            aria-expanded="false"
            aria-haspopup="menu"
            aria-label={`Open actions for ${entry.quote}`}
            className="inkstone-icon-button"
            data-inkstone-vault-actions={entry.id}
            onClick={(event) => {
              if (dismissible.controller.current?.toggle() !== true) return;
              const viewportRect = event.currentTarget
                .closest('.inkstone-vault-virtual-list')
                ?.getBoundingClientRect();
              const triggerRect = event.currentTarget.getBoundingClientRect();
              dismissible.menu.current?.classList.toggle(
                'inkstone-vault-row__menu--upward',
                viewportRect !== undefined &&
                  viewportRect.bottom - triggerRect.bottom < 132 &&
                  triggerRect.top - viewportRect.top > 132,
              );
              dismissible.menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
            }}
            ref={dismissible.trigger}
            type="button"
          >
            <ObsidianIcon icon="ellipsis" />
          </button>
          <div
            className="inkstone-vault-row__menu"
            data-inkstone-vault-menu={entry.id}
            hidden
            ref={dismissible.menu}
            role="menu"
          >
            <VaultMenuButton
              icon="external-link"
              label={`Open source for ${entry.quote}`}
              onClick={() => {
                dismissible.controller.current?.close();
                if (dismissible.trigger.current !== null)
                  onOpen(entry, dismissible.trigger.current);
              }}
              text="Open source"
            />
            {onEdit === undefined ? null : (
              <VaultMenuButton
                icon="square-pen"
                label={`Edit ${entry.quote}`}
                onClick={() => {
                  dismissible.controller.current?.close();
                  if (dismissible.trigger.current !== null)
                    onEdit(entry, dismissible.trigger.current);
                }}
                text="Edit"
              />
            )}
            <VaultMenuButton
              icon="share"
              label={`Export ${entry.quote}`}
              onClick={() => {
                dismissible.controller.current?.close();
                if (dismissible.trigger.current !== null)
                  onExport([entry], dismissible.trigger.current);
              }}
              text="Export"
            />
          </div>
        </>
      )}
    </div>
  );
}

function VaultMenuButton({
  icon,
  label,
  onClick,
  text,
}: {
  readonly icon: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly text: string;
}) {
  return (
    <button
      aria-label={label}
      className="inkstone-icon-button"
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      <ObsidianIcon icon={icon} />
      <span className="inkstone-icon-button__label">{text}</span>
    </button>
  );
}

function BulkActionBar({
  entries,
  onBulkCopy,
  onExport,
  onRenderNow,
  state,
}: VaultAnnotationSidebarAppProps & {
  readonly entries: readonly AnnotationIndexEntry[];
}) {
  const hasInk = entries.some((entry) => entry.type === 'ink');
  const snapshot = entries.map(toBulkSnapshot);
  if (!state.bulkSelectionMode.value) return null;
  const copy = (): void => {
    state.bulkFeedback.value = 'Copying…';
    onRenderNow();
    void onBulkCopy(entries).then(
      () => {
        state.bulkFeedback.value = 'Copied';
        onRenderNow();
      },
      (error) => {
        state.bulkFeedback.value = error instanceof Error ? error.message : String(error);
        onRenderNow();
      },
    );
  };
  return (
    <BulkActionDock
      copyFeedback={state.bulkFeedback.value}
      hasInk={hasInk}
      onCopy={copy}
      onDelete={() => openDialog(state, onRenderNow, 'delete', snapshot)}
      onExport={(invoker) => onExport(entries, invoker)}
      onStyle={() => openDialog(state, onRenderNow, 'style', snapshot)}
      onTags={() => openDialog(state, onRenderNow, 'tags', snapshot)}
      selectedCount={entries.length}
    />
  );
}

function VaultBulkDialog(
  props: VaultAnnotationSidebarAppProps & {
    readonly entries: readonly AnnotationIndexEntry[];
  },
) {
  const { index, onBulkAddTags, onBulkChangeStyle, onBulkDelete, onRenderNow, state } = props;
  const dialog = state.bulkDialog.value;
  const input = useRef<HTMLInputElement>(null);
  const style = useRef<HTMLSelectElement>(null);
  if (dialog === null) return null;
  const close = (): void => {
    state.bulkDialog.value = null;
    state.bulkFeedback.value = null;
    onRenderNow();
  };
  const run = (operation: Promise<BulkOutcome>): void => {
    state.bulkPending.value = true;
    state.bulkFeedback.value = null;
    onRenderNow();
    void operation.then(
      (outcome) => {
        retainFailed(index, state, outcome.failed);
        state.bulkPending.value = false;
        state.bulkDialog.value = null;
        onRenderNow();
      },
      (error) => {
        state.bulkPending.value = false;
        state.bulkFeedback.value = error instanceof Error ? error.message : String(error);
        onRenderNow();
      },
    );
  };
  const styles = uniqueOptions(
    props.styleOptions.length > 0
      ? props.styleOptions
      : index.facets().styles.map(({ id, name }) => [id, name] as const),
  );
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
      description={dialog.kind === 'delete' ? 'This action cannot be undone.' : undefined}
      feedback={state.bulkFeedback.value}
      icon={dialog.kind === 'delete' ? 'trash-2' : dialog.kind === 'tags' ? 'tag' : 'scan-text'}
      onCancel={close}
      onConfirm={() => {
        if (dialog.kind === 'delete') run(onBulkDelete(dialog.selection));
        else if (dialog.kind === 'tags') {
          const tags = (input.current?.value ?? '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
          if (tags.length > 0) run(onBulkAddTags(dialog.selection, tags));
        } else {
          const styleId = style.current?.value ?? '';
          if (styleId.length > 0) run(onBulkChangeStyle(dialog.selection, styleId));
        }
      }}
      pending={state.bulkPending.value}
      title={
        dialog.kind === 'delete'
          ? `Delete ${dialog.selection.length} ${dialog.selection.length === 1 ? 'annotation' : 'annotations'}?`
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
          {styles.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      )}
    </BulkActionDialog>
  );
}

function openDialog(
  state: VaultSidebarStore,
  renderNow: () => void,
  kind: Exclude<NonNullable<VaultSidebarStore['bulkDialog']['value']>['kind'], never>,
  selection: readonly BulkSelectionSnapshot[],
): void {
  state.bulkDialog.value = { kind, selection };
  state.bulkFeedback.value = null;
  renderNow();
}

function retainFailed(
  index: VaultAnnotationIndex,
  state: VaultSidebarStore,
  failed: readonly BulkSelectionSnapshot[],
): void {
  const available = new Set(index.snapshot().map(vaultEntryKey));
  state.selectedKeys.value = new Set(
    failed.map((item) => `${item.noteId}\u0000${item.id}`).filter((key) => available.has(key)),
  );
}

function updateFilter(
  filters: VaultAnnotationFilters,
  key: string,
  value: string,
): VaultAnnotationFilters {
  const next: Record<string, unknown> = { ...filters };
  if (value.length === 0) delete next[key];
  else if (key === 'updatedAfter') next[key] = `${value}T00:00:00.000Z`;
  else if (key === 'updatedBefore') next[key] = `${value}T23:59:59.999Z`;
  else next[key] = [value];
  return next;
}

function filterChips(
  filters: VaultAnnotationFilters,
  facets: ReturnType<VaultAnnotationIndex['facets']>,
): readonly {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly valueLabel: string;
}[] {
  const values = [
    ['types', 'type', 'Type', filters.types?.[0], formatLabel(filters.types?.[0], [])],
    ['tags', 'tag', 'Tag', filters.tags?.[0], filters.tags?.[0]],
    ['statuses', 'status', 'Status', filters.statuses?.[0], formatLabel(filters.statuses?.[0], [])],
    [
      'styleIds',
      'style',
      'Style',
      filters.styleIds?.[0],
      formatLabel(
        filters.styleIds?.[0],
        facets.styles.map(({ id, name }) => [id, name]),
      ),
    ],
    ['folders', 'folder', 'Folder', filters.folders?.[0], filters.folders?.[0]],
    [
      'noteIds',
      'note',
      'Note',
      filters.noteIds?.[0],
      formatLabel(
        filters.noteIds?.[0],
        facets.notes.map(({ noteId, filePath }) => [noteId, filePath]),
      ),
    ],
    [
      'updatedAfter',
      'updated-after',
      'After',
      filters.updatedAfter,
      filters.updatedAfter?.slice(0, 10),
    ],
    [
      'updatedBefore',
      'updated-before',
      'Before',
      filters.updatedBefore,
      filters.updatedBefore?.slice(0, 10),
    ],
  ] as const;
  return values.flatMap(([key, name, label, value, valueLabel]) =>
    value === undefined ? [] : [{ key, label, name, valueLabel: valueLabel ?? value }],
  );
}

function formatLabel(
  value: string | undefined,
  options: readonly (readonly [string, string])[],
): string | undefined {
  if (value === undefined) return undefined;
  return (
    options.find(([id]) => id === value)?.[1] ??
    value.replaceAll('-', ' ').replace(/^./u, (letter) => letter.toUpperCase())
  );
}

function sortGroups(
  groups: readonly { readonly filePath: string; readonly rows: readonly AnnotationIndexEntry[] }[],
  sort: VaultSidebarStore['sort']['value'],
) {
  return [...groups]
    .map((group) => ({
      ...group,
      rows:
        sort === 'updated'
          ? [...group.rows].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          : group.rows,
    }))
    .sort((left, right) =>
      sort === 'document'
        ? left.filePath.localeCompare(right.filePath)
        : (right.rows[0]?.updatedAt ?? '').localeCompare(left.rows[0]?.updatedAt ?? '') ||
          left.filePath.localeCompare(right.filePath),
    );
}

function flattenResult(
  result: ReturnType<VaultAnnotationIndex['query']>,
): readonly AnnotationIndexEntry[] {
  return result.groups.flatMap((group) => group.rows);
}

function virtualItemHeight(item: VaultVirtualItem): number {
  return item.kind === 'group' ? VAULT_GROUP_HEIGHT : VAULT_ROW_HEIGHT;
}

function virtualItemKey(item: VaultVirtualItem): string {
  return item.kind === 'group' ? `group:${item.filePath}` : `row:${vaultEntryKey(item.entry)}`;
}

function uniqueOptions(values: readonly SelectOption[]): readonly SelectOption[] {
  const options = new Map<string, string>();
  for (const [id, label] of values) if (id.length > 0 && !options.has(id)) options.set(id, label);
  return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1]));
}
