import { MarkdownView, type TFile } from 'obsidian';

import { SnapshotAnnotationSession } from '../../application/snapshot-annotation-session';
import { snapshotDraftKey } from '../../application/snapshot-annotation-session';
import type { SnapshotAnnotationDraftStore } from '../../application/snapshot-annotation-draft-store';
import { locateRenderedBlockSourceRange } from '../../domain/rendered-source-map';
import {
  createSnapshotSourceBinding,
  projectSnapshotSourceLink,
  type SnapshotAnchorBlockInput,
} from '../../domain/snapshot-source-binding';
import { hashText } from '../../domain/text-anchor';
import type { SnapshotSourceBinding } from '../../domain/snapshot-annotation';
import type { SnapshotAnnotationRepository } from '../../storage/snapshot-annotation-repository';
import type { SnapshotAnnotationEditor } from '../../ui/snapshot-annotation-editor';
import type {
  SnapshotCaptureBackendRegistry,
  SnapshotCaptureSubjectHandle,
} from './snapshot-capture-backend';
import { SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR } from './snapshot-dom-capture-preparation';

interface SnapshotManagerAppLike {
  readonly vault: {
    cachedRead(file: TFile): Promise<string>;
  };
  readonly workspace: {
    getActiveViewOfType(viewType: typeof MarkdownView): MarkdownView | null;
  };
}

interface SnapshotNoteRepositoryLike {
  getOrCreateNote(input: {
    readonly createId: () => string;
    readonly filePath: string;
    readonly now: string;
    readonly sourceFingerprint: string;
  }): Promise<{ readonly noteId: string }>;
}

export interface ObsidianSnapshotAnnotationManagerInput {
  readonly app: SnapshotManagerAppLike;
  readonly backendId: string;
  readonly captureBackends: SnapshotCaptureBackendRegistry;
  readonly createCaptureSubject: (
    readingRoot: HTMLElement,
    backendId: string,
  ) => SnapshotCaptureSubjectHandle;
  readonly createId?: () => string;
  readonly createThumbnailDataUrl?: (
    record: ReturnType<SnapshotAnnotationSession['snapshot']>['record'],
    pngBytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly desiredPixelRatio?: () => number;
  readonly deviceId?: string;
  readonly document: Document;
  readonly draftStore?: SnapshotAnnotationDraftStore;
  readonly editor: SnapshotAnnotationEditor;
  readonly exportSnapshot?: (
    record: ReturnType<SnapshotAnnotationSession['snapshot']>['record'],
    pngBytes: Uint8Array,
  ) => Promise<void>;
  readonly now?: () => string;
  readonly onActiveSnapshotChanged?: (snapshotId: string | null) => void;
  readonly onIssue?: (error: unknown) => void;
  readonly onRecordsChanged?: (filePath: string) => void | Promise<void>;
  readonly repository: SnapshotAnnotationRepository;
  readonly textRepository: SnapshotNoteRepositoryLike;
  readonly validatePngCoverage?: (pngBytes: Uint8Array, signal: AbortSignal) => Promise<void>;
}

/** Owns Snapshot capture and its one active bounded capture/edit session. */
export class ObsidianSnapshotAnnotationManager {
  private activeCapture: AbortController | null = null;
  private activeSession: SnapshotAnnotationSession | null = null;
  private backendId: string;
  private captureGeneration = 0;
  private readonly createId: () => string;
  private disposed = false;
  private sourceObserver: IntersectionObserver | null = null;
  private readonly thumbnailCache = new Map<string, string>();
  private readonly now: () => string;

  constructor(private readonly input: ObsidianSnapshotAnnotationManagerInput) {
    this.backendId = input.backendId;
    this.createId = input.createId ?? (() => globalThis.crypto.randomUUID());
    this.now = input.now ?? (() => new Date().toISOString());
  }

  selectBackend(backendId: string): void {
    if (
      !this.input.captureBackends.listCapabilities().some(({ backendId: id }) => id === backendId)
    ) {
      throw new Error(`Snapshot capture backend is unavailable: ${backendId}`);
    }
    this.activeCapture?.abort();
    this.backendId = backendId;
  }

  selectedBackendId(): string {
    return this.backendId;
  }

