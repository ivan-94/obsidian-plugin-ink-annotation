// @vitest-environment jsdom

import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationListItemModel } from '../models/annotation-list-item-model';
import { EllipsisMenuTrigger } from '../primitives/ellipsis-menu-trigger';
import { ListItemFrame } from './list-item-frame';

describe('ListItemFrame', () => {
  afterEach(() => document.body.replaceChildren());

  it('owns the shared row, summary and action-trigger structure across sidebar contexts', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const onActivate = vi.fn();

    render(
      <ListItemFrame
        actions={
          <EllipsisMenuTrigger
            className="inkstone-icon-button inkstone-list-item__action-trigger"
            items={[]}
            label="Open current actions"
          />
        }
        model={textModel()}
        onActivate={onActivate}
        presentation={{ context: 'current', showSecondary: true, status: 'active' }}
      />,
      container,
    );

    const current = container.querySelector<HTMLElement>('.inkstone-sidebar-row');
    expect(current).not.toBeNull();
    expect(current?.querySelector('.inkstone-sidebar-row__note')?.textContent).toBe('A note');
    expect(current?.querySelector('.inkstone-list-item__action-trigger')).not.toBeNull();
    current?.querySelector<HTMLButtonElement>('.inkstone-sidebar-row__summary')?.click();
    expect(onActivate).toHaveBeenCalledTimes(1);

    render(
      <ListItemFrame
        actions={
          <EllipsisMenuTrigger
            className="inkstone-icon-button inkstone-list-item__action-trigger"
            items={[]}
            label="Open Vault actions"
          />
        }
        model={textModel()}
        onActivate={onActivate}
        presentation={{
          context: 'vault',
          filePath: 'Notes/Test.md',
          fixedHeight: 66,
          showSecondary: false,
          status: 'active',
        }}
      />,
      container,
    );

    const vault = container.querySelector<HTMLElement>('.inkstone-vault-row');
    expect(vault?.style.height).toBe('66px');
    expect(vault?.dataset.noteGroup).toBe('Notes/Test.md');
    expect(vault?.querySelector('.inkstone-sidebar-row__note')).toBeNull();
    expect(vault?.querySelector('.inkstone-list-item__action-trigger')).not.toBeNull();
    expect(vault?.querySelector('.inkstone-vault-row__type-icon')).not.toBeNull();
  });

  it('uses the model leading kind instead of annotation kind for icon versus thumbnail layout', () => {
    const container = document.createElement('div');
    render(
      <ListItemFrame
        actions={null}
        model={{
          ...textModel(),
          kind: 'ink',
          leading: { icon: 'waves', kind: 'icon' },
          title: 'Ink · Anchor Lab',
        }}
        onActivate={() => undefined}
        presentation={{ context: 'vault', status: 'active' }}
      />,
      container,
    );

    expect(container.querySelector('[data-inkstone-icon="waves"]')).not.toBeNull();
    expect(container.querySelector('[data-inkstone-ink-thumbnail]')).toBeNull();
  });

  it('replaces actions with one trailing selection control and makes the whole row selectable', () => {
    const container = document.createElement('div');
    const onToggle = vi.fn();
    render(
      <ListItemFrame
        actions={<span data-actions="" />}
        model={textModel()}
        onActivate={() => undefined}
        presentation={{ context: 'current', showSecondary: true, status: 'active' }}
        selection={{ label: 'Select annotation one', onToggle, selected: true }}
      />,
      container,
    );

    const row = container.querySelector<HTMLElement>('.inkstone-sidebar-row');
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(row?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-actions]')).toBeNull();
    expect(checkbox?.checked).toBe(true);
    row?.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    checkbox?.click();
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});

function textModel(): AnnotationListItemModel {
  return {
    capabilities: ['open', 'edit'],
    id: 'one',
    key: 'one',
    kind: 'highlight',
    leading: { icon: 'highlighter', kind: 'icon', styleId: 'highlight-sun' },
    metadata: [{ kind: 'time', label: '07-16 10:00' }],
    revision: 1,
    secondary: 'A note',
    state: {
      active: false,
      conflict: false,
      deleted: false,
      unanchored: false,
    },
    title: 'Selected text',
    tone: 'default',
  };
}
