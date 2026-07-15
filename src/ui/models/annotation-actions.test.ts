import { describe, expect, it } from 'vitest';

import { describeAnnotationAction, reduceAsyncAction } from './annotation-actions';

describe('annotation action presentation state', () => {
  it('keeps a failed action retryable without losing its error', () => {
    const pending = reduceAsyncAction({ kind: 'idle' }, { kind: 'start' });
    const failed = reduceAsyncAction(pending, {
      error: new Error('Local write failed'),
      kind: 'fail',
    });

    expect(failed).toMatchObject({ kind: 'error', message: 'Local write failed' });
    expect(reduceAsyncAction(failed, { kind: 'retry' })).toEqual({ kind: 'pending' });
  });

  it('provides one shared descriptor for destructive actions', () => {
    expect(describeAnnotationAction('delete')).toEqual({
      capability: 'delete',
      danger: true,
      icon: 'trash-2',
      label: 'Delete',
    });
  });
});