  async captureActiveReadingView(): Promise<boolean> {
    this.assertAvailable();
    const view = this.activeReadingView();
    const file = view.file;
    if (file === null)
      throw new Error('Open a Markdown file before capturing a Snapshot annotation.');
    const preview = view.contentEl.querySelector<HTMLElement>('.markdown-preview-view');
    const readingRoot = view.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (preview === null || readingRoot === null) {
      throw new Error('Snapshot annotations can only be captured from Reading View.');
    }
    const source = await this.input.app.vault.cachedRead(file);
    const sourceRevision = await hashText(source);
    const now = this.now();
    const note = await this.input.textRepository.getOrCreateNote({
      createId: this.createId,
      filePath: file.path,
      now,
      sourceFingerprint: sourceRevision,
    });
    dismissHostTransientUi(this.input.document);
    this.activeCapture?.abort();
    const controller = new AbortController();
    this.activeCapture = controller;
    const generation = ++this.captureGeneration;
    this.input.document.body.classList.add('is-inkstone-snapshot-capturing');
    const restoreExcludedElements = hideCaptureExcludedElements(this.input.document);
    try {
      await nextPaint(this.input.document);
      // Preview disposal removes its layout profile, so native capture geometry must be measured
      // only after the Reading View has settled into the exact frame that will be sampled.
      const viewportCssRect = integerCaptureRect(
        preview.getBoundingClientRect(),
        this.input.document,
      );
      const sourceBinding = await buildSnapshotCaptureSourceBinding({
        readingRoot,
        source,
        viewportCssRect,
      });
      const frozenOwner = {
        filePath: file.path,
        preview,
        readingRoot,
        renderedText: readingRoot.textContent ?? '',
        scrollLeft: preview.scrollLeft,
        scrollTop: preview.scrollTop,
        source,
        view,
        viewportCssRect,
      };
      const selectedBackendId = this.backendId;
      const capture = await this.input.captureBackends.capture(selectedBackendId, {
        captureGeneration: generation,
        desiredPixelRatio:
          this.input.desiredPixelRatio?.() ??
          Math.min(2, Math.max(1, this.input.document.defaultView?.devicePixelRatio ?? 1)),
        signal: controller.signal,
        subject: this.input.createCaptureSubject(readingRoot, selectedBackendId),
        viewportCssRect,
      });
      await this.input.validatePngCoverage?.(capture.pngBytes, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== this.captureGeneration ||
        !(await this.captureGenerationStillOwned(frozenOwner))
      ) {
        controller.abort();
        return false;
      }
      const session = await SnapshotAnnotationSession.create({
        backend: { id: capture.backendId, version: capture.backendVersion },
        capturedAt: now,
        ...(this.input.deviceId === undefined ? {} : { deviceId: this.input.deviceId }),
        filePath: file.path,
        id: this.createId(),
        logicalHeight: capture.capturedCssRect.height,
        logicalWidth: capture.capturedCssRect.width,
        noteId: note.noteId,
        now: this.now,
        pixelHeight: capture.pixelHeight,
        pixelRatio: capture.pixelRatio,
        pixelWidth: capture.pixelWidth,
        pngBytes: capture.pngBytes,
        source: sourceBinding,
      });
      this.openSession(session, capture.pngBytes);
      return true;
    } finally {
      if (this.activeCapture === controller) this.activeCapture = null;
      restoreExcludedElements();
      this.input.document.body.classList.remove('is-inkstone-snapshot-capturing');
    }
  }

  async reopenLatestForActiveFile(): Promise<boolean> {
    this.assertAvailable();
    const view = this.activeReadingView();
    const filePath = view.file?.path;
    if (filePath === undefined) return false;
    const records = await this.input.repository.listRecords(filePath);
    const latest = records.find(({ deletedAt }) => deletedAt === undefined);
    if (latest === undefined) return false;
    const loaded = await this.input.repository.read(filePath, latest.id);
    if (loaded === null) return false;
    const session = SnapshotAnnotationSession.reopen(loaded.record, loaded.pngBytes, {
      now: this.now,
    });
    this.openSession(session, loaded.pngBytes);
    return true;
  }

  async reopenForActiveFile(snapshotId: string, readOnly = false): Promise<boolean> {
    this.assertAvailable();
    const filePath = this.activeReadingView().file?.path;
    if (filePath === undefined) return false;
    return this.reopen(filePath, snapshotId, readOnly);
  }

