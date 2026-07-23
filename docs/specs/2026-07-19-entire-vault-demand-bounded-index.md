# Entire Vault demand-bounded local Catalog and automated Gate

## Status

- Date: 2026-07-19
- Reassessed: 2026-07-23 against the Snapshot Annotation architecture and current production code
- Implementation started: 2026-07-23 after explicit user authorization
- Status: S35 Catalog core and S36 production cutover implemented; the deterministic 100k local
  adapter Gate passes. Installed-Obsidian host resource qualification remains release evidence, not
  a completed claim.
- UI scope: the existing visual shell is retained; data access, lazy group expansion, page-local
  selection, and generic bounded-search copy changed as required by S36.
- Implemented backend Slice: S35 core
- Implemented production cutover: S36
- Release qualification still open: installed-Obsidian database/heap/input-frame evidence and the
  full Source-Stamp/digest-repair resource protocol. The passing fake-IndexedDB Gate is adapter
  qualification, not a substitute for those host measurements.

This focused specification is authoritative when it conflicts with the full-memory Vault-index
assumptions in:

- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`, D-25 and Entire Vault;
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`, S07;
- `docs/specs/2026_07_15_refactor_to_preact.md`, R05/R06 and the 20k query Gate;
- `docs/delivery/slices/S07-vault-index/`, `R05-observable-index/`, and `R06-vault-preact/`.

It does not change canonical sidecar schemas, Current file behavior, annotation/Snapshot/Legacy Ink
lifecycle, Trash/garbage-collection policy, or existing UI in S35. The earlier documents remain the
historical record of the current implementation.

This reassessment also conforms to:

- `docs/specs/2026-07-22-snapshot-annotation-capture-and-markup.md`;
- `docs/delivery/slices/S2-snapshot-core-product/`;
- `docs/delivery/slices/S6-snapshot-release-reliability/`; and
- the 2026-07-22 retirement of new freehand creation/editing over live Markdown.

## Decision summary

`Entire Vault` means that a query can cover the whole Vault. It no longer means that every
annotation is restored into JavaScript memory or rendered by default.

The target behavior is:

1. Plugin startup does not open or rebuild the Vault Catalog.
2. Opening `Entire Vault` without a query reads at most 20 recent note summaries from a device-local
   database.
3. Expanding one note reads at most 50 annotation rows through keyset pagination.
4. The rest of the Vault stays on disk until the user enters text or an explicit filter.
5. Search scans only the lightweight local projection in bounded database batches; it is cancellable
   and yields between batches.
6. Text records, Legacy Ink canonical records, and Snapshot Annotation `record.json` files remain
   the only annotation authorities. Derived `ink-summaries.json` and Snapshot `summary.json` files
   are hints, never authority.
7. Runtime memory is proportional to the current page and a small cache, not to Vault size.
8. When the Catalog is closed, note-open and sidecar events do not open it; they enter bounded
   in-memory hint buffers and reconcile on the next explicit Catalog use.
9. Snapshot `linkState` and `sourceOrder` are derived from both the canonical Snapshot Source
   Binding and current Markdown. A changed Markdown source makes that note's Snapshot projection
   dirty until a bounded note-local recomputation completes.
10. Select all means all selectable rows in the currently loaded page, never every match in an
    unbounded query. Export-all walks cursors as a bounded stream.

```mermaid
flowchart LR
    T["Text and Legacy Ink canonical sidecars"] --> P["Incremental projector"]
    SNAP["Snapshot record.json"] --> P
    MD["Current Markdown source"] --> LINK["Snapshot link projector"]
    SNAP --> LINK
    LINK --> P
    SUM["Derived summary hints"] -. "never authority" .-> P
    V["Obsidian Vault events"] --> R["Bounded reconciler"]
    R --> P
    P --> DB[("Device-local IndexedDB via Dexie")]
    O["Note opened locally"] --> HINT["Bounded recent/dirty hints"]
    HINT -->|"next Catalog open"| DB
    DB --> N["Recent notes: max 20"]
    DB --> E["One-note page: max 50"]
    DB --> Q["Explicit search/filter: bounded batches"]
    N --> CACHE["Small runtime page cache"]
    E --> CACHE
    Q --> CACHE
```

## Problem statement

The current implementation bounds DOM nodes but not the data model.

`VaultAnnotationIndex` currently owns all list entries in a JavaScript `Map` and can retain several
additional O(N) representations:

- the primary `Map`;
- normalized search strings;
- the sorted snapshot;
- the searchable snapshot;
- facet arrays/maps;
- the last grouped query result.

`VaultIndexCache` serializes the whole projection to `.obsidian-annotations/v1/index.json`.
Restoring it parses the whole file and rebuilds the complete in-memory index. `VaultIndexBuilder`
also collects every projected entry in one array before replacing the index. `query()`,
`snapshot()`, facet calculation, selection hydration, rename, and some delete paths all assume a
full-memory collection.

Snapshot Annotation expanded that collection after this specification was first written. The current
builder now reads each note's Snapshot summaries and the current Markdown source to derive
`linkState` and `sourceOrder`, then adds Snapshot rows to the same complete entry array. The current
UI also calls `snapshot()` for selection hydration and exact search placeholder counts. Lazy
thumbnail rendering bounds image work but does not bound the list/query data model.

The 20,000-entry evidence from S07/R05/R06 proves that the virtualized UI materializes few DOM rows
and that the current machine can search a 20k in-memory array quickly. It does not prove any of the
following:

- retained memory is independent of Vault size;
- CPU remains bounded at 100k or 1M annotations;
- opening the scope does not deserialize the complete projection;
- external changes update only affected records;
- the index cannot compete with Pencil input or other foreground work;
- a parseable `ink-summaries.json` is fresh relative to canonical surfaces;
- a parseable Snapshot `summary.json` is fresh relative to `record.json`;
- Snapshot link state converges after Markdown changes or cross-device Snapshot synchronization;
- a completed Snapshot save never waits for an Entire Vault rebuild.

This is the wrong resource model for a mobile-first plugin. Virtualizing the final DOM is not enough
when the data, search text, facets, and query result are still fully materialized before rendering.

## Current runtime baseline and frozen diagnosis

"Full rebuild" in the current implementation does not read every Markdown file. It does read the
current Markdown source for every discovered note that has Snapshot index entries, and it normally
uses derived Snapshot/Legacy Ink summaries instead of complete vectors. It still rebuilds the
complete derived Entire Vault collection from every note that owns Inkstone sidecars, so its cost
grows with the total annotated Vault rather than with the current screen or changed source.

### Current trigger matrix

| Current trigger                                             | Current behavior                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Plugin startup                                              | Does not rebuild by itself.                                                                                                       |
| First switch to `Entire Vault` while its view is not fresh  | Restores the whole Vault `index.json` if available, then always starts one canonical full rebuild.                                |
| Re-enter `Entire Vault` while the same view remains fresh   | Reuses the in-memory index.                                                                                                       |
| External canonical create/modify/delete while scope is open | Coalesces events for 180 ms, then starts a full rebuild.                                                                          |
| External canonical event while `Current file` is active     | Refreshes the current projection, marks the Vault index stale, and defers the rebuild until `Entire Vault`.                       |
| Ordinary plugin-owned canonical write                       | Suppresses the matching file event and incrementally updates the ready in-memory index.                                           |
| Local Snapshot create/edit/delete/Restore/relink            | Marks the Vault index stale; while Entire Vault is active, Snapshot Done may await a full rebuild and other actions schedule one. |
| External Snapshot `record.json`/`summary.json` event        | Not recognized by the current canonical-sidecar event matcher; no exact Snapshot projection occurs.                               |
| Markdown source modify affecting Snapshot anchors           | Refreshes active-file Snapshot tracking but does not make Markdown a persisted Vault-index Source Stamp.                          |
| Markdown source delete/rename                               | Mutates the in-memory index directly and clears the monolithic cache; it does not immediately perform a rebuild.                  |
| Retry action                                                | Starts a full rebuild.                                                                                                            |

The 180 ms timer is only a trailing debounce. It does not bound work for a long iCloud/Sync stream:
events spaced beyond the debounce window can repeatedly abort an in-progress build and restart it
from the root. An external Ink surface event also starts an affected-note summary rebuild without
awaiting it before the Vault-wide rebuild is scheduled, so both jobs may overlap.

### Current rebuild process and cost model

One rebuild currently:

1. lists every directory under `.obsidian-annotations/v1/notes/`;
2. reads each `meta.json` sequentially;
3. uses four note workers by default;
4. lists and reads every text annotation JSON for each discovered note;
5. reads Legacy Ink summaries, falling back to canonical surface/document reads when that summary is
   absent or invalid;
6. lists and reads Snapshot `summary.json` files, falling back to `record.json`, and reads the
   owning Markdown source to derive link state and source order;
7. accumulates every active entry in a new JavaScript array while the previous Map remains usable;
8. retries the whole scan once if an incremental index mutation supersedes it;
9. replaces the complete in-memory Map, rebuilds search strings/snapshots on demand, serializes the
   complete sorted projection, and rewrites Vault `index.json`.

For `D` sidecar note roots, `A` text-record files, `L` Legacy Ink records/summaries, `S` Snapshot
records/summaries, `M` Markdown sources needed for Snapshot link projection, and `E` active
projected entries, a normal pass is approximately `O(D + A + L + S + M)` storage operations plus
`O(A + L + S + E log E)` main-thread decode/projection/sorting work. Peak memory may simultaneously
contain the old Map and its caches, the new entry array, decoded records/summaries, the replacement
Map, and the full JSON serialization string. The historical 20k local evidence measured a 73.16 MiB
heap increase even while the virtual list materialized only 18 rows. This behavior is the baseline
S35 must remove, not optimize in place.

## First-principles constraints

