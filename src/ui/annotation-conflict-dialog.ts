export interface AnnotationConflictCandidateView {
  readonly body?: string;
  readonly deviceId?: string;
  readonly mark?: { readonly kind: 'highlight' | 'underline'; readonly styleId: string };
  readonly path: string;
  readonly previewSvg?: string;
  readonly quote: string;
  readonly revision: number;
  readonly tags: readonly string[];
  readonly updatedAt: string;
}

export interface AnnotationConflictReviewView {
  readonly annotationId: string;
  readonly candidates: readonly AnnotationConflictCandidateView[];
  readonly kind: 'ink' | 'text';
}

export class AnnotationConflictDialog {
  private readonly document: Document;
  private element: HTMLDivElement | null = null;
  private invoker: HTMLElement | null = null;

  constructor(input: { readonly document: Document }) {
    this.document = input.document;
  }

  show(input: {
    readonly conflicts: readonly AnnotationConflictReviewView[];
    readonly invoker?: HTMLElement;
    readonly onResolve: (
      annotationId: string,
      candidatePath: string,
      kind: AnnotationConflictReviewView['kind'],
    ) => Promise<void>;
  }): void {
    if (input.conflicts.length === 0) {
      throw new Error('Conflict repair requires at least one divergent annotation.');
    }
    this.close(false);
    this.invoker = input.invoker ?? null;
    const dialog = this.document.createElement('div');
    dialog.className = 'inkstone-conflict-dialog';
    dialog.setAttribute('aria-label', 'Repair annotation conflict');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('role', 'dialog');
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });

    const heading = this.document.createElement('h2');
    heading.textContent = 'Repair annotation conflict';
    const explanation = this.document.createElement('p');
    explanation.textContent =
      'Compare the copies and choose one explicitly. Inkstone will create a higher local revision and keep every conflict file.';
    const conflictSelector = this.document.createElement('select');
    conflictSelector.setAttribute('aria-label', 'Conflicted annotation');
    for (const [index, conflict] of input.conflicts.entries()) {
      const option = this.document.createElement('option');
      option.value = String(index);
      option.textContent = `${index + 1}. ${conflict.kind === 'ink' ? 'Ink · ' : ''}${conflict.candidates[0]?.quote ?? conflict.annotationId}`;
      conflictSelector.append(option);
    }
    if (input.conflicts.length === 1) conflictSelector.hidden = true;
    const candidates = this.document.createElement('fieldset');
    const legend = this.document.createElement('legend');
    legend.textContent = 'Choose the copy to keep';
    candidates.append(legend);
    const status = this.document.createElement('p');
    status.dataset.inkstoneConflictStatus = '';
    const resolve = this.document.createElement('button');
    resolve.type = 'button';
    resolve.disabled = true;
    resolve.setAttribute('aria-label', 'Resolve with selected copy');
    resolve.textContent = 'Use selected copy';
    const close = this.document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.close());

    const selectedConflict = (): AnnotationConflictReviewView => {
      const conflict = input.conflicts[Number(conflictSelector.value)];
      if (conflict === undefined) throw new Error('The selected conflict is unavailable.');
      return conflict;
    };
    const renderCandidates = (): void => {
      candidates.querySelectorAll('label').forEach((label) => label.remove());
      resolve.disabled = true;
      status.textContent = '';
      status.removeAttribute('role');
      const conflict = selectedConflict();
      for (const [index, candidate] of conflict.candidates.entries()) {
        const label = this.document.createElement('label');
        label.className = 'inkstone-conflict-dialog__candidate';
        const radio = this.document.createElement('input');
        radio.type = 'radio';
        radio.name = 'inkstone-conflict-candidate';
        radio.value = candidate.path;
        radio.addEventListener('change', () => {
          resolve.disabled = false;
        });
        const title = this.document.createElement('strong');
        title.textContent = `Copy ${index + 1} · revision ${candidate.revision}`;
        const metadata = this.document.createElement('span');
        metadata.textContent = `${candidate.deviceId ?? 'unknown device'} · ${candidate.updatedAt} · ${basename(candidate.path)}`;
        const quote = this.document.createElement('q');
        quote.textContent = candidate.quote;
        const preview =
          candidate.previewSvg === undefined ? null : this.document.createElement('img');
        if (preview !== null && candidate.previewSvg !== undefined) {
          preview.alt = `Ink preview for copy ${index + 1}`;
          preview.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(candidate.previewSvg)}`;
        }
        const details = this.document.createElement('span');
        details.textContent = [
          candidate.mark === undefined
            ? 'note only'
            : `${candidate.mark.kind} · ${candidate.mark.styleId}`,
          candidate.tags.length === 0 ? 'no tags' : `tags: ${candidate.tags.join(', ')}`,
          candidate.body?.trim() || 'no note body',
        ].join(' · ');
        label.append(radio, title, metadata, quote);
        if (preview !== null) label.append(preview);
        label.append(details);
        candidates.append(label);
      }
    };
    conflictSelector.addEventListener('change', renderCandidates);
    resolve.addEventListener('click', () => {
      const chosen = candidates.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      if (chosen === null) return;
      conflictSelector.disabled = true;
      candidates.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
        input.disabled = true;
      });
      resolve.disabled = true;
      status.textContent = 'Saving the selected copy locally…';
      status.removeAttribute('role');
      void input
        .onResolve(selectedConflict().annotationId, chosen.value, selectedConflict().kind)
        .then(() => {
          status.textContent = 'Conflict repaired locally. Original conflict files were preserved.';
        })
        .catch(() => {
          status.setAttribute('role', 'alert');
          status.textContent =
            "The conflict changed or couldn't be saved. Close and review it again.";
          conflictSelector.disabled = false;
          candidates.querySelectorAll<HTMLInputElement>('input').forEach((candidate) => {
            candidate.disabled = false;
          });
          resolve.disabled = false;
        });
    });

    dialog.append(heading, explanation, conflictSelector, candidates, status, resolve, close);
    this.document.body.append(dialog);
    this.element = dialog;
    renderCandidates();
    candidates.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }

  close(returnFocus = true): void {
    this.element?.remove();
    this.element = null;
    if (returnFocus) this.invoker?.focus({ preventScroll: true });
    this.invoker = null;
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