  async reopen(filePath: string, snapshotId: string, readOnly = false): Promise<boolean> {
    this.assertAvailable();
    const loaded = await this.input.repository.read(filePath, snapshotId);
    if (loaded === null || loaded.record.deletedAt !== undefined) return false;
    const session = SnapshotAnnotationSession.reopen(loaded.record, loaded.pngBytes, {
      now: this.now,
    });
    this.openSession(session, loaded.pngBytes, readOnly);
    return true;
  }

  async exportForActiveFile(snapshotId: string): Promise<boolean> {
    this.assertAvailable();
    const filePath = this.activeReadingView().file?.path;
    if (filePath === undefined) return false;
    return this.exportSnapshot(filePath, snapshotId);
  }

  async exportSnapshot(filePath: string, snapshotId: string): Promise<boolean> {
    this.assertAvailable();
    if (this.input.exportSnapshot === undefined) return false;
    const loaded = await this.input.repository.read(filePath, snapshotId);
    if (loaded === null) return false;
    await this.input.exportSnapshot(loaded.record, loaded.pngBytes);
    return true;
  }

  async jumpToSourceForActiveFile(snapshotId: string): Promise<boolean> {
    this.assertAvailable();
    const view = this.activeReadingView();
    const file = view.file;
    if (file === null) return false;
    return this.jumpToSourceInView(view, file.path, snapshotId);
  }

  async jumpToSource(filePath: string, snapshotId: string): Promise<boolean> {
    this.assertAvailable();
    const view = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    if (view === null || view.file?.path !== filePath) return false;
    return this.jumpToSourceInView(view, filePath, snapshotId);
  }

  private async jumpToSourceInView(
    view: MarkdownView,
    filePath: string,
    snapshotId: string,
  ): Promise<boolean> {
    const file = view.file;
    if (file === null || file?.path !== filePath) return false;
    const entry = (await this.input.repository.listIndexEntries(filePath)).find(
      ({ id }) => id === snapshotId,
    );
    if (entry === undefined) return false;
    const source = await this.input.app.vault.cachedRead(file);
    const link = projectSnapshotSourceLink(source, entry.source);
    if (link.state === 'unanchored') return false;
    const anchor = link.anchors.find(({ focus }) => focus) ?? link.anchors[0];
    if (anchor === undefined) return false;
    const root = view.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (root === null) return false;
    for (const element of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li')) {
      const renderedText = element.textContent?.trim() ?? '';
      if (renderedText.length === 0) continue;
      try {
        const range = locateRenderedBlockSourceRange({
          renderedText,
          sectionSource: source,
          sectionSourceStart: 0,
        });
        if (range.start > anchor.start || range.end < anchor.end) continue;
        element.scrollIntoView({ block: 'center' });
        element.classList.add('inkstone-snapshot-source-pulse');
        globalThis.setTimeout(
          () => element.classList.remove('inkstone-snapshot-source-pulse'),
          900,
        );
        return true;
      } catch {
        // Keep looking for the uniquely mapped source block.
      }
    }
    return false;
  }

  async thumbnailForActiveFile(snapshotId: string): Promise<string | null> {
    this.assertAvailable();
    const view = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    const filePath = view?.file?.path;
    if (filePath === undefined) return null;
    return this.thumbnail(filePath, snapshotId);
  }

  async thumbnail(filePath: string, snapshotId: string): Promise<string | null> {
    this.assertAvailable();
    if (this.input.createThumbnailDataUrl === undefined) return null;
    const loaded = await this.input.repository.read(filePath, snapshotId);
    if (loaded === null) return null;
    const key = `${loaded.record.asset.sha256}:${loaded.record.revision}`;
    const cached = this.thumbnailCache.get(key);
    if (cached !== undefined) {
      this.thumbnailCache.delete(key);
      this.thumbnailCache.set(key, cached);
      return cached;
    }
    const dataUrl = await this.input.createThumbnailDataUrl(
      loaded.record,
      loaded.pngBytes,
      new AbortController().signal,
    );
    this.thumbnailCache.set(key, dataUrl);
    while (this.thumbnailCache.size > 32) {
      const oldest = this.thumbnailCache.keys().next().value;
      if (oldest === undefined) break;
      this.thumbnailCache.delete(oldest);
    }
    return dataUrl;
  }