| ID    | Constraint                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EV-01 | Canonical text, Legacy Ink, and Snapshot `record.json` sidecars are authoritative; every index/cache/database projection is disposable.                       |
| EV-02 | `Entire Vault` is a query scope, not an eager materialization contract.                                                                                       |
| EV-03 | Default presentation is a bounded recent-note window, not a browse-all list.                                                                                  |
| EV-04 | Runtime memory must be O(current page + bounded batch + small LRU), not O(total annotations).                                                                 |
| EV-05 | IndexedDB owns persistent records, indexes, transactions, and ordered cursors; application code does not                                                      |
|       | implement another general-purpose database.                                                                                                                   |
| EV-06 | No index database or monolithic cache file is stored inside the Vault or synchronized through iCloud.                                                         |
| EV-07 | Vault events accelerate convergence but are not the sole correctness mechanism.                                                                               |
| EV-08 | Reconciliation reads file bodies only for sources whose identity or stat changed.                                                                             |
| EV-09 | Every query has a hard page/batch limit, an `AbortSignal`, and a versioned cursor.                                                                            |
| EV-10 | Snapshot Pencil/mouse input, Current file loading, and canonical persistence outrank search indexing and reconciliation.                                      |
| EV-11 | A local index failure may make Entire Vault temporarily unavailable; it must never block text/Snapshot creation, canonical saving, Current file, or recovery. |
| EV-12 | No full-text engine, Worker, WASM, or custom inverted index is added until the bounded database search Gate                                                   |
|       | proves it necessary.                                                                                                                                          |
| EV-13 | S35 does not change the UI and must not ship a second production index alongside the current one.                                                             |
| EV-14 | Opening a note or writing a canonical text/Legacy Ink/Snapshot record must not open a closed Catalog solely to keep a derived projection warm.                |
| EV-15 | Snapshot link projections depend on current Markdown; they cannot report `current` after a known Markdown change until the affected note is recomputed.       |
| EV-16 | Interactive selection is limited to explicitly loaded rows; export-all uses bounded cursor streaming rather than materializing all matches.                   |
| EV-17 | Catalog build/query/reconciliation reads zero Snapshot PNG bytes and retains zero Snapshot stroke arrays or Source Bindings in UI result pages.               |

## Goals

- Define an asynchronous, page-oriented application port for recent notes, one-note rows, search,
  filters, and bounded facet suggestions.
- Store the derived projection in a device-local IndexedDB database using a mature wrapper.
- Make local canonical writes, external sidecar changes, and Markdown dependency changes update only
  affected projections.
- Project Snapshot Annotation list/search metadata without loading Capture Assets and recompute
  Snapshot link state from bounded device-local Source Binding rows.
- Detect missed creates, modifications, deletions, and renames without parsing every unchanged
  sidecar.
- Make first build, repair, and schema replacement cancellable, resumable, and memory-bounded.
- Prove resource behavior at 20k and 100k scale in a real installed desktop Obsidian production
  host.
- Provide one automated local Gate command and machine-readable evidence.
- Preserve exact canonical-data safety and existing Current file behavior.

## Non-goals

- No UI changes in S35.
- No physical iPad session for S35; the acceptance Gate is local and automated.
- No canonical sidecar schema migration.
- No new authoritative Snapshot summary/manifest schema; `record.json` remains the commit point.
- No database file inside `.obsidian-annotations/`.
- No live SQLite database in the Vault.
- No native SQLite bridge, SQLite WASM/OPFS stack, server, telemetry, or remote search service.
- No fuzzy search, semantic search, OCR, handwriting recognition, or relevance-learning model.
- No custom token store or home-grown inverted index in the first implementation.
- No unbounded browse-all endpoint and no exact all-result count on the interactive query path.
- No automatic physical deletion of canonical records.
- No production dual-write to both the old in-memory index and the new database while UI still
  consumes only the old index.
- No Catalog read of Snapshot PNG assets and no thumbnail prewarming during inventory/rebuild.
- The original S35/S36 backend scope did not define mixed-type Snapshot mutations. The 2026-07-23 UI
  follow-up now defines page-local Snapshot Copy/Export/Delete/Restore without changing Catalog
  resource bounds or adding text-only Tags/Style semantics.

## Terminology

### Canonical sidecar

The text annotation record, Legacy Ink canonical record, or Snapshot Annotation `record.json` stored
under `.obsidian-annotations/v1/notes/`. It is the source of truth and participates in the user's
existing Vault synchronization. Derived `ink-summaries.json` and Snapshot `summary.json` files are
not canonical sidecars in this specification.

### Vault Catalog

The new application-facing name for the device-local, queryable projection. This avoids using
`Index` for both a product read model and a JavaScript container.

### Catalog Note

A note-level aggregate containing path, title, active annotation counts, problem counts, and recent
activity timestamps. It contains no array of all child entries.

### Catalog Entry

A lightweight text-annotation or Ink-surface row used for list display, structured filters, and
search. It may also be a Snapshot summary row. It never contains an Ink control trace, Snapshot
stroke array, Capture Asset bytes, Brush Geometry, Canvas pixels, mask, thumbnail SVG, or a Source
Binding in UI-facing results.

### Source Stamp

The device-local observation of one canonical sidecar, derived hint, or Markdown projection
dependency: authority class, kind, owning note/logical ID, `mtime`, size, optional content digest,
and projected revision/source revision.

### Reconciliation

A cold, cancellable comparison between the current canonical sidecar inventory, relevant Markdown
dependencies, and Source Stamps. It parses only new/changed sources and removes projections only
after an inventory pass completed.

### Snapshot Link Projection Dependency

The current Markdown source plus one Snapshot Source Binding. The Source Binding is copied into a
device-local internal Catalog table solely so one changed Markdown file can recompute its Snapshot
rows without rereading every Snapshot sidecar. It is never returned by query APIs or included in
search text. Losing it is harmless because canonical `record.json` can rebuild it.

### Projection Epoch

A monotonically increasing database value changed by every committed Catalog mutation. Query cursors
are valid only for the epoch in which they were issued.

## Product data-access contract

### Default state: recent notes only

With no search text and no explicit filter:

- return at most 20 `CatalogNoteSummary` rows;
- sort descending by `activityAt`, then stable `noteId`;
- return no child annotation arrays;
- provide no cursor that can turn this into browse-all;
- do not calculate global facets or an exact annotation total;
- do not open or parse canonical sidecars merely to satisfy the query.

`activityAt` is the maximum of:

- `lastAnnotatedAt`, derived from active canonical text, Legacy Ink, and Snapshot records; and
- `lastOpenedAt`, a device-local timestamp updated when the note is opened.

`lastOpenedAt` is disposable local state. It is not written into canonical sidecars and is not a
cross-device synchronization claim.

Opening a note while the Catalog database is closed records only a bounded 20-note in-memory hint.
It does not open IndexedDB. The hints are merged on the next explicit Catalog open; losing them in a
crash is acceptable because recency is not canonical data.

### Expanded note

Opening one recent/search result note group:

- returns at most 50 Catalog Entries;
- uses document-order keyset pagination `(position, rowId)`;
- never loads other notes;
- returns `nextCursor`/`hasMore`, not an array containing every child;
- invalidates the cursor with a typed `superseded` result if the Projection Epoch changes.

The group header may show the Catalog Note's active annotation count in default recent-note mode. In
explicit search/filter mode, a group contains only matches in the currently retained pages and must
not present that partial count as the exact number of all matches.

### Explicit Vault query

Non-empty normalized search text or at least one explicit filter enters query mode.

- Page size defaults to 30 and cannot exceed 50.
- The result is a flat bounded page plus note metadata needed to group that page.
- File grouping is a presentation over the at-most-three retained result pages. The same file may
  receive additional rows from a later page; no API materializes every row merely to make grouping
  complete.
- The default order is `updatedAt DESC, rowId DESC`.
- Pagination continues from the last scanned database key, not an integer offset.
- Exact total count is omitted. The response reports `hasMore` and scan progress.
- A query may return `partial` while a long on-demand scan continues; it must never pretend a
  partial page is a complete all-Vault result.
- A new query aborts the previous query before starting work.

### Facet suggestions

Facet discovery is also on demand and bounded:

- fixed enums (`type`, `status`, `conflict`) come from domain/schema definitions;
- styles come from plugin settings;
- note/folder/tag suggestions require a prefix and return at most 20 values;
- no method returns every note, folder, or tag as a runtime array;
- exact facet counts are not required on the interactive path.

### Bulk operations

Bulk actions operate on explicitly selected `(noteId, annotationId, expectedRevision)` snapshots.
`Select all` selects only selectable rows in the currently loaded page and therefore selects at most
50 rows. There is no implicit `select all matching` that materializes every result. Existing
revision-safe canonical mutation rules remain unchanged, and Snapshot rows remain excluded from
text-only Tags/Style mutations. Snapshot rows participate in page-local Copy/Export/Delete/Restore;
their revision snapshots and loaded-row limit follow the same bound.

Export-all is a separate application use case. It follows the query cursor, hydrates one bounded
page at a time, writes through an `AsyncIterable`, and releases each page before advancing. It never
turns query results into one complete runtime array.

### Runtime cache bounds

One Catalog instance may retain at most:

- 20 recent Catalog Note summaries;
- three entry/search pages, each no larger than 50 rows;
- one active database scan batch no larger than 128 rows;
- one current Markdown source and one at-most-100-row Snapshot-link recomputation batch;
- 20 pending recent-note hints;
- 256 Dirty Source Hint paths or one collapsed `needsReconcile` bit;
- query/filter/cursor metadata without duplicated annotation bodies.

Closing the scope clears pages and the active batch. An LRU eviction never writes canonical data and
never changes search correctness; an evicted page is read again from IndexedDB.

## Application ports

The UI-facing contract becomes asynchronous and page-oriented after the deferred S36 cutover:

