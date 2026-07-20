import { describe, expect, it } from 'vitest';

import { hashRecoveryBytes, type InkPreparedCommandPatch } from '../domain/ink-recovery-patch';
import {
  encodeInkSurfaceRecord,
  type InkStroke,
  type InkSurfaceRecord,
} from '../domain/ink-surface';
import {
  LocalInkRecoveryReader,
  planLocalInkRecovery,
  type LocalInkRecoveryCheckpoint,
} from './local-ink-recovery';

describe('retired Ink Recovery read-only migration', () => {
  it('reads a legacy v3 checkpoint without mutating or clearing any source bytes', () => {
    const storage = new MemoryStorage();
    const base = surface('saved');
    const pending = revision(base, 2, [...base.strokes, stroke('draft')]);
    storage.seed(
      checkpointKey(),
      JSON.stringify({
        capturedAt: pending.updatedAt,
        expectedBases: [encodeInkSurfaceRecord(base)],
        filePath: 'Ink.md',
        generation: 'legacy-v3',
        pendingAttempts: [encodeInkSurfaceRecord(pending)],
        records: [encodeInkSurfaceRecord(pending)],
        version: 3,
      }),
    );
    const before = storage.snapshot();

    const checkpoint = new LocalInkRecoveryReader(storage, 'Vault', 'device-a').load('Ink.md');

    expect(checkpoint).toMatchObject({
      expectedBases: [{ revision: 1, strokes: [{ id: 'saved' }] }],
      pendingAttempts: [{ revision: 2, strokes: [{ id: 'saved' }, { id: 'draft' }] }],
      version: 3,
    });
    expect(storage.snapshot()).toEqual(before);
    expect(storage.mutationCount).toBe(0);
  });

  it('replays an unacknowledged v4 command chain while keeping the journal byte-for-byte intact', () => {
    const storage = new MemoryStorage();
    seedV4Journal(storage, surface('saved'), stroke('draft'));
    const before = storage.snapshot();

    const checkpoint = new LocalInkRecoveryReader(storage, 'Vault', 'device-a').load('Ink.md');

    expect(checkpoint).toMatchObject({
      acknowledgedRecords: [{ strokes: [{ id: 'saved' }] }],
      acknowledgedSequence: 0,
      baseRecords: [{ strokes: [{ id: 'saved' }] }],
      lastSequence: 1,
      records: [{ strokes: [{ id: 'saved' }, { id: 'draft' }] }],
      version: 4,
    });
    expect(storage.snapshot()).toEqual(before);
    expect(storage.mutationCount).toBe(0);
  });

  it('preserves corrupt legacy bytes in place and reports a read failure', () => {
    const storage = new MemoryStorage();
    storage.seed(checkpointKey(), '{not-json');
    const before = storage.snapshot();

    expect(() => new LocalInkRecoveryReader(storage, 'Vault', 'device-a').load('Ink.md')).toThrow(
      'raw bytes were preserved',
    );
    expect(storage.snapshot()).toEqual(before);
    expect(storage.mutationCount).toBe(0);
  });

  it('plans one exact v3 CAS migration into canonical sidecars', () => {
    const base = surface('saved');
    const pending = revision(base, 2, [...base.strokes, stroke('draft')]);
    const checkpoint: LocalInkRecoveryCheckpoint = {
      capturedAt: pending.updatedAt,
      expectedBases: [base],
      filePath: 'Ink.md',
      generation: 'legacy-v3',
      pendingAttempts: [pending],
      records: [pending],
      version: 3,
    };

    expect(planLocalInkRecovery([base], checkpoint, '2026-07-19T01:00:00.000Z')).toEqual({
      expectedBases: [base],
      kind: 'restore',
      records: [pending],
      writes: [pending],
    });
  });

  it('fails closed when the canonical surface set no longer matches legacy Recovery', () => {
    const base = surface('saved');
    const checkpoint: LocalInkRecoveryCheckpoint = {
      capturedAt: base.updatedAt,
      filePath: 'Ink.md',
      generation: 'legacy-v2',
      records: [base],
      version: 2,
    };

    expect(
      planLocalInkRecovery([{ ...base, id: 'replacement' }], checkpoint, base.updatedAt),
    ).toMatchObject({ kind: 'conflict' });
  });
});