  async refreshSourceTrackingForActiveFile(): Promise<void> {
    this.sourceObserver?.disconnect();
    this.sourceObserver = null;
    const view = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    const root = view?.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer') ?? null;
    if (
      view === null ||
      file === null ||
      file === undefined ||
      view.getMode() !== 'preview' ||
      root === null
    ) {
      this.input.onActiveSnapshotChanged?.(null);
      return;
    }
    // Remove markers left by builds from before Snapshot navigation moved entirely to Current file.
    root.querySelectorAll('.inkstone-snapshot-marker').forEach((marker) => marker.remove());
    const [entries, source] = await Promise.all([
      this.input.repository.listIndexEntries(file.path),
      this.input.app.vault.cachedRead(file),
    ]);
    const byElement = new Map<HTMLElement, string[]>();
    for (const entry of entries.filter(({ deletedAt }) => deletedAt === undefined)) {
      const link = projectSnapshotSourceLink(source, entry.source);
      if (link.state === 'unanchored') continue;
      const anchor = link.anchors.find(({ focus }) => focus) ?? link.anchors[0];
      if (anchor === undefined) continue;
      const element = findRenderedElementForAnchor(root, source, anchor);
      if (element === null) continue;
      const ids = byElement.get(element) ?? [];
      ids.push(entry.id);
      byElement.set(element, ids);
    }
    const Observer = this.input.document.defaultView?.IntersectionObserver;
    if (Observer === undefined || byElement.size === 0) return;
    const observer = new Observer((observations) => {
      const visible = observations
        .filter(({ isIntersecting }) => isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      const ids = visible === undefined ? undefined : byElement.get(visible.target as HTMLElement);
      this.input.onActiveSnapshotChanged?.(ids?.[0] ?? null);
    });
    for (const element of byElement.keys()) observer.observe(element);
    this.sourceObserver = observer;
  }

  async resumeLatestDraftForActiveFile(): Promise<boolean> {
    this.assertAvailable();
    const filePath = this.activeReadingView().file?.path;
    if (filePath === undefined || this.input.draftStore === undefined) return false;
    const draft = await this.input.draftStore.loadLatest(filePath);
    if (draft === null) return false;
    const session = SnapshotAnnotationSession.resumeDraft(draft, { now: this.now });
    this.openSession(session, draft.pngBytes);
    return true;
  }

  activeSessionSnapshot(): ReturnType<SnapshotAnnotationSession['snapshot']> | null {
    return this.activeSession?.snapshot() ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activeCapture?.abort();
    this.activeCapture = null;
    this.sourceObserver?.disconnect();
    this.sourceObserver = null;
    this.activeSession = null;
    this.thumbnailCache.clear();
    this.input.editor.dispose();
  }

  private activeReadingView(): MarkdownView {
    const view = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    if (view === null || view.getMode() !== 'preview') {
      throw new Error('Switch the active Markdown file to Reading View before capturing.');
    }
    return view;
  }

  private openSession(
    session: SnapshotAnnotationSession,
    pngBytes: Uint8Array,
    readOnly = false,
  ): void {
    this.activeSession = session;
    const { filePath, id } = session.snapshot().record;
    this.input.editor.open({
      onClose: () => {
        if (this.activeSession === session) this.activeSession = null;
      },
      onDone: async () => {
        await session.done(this.input.repository);
        if (this.input.draftStore !== undefined) {
          await this.input.draftStore
            .discard(
              snapshotDraftKey(session.snapshot().record.filePath, session.snapshot().record.id),
            )
            .catch((error: unknown) => this.input.onIssue?.(error));
        }
        const filePath = session.snapshot().record.filePath;
        await this.input.onRecordsChanged?.(filePath);
        await this.refreshSourceTrackingForActiveFile().catch((error: unknown) =>
          this.input.onIssue?.(error),
        );
      },
      ...(readOnly
        ? {
            onEdit: async () => {
              if (!(await this.reopen(filePath, id))) {
                throw new Error('Snapshot annotation is no longer available for editing.');
              }
            },
          }
        : {}),
      ...(this.input.draftStore === undefined
        ? {}
        : {
            onSaveDraft: () =>
              session.saveDraft(this.input.draftStore as SnapshotAnnotationDraftStore),
          }),
      ...(this.input.exportSnapshot === undefined
        ? {}
        : {
            onExport: () =>
              this.input.exportSnapshot?.(session.snapshot().record, session.captureBytes()) ??
              Promise.reject(new Error('Snapshot export is unavailable.')),
          }),
      pngBytes,
      readOnly,
      session,
    });
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error('Snapshot Annotation manager is disposed.');
  }

  private async captureGenerationStillOwned(input: {
    readonly filePath: string;
    readonly preview: HTMLElement;
    readonly readingRoot: HTMLElement;
    readonly renderedText: string;
    readonly scrollLeft: number;
    readonly scrollTop: number;
    readonly source: string;
    readonly view: MarkdownView;
    readonly viewportCssRect: {
      readonly height: number;
      readonly left: number;
      readonly top: number;
      readonly width: number;
    };
  }): Promise<boolean> {
    const active = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    if (
      active !== input.view ||
      active?.file?.path !== input.filePath ||
      active.getMode() !== 'preview' ||
      input.view.contentEl.querySelector('.markdown-preview-view') !== input.preview ||
      input.view.contentEl.querySelector('.markdown-preview-sizer') !== input.readingRoot ||
      input.preview.scrollLeft !== input.scrollLeft ||
      input.preview.scrollTop !== input.scrollTop ||
      (input.readingRoot.textContent ?? '') !== input.renderedText ||
      !sameCaptureRect(
        integerCaptureRect(input.preview.getBoundingClientRect(), this.input.document),
        input.viewportCssRect,
      )
    ) {
      return false;
    }
    return (await this.input.app.vault.cachedRead(active.file)).localeCompare(input.source) === 0;
  }
}

function sameCaptureRect(
  left: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  },
  right: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  },
): boolean {
  return (
    Math.abs(left.left - right.left) <= 1 &&
    Math.abs(left.top - right.top) <= 1 &&
    Math.abs(left.width - right.width) <= 1 &&
    Math.abs(left.height - right.height) <= 1
  );
}

