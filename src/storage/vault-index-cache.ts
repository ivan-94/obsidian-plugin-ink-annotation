import type { AnnotationIndexEntry } from '../domain/vault-annotation-index';
import type { TextFileStore } from './sidecar-repository';

const VAULT_INDEX_PATH = '.obsidian-annotations/v1/index.json';
const VAULT_INDEX_SCHEMA_VERSION = 3;

export class VaultIndexCache {
  constructor(private readonly store: TextFileStore) {}

  async load(): Promise<{
    readonly entries: readonly AnnotationIndexEntry[];
    readonly generatedAt: string;
  } | null> {
    const contents = await this.store.read(VAULT_INDEX_PATH);
    if (contents === null) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== VAULT_INDEX_SCHEMA_VERSION ||
        parsed.derived !== true ||
        typeof parsed.generatedAt !== 'string' ||
        !Array.isArray(parsed.entries) ||
        !parsed.entries.every(isIndexEntry)
      ) {
        return null;
      }
      return {
        entries: parsed.entries.map((entry) => ({ ...entry, tags: [...entry.tags] })),
        generatedAt: parsed.generatedAt,
      };
    } catch {
      return null;
    }
  }

  async save(entries: readonly AnnotationIndexEntry[], generatedAt: string): Promise<void> {
    await this.store.mkdir('.obsidian-annotations/v1');
    await this.store.write(
      VAULT_INDEX_PATH,
      `${JSON.stringify(
        { derived: true, entries, generatedAt, schemaVersion: VAULT_INDEX_SCHEMA_VERSION },
        null,
        2,
      )}\n`,
    );
  }

  async clear(): Promise<void> {
    if (this.store.remove === undefined) {
      throw new Error('The text file store cannot clear the derived Vault index.');
    }
    await this.store.remove(VAULT_INDEX_PATH);
  }
}

function isIndexEntry(value: unknown): value is AnnotationIndexEntry {
  return (
    isRecord(value) &&
    typeof value.conflict === 'boolean' &&
    typeof value.filePath === 'string' &&
    typeof value.id === 'string' &&
    typeof value.noteId === 'string' &&
    typeof value.position === 'number' &&
    typeof value.quote === 'string' &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    isStatus(value.status) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    (value.type === 'highlight' ||
      value.type === 'underline' ||
      value.type === 'note' ||
      value.type === 'ink' ||
      value.type === 'snapshot') &&
    typeof value.updatedAt === 'string' &&
    (value.body === undefined || typeof value.body === 'string') &&
    (value.styleId === undefined || typeof value.styleId === 'string') &&
    (value.styleName === undefined || typeof value.styleName === 'string') &&
    (value.ink === undefined || isInkMetadata(value.ink)) &&
    (value.type === 'snapshot' ? isSnapshotMetadata(value.snapshot) : value.snapshot === undefined)
  );
}

function isStatus(value: unknown): value is AnnotationIndexEntry['status'] {
  return (
    value === 'active' ||
    value === 'draft' ||
    value === 'resolved' ||
    value === 'unanchored' ||
    value === 'needs-rebase'
  );
}

function isInkMetadata(value: unknown): value is NonNullable<AnnotationIndexEntry['ink']> {
  return (
    isRecord(value) &&
    Array.isArray(value.headingPath) &&
    value.headingPath.every((part) => typeof part === 'string') &&
    typeof value.strokeCount === 'number' &&
    Number.isInteger(value.strokeCount) &&
    value.strokeCount >= 0
  );
}

function isSnapshotMetadata(
  value: unknown,
): value is NonNullable<AnnotationIndexEntry['snapshot']> {
  return (
    isRecord(value) &&
    typeof value.capturedAt === 'string' &&
    Array.isArray(value.headingPath) &&
    value.headingPath.every((part) => typeof part === 'string') &&
    (value.linkState === 'linked' ||
      value.linkState === 'source-changed' ||
      value.linkState === 'unanchored') &&
    typeof value.logicalHeight === 'number' &&
    Number.isFinite(value.logicalHeight) &&
    value.logicalHeight > 0 &&
    typeof value.logicalWidth === 'number' &&
    Number.isFinite(value.logicalWidth) &&
    value.logicalWidth > 0 &&
    typeof value.strokeCount === 'number' &&
    Number.isInteger(value.strokeCount) &&
    value.strokeCount >= 0 &&
    typeof value.thumbnailKey === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
