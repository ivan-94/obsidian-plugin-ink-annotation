import type { SnapshotAnnotationSession } from '../application/snapshot-annotation-session';
import { setIcon } from 'obsidian';
import type { LocalInkToolPreferenceStore } from '../storage/local-ink-tool-preference';
import { SnapshotImageCamera } from './snapshot-image-camera';
import { SnapshotInkWorkspace } from './snapshot-ink-workspace';

export interface SnapshotAnnotationEditorInput {
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly document: Document;
  readonly preferenceStore?: Pick<LocalInkToolPreferenceStore, 'load' | 'save'>;
  readonly revokeObjectUrl?: (url: string) => void;
}

export interface OpenSnapshotAnnotationEditorInput {
  readonly onClose: () => void;
  readonly onDone: () => Promise<void>;
  readonly onEdit?: () => void | Promise<void>;
  readonly onExport?: () => Promise<void>;
  readonly onSaveDraft?: () => Promise<void>;
  readonly pngBytes: Uint8Array;
  readonly readOnly?: boolean;
  readonly session: SnapshotAnnotationSession;
}

/** Bounded image editor that delegates Ink input, tools, and rendering to shared Ink contracts. */
export class SnapshotAnnotationEditor {
  private readonly createObjectUrl: (blob: Blob) => string;
  private disposeActive: (() => void) | null = null;
  private readonly document: Document;
  private readonly preferenceStore: Pick<LocalInkToolPreferenceStore, 'load' | 'save'> | undefined;
  private readonly revokeObjectUrl: (url: string) => void;

  constructor(input: SnapshotAnnotationEditorInput) {
    this.document = input.document;
    this.preferenceStore = input.preferenceStore;
    this.createObjectUrl =
      input.createObjectUrl ?? ((blob) => globalThis.URL.createObjectURL(blob));
    this.revokeObjectUrl = input.revokeObjectUrl ?? ((url) => globalThis.URL.revokeObjectURL(url));
  }

