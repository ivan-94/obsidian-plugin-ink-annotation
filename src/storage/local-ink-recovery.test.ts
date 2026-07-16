import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { LocalInkRecoveryStore, planLocalInkRecovery } from './local-ink-recovery';

describe('local Ink recovery checkpoint', () => {
  it('fences a disposed manager after a reloaded manager claims the file', () => {
    const storage = new MemoryStorage();
    const store = new LocalInkRecoveryStore(storage, 'Vault', 'device-a');
    store.claim('Ink.md', 'old-manager');
    store.save('Ink.md', [surface('a', 1, ['old'])], 'old-manager');

    store.claim('Ink.md', 'new-manager');

    expect(() => store.save('Ink.md', [surface('a', 1, ['late-old'])], 'old-manager')).toThrow(
      /stale Ink recovery owner/u,
    );
    expect(() => store.save('Ink.md', [surface('a', 1, ['new'])], 'new-manager')).not.toThrow();
    expect(store.load('Ink.md')).toMatchObject({ records: [{ strokes: [{ id: 'new' }] }] });
  });

  it('round-trips validated bounded records and clears only the captured generation', () => {
    const storage = new MemoryStorage();
    const store = new LocalInkRecoveryStore(storage, 'Vault', 'device-a');
    const first = store.save('Ink.md', [surface('a', 1, ['unsaved'])]);
    const second = store.save('Ink.md', [surface('a', 1, ['newer'])]);

    store.clear('Ink.md', first);
    expect(store.load('Ink.md')).toMatchObject({
      generation: second,
      records: [{ id: 'a', strokes: [{ id: 'newer' }] }],
    });

    store.clear('Ink.md', second);
    expect(store.load('Ink.md')).toBeNull();
  });

  it('fails closed for legacy divergent content even when the revision still matches', () => {
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      filePath: 'Ink.md',
      generation: 'generation-a',
      records: [surface('a', 2, ['saved', 'unsaved'])],
      version: 1 as const,
    };

    expect(
      planLocalInkRecovery([surface('a', 2, ['saved'])], checkpoint, '2026-07-16T01:00:00.000Z'),
    ).toMatchObject({ kind: 'conflict' });

    expect(
      planLocalInkRecovery([surface('a', 3, ['other'])], checkpoint, '2026-07-16T01:00:00.000Z'),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('treats an already persisted checkpoint as recovered instead of writing again', () => {
    const checkpointRecord = surface('a', 2, ['saved']);
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      filePath: 'Ink.md',
      generation: 'generation-a',
      records: [checkpointRecord],
      version: 1 as const,
    };

    expect(
      planLocalInkRecovery(
        [{ ...checkpointRecord, revision: 3, updatedAt: '2026-07-16T00:30:00.000Z' }],
        checkpoint,
        '2026-07-16T01:00:00.000Z',
      ),
    ).toMatchObject({ kind: 'none', records: [{ revision: 3 }], writes: [] });
  });

  it('fails closed for a version-2 optimistic revision without an exact expected base', () => {
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      filePath: 'Ink.md',
      generation: 'generation-a',
      records: [surface('a', 2, ['pending'])],
      version: 2 as const,
    };

    expect(
      planLocalInkRecovery([surface('a', 1, [])], checkpoint, '2026-07-16T01:00:00.000Z'),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('fails closed when a legacy optimistic checkpoint diverges at the canonical revision', () => {
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      filePath: 'Ink.md',
      generation: 'generation-a',
      records: [surface('a', 2, ['local-pending'])],
      version: 2 as const,
    };

    expect(
      planLocalInkRecovery(
        [surface('a', 2, ['concurrent-canonical'])],
        checkpoint,
        '2026-07-16T01:00:00.000Z',
      ),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('restores a version-3 working record only from its exact expected base', () => {
    const base = surface('a', 1, []);
    const working = surface('a', 1, ['local-working']);
    const pending = {
      ...working,
      revision: 2,
      updatedAt: '2026-07-16T00:30:00.000Z',
    };
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      expectedBases: [base],
      filePath: 'Ink.md',
      generation: 'generation-v3',
      pendingAttempts: [pending],
      records: [working],
      version: 3 as const,
    };

    expect(planLocalInkRecovery([base], checkpoint, '2026-07-16T01:00:00.000Z')).toMatchObject({
      expectedBases: [{ id: 'a', revision: 1, strokes: [] }],
      kind: 'restore',
      records: [{ id: 'a', revision: 2, strokes: [{ id: 'local-working' }] }],
      writes: [{ id: 'a', revision: 2, strokes: [{ id: 'local-working' }] }],
    });
  });

  it('treats the exact version-3 pending attempt as an idempotent recovery success', () => {
    const base = surface('a', 1, []);
    const pending = surface('a', 2, ['already-landed']);
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      expectedBases: [base],
      filePath: 'Ink.md',
      generation: 'generation-v3',
      pendingAttempts: [pending],
      records: [pending],
      version: 3 as const,
    };

    expect(planLocalInkRecovery([pending], checkpoint, '2026-07-16T01:00:00.000Z')).toMatchObject({
      expectedBases: [],
      kind: 'none',
      records: [{ id: 'a', revision: 2, strokes: [{ id: 'already-landed' }] }],
      writes: [],
    });
  });

  it('writes newer working content from an already-landed version-3 pending attempt', () => {
    const base = surface('a', 1, []);
    const pending = surface('a', 2, ['landed']);
    const working = surface('a', 2, ['landed', 'after-failure']);
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      expectedBases: [base],
      filePath: 'Ink.md',
      generation: 'generation-v3',
      pendingAttempts: [pending],
      records: [working],
      version: 3 as const,
    };

    expect(planLocalInkRecovery([pending], checkpoint, '2026-07-16T01:00:00.000Z')).toMatchObject({
      expectedBases: [{ id: 'a', revision: 2, strokes: [{ id: 'landed' }] }],
      kind: 'restore',
      records: [
        {
          id: 'a',
          revision: 3,
          strokes: [{ id: 'landed' }, { id: 'after-failure' }],
        },
      ],
      writes: [{ id: 'a', revision: 3 }],
    });
  });

  it('recognizes recovered working content after a crash before checkpoint clearing', () => {
    const base = surface('a', 1, []);
    const pending = surface('a', 2, ['pending']);
    const working = surface('a', 1, ['pending', 'newer-working']);
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      expectedBases: [base],
      filePath: 'Ink.md',
      generation: 'generation-v3',
      pendingAttempts: [pending],
      records: [working],
      version: 3 as const,
    };
    const recovered = {
      ...working,
      revision: 2,
      updatedAt: '2026-07-16T01:00:00.000Z',
    };

    expect(planLocalInkRecovery([recovered], checkpoint, '2026-07-16T02:00:00.000Z')).toMatchObject(
      {
        expectedBases: [],
        kind: 'none',
        records: [{ id: 'a', revision: 2, strokes: [{ id: 'pending' }, { id: 'newer-working' }] }],
        writes: [],
      },
    );
  });

  it('recognizes a second recovery revision after the pending attempt landed before the crash', () => {
    const base = surface('a', 1, []);
    const pending = surface('a', 2, ['pending']);
    const working = surface('a', 2, ['pending', 'newer-working']);
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      expectedBases: [base],
      filePath: 'Ink.md',
      generation: 'generation-v3',
      pendingAttempts: [pending],
      records: [working],
      version: 3 as const,
    };
    const recovered = {
      ...working,
      revision: 3,
      updatedAt: '2026-07-16T01:00:00.000Z',
    };

    expect(planLocalInkRecovery([recovered], checkpoint, '2026-07-16T02:00:00.000Z')).toMatchObject(
      {
        expectedBases: [],
        kind: 'none',
        records: [{ id: 'a', revision: 3, strokes: [{ id: 'pending' }, { id: 'newer-working' }] }],
        writes: [],
      },
    );
  });

  it('rejects a version-3 canonical record with the expected revision but different content', () => {
    const base = surface('a', 1, ['original']);
    const working = surface('a', 1, ['original', 'local']);
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      expectedBases: [base],
      filePath: 'Ink.md',
      generation: 'generation-v3',
      pendingAttempts: [surface('a', 2, ['original', 'local'])],
      records: [working],
      version: 3 as const,
    };

    expect(
      planLocalInkRecovery(
        [surface('a', 1, ['concurrent'])],
        checkpoint,
        '2026-07-16T01:00:00.000Z',
      ),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('keeps version-3 expected bases aligned with only the records that require writes', () => {
    const baseA = surface('a', 1, []);
    const pendingA = surface('a', 2, ['already-landed']);
    const baseB = surface('b', 1, []);
    const pendingB = surface('b', 2, ['needs-write']);
    const checkpoint = {
      capturedAt: '2026-07-16T00:00:00.000Z',
      expectedBases: [baseA, baseB],
      filePath: 'Ink.md',
      generation: 'generation-v3',
      pendingAttempts: [pendingA, pendingB],
      records: [pendingA, pendingB],
      version: 3 as const,
    };

    expect(
      planLocalInkRecovery([pendingA, baseB], checkpoint, '2026-07-16T01:00:00.000Z'),
    ).toMatchObject({
      expectedBases: [{ id: 'b', revision: 1 }],
      kind: 'restore',
      records: [
        { id: 'a', revision: 2, strokes: [{ id: 'already-landed' }] },
        { id: 'b', revision: 2, strokes: [{ id: 'needs-write' }] },
      ],
      writes: [{ id: 'b', revision: 2 }],
    });
  });

  it('keeps version-2 checkpoints readable without auto-promoting unverifiable content', () => {
    const store = new LocalInkRecoveryStore(new MemoryStorage(), 'Vault', 'device-a');
    store.save('Ink.md', [surface('a', 2, ['pending'])]);
    const checkpoint = store.load('Ink.md');
    if (checkpoint === null) throw new Error('Missing saved recovery checkpoint.');

    expect(checkpoint.version).toBe(2);
    expect(
      planLocalInkRecovery([surface('a', 1, [])], checkpoint, '2026-07-16T01:00:00.000Z'),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('round-trips version-3 expected bases, pending attempts and working records', () => {
    const store = new LocalInkRecoveryStore(new MemoryStorage(), 'Vault', 'device-a');
    const base = surface('a', 1, []);
    const pending = surface('a', 2, ['pending']);
    const working = surface('a', 2, ['pending', 'newer-working']);

    store.save('Ink.md', [working], undefined, {
      expectedBases: [base],
      pendingAttempts: [pending],
    });

    expect(store.load('Ink.md')).toMatchObject({
      expectedBases: [{ id: 'a', revision: 1, strokes: [] }],
      pendingAttempts: [{ id: 'a', revision: 2, strokes: [{ id: 'pending' }] }],
      records: [
        {
          id: 'a',
          revision: 2,
          strokes: [{ id: 'pending' }, { id: 'newer-working' }],
        },
      ],
      version: 3,
    });
  });

  it('quarantines corrupt checkpoint bytes instead of permanently blocking the note', () => {
    const storage = new MemoryStorage();
    const store = new LocalInkRecoveryStore(storage, 'Vault', 'device-a');
    store.save('Ink.md', [surface('a', 1, ['unsaved'])]);
    const checkpointKey = storage.key(0);
    if (checkpointKey === null) throw new Error('Missing checkpoint fixture.');
    storage.setItem(checkpointKey, '{');

    expect(() => store.load('Ink.md')).toThrow(/quarantined/u);
    expect(store.load('Ink.md')).toBeNull();
    expect(storage.keys().some((key) => key.includes('quarantine'))).toBe(true);
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.values.keys()];
  }
}

function surface(id: string, revision: number, strokeIds: readonly string[]): InkSurfaceRecord {
  return {
    createdAt: '2026-07-16T00:00:00.000Z',
    deviceId: 'device-a',
    filePath: 'Ink.md',
    id,
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1_200,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-a',
      themeMode: 'light',
    },
    noteId: 'note-a',
    revision,
    schemaVersion: 2,
    status: 'active',
    strokes: strokeIds.map((strokeId) => ({
      color: '#d97777',
      id: strokeId,
      points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
      tool: 'pen',
      width: 4,
    })),
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}