function seedV4Journal(storage: MemoryStorage, base: InkSurfaceRecord, added: InkStroke): void {
  const generation = 'legacy-v4';
  const ownerId = 'crashed-process';
  const encodedRecords = [encodeInkSurfaceRecord(base)];
  const baseDigest = hashRecoveryBytes(JSON.stringify(encodedRecords));
  const command: InkPreparedCommandPatch = {
    commandId: 'draw:draft',
    commandKind: 'add',
    documentGeneration: 0,
    formatVersion: 1,
    surfacePatches: [
      {
        deleted: [],
        surfaceId: base.id,
        upserted: [{ index: base.strokes.length, previousDigest: null, stroke: added }],
      },
    ],
  };
  const payload = JSON.stringify(command);
  const payloadChecksum = hashRecoveryBytes(payload);
  const afterDigest = hashRecoveryBytes(
    JSON.stringify({
      beforeDigest: baseDigest,
      commandId: command.commandId,
      payloadChecksum,
      sequence: 1,
    }),
  );
  const root = journalRoot();
  const generationRoot = `${root}generation/${encodeURIComponent(generation)}/`;
  storage.seed(
    `${root}head`,
    JSON.stringify({
      baseDigest,
      capturedAt: '2026-07-19T00:00:00.000Z',
      digestMode: 'command-chain-v1',
      filePath: 'Ink.md',
      generation,
      kind: 'head',
      ownerId,
      version: 4,
    }),
  );
  storage.seed(
    `${generationRoot}base`,
    JSON.stringify({
      filePath: 'Ink.md',
      generation,
      kind: 'base',
      ownerId,
      records: encodedRecords,
      recordsChecksum: hashRecoveryBytes(JSON.stringify(encodedRecords)),
      version: 4,
    }),
  );
  storage.seed(
    `${generationRoot}entry/1`,
    JSON.stringify({
      afterDigest,
      beforeDigest: baseDigest,
      command,
      commandId: command.commandId,
      generation,
      kind: 'entry',
      ownerId,
      payloadChecksum,
      payloadLength: new TextEncoder().encode(payload).byteLength,
      sequence: 1,
      version: 4,
    }),
  );
}

function checkpointKey(): string {
  return `inkstone:Vault:device-a:ink-recovery-v1:${encodeURIComponent('Ink.md')}`;
}

function journalRoot(): string {
  return `inkstone:Vault:device-a:ink-recovery-journal-v4:${encodeURIComponent('Ink.md')}:`;
}

class MemoryStorage implements Pick<Storage, 'getItem' | 'key' | 'length'> {
  private readonly values = new Map<string, string>();
  mutationCount = 0;

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  seed(key: string, value: string): void {
    this.values.set(key, value);
  }

  snapshot(): readonly (readonly [string, string])[] {
    return [...this.values.entries()];
  }
}

function revision(
  record: InkSurfaceRecord,
  nextRevision: number,
  strokes: readonly InkStroke[],
): InkSurfaceRecord {
  return {
    ...record,
    revision: nextRevision,
    strokes,
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

function surface(strokeId: string): InkSurfaceRecord {
  return {
    createdAt: '2026-07-18T00:00:00.000Z',
    deviceId: 'device-a',
    filePath: 'Ink.md',
    id: 'surface-a',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1_000,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-a',
      themeMode: 'light',
    },
    noteId: 'note-a',
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes: [stroke(strokeId)],
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function stroke(id: string): InkStroke {
  return {
    color: '#111111',
    id,
    points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
    tool: 'pen',
    width: 4,
  };
}