  open(input: OpenSnapshotAnnotationEditorInput): void {
    this.disposeActive?.();
    const snapshot = input.session.snapshot();
    const { logicalHeight, logicalWidth } = snapshot.record.ink;
    const root = this.document.createElement('div');
    root.className = `inkstone-snapshot-editor is-snapshot-markup-mode${input.readOnly === true ? ' is-read-only' : ''}`;
    root.dataset.inkstoneSnapshotEditor = '';
    root.setAttribute(
      'aria-label',
      input.readOnly === true
        ? 'Snapshot annotation preview, read only'
        : 'Snapshot annotation editor',
    );
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('role', 'dialog');
    root.tabIndex = -1;

    const header = this.document.createElement('header');
    header.className = 'inkstone-snapshot-editor__header';
    const closeButton = this.document.createElement('button');
    closeButton.className = 'inkstone-snapshot-editor__close';
    closeButton.dataset.inkstoneSnapshotClose = '';
    closeButton.setAttribute('aria-label', 'Close Snapshot editor');
    closeButton.type = 'button';
    setIcon(closeButton, 'x');
    header.append(closeButton);
    const title = this.document.createElement('div');
    title.className = 'inkstone-snapshot-editor__title';
    title.textContent = snapshot.record.filePath;
    const status = this.document.createElement('span');
    status.className = 'inkstone-snapshot-editor__status';
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('role', 'status');
    header.append(title, status);
    if (input.readOnly === true) {
      const enterEdit = this.document.createElement('button');
      enterEdit.className = 'inkstone-snapshot-editor__read-only';
      enterEdit.dataset.inkstoneSnapshotReadOnly = '';
      enterEdit.disabled = input.onEdit === undefined;
      enterEdit.textContent = input.onEdit === undefined ? 'Read only' : 'Read only · Edit';
      enterEdit.type = 'button';
      enterEdit.addEventListener('click', () => {
        if (input.onEdit === undefined || enterEdit.disabled) return;
        enterEdit.disabled = true;
        status.textContent = 'Opening editor…';
        void Promise.resolve(input.onEdit()).catch((error: unknown) => {
          enterEdit.disabled = false;
          status.textContent =
            error instanceof Error ? error.message : 'Could not enter Snapshot edit mode.';
        });
      });
      header.append(enterEdit);
    }

    const viewport = this.document.createElement('main');
    viewport.className = 'inkstone-snapshot-editor__viewport';
    const frame = this.document.createElement('div');
    frame.className = 'inkstone-snapshot-editor__frame';
    frame.style.setProperty('--inkstone-snapshot-aspect', `${logicalWidth} / ${logicalHeight}`);
    frame.style.setProperty('--inkstone-snapshot-width', `${logicalWidth}px`);
    const image = this.document.createElement('img');
    image.alt = `Captured Reading View from ${snapshot.record.filePath}`;
    image.draggable = false;
    const ownedBytes = Uint8Array.from(input.pngBytes);
    const objectUrl = this.createObjectUrl(new Blob([ownedBytes.buffer], { type: 'image/png' }));
    image.src = objectUrl;
    const canvas = this.document.createElement('canvas');
    canvas.dataset.inkstoneSnapshotCanvas = '';
    canvas.width = snapshot.record.asset.pixelWidth;
    canvas.height = snapshot.record.asset.pixelHeight;
    canvas.setAttribute('aria-label', 'Snapshot Ink canvas');
    frame.append(image, canvas);
    viewport.append(frame);
    root.append(header, viewport);
    this.document.body.append(root);
    this.document.body.classList.add('is-inkstone-snapshot-editor');

    const context = canvas.getContext('2d');
    if (context === null) {
      this.revokeObjectUrl(objectUrl);
      root.remove();
      this.document.body.classList.remove('is-inkstone-snapshot-editor');
      throw new Error('Snapshot Annotation Canvas 2D is unavailable.');
    }

    const camera = new SnapshotImageCamera({
      imageHeight: logicalHeight,
      imageWidth: logicalWidth,
    });
    const touches = new Map<number, { readonly x: number; readonly y: number }>();
    let backDialog: HTMLElement | null = null;
    let committing = false;

    const applyCamera = (): number => {
      const state = camera.snapshot();
      frame.style.transformOrigin = '0 0';
      frame.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
      workspace?.syncZoom(state.scale, 'manual');
      return state.scale;
    };
    const fitCamera = (): number => {
      const bounds = snapshotFitViewportBounds(
        this.document,
        root,
        viewport.getBoundingClientRect(),
      );
      if (bounds.width > 0 && bounds.height > 0) {
        camera.fit(bounds);
      }
      const state = camera.snapshot();
      frame.style.transformOrigin = '0 0';
      frame.style.transform = `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;
      return state.scale;
    };
    const stepCamera = (factor: number): number => {
      const bounds = viewport.getBoundingClientRect();
      camera.zoomAt({
        factor,
        screenX: Math.max(0, bounds.width / 2),
        screenY: Math.max(0, bounds.height / 2),
      });
      return applyCamera();
    };
    const close = (): void => {
      this.disposeActive?.();
      input.onClose();
    };

    let workspace: SnapshotInkWorkspace | null = null;
    workspace = new SnapshotInkWorkspace({
      canvas,
      controlsHost: root,
      document: this.document,
      logicalHeight,
      logicalWidth,
      onDone: async () => {
        if (committing) return;
        committing = true;
        status.textContent = 'Saving locally…';
        try {
          await input.onDone();
          status.textContent = 'Saved locally';
          close();
        } catch (error) {
          committing = false;
          status.textContent = error instanceof Error ? error.message : 'Local save failed. Retry.';
          throw error;
        }
      },
      ...(input.onExport === undefined ? {} : { onExport: input.onExport }),
      onPanBy: (delta) => {
        camera.panBy(delta);
        applyCamera();
      },
      onStatus: (message) => {
        status.textContent = message;
      },
      onZoomFit: fitCamera,
      onZoomStep: stepCamera,
      pixelRatio: snapshot.record.asset.pixelRatio,
      ...(this.preferenceStore === undefined ? {} : { preferenceStore: this.preferenceStore }),
      readOnly: input.readOnly === true,
      session: input.session,
    });

    const closeBackDialog = (): void => {
      backDialog?.remove();
      backDialog = null;
    };
    const showBackDialog = (): void => {
      if (backDialog !== null) return;
      const dialog = this.document.createElement('div');
      dialog.className = 'inkstone-snapshot-editor__back-dialog';
      dialog.dataset.inkstoneSnapshotBackDialog = '';
      dialog.setAttribute('aria-label', 'Unsaved Snapshot annotation');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('role', 'dialog');
      const message = this.document.createElement('p');
      message.textContent = 'Save this Snapshot annotation as a device-local draft?';
      const actions = this.document.createElement('div');
      actions.className = 'inkstone-snapshot-editor__back-actions';
      const saveDraft = textButton(this.document, 'Save draft');
      saveDraft.dataset.inkstoneSnapshotSaveDraft = '';
      const discard = textButton(this.document, 'Discard');
      discard.dataset.inkstoneSnapshotDiscard = '';
      const continueEditing = textButton(this.document, 'Continue editing');
      continueEditing.dataset.inkstoneSnapshotContinue = '';
      actions.append(saveDraft, discard, continueEditing);
      dialog.append(message, actions);
      root.append(dialog);
      backDialog = dialog;
      continueEditing.addEventListener('click', closeBackDialog);
      let discardConfirmed = false;
      discard.addEventListener('click', () => {
        if (!discardConfirmed) {
          discardConfirmed = true;
          message.textContent = 'Discard this unsaved Snapshot annotation permanently?';
          discard.textContent = 'Confirm discard';
          discard.focus();
          return;
        }
        close();
      });
      saveDraft.addEventListener('click', () => {
        if (committing) return;
        committing = true;
        saveDraft.disabled = true;
        discard.disabled = true;
        continueEditing.disabled = true;
        status.textContent = 'Saving draft on this device…';
        void (input.onSaveDraft?.() ?? Promise.reject(new Error('Draft storage is unavailable.')))
          .then(() => close())
          .catch((error: unknown) => {
            committing = false;
            saveDraft.disabled = false;
            discard.disabled = false;
            continueEditing.disabled = false;
            status.textContent =
              error instanceof Error ? error.message : 'Device-local draft save failed.';
          });
      });
      saveDraft.focus();
    };
    const onBack = (): void => {
      if (committing) return;
      if (input.readOnly === true) {
        close();
        return;
      }
      if (input.session.hasUnsavedChanges()) showBackDialog();
      else close();
    };
    closeButton.addEventListener('click', onBack);

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      }
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        const previous = touches.get(event.pointerId);
        if (previous === undefined) return;
        const before = touchGesture([...touches.values()]);
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const after = touchGesture([...touches.values()]);
        camera.panBy({ x: after.centerX - before.centerX, y: after.centerY - before.centerY });
        if (before.distance > 0 && after.distance > 0) {
          const bounds = viewport.getBoundingClientRect();
          camera.zoomAt({
            factor: after.distance / before.distance,
            screenX: after.centerX - bounds.left,
            screenY: after.centerY - bounds.top,
          });
        }
        applyCamera();
        event.preventDefault();
      }
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        touches.delete(event.pointerId);
        event.preventDefault();
      }
    };
    const onWheel = (event: WheelEvent): void => {
      if (committing || !event.metaKey) return;
      const bounds = viewport.getBoundingClientRect();
      camera.zoomAt({
        factor: Math.exp(-event.deltaY * 0.0015),
        screenX: event.clientX - bounds.left,
        screenY: event.clientY - bounds.top,
      });
      applyCamera();
      event.preventDefault();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onBack();
    };
    this.document.addEventListener('keydown', onKeyDown, true);
    this.disposeActive = () => {
      if (!root.isConnected) return;
      workspace?.dispose();
      workspace = null;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      viewport.removeEventListener('wheel', onWheel);
      this.document.removeEventListener('keydown', onKeyDown, true);
      closeBackDialog();
      this.revokeObjectUrl(objectUrl);
      root.remove();
      this.document.body.classList.remove('is-inkstone-snapshot-editor');
      this.disposeActive = null;
    };
    fitCamera();
    workspace.syncZoom(camera.snapshot().scale, 'fit');
    root.focus();
  }

  dispose(): void {
    this.disposeActive?.();
  }
}

function touchGesture(points: readonly { readonly x: number; readonly y: number }[]): {
  readonly centerX: number;
  readonly centerY: number;
  readonly distance: number;
} {
  const first = points[0];
  if (first === undefined) return { centerX: 0, centerY: 0, distance: 0 };
  const second = points[1];
  if (second === undefined) return { centerX: first.x, centerY: first.y, distance: 0 };
  return {
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

function snapshotFitViewportBounds(
  document: Document,
  root: HTMLElement,
  viewport: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>,
): { readonly height: number; readonly width: number } {
  const full = { height: viewport.height, width: viewport.width };
  if (!document.body.classList.contains('is-mobile')) return full;
  const controls = root.querySelector<HTMLElement>('.inkstone-ink-controls');
  // An explicitly dragged toolbar is user-positioned overlay chrome and must not redefine Fit.
  if (controls === null || controls.style.top.length > 0) return full;
  const toolbar = controls.getBoundingClientRect();
  const horizontallyOverlaps = toolbar.right > viewport.left && toolbar.left < viewport.right;
  const verticallyOverlaps = toolbar.bottom > viewport.top && toolbar.top < viewport.bottom;
  if (!horizontallyOverlaps || !verticallyOverlaps || toolbar.width <= 0 || toolbar.height <= 0) {
    return full;
  }
  const height = Math.min(viewport.height, toolbar.top - viewport.top - 8);
  return height > 0 ? { height, width: viewport.width } : full;
}

function textButton(document: Document, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'inkstone-snapshot-editor__text-button';
  button.textContent = label;
  button.type = 'button';
  return button;
}
