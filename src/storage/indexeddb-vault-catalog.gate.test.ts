import { writeFile } from 'node:fs/promises';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../application/vault-catalog';
import { IndexedDbVaultCatalog } from './indexeddb-vault-catalog';

describe('Vault Catalog 100k local adapter gate', () => {
  it('keeps recent, note-page, and search results demand bounded at 100k rows', async () => {
    const catalog = new IndexedDbVaultCatalog({
      IDBKeyRange,
      databaseName: 'vault-catalog-100k-gate',
      indexedDB: new IDBFactory(),
      vaultFingerprint: 'gate-vault',
    });
    const beforeHeap = process.memoryUsage().heapUsed;
    const buildStartedAt = performance.now();
    const noteCount = 100;
    const entriesPerNote = 1_000;
    let ordinal = 0;
    for (let noteIndex = 0; noteIndex < noteCount; noteIndex += 1) {
      const entries: CatalogEntry[] = [];
      for (let entryIndex = 0; entryIndex < entriesPerNote; entryIndex += 1) {
        const current = ordinal++;
        entries.push({
          annotationId: `annotation-${String(current).padStart(6, '0')}`,
          conflict: 0,
          filePath: `Notes/Note-${String(noteIndex).padStart(3, '0')}.md`,
          folder: 'Notes',
          noteId: `note-${String(noteIndex).padStart(3, '0')}`,
          position: entryIndex,
          quote: `Gate annotation ${current}`,
          revision: 1,
          searchTextNormalized: `gate annotation ${current} common`,
          status: 'active',
          tags: ['gate'],
          tagsNormalized: ['gate'],
          type: 'highlight',
          updatedAt: new Date(Date.UTC(2026, 6, 23) + current).toISOString(),
        });
      }
      await catalog.replaceNoteProjection({
        entries,
        noteId: `note-${String(noteIndex).padStart(3, '0')}`,
      });
    }
    const buildMs = performance.now() - buildStartedAt;
    const afterBuildHeap = process.memoryUsage().heapUsed;

    const recentStartedAt = performance.now();
    const recent = await catalog.recentNotes();
    const recentMs = performance.now() - recentStartedAt;
    const notePageStartedAt = performance.now();
    const notePage = await catalog.entriesForNote({ limit: 50, noteId: 'note-099' });
    const notePageMs = performance.now() - notePageStartedAt;
    const commonStartedAt = performance.now();
    const common = await catalog.search({ limit: 50, text: 'common' });
    const commonMs = performance.now() - commonStartedAt;
    const absentStartedAt = performance.now();
    const absent = await catalog.search({ limit: 50, text: '不存在-tail' });
    const absentMs = performance.now() - absentStartedAt;

    expect(recent.notes).toHaveLength(20);
    expect(notePage.state).toBe('ready');
    expect(notePage.entries).toHaveLength(50);
    expect(common.state).toBe('ready');
    expect(common.entries).toHaveLength(50);
    expect(absent.state).toBe('ready');
    expect(absent.entries).toHaveLength(0);
    expect(absent.progress.scanned).toBe(100_000);

    await writeFile(
      '.vault-catalog-gate-metrics.json',
      `${JSON.stringify(
        {
          absentMs,
          afterBuildHeap,
          beforeHeap,
          buildMs,
          commonMs,
          entries: 100_000,
          notePageMs,
          recentMs,
        },
        null,
        2,
      )}\n`,
    );
    catalog.close();
  }, 120_000);
});
