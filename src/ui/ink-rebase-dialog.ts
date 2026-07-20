import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import {
  confirmInkRebase,
  previewInkRebase,
  type InkLayoutObservation,
  type InkSurfaceSection,
} from '../domain/ink-surface-layout';
import { drawInkBrushGeometryToCanvas } from './ink-brush-canvas-adapter';

const SHARED_INK_GEOMETRY = new SharedInkStrokeGeometry();

export interface InkRebaseTarget {
  readonly layout: InkLayoutObservation;
  readonly section: InkSurfaceSection;
}

/** Explicit preview/confirm boundary for recovering geometry after source or layout drift. */
export class InkRebaseDialog {
  private readonly document: Document;
  private element: HTMLElement | null = null;
  private readonly now: () => string;
  private readonly onConfirm: (record: InkSurfaceRecord) => Promise<void>;
  private readonly record: InkSurfaceRecord;
  private resolve: ((result: 'cancelled' | 'confirmed') => void) | null = null;
  private readonly targets: readonly InkRebaseTarget[];

  constructor(input: {
    readonly document: Document;
    readonly now?: () => string;
    readonly onConfirm: (record: InkSurfaceRecord) => Promise<void>;
    readonly record: InkSurfaceRecord;
    readonly targets: readonly InkRebaseTarget[];
  }) {
    if (input.targets.length === 0) {
      throw new Error('Ink rebase requires at least one target section.');
    }
    this.document = input.document;
    this.now = input.now ?? (() => new Date().toISOString());
    this.onConfirm = input.onConfirm;
    this.record = input.record;
    this.targets = input.targets;
  }

  show(): Promise<'cancelled' | 'confirmed'> {
    if (this.element !== null) {
      throw new Error('Ink rebase dialog is already open.');
    }
    const dialog = this.document.createElement('div');
    dialog.className = 'inkstone-ink-rebase-dialog';
    dialog.dataset.inkstoneRebaseDialog = 'true';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('role', 'dialog');

    const title = this.document.createElement('h2');
    title.textContent = 'Rebase Ink';
    const context = this.document.createElement('p');
    const oldHeading = this.record.binding?.headingPath.join(' › ') || 'Unanchored section';
    context.textContent = `Saved context: ${oldHeading} · ${this.record.strokes.length} stroke${this.record.strokes.length === 1 ? '' : 's'}`;

    const selectLabel = this.document.createElement('label');
    selectLabel.textContent = 'Move Ink to section';
    const select = this.document.createElement('select');
    select.dataset.inkstoneRebaseTarget = 'true';
    this.targets.forEach((target, index) => {
      const option = this.document.createElement('option');
      option.value = String(index);
      option.textContent = targetLabel(target.section, index);
      select.append(option);
    });
    selectLabel.append(select);

    const previewLabel = this.document.createElement('p');
    previewLabel.dataset.inkstoneRebasePreview = 'true';
    const canvas = this.document.createElement('canvas');
    canvas.width = 440;
    canvas.height = 280;
    canvas.setAttribute('aria-label', 'Ink placement preview');

    const status = this.document.createElement('p');
    status.className = 'inkstone-ink-rebase-dialog__status';
    status.setAttribute('aria-live', 'polite');
    const actions = this.document.createElement('div');
    actions.className = 'inkstone-ink-rebase-dialog__actions';
    const cancel = this.document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.dataset.inkstoneRebaseCancel = 'true';
    const confirm = this.document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = 'Confirm rebase';
    confirm.dataset.inkstoneRebaseConfirm = 'true';
    actions.append(cancel, confirm);
    dialog.append(title, context, selectLabel, previewLabel, canvas, status, actions);
    this.document.body.append(dialog);
    this.element = dialog;

    const previewSelected = (): ReturnType<typeof previewInkRebase> | null => {
      const target = this.targets[Number.parseInt(select.value, 10) || 0];
      if (target === undefined) return null;
      try {
        const preview = previewInkRebase(this.record, target.section, target.layout);
        previewLabel.textContent = `Preview: ${targetLabel(target.section, 0)}`;
        status.textContent = '';
        confirm.disabled = false;
        renderPreview(canvas, preview.record);
        return preview;
      } catch (error) {
        previewLabel.textContent = 'Preview unavailable';
        status.textContent = error instanceof Error ? error.message : String(error);
        confirm.disabled = true;
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        return null;
      }
    };
    select.addEventListener('change', previewSelected);
    cancel.addEventListener('click', () => this.close('cancelled'));
    confirm.addEventListener('click', () => {
      const preview = previewSelected();
      if (preview === null) return;
      confirm.disabled = true;
      status.textContent = 'Saving rebase…';
      const updated = confirmInkRebase(this.record, preview, this.now());
      void this.onConfirm(updated).then(
        () => this.close('confirmed'),
        (error: unknown) => {
          confirm.disabled = false;
          status.textContent = error instanceof Error ? error.message : String(error);
        },
      );
    });
    previewSelected();
    select.focus();

    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  dispose(): void {
    this.close('cancelled');
  }

  private close(result: 'cancelled' | 'confirmed'): void {
    if (this.element === null) return;
    this.element.remove();
    this.element = null;
    this.resolve?.(result);
    this.resolve = null;
  }
}

function targetLabel(section: InkSurfaceSection, index: number): string {
  return section.headingPath.join(' › ') || `Document section ${index + 1}`;
}

function renderPreview(canvas: HTMLCanvasElement, record: InkSurfaceRecord): void {
  const context = canvas.getContext('2d');
  if (context === null) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(
    canvas.width / record.layout.logicalWidth,
    canvas.height / record.layout.logicalHeight,
  );
  context.save();
  try {
    context.scale(scale, scale);
    for (const stroke of record.strokes) {
      if (stroke.tool === 'eraser') continue;
      const compiled = SHARED_INK_GEOMETRY.compile(stroke);
      if (!('geometry' in compiled)) {
        throw new Error(
          `Unsupported Ink Brush Geometry ${compiled.requestedVersion}: ${compiled.reason}.`,
        );
      }
      drawInkBrushGeometryToCanvas(context, compiled.geometry);
    }
  } finally {
    context.restore();
  }
}