```ts
interface VaultCatalogQueryPort {
  recentNotes(input?: {
    readonly limit?: number; // default 20, maximum 20
    readonly signal?: AbortSignal;
  }): Promise<RecentNotesResult>;

  entriesForNote(input: {
    readonly cursor?: CatalogCursor;
    readonly limit?: number; // default 30, maximum 50
    readonly noteId: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogEntryPage>;

  search(input: {
    readonly cursor?: CatalogCursor;
    readonly filters?: VaultCatalogFilters;
    readonly limit?: number; // default 30, maximum 50
    readonly signal?: AbortSignal;
    readonly text: string;
  }): Promise<VaultCatalogSearchPage>;

  suggestFacet(input: {
    readonly facet: 'folder' | 'note' | 'tag';
    readonly limit?: number; // maximum 20
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly FacetSuggestion[]>;
}

interface VaultCatalogProjectionPort {
  applyTextRecord(record: TextAnnotationRecord, source: SourceObservation): Promise<void>;
  applyLegacyInk(input: LegacyInkProjection): Promise<void>;
  applySnapshotRecord(input: SnapshotRecordProjection): Promise<void>;
  applyMarkdownDependency(input: MarkdownDependencyProjection): Promise<void>;
  removeSource(input: SourceRemoval): Promise<void>;
  renameNote(input: NoteRenameProjection): Promise<void>;
  recordNoteOpened(noteId: string, openedAt: string): Promise<void>;
}

interface CatalogResultMeta {
  readonly freshness: 'current' | 'reconciling' | 'stale';
  readonly projectionEpoch: number;
}
```

There is intentionally no `snapshot()`, synchronous `query()`, `rebuild(entries[])`, or
`facets(): all values` method.

Every public limit is validated. A caller cannot request `Number.MAX_SAFE_INTEGER`, omit an internal
scan batch limit, or reinterpret a search cursor under different query text/filters.

Canonical persistence callers do not await this projection port. They publish a lightweight event;
the Catalog session either enqueues it on an already-open write lane or records a bounded Dirty
Source Hint while closed.

## Database decision

### Selected baseline

Use IndexedDB through Dexie in `src/storage/`.

IndexedDB supplies persistent keyed records, secondary indexes, ordered cursors, and atomic
transactions. Dexie supplies declarative schema versions, compound/multi-entry indexes,
transactions, bulk operations, and browser implementation workarounds. This is narrower and less
error-prone than extending the project's purpose-built Snapshot Draft IndexedDB adapter into a
second general-purpose database layer.

The implementation spike must select and pin an exact currently supported Dexie version only after
real Obsidian desktop/mobile-safe bundle qualification. The 2026-07-19 version guess is retired.
Only the core `dexie` package is allowed; Dexie Cloud, React hooks, sync, observability, and network
addons are out of scope.

### Alternatives

| Alternative                         | Decision | Reason                                                                                   |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| Full JavaScript `Map`               | Reject   | O(Vault) retained memory and repeated O(N) caches/results.                               |
| Vault `index.json`                  | Retire   | Whole-file parse/rewrite, iCloud churn, stale-cache ambiguity, and no query paging.      |
| Raw IndexedDB throughout production | Reject   | Recreates schema, transaction, upgrade, cursor, and browser-workaround infrastructure.   |
| Native SQLite                       | Reject   | Not a portable Obsidian mobile plugin primitive and would require an unavailable bridge. |
| SQLite WASM/OPFS                    | Reject   | Adds WASM/Worker/filesystem complexity before evidence requires it.                      |
| FlexSearch persistent index         | Defer    | Adds a second index lifecycle; permit only after the bounded 100k search Gate fails.     |
| Custom inverted/token index         | Reject   | Reimplements a search database and increases write/storage amplification.                |

Dexie is not canonical storage. If the dependency cannot pass the production Obsidian spike, mobile
bundle scan, blocked-upgrade test, and resource Gate, the fallback is a small storage adapter over
native IndexedDB behind the same ports—not a return to the full-memory model.

## Local database placement and lifecycle

- Database family: `inkstone-vault-catalog-v1`.
- The database is device-local browser storage, separate from
  `inkstone-snapshot-annotation-drafts-v1`.
- It must be scoped to one Vault through a `VaultLocalIdentityPort`; the desktop implementation may
  hash a gated `FileSystemAdapter.getBasePath()`, while mobile/other adapters use a persistent local
  namespace and validate a stored Vault fingerprint.
- Raw Vault paths or annotation text must not appear in the database name.
- A fingerprint mismatch fails closed and creates a fresh derived database; it never serves another
  Vault's projection.
- Constructing plugin services does not open the database. Only explicit Catalog use, repair, or an
  already-open Catalog transaction may access it.
- Canonical and external events received while the database is closed enter a bounded Dirty Source
  Hint set. The set holds at most 256 normalized paths; overflow collapses to one `needsReconcile`
  bit. Neither case opens IndexedDB.
- Closing/switching away from Entire Vault clears page/search caches immediately and closes the
  Dexie connection after at most a 30-second idle grace period. The grace period retains no full
  Catalog arrays.
- `onunload` closes the Dexie connection and cancels all query/reconcile work.
- A `versionchange`/blocked upgrade closes the old connection; the Catalog reports unavailable
  rather than leaving a half-upgraded instance.
- Because the database is derived, schema changes do not perform unbounded in-place data migration.
  A new schema uses a new database generation and rebuilds lazily from canonical sources. The old
  generation is deleted only after the new generation is usable.

## Database schema v1

Schema notation below uses Dexie syntax. Exact TypeScript names may change during the S35.0 spike,
but key order and query purpose are frozen.

```ts
db.version(1).stores({
  meta: '&key',
  notes:
    '&noteId, &filePath, [activityAt+noteId], [lastAnnotatedAt+noteId], folder, titleNormalized',
  entries:
    '++rowId, &[noteId+annotationId], [noteId+position+rowId], [updatedAt+rowId], ' +
    'filePath, folder, type, status, styleId, conflict, *tagsNormalized',
  snapshotBindings: '&[noteId+annotationId], noteId, filePath, sourceRevision',
  sources: '&sourcePath, [noteId+kind+logicalId], noteId, authority, kind, projectedRevision',
});
```

### `meta`

Required keys:

- `schemaVersion`;
- `vaultFingerprint`;
- `projectionEpoch`;
- `lastCompletedReconcileEpoch`;
- `lastCompletedReconcileAt`;
- `reconcileState` (`idle` or an interrupted run descriptor);
- `databaseGeneration`;
- `cleanShutdown`.

`cleanShutdown` is a reconciliation hint, not a transaction log. A false value may schedule an
earlier inventory pass; it cannot make canonical data invalid.

### `notes`

```ts
interface CatalogNoteRow {
  readonly activityAt: string;
  readonly annotationCount: number;
  readonly conflictCount: number;
  readonly filePath: string;
  readonly folder: string;
  readonly legacyInkCount: number;
  readonly lastAnnotatedAt: string;
  readonly lastOpenedAt?: string;
  readonly noteId: string;
  readonly problemCount: number;
  readonly snapshotCount: number;
  readonly textCount: number;
  readonly title: string;
  readonly titleNormalized: string;
}
```

No note row embeds child Catalog Entries. Counts are updated in the same IndexedDB transaction as
the affected entry set. When removal affects a maximum timestamp, the new maximum is read through
the note/updated index rather than loading all child entries.

`problemCount` includes text/Legacy Ink problem states plus Snapshot `source-changed`/`unanchored`
link states. A Markdown-only link recomputation does not change `lastAnnotatedAt`; that timestamp is
derived from canonical annotation `updatedAt`, not from disposable projection work.

### `entries`

```ts
interface CatalogEntryRow {
  readonly annotationId: string;
  readonly body?: string;
  readonly capturedAt?: string;
  readonly conflict: 0 | 1;
  readonly filePath: string;
  readonly folder: string;
  readonly headingPath?: readonly string[];
  readonly linkState?: 'linked' | 'source-changed' | 'unanchored';
  readonly logicalHeight?: number;
  readonly logicalWidth?: number;
  readonly noteId: string;
  readonly position: number;
  readonly quote: string;
  readonly revision: number;
  readonly rowId?: number;
  readonly searchTextNormalized: string;
  readonly status: AnnotationIndexStatus;
  readonly strokeCount?: number;
  readonly styleId?: string;
  readonly styleName?: string;
  readonly tags: readonly string[];
  readonly tagsNormalized: readonly string[];
  readonly thumbnailKey?: string;
  readonly type: 'highlight' | 'ink' | 'note' | 'snapshot' | 'underline';
  readonly updatedAt: string;
}
```

`type: 'ink'` is retained as a storage/API compatibility value but means Legacy Ink. New freehand
creation produces `type: 'snapshot'` only.

Forbidden fields include:

- `points` or Brush Control Trace;
- contours, polygons, masks, meshes, geometry digests, or Canvas pixels;
- `thumbnailSvg` or other preview markup;
- Snapshot Source Bindings in the UI/search row;
- complete canonical records not needed for list/search;
- a precomputed array of tokens/ngrams.

`searchTextNormalized` preserves current case-insensitive NFKC substring semantics without building
an inverted index. It is computed once when projecting a changed record and stored on disk. Its
fields are quote, optional body, file path, tags, style name/ID, Legacy Ink/Snapshot heading,
Snapshot link state and stroke-count label, type, status, and conflict label.

### `snapshotBindings`

```ts
interface CatalogSnapshotBindingRow {
  readonly annotationId: string;
  readonly filePath: string;
  readonly noteId: string;
  readonly source: SnapshotSourceBinding;
  readonly sourceRevision: string;
}
```

This internal table is a disposable copy of the bounded 1–5-anchor Source Binding. It exists so one
Markdown body read can recompute all affected Snapshot rows through note-local batches without
rereading every Snapshot sidecar. Query/search APIs never return it, never include it in normalized
search text, and never load more than 100 bindings in one batch.

### `sources`

```ts
interface CatalogSourceRow {
  readonly authority: 'canonical' | 'derived-hint' | 'projection-dependency';
  readonly contentDigest?: string;
  readonly kind:
    | 'legacy-ink-document'
    | 'legacy-ink-summary'
    | 'legacy-ink-surface'
    | 'markdown-source'
    | 'meta'
    | 'snapshot-record'
    | 'snapshot-summary'
    | 'text-record';
  readonly logicalId: string;
  readonly mtime: number;
  readonly noteId: string;
  readonly projectedRevision?: number;
  readonly sourcePath: string;
  readonly sourceRevision?: string;
  readonly size: number;
}
```

