import type { TextAnnotationExportFormat } from '../application/text-annotation-exporter';

export class AnnotationExportDialog {
  private readonly document: Document;
  private element: HTMLDivElement | null = null;
  private invoker: HTMLElement | null = null;

  constructor(input: { readonly document: Document }) {
    this.document = input.document;
  }

  show(input: {
    readonly invoker?: HTMLElement;
    readonly onExport: (format: TextAnnotationExportFormat) => Promise<string>;
    readonly title: string;
  }): void {
    this.close(false);
    this.invoker = input.invoker ?? null;
    const dialog = this.document.createElement('div');
    dialog.className = 'inkstone-export-dialog';
    dialog.setAttribute('aria-label', input.title);
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('role', 'dialog');
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
    const heading = this.document.createElement('h2');
    heading.textContent = input.title;
    const format = this.document.createElement('select');
    format.setAttribute('aria-label', 'Export format');
    for (const [value, label] of [
      ['markdown-report', 'Standalone Markdown report'],
      ['markdown-highlight', 'Plain Markdown highlights'],
      ['markdown-footnote', 'Markdown footnotes'],
      ['html-mark', 'HTML marks'],
    ] as const) {
      const option = this.document.createElement('option');
      option.value = value;
      option.textContent = label;
      format.append(option);
    }
    const status = this.document.createElement('p');
    status.dataset.inkstoneExportStatus = '';
    const create = this.document.createElement('button');
    create.type = 'button';
    create.setAttribute('aria-label', 'Create export');
    create.textContent = 'Export';
    create.addEventListener('click', () => {
      create.disabled = true;
      status.removeAttribute('role');
      status.textContent = 'Creating export…';
      void input
        .onExport(format.value as TextAnnotationExportFormat)
        .then((path) => {
          status.textContent = `Created ${path}`;
        })
        .catch(() => {
          status.setAttribute('role', 'alert');
          status.textContent = "Couldn't create export. Retry.";
        })
        .finally(() => {
          create.disabled = false;
        });
    });
    const close = this.document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.close());
    dialog.append(heading, format, status, create, close);
    this.document.body.append(dialog);
    this.element = dialog;
    format.focus({ preventScroll: true });
  }

  close(returnFocus = true): void {
    this.element?.remove();
    this.element = null;
    if (returnFocus) {
      this.invoker?.focus({ preventScroll: true });
    }
    this.invoker = null;
  }
}