function integerCaptureRect(
  rect: DOMRect,
  document: Document,
): {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
} {
  const left = Math.max(0, Math.ceil(rect.left));
  const top = Math.max(0, Math.ceil(rect.top));
  const right = Math.floor(rect.right);
  const statusBar = document.querySelector<HTMLElement>('.status-bar');
  const statusRect = statusBar?.getBoundingClientRect();
  const overlapsStatusBar =
    statusRect !== undefined &&
    statusRect.height > 0 &&
    statusRect.top > rect.top &&
    statusRect.top < rect.bottom &&
    statusRect.right > rect.left &&
    statusRect.left < rect.right;
  const bottom = Math.floor(
    overlapsStatusBar ? Math.min(rect.bottom, statusRect.top) : rect.bottom,
  );
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) {
    throw new Error('The active Reading View has no visible viewport to capture.');
  }
  return Object.freeze({ height, left, top, width });
}

function dismissHostTransientUi(document: Document): void {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) activeElement.blur();
  const KeyboardEventConstructor = document.defaultView?.KeyboardEvent;
  if (KeyboardEventConstructor === undefined) return;
  const event = new KeyboardEventConstructor('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'Escape',
    key: 'Escape',
  });
  (activeElement ?? document).dispatchEvent(event);
}

function hideCaptureExcludedElements(document: Document): () => void {
  const originals = [
    ...document.querySelectorAll<HTMLElement>(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR),
  ].map((element) => ({
    display: element.style.getPropertyValue('display'),
    priority: element.style.getPropertyPriority('display'),
    element,
  }));
  for (const { element } of originals) element.style.setProperty('display', 'none', 'important');
  return () => {
    for (const { display, element, priority } of originals) {
      if (display.length === 0) element.style.removeProperty('display');
      else element.style.setProperty('display', display, priority);
    }
  };
}