Source Stamps permit deletion, rename, and missed-event detection without retaining a JavaScript
path map. A reconcile pass ordered-merges one completed Vault directory listing with a database
Source cursor; unchanged stamps are compared but not rewritten. Digest calculation is conditional:

- unchanged `(mtime, size)` skips body read;
- changed stat reads and parses the source;
- same stat with suspicious lifecycle evidence may compare a content digest;
- an unavailable/unhydrated source is retained as unknown and is never interpreted as deleted.

Snapshot `summary.json` has `authority: 'derived-hint'`. It may accelerate same-session projection
after the corresponding `record.json` was successfully committed and observed, but a cold/external
summary cannot by itself make a row current. First build/repair reads canonical Snapshot records one
at a time when freshness cannot be proven, extracts their compact row/binding, and immediately
releases stroke arrays. It never reads the referenced PNG.

Markdown Source Stamps cover only notes with Snapshot Binding rows. An offline-resume inventory
stats those Markdown files, reads bodies only when their observed stamp changed, and recomputes only
that note's Snapshot rows.

## Query execution

### Keyset pagination

Integer offsets are forbidden because deep offsets are O(N) and unstable under mutation. Cursors
contain:

- schema version;
- Projection Epoch;
- normalized query/filter digest;
- driver index and direction;
- last scanned compound key.

The cursor is opaque to callers and validated before use. A mismatched epoch/query returns
`superseded`; it never silently skips or duplicates rows under another query.

### Bounded search algorithm

The baseline search is a bounded IndexedDB scan, not an in-memory rebuild:

1. Normalize query text once with NFKC and locale-independent lowercase rules.
2. Use `[updatedAt+rowId]` descending as the single Vault-search driver so ordering and cursors stay
   deterministic. Apply text and structured filters within each bounded batch; do not implement a
   custom cost-based query planner.
3. Read at most 128 lightweight Catalog Entry rows in one transaction.
4. Apply remaining structured predicates and `searchTextNormalized.includes(needle)`.
5. Append matches only until the requested page is full.
6. Close the transaction, check `AbortSignal` and Projection Epoch, then yield to the host.
7. Continue from the last scanned key only when another batch is necessary.
8. Return a cursor containing the last scanned key and whether more source rows may exist.

`entriesForNote` separately uses `[noteId+position+rowId]`; bounded facet suggestions use their
declared tag/note/folder indexes. These endpoints do not change the Vault-search driver.

No transaction is held open across a timer/rAF yield. A production `toArray()` is allowed only after
a statically visible `limit()` no greater than 128. Unbounded `toArray()`, `sortBy()`, `snapshot()`,
`getAll()`, `keys()`, or `primaryKeys()` over Catalog tables is prohibited.

### Search accelerator decision Gate

Do not add FlexSearch in S35 by default. First run the real-host 100k Gate below.

A persistent full-text accelerator may be proposed later only if all are true:

- worst-case explicit search exceeds the total-latency budget after database/query tuning;
- main-thread slice and memory budgets already pass;
- a production Obsidian spike proves persistent IndexedDB operation and CJK behavior;
- it remains lazy, returns bounded numeric IDs, and hydrates rows from Dexie;
- it never stores canonical Ink vectors or becomes required for correctness;
- it has a bounded repair story and does not add a synchronous write to canonical mutation paths.

WASM or a main-thread search engine is not an acceptable response to a reconciliation, persistence,
or compositor bottleneck.

## Incremental projection

### Target execution matrix

The implementation must distinguish path-level projection, inventory reconciliation, and full
canonical rebuild. They are different operations and must have different triggers.

| Target trigger/state                                                      | Required operation                                                                                                                      | Full inventory allowed   | Full canonical rebuild allowed |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------ |
| Plugin startup or ordinary note open while Catalog is closed              | Record only bounded in-memory session/hint state.                                                                                       | No                       | No                             |
| Local canonical write while Catalog is closed                             | Add one normalized Dirty Source Hint, or collapse overflow to `needsReconcile`.                                                         | No                       | No                             |
| Markdown modify while Catalog is closed                                   | Add one note-local Markdown Dependency Hint without opening IndexedDB.                                                                  | No                       | No                             |
| First Catalog use with a valid database in a new plugin session           | Open the database, flush retained hints, then run a bounded changed-only inventory to cover the offline interval; remain `reconciling`. | Yes                      | No                             |
| Ordinary known-path create/modify/delete/rename while Catalog is open     | Coalesce and apply only the affected path/logical source set transactionally.                                                           | No                       | No                             |
| Known Markdown modify while Catalog is open                               | Read that Markdown body once and recompute only its Snapshot Binding rows in bounded batches.                                           | No                       | No                             |
| Long external event stream                                                | Maintain one active worker and a follow-up dirty generation; never restart a root scan solely because another event arrived.            | Only if already required | No                             |
| Dirty Hint overflow, unknown root/meta lifecycle event, or unclean resume | Set `needsReconcile`; run changed-only inventory only on the next explicit/open Catalog work opportunity.                               | Yes                      | No                             |
| Missing database or new database generation                               | Stream canonical sources into bounded database transactions.                                                                            | Yes                      | Yes                            |
| Fingerprint mismatch, corrupt/unsupported schema, proven invariant break  | Fail closed and build a fresh disposable generation without serving the suspect generation.                                             | Yes                      | Yes                            |
| Explicit user Repair/digest audit                                         | Read canonical sources in bounded batches and replace or repair the disposable generation.                                              | Yes                      | Yes                            |

"Full inventory" lists paths and compares canonical, derived-hint, and relevant Markdown Dependency
Source Stamps; it parses only new or changed bodies. “Full canonical rebuild” reads canonical bodies
and reconstructs a new database generation. An ordinary event, query failure, stale summary,
Markdown modify, note rename, or scope switch may never be promoted from the first category into the
second merely as an implementation shortcut.

### Local canonical writes

After a canonical sidecar write succeeds:

1. publish a lightweight canonical projection event;
2. if the Catalog is closed, add the path to bounded Dirty Source Hints and stop;
3. if the Catalog is already open, enqueue a device-local Catalog transaction asynchronously;
4. read the existing projected row by indexed identity;
5. reject an older revision and make an identical revision idempotent;
6. upsert/remove the one Catalog Entry and Source Stamp;
7. for a Snapshot, also upsert/remove its internal Snapshot Binding row;
8. update the owning Catalog Note aggregate;
9. increment Projection Epoch once;
10. notify query subscribers with an invalidation/version, not a full snapshot.

Canonical success never waits for the Catalog. Catalog failure is logged as a privacy-safe error and
marks the local projection stale. It cannot roll back or report failure for the canonical operation.
Snapshot editor Done, delete, Restore, and relink follow the same rule: the user-visible canonical
operation never awaits a Catalog rebuild, reconciliation, or database open.

### External sidecar events

Create/modify/delete/rename events under the canonical sidecar root are coalesced by normalized path
for 250 ms. Each affected path runs one of:

- create/modify: stat, compare Source Stamp, parse only if changed, project transactionally;
- delete: remove the exact Source Stamp, then reproject its indexed `(noteId, kind, logicalId)`
  source set; remove the Catalog Entry only when no active canonical candidate remains;
- note rename/lifecycle event: update the note and its entries through the `noteId` index in bounded
  database batches;
- Legacy Ink summary/surface/document event: refresh only the affected note's Legacy Ink
  projections;
- Snapshot `record.json` create/modify: parse that canonical record, project its compact row and
  Source Binding, and never read its PNG;
- Snapshot `record.json` delete: remove/reproject only that Snapshot logical identity after exact
  deletion is proven;
- Snapshot `summary.json` create/modify/delete: update only the derived-hint stamp or schedule exact
  record verification; it cannot create or delete an authoritative row by itself;
- Snapshot asset/orphan-marker event: no Catalog projection and zero asset body reads.

The event stream is an accelerator. Missing an event does not permanently lose the change because
reconciliation compares the inventory later.

Conflict siblings are separate Source Stamps that may project one logical Catalog Entry. Deleting
one sibling cannot remove the logical row while another active/divergent candidate remains. Deleting
`ink-summaries.json` removes only that derived hint stamp and schedules affected-note
reconciliation; it never deletes canonical surface entries. Deleting Snapshot `summary.json`
likewise removes no Snapshot row. Meta/root deletion follows the existing source-note lifecycle
service rather than guessing from one missing child.

When the Catalog is closed, the coalescer writes only Dirty Source Hints. On the next explicit open,
hints are applied before the first result can be labelled fresh. If hints overflowed or were lost on
restart, the result exposes `freshness: 'reconciling'` until a completed inventory pass converges.
The Catalog must not present stale cached rows as proven current.

### Legacy Ink projection correctness

`ink-summaries.json` remains a disposable hint, not authority. The current schema does not prove
that a parseable summary set matches every current canonical surface revision.

Therefore:

- a local canonical Ink write may project its freshly committed `InkSurfaceSummary` directly;
- an external `surfaces/<id>.json` event parses that affected surface and replaces its projection;
- an `ink-summaries.json` event may accelerate a note refresh but cannot suppress a newer observed
  surface Source Stamp;
- first build/repair may parse canonical surfaces one at a time when freshness cannot be proven;
- canonical surface objects and thumbnail geometry are released after each bounded batch and never
  accumulated in the Catalog.

Adding a source-set digest to a future Legacy Ink summary schema is a separate optimization
decision, not a prerequisite for S35 correctness.

### Snapshot projection correctness

Snapshot Annotation `record.json` is the commit point. Snapshot `summary.json`, flattened
thumbnails, Capture Assets, and link-resolution projections are disposable.

Therefore:

- a local Snapshot commit may project the exact compact entry and Source Binding created from the
  freshly committed record without rereading it;
- an external/cold `record.json` event parses that record, extracts only list/search metadata and
  the bounded Source Binding, and releases Capture Asset metadata and stroke arrays after the
  transaction;
