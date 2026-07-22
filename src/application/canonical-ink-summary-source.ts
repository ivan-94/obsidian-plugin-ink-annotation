import type { InkSurfaceRecord } from '../domain/ink-surface';
import { summarizeInkSurface, type InkSurfaceSummary } from '../domain/ink-surface-summary';

export interface InkDocumentSnapshotSource {
  read(filePath: string): Promise<InkSurfaceRecord | null>;
}

export interface LegacyInkSummarySource {
  listSurfaceSummaries(filePath: string): Promise<readonly InkSurfaceSummary[]>;
  readSurface(filePath: string, surfaceId: string): Promise<InkSurfaceRecord | null>;
}

/**
 * One read model for all Ink projections during the snapshot migration.
 *
 * A present `ink.json` is authoritative, including its tombstone. Legacy summaries are consulted
 * only for notes that have not crossed the snapshot cut-over yet.
 */
export class CanonicalInkSummarySource {
  constructor(
    private readonly input: {
      readonly legacy: LegacyInkSummarySource;
      readonly snapshots: InkDocumentSnapshotSource;
    },
  ) {}

  async listSurfaceSummaries(filePath: string): Promise<readonly InkSurfaceSummary[]> {
    const snapshot = await this.input.snapshots.read(filePath);
    return snapshot === null
      ? this.input.legacy.listSurfaceSummaries(filePath)
      : Object.freeze([summarizeInkSurface(snapshot)]);
  }

  async readSurface(filePath: string, surfaceId: string): Promise<InkSurfaceRecord | null> {
    const snapshot = await this.input.snapshots.read(filePath);
    if (snapshot !== null) return snapshot.id === surfaceId ? snapshot : null;
    return this.input.legacy.readSurface(filePath, surfaceId);
  }
}