interface SnapshotCaptureSourceBlock {
  readonly anchor: SnapshotAnchorBlockInput;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

async function buildSnapshotCaptureSourceBinding(input: {
  readonly readingRoot: HTMLElement;
  readonly source: string;
  readonly viewportCssRect: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  };
}): Promise<SnapshotSourceBinding> {
  const blocks: SnapshotCaptureSourceBlock[] = [];
  for (const element of input.readingRoot.querySelectorAll<HTMLElement>(
    'h1, h2, h3, h4, h5, h6, p, li',
  )) {
    const renderedText = element.textContent?.trim() ?? '';
    const bounds = element.getBoundingClientRect();
    if (
      renderedText.length === 0 ||
      bounds.right <= input.viewportCssRect.left ||
      bounds.left >= input.viewportCssRect.left + input.viewportCssRect.width ||
      bounds.bottom <= input.viewportCssRect.top ||
      bounds.top >= input.viewportCssRect.top + input.viewportCssRect.height
    ) {
      continue;
    }
    try {
      const range = locateRenderedBlockSourceRange({
        renderedText,
        sectionSource: input.source,
        sectionSourceStart: 0,
      });
      if (blocks.some(({ anchor }) => anchor.start === range.start && anchor.end === range.end)) {
        continue;
      }
      blocks.push({
        anchor: {
          displayText: renderedText,
          end: range.end,
          scope: { headingPath: headingPathBefore(input.readingRoot, element) },
          start: range.start,
        },
        bottom: Math.min(input.viewportCssRect.height, bounds.bottom - input.viewportCssRect.top),
        left: Math.max(0, bounds.left - input.viewportCssRect.left),
        right: Math.min(input.viewportCssRect.width, bounds.right - input.viewportCssRect.left),
        top: Math.max(0, bounds.top - input.viewportCssRect.top),
      });
    } catch {
      // Unsupported or ambiguous rendered blocks are omitted from the stable source map.
    }
  }
  blocks.sort((left, right) => left.anchor.start - right.anchor.start);
  const nonOverlapping = blocks.filter(
    ({ anchor }, index, all) => index === 0 || anchor.start >= (all[index - 1]?.anchor.end ?? 0),
  );
  if (nonOverlapping.length === 0) {
    throw new Error('The visible Reading View has no stable source blocks to anchor a capture.');
  }

  const createBinding = async (
    selected: readonly SnapshotCaptureSourceBlock[],
    center: { readonly x: number; readonly y: number },
  ): Promise<SnapshotSourceBinding> => {
    if (selected.length === 0) {
      throw new Error('The cropped Snapshot has no stable source block to anchor.');
    }
    const focusBlock = selected.reduce((best, block) =>
      blockDistance(block, center) < blockDistance(best, center) ? block : best,
    );
    return createSnapshotSourceBinding({
      blocks: selected.map(({ anchor }) => anchor),
      focusBlockIndex: selected.indexOf(focusBlock),
      source: input.source,
    });
  };
  return createBinding(nonOverlapping, {
    x: input.viewportCssRect.width / 2,
    y: input.viewportCssRect.height / 2,
  });
}

function blockDistance(
  block: SnapshotCaptureSourceBlock,
  center: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(
    (block.left + block.right) / 2 - center.x,
    (block.top + block.bottom) / 2 - center.y,
  );
}

function headingPathBefore(
  readingRoot: HTMLElement,
  focusElement: HTMLElement | null,
): readonly string[] {
  const path: string[] = [];
  for (const heading of readingRoot.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    if (
      focusElement !== null &&
      heading !== focusElement &&
      (heading.compareDocumentPosition(focusElement) & Node.DOCUMENT_POSITION_FOLLOWING) === 0
    ) {
      continue;
    }
    const level = Number(heading.tagName.slice(1));
    path.splice(level - 1);
    const text = heading.textContent?.trim();
    if (text !== undefined && text.length > 0) path[level - 1] = text;
    if (heading === focusElement) break;
  }
  return path.filter((part) => part !== undefined);
}

function findRenderedElementForAnchor(
  root: HTMLElement,
  source: string,
  anchor: { readonly end: number; readonly start: number },
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li')) {
    const renderedText = element.textContent?.trim() ?? '';
    if (renderedText.length === 0) continue;
    try {
      const range = locateRenderedBlockSourceRange({
        renderedText,
        sectionSource: source,
        sectionSourceStart: 0,
      });
      if (range.start <= anchor.start && range.end >= anchor.end) return element;
    } catch {
      // Unsupported or ambiguous blocks cannot host a trusted Snapshot marker.
    }
  }
  return null;
}

function nextPaint(document: Document): Promise<void> {
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(resolve, 320);
    const requestAnimationFrame = document.defaultView?.requestAnimationFrame;
    if (requestAnimationFrame === undefined) return;
    requestAnimationFrame.call(document.defaultView, () => {
      requestAnimationFrame.call(document.defaultView, () => {
        // Electron capturePage may otherwise sample the previous GPU-composited frame even after
        // DOM visibility and two renderer frames have advanced. This bounded host-settle window
        // also lets Obsidian finish closing the command palette that invoked capture.
        globalThis.setTimeout(() => {
          globalThis.clearTimeout(timeout);
          resolve();
        }, 220);
      });
    });
  });
}