- a parseable `summary.json` may accelerate a stale/reconciling presentation but cannot prove
  currentness unless tied to a freshly observed local canonical commit;
- first build/repair reads canonical Snapshot records one at a time when summary freshness cannot be
  proven;
- no Catalog path reads, hashes, decodes, or prewarms `capture-*.png`;
- deleting `summary.json`, a thumbnail, or an orphan marker never removes a Snapshot Catalog row.
- a note root containing canonical Snapshot records is discoverable even if `meta.json` is absent;
  the record's `noteId`/`filePath` can establish a Catalog Note, while inconsistent identities fail
  closed as a repair issue.

A future digest-bearing canonical lightweight manifest would be a canonical schema/product change.
It is not required or authorized for S35.

### Markdown dependency projection

Snapshot `linkState` and `sourceOrder` depend on current Markdown, but Markdown is not annotation
canonical data. It is a projection dependency.

- a known Markdown modify while the Catalog is open reads only that file and pages its
  `snapshotBindings` rows in batches of at most 100;
- each batch recomputes `linked | source-changed | unanchored` and `position`, updates changed rows
  only, and yields within 8 ms;
- a known Markdown modify while closed records one bounded note/path hint and opens no database;
- after restart, reconciliation stats only Markdown files represented by Snapshot Binding rows and
  reads bodies only for changed stamps;
- unavailable/unhydrated Markdown preserves the prior projection as stale/unknown and never guesses
  an unanchored result;
- the Catalog cannot report `freshness: 'current'` while an observed Markdown Dependency Hint is
  pending.

## Reconciliation

### Triggers

Reconciliation may run only after one of:

- first explicit Entire Vault/Catalog use on a missing database;
- first explicit Catalog use in a new plugin session when the database predates that session, so
  sidecar and relevant Markdown changes made while the plugin was not observing Vault events can
  converge;
- Catalog work after an unclean shutdown, background/resume gap, Dirty Hint overflow, or an
  unclassifiable root/meta lifecycle event set `needsReconcile`;
- explicit repair command;
- database schema generation replacement.

An ordinary burst containing known canonical child paths does not trigger a Vault-wide inventory;
those paths use incremental projection. Resume/startup may set an in-memory requirement, but neither
opens IndexedDB nor starts inventory until explicit Catalog use. Reconciliation never runs
synchronously during plugin startup.

### Coalescing and restart policy

- At most one projector/reconciler task owns the Catalog write lane.
- Known paths are normalized and coalesced by final observed path state. A delete followed by a
  recreate is resolved by stat/parse of the final state, not by blindly replaying both events.
- Events arriving during reconciliation enter a bounded next-generation Dirty Source set. They do
  not cancel and restart the root inventory.
- If an event affects a directory whose completed listing was already processed in the current
  epoch, only that path or directory is queued for a follow-up pass.
- Closing the Catalog cancels after the current bounded transaction, persists no unbounded work
  queue, and collapses remaining uncertainty into bounded hints/`needsReconcile`.
- Query cancellation and reconciliation cancellation are separate. Starting a new search may abort
  the old search, but it may not restart canonical inventory.

### Inventory protocol

1. Allocate a reconcile epoch and store `reconcileState: running`.
2. Obtain one complete non-recursive listing of the canonical note-root directories. A failed or
   unavailable listing proves no deletion.
3. Ordered-merge that sorted listing with the database cursor for note-root/meta Source Stamps;
   process additions and only deletions proven by the complete listing.
4. For each present note root, obtain complete non-recursive child listings as needed, including the
   nested Snapshot Annotation directory/ID structure, and ordered-merge them with that note's Source
   cursor. Listing arrays are processed one directory at a time and not copied into an all-Vault
   structure.
5. Stat each present source; parse only a missing/changed Source Stamp and do not write an unchanged
   stamp.
6. Apply child deletion only after that exact note directory listing completed successfully.
7. After canonical inventory, stat Markdown dependencies only for notes that own Snapshot Binding
   rows; read/recompute only changed sources.
8. Process at most 100 sources/bindings or 8 ms of main-thread work per batch, then yield and check
   cancellation, background, Vault close, memory pressure, and foreground Snapshot contact.
9. Commit `lastCompletedReconcileEpoch/At` only after every canonical directory and required
   Markdown dependency completed, then clear the running state.

An interrupted pass leaves every unprocessed directory unchanged. It may retain already applied
additions/changes and exact deletions proven by a completed directory listing; it never performs a
global speculative deletion sweep. Restarting repeats from canonical inventory. Progress is a hint,
not a recovery journal.

Obsidian's `DataAdapter.list()` returns one non-recursive directory listing as an array. The adapter
may therefore transiently hold O(annotated note directories) paths for the note root; S35 must not
copy that array into another all-Vault structure, must release it after the ordered merge, and must
report its peak in the Gate. No annotation-entry body array is permitted.

### Full rebuild

Full canonical rebuild is reserved for:

- no local database;
- Vault fingerprint mismatch;
- unsupported/corrupt database schema;
- explicit repair;
- a proven invariant violation.

It is not the normal response to one sidecar event, one failed query, one note rename, or one stale
summary. Rebuild streams directly into bounded database transactions and never creates an
`AnnotationIndexEntry[]` for the whole Vault.

A valid existing Catalog is never deleted merely because a reconciliation was interrupted. A fresh
generation becomes eligible to replace the previous one only after its initial canonical pass
finishes and its Vault fingerprint/schema metadata validate. Until then, the previous generation is
either served as explicitly stale/reconciling or the Catalog is reported unavailable; no partial
generation is labelled current.

## Scheduling and foreground protection

Work priority is fixed:

1. Active Pencil/mouse contact and Canvas frame submission;
2. Snapshot capture/editor presentation, Current file read/render, thumbnail work for visible rows,
   and canonical persistence;
3. explicit user Catalog query;
4. local canonical projection events;
5. external-event reconciliation;
6. full repair/rebuild.

Background Catalog work must pause within one animation frame when Snapshot Ink contact becomes
active and may resume only after at least 250 ms without contact/frame debt. On mobile-equivalent
settings, sidecar read concurrency is one; desktop default is two. IndexedDB write batches are
serialized per database, but canonical writes never wait for them.

An explicit search may continue while the sidebar is active, but it still obeys 8 ms CPU slices,
cancellation, and the Snapshot editor input/frame budgets.

Catalog result envelopes include `freshness: 'current' | 'reconciling' | 'stale'`. Only a complete
Dirty Source/Markdown Dependency Hint flush plus a valid completed reconcile epoch can report
`current` after an unclean shutdown or hint overflow.

`current` means current relative to all observed Vault events and the latest successful path/stat
inventory. It is not proof that iCloud has synchronized or that a provider did not replace bytes
while preserving both `mtime` and size. An explicit repair performs a full content read/digest when
that stronger check is required.

## Failure policy

| Failure                              | Required behavior                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| IndexedDB unavailable/quota          | Current file and canonical writes continue; Entire Vault reports local index unavailable.  |
| Dexie open/upgrade blocked           | Close stale connection; retry or create a fresh derived generation; no canonical mutation. |
| Corrupt Catalog row                  | Quarantine/replace affected projection when possible; otherwise rebuild derived database.  |
| Sidecar parse failure                | Keep prior projection marked stale/problematic; never invent a deletion.                   |
| Snapshot summary/record disagreement | Treat the summary as stale; parse canonical record in a bounded lane and never read PNG.   |
| Markdown dependency unavailable      | Preserve prior Snapshot link projection as stale/unknown; retry without guessing.          |
| Unhydrated/permission-denied source  | Preserve Source Stamp and projection as unknown; retry later.                              |
| Interrupted inventory                | Keep unprocessed rows; only completed-directory comparisons may apply exact deletions.     |
| Stale query cursor                   | Return `superseded`; caller restarts.                                                      |
| Catalog projection event failure     | Mark Catalog stale and retry cold; canonical success remains success.                      |
| Database deletion                    | Rebuild lazily from canonical sidecars.                                                    |
| Old Vault `index.json` present       | Ignore it after cutover; it never seeds the new database.                                  |

Diagnostics may contain counts, durations, batch sizes, schema/generation IDs, error classes, and
digests. They must not contain annotation body, quote, Legacy Ink/Snapshot points, Source Bindings,
thumbnail markup, or full source path unless the user explicitly exports a repair report.

## Migration and cutover

### S35 backend qualification

The original Slice boundary built the new ports, database adapter, projection/reconciliation
services, and a new gate-only host injection seam before production cutover. The former build-flag
and S27 local-Gate runtime were retired with Document Ink and were not reused. During
implementation, the Catalog remained isolated until the S36 cutover; the final production path does
not wire two always-on indexes.

### S36 UI cutover

The user separately authorized S36 on 2026-07-23. The production cutover now:

- adapt the existing Entire Vault view to async recent/search pages;
- make the default state exactly the approved 20 most-recent annotated notes with no browse-all
  cursor;
- load a note's children only on expansion and retain at most three 50-row pages;
- preserve existing visual design unless a later UI specification changes it;
- preserve Snapshot cards and lazy thumbnails while keeping PNG reads limited to rendered rows;
- replace selection/facet/exact-count code that calls `snapshot()`;
- define Select all as the currently loaded selectable page only and implement export-all as bounded
  cursor streaming;
- switch canonical projection events to the Catalog;
- remove `VaultAnnotationIndex`, `VaultIndexBuilder`, and `VaultIndexCache` production wiring;
- stop writing `.obsidian-annotations/v1/index.json`;
- best-effort delete the known derived `index.json` after successful cutover, without touching
  canonical note directories;
- keep Current file direct from canonical repositories.

The cutover is atomic at the product architecture level. A permanent feature flag or two production
indexes is prohibited.

## Local automated validation Gate

### Single command

The implementation must add:

```bash
npm run gate:vault-catalog-local
```

The command must:

1. run focused unit/repository/static-bound checks;
2. create an owned disposable test Vault and deterministic Catalog fixtures;
3. build the current production plugin plus an unpublished gate-only host seam that is absent from
   release builds;
