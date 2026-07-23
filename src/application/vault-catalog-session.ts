import {
  VAULT_CATALOG_LIMITS,
  type CatalogEntryPage,
  type CatalogCursor,
  type RecentNotesResult,
  type FacetSuggestion,
  type VaultCatalogFilters,
  type VaultCatalogQueryPort,
  type VaultCatalogSearchPage,
} from './vault-catalog';

export interface VaultCatalogSessionStore extends VaultCatalogQueryPort {
  close(): void;
  recordNoteOpened(noteId: string, openedAt: string): Promise<void>;
}

interface VaultCatalogSessionOptions {
  readonly onIssue?: (error: unknown) => void;
  readonly openCatalog: (signal?: AbortSignal) => Promise<VaultCatalogSessionStore>;
  readonly projectPaths?: (
    store: VaultCatalogSessionStore,
    paths: readonly string[],
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly reconcile?: (store: VaultCatalogSessionStore, signal?: AbortSignal) => Promise<void>;
}

export class VaultCatalogSession implements VaultCatalogQueryPort {
  private readonly openCatalog: (signal?: AbortSignal) => Promise<VaultCatalogSessionStore>;
  private readonly onIssue: (error: unknown) => void;
  private readonly projectPaths:
    | ((
        store: VaultCatalogSessionStore,
        paths: readonly string[],
        signal?: AbortSignal,
      ) => Promise<void>)
    | undefined;
  private readonly reconcile:
    ((store: VaultCatalogSessionStore, signal?: AbortSignal) => Promise<void>) | undefined;
  private lifecycleAbort: AbortController | null = null;
  private openStore: Promise<VaultCatalogSessionStore> | null = null;
  private readonly recentNoteHints = new Map<string, string>();
  private readonly dirtyPaths = new Set<string>();
  private needsReconcile = false;
  private writeLane: Promise<void> = Promise.resolve();

  constructor(options: VaultCatalogSessionOptions) {
    this.openCatalog = options.openCatalog;
    this.onIssue = options.onIssue ?? (() => undefined);
    this.projectPaths = options.projectPaths;
    this.reconcile = options.reconcile;
  }

  markDirtyPath(path: string): void {
    if (path.length === 0) return;
    if (!this.needsReconcile) {
      this.dirtyPaths.add(path);
      if (this.dirtyPaths.size > VAULT_CATALOG_LIMITS.dirtyPaths) {
        this.dirtyPaths.clear();
        this.needsReconcile = true;
      }
    }
    if (this.openStore !== null) void this.drainDirtyHints().catch(this.onIssue);
  }

  requestReconcile(): void {
    this.dirtyPaths.clear();
    this.needsReconcile = true;
    if (this.openStore !== null) void this.drainDirtyHints().catch(this.onIssue);
  }

  recordNoteOpened(noteId: string, openedAt: string): void {
    if (noteId.length === 0) return;
    this.recentNoteHints.delete(noteId);
    this.recentNoteHints.set(noteId, openedAt);
    while (this.recentNoteHints.size > VAULT_CATALOG_LIMITS.recentNotes) {
      const oldest = this.recentNoteHints.keys().next().value;
      if (oldest === undefined) break;
      this.recentNoteHints.delete(oldest);
    }
    if (this.openStore !== null) void this.flushRecentNoteHints();
  }

  async recentNotes(
    input: {
      readonly limit?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RecentNotesResult> {
    const store = await this.ensureOpen();
    await this.drainDirtyHints();
    await this.flushRecentNoteHints();
    return store.recentNotes(input);
  }

  async entriesForNote(input: {
    readonly cursor?: CatalogCursor;
    readonly limit?: number;
    readonly noteId: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogEntryPage> {
    const store = await this.ensureOpen();
    await this.drainDirtyHints();
    await this.flushRecentNoteHints();
    return store.entriesForNote(input);
  }

  async search(input: {
    readonly cursor?: CatalogCursor;
    readonly filters?: VaultCatalogFilters;
    readonly limit?: number;
    readonly signal?: AbortSignal;
    readonly text: string;
  }): Promise<VaultCatalogSearchPage> {
    const store = await this.ensureOpen();
    await this.drainDirtyHints();
    await this.flushRecentNoteHints();
    return store.search(input);
  }

  async suggestFacet(input: {
    readonly facet: 'folder' | 'note' | 'tag';
    readonly limit?: number;
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly FacetSuggestion[]> {
    const store = await this.ensureOpen();
    await this.drainDirtyHints();
    return store.suggestFacet(input);
  }

  close(): void {
    this.lifecycleAbort?.abort();
    this.lifecycleAbort = null;
    void this.openStore?.then(
      (store) => store.close(),
      () => undefined,
    );
    this.openStore = null;
  }

  private ensureOpen(): Promise<VaultCatalogSessionStore> {
    if (this.openStore === null) {
      const abort = new AbortController();
      this.lifecycleAbort = abort;
      this.openStore = this.openCatalog(abort.signal);
    }
    return this.openStore;
  }

  private async flushRecentNoteHints(): Promise<void> {
    if (this.openStore === null || this.recentNoteHints.size === 0) return;
    const store = await this.openStore;
    const hints = [...this.recentNoteHints];
    this.recentNoteHints.clear();
    for (const [noteId, openedAt] of hints) {
      await store.recordNoteOpened(noteId, openedAt);
    }
  }

  private drainDirtyHints(): Promise<void> {
    if (this.openStore === null) return Promise.resolve();
    const task = this.writeLane.then(async () => {
      const store = await this.openStore;
      if (store === null) return;
      const signal = this.lifecycleAbort?.signal;
      throwIfAborted(signal);
      while (this.needsReconcile || this.dirtyPaths.size > 0) {
        if (this.needsReconcile) {
          this.needsReconcile = false;
          this.dirtyPaths.clear();
          if (this.reconcile === undefined) {
            this.needsReconcile = true;
            return;
          }
          await this.reconcile(store, signal);
          continue;
        }
        const paths = [...this.dirtyPaths];
        this.dirtyPaths.clear();
        if (this.projectPaths === undefined) {
          paths.forEach((path) => this.dirtyPaths.add(path));
          return;
        }
        await this.projectPaths(store, paths, signal);
      }
    });
    this.writeLane = task.catch(this.onIssue);
    return task;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Vault Catalog session was closed.', 'AbortError');
  }
}
