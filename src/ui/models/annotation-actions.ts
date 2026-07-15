import type { AnnotationCapability } from './annotation-list-item-model';

export interface AnnotationActionDescriptor {
  readonly capability: AnnotationCapability;
  readonly danger?: boolean;
  readonly icon: string;
  readonly label: string;
}

export type AsyncActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'success' }
  | { readonly error: unknown; readonly kind: 'error'; readonly message: string };

export type AsyncActionEvent =
  | { readonly kind: 'fail'; readonly error: unknown }
  | { readonly kind: 'reset' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'start' }
  | { readonly kind: 'succeed' };

const ACTIONS: Readonly<Record<AnnotationCapability, AnnotationActionDescriptor>> = {
  copy: { capability: 'copy', icon: 'copy', label: 'Copy' },
  delete: { capability: 'delete', danger: true, icon: 'trash-2', label: 'Delete' },
  edit: { capability: 'edit', icon: 'square-pen', label: 'Edit' },
  export: { capability: 'export', icon: 'share', label: 'Export' },
  'export-png': { capability: 'export-png', icon: 'image-down', label: 'Export PNG' },
  'export-svg': { capability: 'export-svg', icon: 'file-code-2', label: 'Export SVG' },
  open: { capability: 'open', icon: 'external-link', label: 'Open source' },
  restore: { capability: 'restore', icon: 'undo-2', label: 'Restore' },
};

export function describeAnnotationAction(
  capability: AnnotationCapability,
): AnnotationActionDescriptor {
  return ACTIONS[capability];
}

export function reduceAsyncAction(
  _state: AsyncActionState,
  event: AsyncActionEvent,
): AsyncActionState {
  switch (event.kind) {
    case 'fail':
      return { error: event.error, kind: 'error', message: errorMessage(event.error) };
    case 'reset':
      return { kind: 'idle' };
    case 'retry':
    case 'start':
      return { kind: 'pending' };
    case 'succeed':
      return { kind: 'success' };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