4. install it into the owned Vault;
5. launch/reload and control real desktop Obsidian using newly established owned-Vault
   orchestration; historical S27 evidence may inform it but no current S27 script is assumed;
6. seed/query the production Dexie adapter inside the Obsidian host;
7. capture raw JSON and host/resource samples;
8. analyze every fixed budget automatically;
9. emit build, implementation, fixture, protocol, and schema digests;
10. write PASS/FAIL plus a Source Manifest under
    `docs/delivery/slices/S35-vault-catalog-local-gate/`.

Vitest/jsdom/fake-indexeddb results are necessary but cannot alone pass the production-host Gate. No
physical iPad run is required for S35.

### Fixtures

| Fixture                      | Purpose                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| correctness-small            | CJK/Unicode paths, duplicate quotes, tags, conflicts, tombstones, rename, missing/unhydrated source.    |
| canonical-20k                | 100 notes: 8k text, 8k Snapshot, 4k Legacy Ink entries through production canonical readers.            |
| catalog-100k                 | 5,000 notes × 20 mixed lightweight text/Snapshot/Legacy Ink rows through production Catalog ports.      |
| deep-note-10k                | One mixed note with 10k entries/bindings proving child and Markdown-link pagination remain bounded.     |
| delta-1-percent              | 1% canonical create/modify/delete/rename change set over an existing inventory.                         |
| snapshot-source-churn        | Markdown moves/edits with linked, source-changed, unanchored, unavailable, and superseded recomputes.   |
| snapshot-sync-staleness      | External record/summary arrival order, stale/missing summary, tombstone, Restore, and asset-only event. |
| event-stream                 | Spaced sync events, duplicate paths, delete/recreate, and changes during reconciliation.                |
| query-churn                  | 100 successive CJK/Latin searches, cancellation, filters, and scope close/reopen.                       |
| snapshot-editor-interference | Background reconcile/search while deterministic Snapshot Pencil input/frame submission is captured.     |

The 100k fixture may seed the derived database through production projection ports to avoid creating
100k physical files. The 20k fixture must use real canonical sidecar files and production
repositories so projection correctness is not replaced by database-only evidence. Snapshot fixtures
contain valid tiny Capture Assets so canonical layout is realistic, while the Catalog
instrumentation must prove that it reads zero asset bytes.

### Required instrumentation

- IndexedDB open count and timing;
- sidecar inventory stat count and body-read count;
- Snapshot record/summary/asset and Markdown-dependency stat/body-read counts separated by kind;
- path-projection, inventory-start/complete/abort, full-rebuild, and root-restart counts;
- rows visited, rows materialized, batch size, yield count, and cancellation latency;
- main-thread task durations;
- query total latency and time to first page;
- JS heap before open, after recent page, after search, after close/idle;
- database/storage estimate where the host exposes it;
- Projection Epoch and cursor invalidation outcomes;
- Snapshot input-handler, frame-work, and input-to-submit spans during interference;
- elapsed time from successful Snapshot `record.json` commit to user-visible Done completion,
  separately from asynchronous Catalog convergence;
- raw canonical hashes before/after database deletion/rebuild.

### Fixed budgets

| Budget                                | PASS condition                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Startup isolation                     | 0 Catalog IndexedDB opens and 0 sidecar index reads before explicit Catalog use/repair.                                                |
| Recent-note materialization           | At most 20 note rows and 0 entry rows; P95 query ≤ 50 ms.                                                                              |
| One-note page                         | At most 50 returned rows; no batch > 128; P95 ≤ 75 ms.                                                                                 |
| Loaded-page Select all                | Selects at most 50 selectable rows and performs no continuation query.                                                                 |
| Search batch                          | At most 128 visited rows or 8 ms CPU before yielding.                                                                                  |
| Search long task                      | No Catalog main-thread task ≥ 50 ms.                                                                                                   |
| Search cancellation                   | Previous query stops within 50 ms after abort/new query.                                                                               |
| Common 100k search first page         | P95 ≤ 250 ms for a query matching at least one row in the newest 10% of the driver order.                                              |
| Worst-case 100k absent/CJK-tail query | Completes within 5 s; no long-task violation.                                                                                          |
| Query result memory                   | At most three 50-row pages plus one 128-row batch and bounded note metadata.                                                           |
| Recent-page heap delta                | ≤ 8 MiB over pre-open idle checkpoint.                                                                                                 |
| Search-page heap delta                | ≤ 16 MiB over pre-open idle checkpoint after one completed page.                                                                       |
| Vault-size retained-heap slope        | 100k post-close/idle retained heap is ≤ 20k retained heap + max(4 MiB, 10%).                                                           |
| Inventory transient memory            | One note-root listing + one child listing + one 100-row batch + at most one source body; overhead excluding that body's bytes ≤ 8 MiB. |
| Snapshot asset isolation              | 0 `capture-*.png` body reads/hashes/decodes during build, reconcile, recent, expand, or search.                                        |
| Snapshot binding batch                | At most 100 bindings and one Markdown body retained; yield within 8 ms.                                                                |
| Markdown dependency delta             | One known Markdown modify reads one Markdown body, no other note body, and no Snapshot sidecar.                                        |
| Snapshot summary authority            | Stale/missing/deleted summary cannot create/delete a current row without canonical record proof.                                       |
| Snapshot save isolation               | Successful Done/action completion does not await Catalog open, rebuild, reconcile, or query.                                           |
| No-op reconcile writes                | 0 note/entry/source row writes and 0 body reads; only run-state metadata may change.                                                   |
| Ordinary external path event          | 0 Vault-wide inventories/rebuilds; read only the affected source set and conflict siblings.                                            |
| Same-session retained hint flush      | Without overflow/uncertainty, 0 Vault-wide inventories; read only hinted source bodies.                                                |
| Long external event stream            | One active write lane; 0 root-scan restarts caused solely by later events.                                                             |
| Explicit digest repair                | Detects preserved-stat byte replacement in bounded 100-source/8 ms batches.                                                            |
| Incremental reconcile body reads      | For 1% delta, reads ≤ changed sources + 1% fixed verification allowance; unchanged bodies skip.                                        |
| Reconcile scheduling                  | Concurrency 1 mobile-equivalent/2 desktop; batch ≤ 100 sources or 8 ms before yield.                                                   |
| Interrupted reconciliation            | Performs no speculative/global deletion and preserves every unprocessed directory.                                                     |
| Snapshot editor interference          | Background work pauses within one frame and the current Snapshot input/frame budgets remain PASS.                                      |
| Canonical safety                      | DB clear/rebuild changes 0 canonical sidecar bytes.                                                                                    |
| Storage amplification                 | Catalog database ≤ 4× serialized lightweight entry/binding/source bytes for the 100k fixture.                                          |
| Production query bounds               | Static guard finds no unbounded Catalog `toArray/getAll/sortBy/keys/primaryKeys/snapshot`.                                             |

Absolute desktop timings are qualification limits for the owned local environment, not a claim about
every device. The structural limits—page size, batch size, zero eager startup work, cancellation,
memory slope, sidecar read amplification, and canonical safety—are release invariants.

Latency distributions use at least five deterministic repetitions after one separately reported cold
run. Heap checkpoints are sampled after the same idle/quiescence protocol in every condition; the
report must state whether host GC was requested or only natural idle collection was available. A
Gate cannot selectively discard a slow or high-memory repetition.

### Gate artifacts

```text
docs/delivery/slices/S35-vault-catalog-local-gate/
  README.md
  raw/capture.json
  results.json
  performance.md
  test-results.md
  risk-register.md
  source-manifest.md
```

`results.json` must include per-budget actual/limit/status, dataset cardinalities, host/Obsidian
versions, database/Dexie versions, and all required digests. A failed run remains evidence and is
not overwritten by a later pass.

## Execution hold point

The user authorized implementation on 2026-07-23. The former hold is released. Runtime changes must
still preserve canonical-sidecar safety, and installed-Obsidian host measurements must remain
distinguishable from the deterministic fake-IndexedDB adapter Gate.

## TDD task breakdown

Every implementation step follows one failing observable test, minimum implementation, green
verification, then refactor. Mock only database/Vault/clock/scheduler boundaries.

### S35.0 — Dependency and production-host feasibility spike

Deliverables:

- select, add, and pin the minimal currently supported Dexie core dependency in the spike branch;
- extend the existing Snapshot Draft `fake-indexeddb` precedent to prove injected
  `indexedDB`/`IDBKeyRange`, compound indexes, multi-entry indexes, cursor cancellation, and close;
- prove create/open/transaction/compound-index/multi-entry/versionchange/close/delete inside the
  real installed Obsidian Gate host;
- establish owned-Vault launch/reload/gate-host orchestration without depending on deleted S27
  scripts or retired build flags;
- measure production bundle gzip delta;
- define and test `VaultLocalIdentityPort` including cross-Vault mismatch rejection;
- record why Dexie is accepted or fall back to a thin native adapter behind the same port.

Exit:

- no UI or `main.ts` production wiring;
- mobile import scan passes;
- real-host database smoke passes;
- dependency decision and measurements are recorded.

### S35.1 — Page-oriented domain/application contract

Deliverables:

- define Catalog Note/Entry DTOs, limits, filters, result states, typed cursors, and errors;
- define Snapshot display rows separately from internal Snapshot Binding rows and forbid Source
  Bindings in query results;
- define query/projection/inventory/scheduler ports;
- test hard limit validation, cursor query digest, epoch invalidation, and immutable page results;
- specify Select all as current loaded page only and export-all as an `AsyncIterable` cursor walk;
- remove any need for `snapshot()` from the new port.

Exit:

- all behavior can be tested against an in-memory fake port without importing DOM/Obsidian/Dexie;
- no method can request or return the complete Catalog.

### S35.2 — Dexie Catalog repository

Deliverables:

- implement schema v1 and typed storage adapter;
- implement recent-note query, note-entry keyset page, bounded facet suggestions, and transactions;
- implement internal Snapshot Binding storage and note-local 100-row binding pages;
- implement exact upsert/remove/rename/note-aggregate updates;
- implement database generation, close/versionchange/quota/corruption handling;
- add the static production-query bound checker.

Tests:

- compound/multi-entry index behavior;
- 20/50/100/128 caps;
- no cross-note or cross-Vault leakage;
- revision stale/identical/divergent cases;
- quota, abort, blocked upgrade, deletion, and rebuild;
- no Legacy Ink/Snapshot vectors, PNG bytes, thumbnail SVG, or Source Bindings in query rows.

Exit:

- fake-indexeddb repository contract passes;
- delete/recreate produces an empty disposable Catalog without touching fixture sidecars.

### S35.3 — Incremental projector and reconciler

Implementation order inside this Slice is fixed as five vertical TDD cycles; they are not one
horizontal “write all tests, then all services” batch:

1. **S35.3a — Closed-Catalog hints and coalescer.** Prove zero IndexedDB opens, 256-path overflow,
   final-state path coalescing, and one dirty follow-up generation.
2. **S35.3b — Canonical exact-path projector.** Prove Text/Legacy Ink/Snapshot local/external
   create, update, tombstone, physical delete, rename, summary disagreement, and conflict behavior
   without any Vault-wide inventory or PNG read.
3. **S35.3c — Markdown dependency projector.** Prove one-body note-local Snapshot recomputation,
   100-binding/8-ms batches, closed-Catalog hints, unavailable-source preservation, and freshness.
4. **S35.3d — Completed-directory reconciler.** Prove changed-only parsing, exact deletion only
   after a successful listing, interrupted-pass safety, cross-session convergence, and no-op zero
   writes/body reads.
5. **S35.3e — Scheduler integration.** Prove one write lane, no root restart under a long event
   stream, foreground Snapshot-contact pause, scope-close cancellation, save isolation, and
   freshness transitions.

Deliverables:

- project text, Legacy Ink, and Snapshot records after canonical success;
- store Snapshot Source Bindings only in the internal device-local table and recompute link state on
  changed Markdown without rereading Snapshot sidecars;
- coalesce external sidecar events by path;
- buffer at most 256 Dirty Source/Markdown Dependency Hints and 20 recent-note hints without opening
  a closed database;
- implement Source Stamps, completed-directory ordered merge, changed-only parsing, and exact
  deletion detection without rewriting unchanged stamps;
- implement note rename/source-missing updates by indexed batches;
- integrate foreground Snapshot-contact pause signals through an application scheduler port;
- preserve parse/unhydrated failures as stale/unknown rather than deletion.

Tests:

- create/update/tombstone/physical delete/rename/conflict for text and Legacy Ink;
- deleting one conflict sibling preserves/reprojects the logical row, and deleting
  `ink-summaries.json` removes no canonical surface row;
- local/external Snapshot create/edit/tombstone/Restore/relink/delete projects exactly one logical
  row and never reads PNG;
- stale, missing, delayed, and deleted Snapshot summaries cannot override `record.json` or delete a
  current row;
- one Markdown change recomputes only that note's Snapshot rows in bounded binding batches, and an
  unavailable body preserves prior link state as stale/unknown;
- missed event discovered by reconciliation;
- changed stat parsed, unchanged stat skipped;
- no-op reconciliation performs zero note/entry/source row writes and zero body reads;
- explicit digest repair detects a same-size/preserved-mtime byte replacement;
- interrupted pass cannot delete from an unprocessed/failed directory;
- event arriving during reconciliation supersedes older projection safely;
- a sustained event stream does not abort/restart root inventory and rechecks only affected
  paths/directories after the current epoch;
- one external Legacy Ink surface or Snapshot record change cannot leave a stale summary row
  indefinitely;
- canonical text/Snapshot writes and Snapshot Done/actions are not awaited on Catalog completion;
- closed-Catalog events perform zero IndexedDB opens, hint overflow sets one reconcile bit, and the
  next explicit open converges before reporting `freshness: 'current'`.

Exit:

- a 1% delta causes O(delta) body reads;
- no full rebuild on an ordinary event;
- no runtime wiring that duplicates the current production index.

### S35.4 — On-demand bounded search

Deliverables:

- implement NFKC normalized search projection;
- implement the fixed updated-time search driver, 128-row database batches, keyset continuation,
  yielding, progress, and cancellation;
- implement result-page grouping metadata without full result arrays;
- implement long-query supersession on Projection Epoch change;
- add a benchmark that determines whether a search accelerator is necessary.

Tests:

- CJK, case, Unicode normalization, quote/body/path/tag/style/type/status search parity;
- Snapshot heading, type, link state, and stroke-count search parity without Source Binding text;
- combined filters;
- match at beginning/middle/end and absent query;
- cancellation between every batch boundary;
- mutation during scan returns `superseded`;
- no exact total/full facet/full snapshot allocation;
- 20k and 100k resource budgets.

Exit:

- baseline Gate passes, or a separate evidence-backed accelerator proposal is written before any
  FlexSearch/Worker/WASM implementation.

### S35.5 — Real Obsidian local Gate and evidence

Deliverables:

- implement `npm run gate:vault-catalog-local`;
- use the newly qualified owned-Vault launch/reload/foreground gate orchestration;
- generate deterministic Snapshot-aware 20k canonical and 100k Catalog fixtures;
- capture raw host/query/memory/read-amplification/Markdown-churn/Snapshot-editor-interference
  evidence;
- emit PASS/FAIL, reports, and Source Manifest.

Exit:

- every fixed budget has machine-readable evidence;
- full `npm run check`, mobile bundle scan, and the real-host Gate pass;
- failures remain recorded;
- no physical iPad or UI modification is required.

### S36 — Deferred UI cutover and legacy removal

This Slice was originally deferred to make the migration boundary explicit. It was authorized on
2026-07-23 and its production data-path cutover is implemented.

- consume async recent/search pages in the existing visual shell;
- show exactly 20 recent note groups by default and load child pages only on expansion;
- replace full snapshot selection/facets/exact-count placeholders;
- make Select all page-local, add bounded stream export-all, and preserve revision-safe selection;
- retain lazy Snapshot thumbnails and add page-local Snapshot Copy/Export/Delete/Restore while
  keeping Tags/Style disabled for non-text selections;
- atomically switch production projection wiring;
- remove old in-memory index/cache/builder and Vault `index.json` writes;
- add local UI behavior tests and a separate acceptance decision.

## Acceptance criteria

- Entire Vault default data access returns no more than 20 recent note summaries.
- Non-recent notes do not enter runtime memory until an explicit query/filter or note expansion
  needs them.
- No production API exposes a full Catalog snapshot.
- Runtime memory slope between 20k and 100k satisfies the fixed Gate.
- Search, paging, and reconcile are cancellable and use bounded database batches.
- Startup does not open/rebuild the Catalog or read its sidecars.
- Local canonical mutation never waits before reporting canonical success; it updates an already
  open Catalog asynchronously or records a bounded Dirty Source Hint while closed.
- Snapshot Done/delete/Restore/relink completion never waits for Catalog work.
- Opening notes and receiving sidecar events while the Catalog is closed perform zero Catalog
  IndexedDB opens.
- An ordinary known-path external event performs zero Vault-wide inventories and zero full canonical
  rebuilds.
- A sustained external event stream does not restart root inventory; it converges through one
  bounded follow-up dirty generation.
- Missed create/modify/delete/rename events with an observable path/stat delta converge through
  changed-only reconciliation; explicit digest repair covers preserved-stat replacement.
- A no-change reconciliation rewrites no Catalog Note/Entry/Source rows and reads no sidecar bodies.
- An interrupted inventory cannot remove valid projections.
- Legacy Ink and Snapshot summaries cannot remain trusted solely because their derived JSON is
  parseable.
- External Snapshot record/summary arrival-order permutations converge to `record.json`, and asset
  events read zero PNG bytes.
- A changed Markdown dependency recomputes only that note's Snapshot link state/source order in
  bounded batches before the Catalog reports `current`.
- Select all selects no more than the current 50-row page; export-all releases every page before
  advancing its cursor.
- Clearing/corrupting/replacing the local database changes no canonical bytes and loses no
  annotation data.
- Current file and Snapshot creation/editing remain usable when the Catalog database fails.
- A stale/reconciling Catalog is labelled explicitly and cannot claim `freshness: 'current'` until
  pending hints and required inventory work complete.
- No derived Catalog/index file is written into the Vault after S36 cutover.
- S35 passes unit, repository, and static-bound checks before release. Snapshot-aware 20k canonical,
  100k real-host Catalog, memory, Markdown-churn, and Snapshot-editor-interference measurements
  remain installed-host release qualification and must not be inferred from the adapter Gate.

## Residual risks and explicit follow-ups

- Local desktop Obsidian evidence does not prove an exact iPad latency number. S35 accepts this by
  user decision, while retaining structural mobile-safe budgets and the mobile bundle scan.
- IndexedDB quota and eviction policy remain controlled by the host. Because the Catalog is
  disposable, eviction is availability degradation rather than canonical data loss.
- `lastOpenedAt` is device-local and may differ across devices by design.
- The current canonical Legacy Ink summary schema lacks source-set freshness proof. S35 parses every
  observed changed surface rather than trusting a parseable summary; a digest-bearing summary schema
  may reduce cold work later.
- Snapshot `summary.json` is likewise derived and lacks a canonical digest relationship. Cold/repair
  work may therefore read large `record.json` files one at a time to extract compact rows/bindings.
  A future canonical lightweight manifest would require a separate schema/product decision.
- A very large Markdown file must be retained while its Snapshot bindings are recomputed. Memory is
  O(one current source + one bounded binding batch), not O(Vault), and the Gate must report that
  source-size dependency explicitly.
- A provider can theoretically change sidecar bytes while preserving both `mtime` and size during
  plugin downtime. Ordinary changed-only reconciliation cannot observe that case without reading
  every body; explicit repair/digest audit detects it, and the canonical sidecar remains unaffected.
- On-demand substring search is O(scanned lightweight rows) in total CPU. It is intentionally
  demand-bound and yielded; the 100k Gate decides whether a mature persistent accelerator is worth
  its additional lifecycle.
- Vault-local identity on mobile lacks the desktop base-path primitive and must pass the S35.0
  cross-Vault mismatch test before production cutover.
- An older plugin version may recreate Vault `index.json`; newer builds ignore it. This is harmless
  derived-data churn, not canonical conflict resolution.

## Source Manifest

### Sources

- User decision on 2026-07-19: Entire Vault should present recent annotated files by default; the
  rest of the Vault should be loaded only when explicitly searched.
- User architecture direction on 2026-07-19: prioritize simple, robust, economical mobile resource
  use; do not retain the complete index in memory; prefer established database tooling over a
  home-grown index.
- User instruction on 2026-07-19: write a detailed specification and task breakdown, use local
  automated validation, and do not modify UI in this work.
- User follow-up on 2026-07-19: revise the plan first and do not begin implementation.
- User approval on 2026-07-23 of the reassessment recommendations:
  - default to the 20 most-recent annotated notes with no browse-all cursor;
  - treat Markdown as a Snapshot link-projection dependency that must converge before `current`;
  - define Select all as the currently loaded at-most-50-row page and use bounded streaming for
    export-all.
- `AGENTS.md` and `CONTEXT.md`.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`, especially D-02, D-10, D-12, D-15,
  D-25, Entire Vault, Performance, and Reliability.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`, S07 and S14 resource
  evidence.
- `docs/specs/2026_07_15_refactor_to_preact.md`, Entire Vault performance, R05/R06, and performance
  Gate.
- `docs/specs/2026-07-16-sidecar-lifecycle-trash-and-garbage-collection.md`, note lifecycle, index
  hygiene, resource scheduling, and failure policy.
- `docs/specs/2026-07-22-snapshot-annotation-capture-and-markup.md`, especially Entire Vault,
  canonical `record.json`, derived data, Source Binding, and performance/reliability contracts.
- `docs/delivery/slices/S07-vault-index/`, `R05-observable-index/`, and `R06-vault-preact/`.
- `docs/delivery/slices/S2-snapshot-core-product/` and
  `docs/delivery/slices/S6-snapshot-release-reliability/`.
- `docs/delivery/slices/S14-release-candidate/scale-report.json`, especially the 20k heap/RSS and
  virtual-row evidence.
- Current implementation: `src/domain/vault-annotation-index.ts`,
  `src/domain/snapshot-annotation-summary.ts`, `src/application/vault-index-builder.ts`,
  `src/application/vault-index-events.ts`, `src/storage/vault-index-cache.ts`,
  `src/storage/snapshot-annotation-repository.ts`,
  `src/storage/indexeddb-snapshot-annotation-draft-store.ts`,
  `src/adapters/obsidian/annotation-sidebar-view.ts`,
  `src/adapters/obsidian/snapshot-annotation-manager.ts`, `src/ui/vault-annotation-sidebar.ts`,
  `src/ui/sidebar/vault-annotation-sidebar-app.tsx`, `src/main.ts`, and `package.json`.
- Current repository state confirming that the former S27 local Gate scripts, Catalog build flags,
  `scripts/scale-harness.ts`, and `src/storage/indexeddb-ink-draft-store.ts` no longer exist.
- Existing IndexedDB precedent: `src/storage/indexeddb-snapshot-annotation-draft-store.ts` and its
  tests.
- `node_modules/obsidian/obsidian.d.ts`, especially mobile-safe `DataAdapter.list/stat`,
  `Vault.getName()`, and desktop-only `FileSystemAdapter.getBasePath()` boundaries.
- [Indexed Database API 3.0](https://www.w3.org/TR/IndexedDB/) for persistent records, indexes,
  transactions, and ordered cursors.
- [Dexie official repository](https://github.com/dexie/Dexie.js),
  [compound indexes](https://dexie.org/docs/Compound-Index),
  [multi-entry indexes](https://dexie.org/docs/MultiEntry-Index),
  [bulkPut transaction warning](https://dexie.org/docs/Table/Table.bulkPut%28%29), and
  [offset pagination limits](https://dexie.org/docs/Collection/Collection.offset%28%29).
- [Obsidian mobile plugin self-critique checklist](https://docs.obsidian.md/oo/plugin) for mobile
  adapter/import/dependency constraints.
- `/Users/ivan/.agents/docs/agents/workflows.md` and
  `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

The IndexedDB/Dexie web sources above are retained as historical architecture inputs from the
2026-07-19 revision. S35.0 must revalidate the exact current dependency/version against primary
sources and real Obsidian rather than treating the old version guess as current evidence.

### Produced artifacts

- `docs/specs/2026-07-19-entire-vault-demand-bounded-index.md`.
- One authoritative-document entry in `docs/specs/README.md`.

### Key decisions

- Redefine Entire Vault as full-Vault query coverage, not eager full-Vault presentation.
- Default to at most 20 recent note summaries; page one note or explicit query results on demand.
- Replace the full-memory Map/whole-Vault JSON design with a disposable device-local Dexie database.
- Use keyset pagination and 128-row search batches; prohibit full snapshots and unbounded table
  materialization.
- Keep a closed Catalog truly dormant: note opens and sidecar events enter bounded in-memory hints
  and cannot open IndexedDB solely to warm derived data.
- Treat Snapshot `record.json` as canonical, Snapshot `summary.json` as a derived hint, and Capture
  Assets as completely outside Catalog build/query reads.
- Store Snapshot Source Bindings only in a device-local internal table and recompute link state for
  one changed Markdown source in bounded batches before reporting `current`.
- Keep Legacy Ink readable/searchable but reserve new freehand creation for Snapshot Annotation.
- Make Select all page-local and keep export-all bounded through cursor streaming.
- Separate exact path projection, changed-only inventory, and full canonical rebuild; an ordinary
  event can invoke only the first, while the third is reserved for missing/corrupt generations and
  explicit Repair.
- Replace the current abort/restart response to long sync streams with one active write lane and a
  bounded follow-up dirty generation.
- Preserve exact substring semantics initially through bounded IndexedDB scans; defer a persistent
  full-text engine until the 100k production-host Gate proves it necessary.
- Treat Vault events as an accelerator and use completed-directory ordered merge for missed changes
  and exact deletion detection without rewriting unchanged stamps.
- Keep S35 backend qualification separate from the later S36 UI cutover; do not ship a permanent
  dual-index architecture.
- Rebuild the retired local-Gate infrastructure through a new gate-only host seam; do not assume the
  removed S27 scripts/build flags still exist.
- Require local real-Obsidian Snapshot-aware automation and resource evidence; no physical iPad
  session for S35.

### Verification evidence

- `dexie@4.4.4` is pinned exactly; no Dexie addons or network service were added.
- The production path no longer constructs `VaultAnnotationIndex`, `VaultIndexBuilder`, or
  `VaultIndexCache`, and no longer writes the Vault-local `index.json` projection.
- Catalog construction is lazy; closed-session recency and dirty hints are bounded at 20 and 256.
- Repository tests cover 20/50/100/128 bounds, keyset note pages, normalized bounded search,
  revision rejection, Markdown-only Snapshot link reprojection, and internal Binding isolation.
- Snapshot Done publishes Catalog convergence without awaiting it.
- `npm run gate:vault-catalog-local` passed the 100k production-adapter fixture, static production
  bounds, typecheck, production build, mobile bundle scan, and retired-Document-Ink scan.
- Final repository verification passed `npm run check`: 121 test files / 830 unit and integration
  tests, plus 7 performance files / 8 performance tests, production build, mobile bundle scan, and
  retired-Document-Ink scan.
- The latest local adapter metrics and Source Manifest are written under
  `docs/delivery/slices/S35-vault-catalog-local-gate/` (ignored delivery evidence).
- Installed desktop Obsidian heap/input-frame observation is explicitly still pending and is not
  inferred from fake-IndexedDB results.
- Relevant current specifications, S07/R05/R06 and Snapshot S2/S6 evidence, current index/Snapshot
  implementation and callers, package/scripts state, and historical 20k scale evidence were
  inspected before revising.
- Focused current behavior verification passed: 6 files / 74 tests covering the Vault index,
  builder/cache/view/sidebar and Snapshot summaries.
- Focused current performance verification passed: 2 files / 3 tests covering the 20k full-memory
  query and 500-row Snapshot summary projection. These are baseline evidence, not the planned S35
  Gate.
- `npx prettier --check` passed for this specification and `docs/specs/README.md` after revision.
- A local resolver confirmed every repository-relative Markdown link in both revised files exists;
  the specification's 18 fenced-code delimiters are balanced.
- `git diff --check` passed for the document-only change.
- The deterministic automated Gate is implemented and passing; the interactive real-host portion
  remains release qualification evidence.
- The current 180 ms external-event path, missing Snapshot sidecar event match, Snapshot Done
  refresh await, full builder loop, Markdown-dependent Snapshot summary projection, cache rewrite,
  and in-memory replacement behavior were re-read before freezing the revised trigger matrix.

### Open questions / risks

- The production mobile identity uses the Vault-local device ID plus Vault name, validates the full
  stored fingerprint, and keeps raw paths out of the database name. Cross-device installed-host
  qualification remains part of the release evidence.
- `dexie@4.4.4` is pinned and passes the production build/mobile scan and injected fake-IndexedDB
  adapter Gate. Installed-Obsidian version-change/blocked-upgrade observation remains pending.
- The 100k Gate may justify a mature persistent search accelerator; no accelerator is pre-approved
  without that evidence.
- Cold first-build/repair may need to parse large Snapshot `record.json` files one at a time because
  the derived `summary.json` has no canonical freshness proof. A canonical lightweight manifest is a
  separate future schema decision.
- A changed very large Markdown source is one unavoidable bounded-memory input for link projection;
  the Gate must report source-size sensitivity.
- S36 is authorized and its async bounded production cutover is implemented. A dedicated explicit
  export-all UI affordance and installed-host visual acceptance remain follow-up release work; the
  bounded cursor-stream application contract is present and page-local export remains safe.
