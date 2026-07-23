import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { SidecarRepository } from '../storage/sidecar-repository';

export interface SidecarGarbageCollectionPreview {
  readonly eligibleTextAnnotations: number;
  readonly heldTextAnnotations: number;
}

export interface SidecarGarbageCollectionResult {
  readonly failedTextAnnotations: number;
  readonly heldTextAnnotations: number;
  readonly removedTextAnnotations: number;
}

interface TextTombstoneGraveyard {
  recordTextTombstones(
    records: readonly TextAnnotationRecord[],
    compactedAt: string,
  ): Promise<void>;
}

export class SidecarGarbageCollector {
  constructor(
    private readonly input: {
      readonly graveyard: TextTombstoneGraveyard;
      readonly now: () => string;
      readonly repository: SidecarRepository;
    },
  ) {}

  async preview(): Promise<SidecarGarbageCollectionPreview> {
    const inspection = await this.inspect();
    return {
      eligibleTextAnnotations: inspection.eligible.length,
      heldTextAnnotations: inspection.held,
    };
  }

  async clear(): Promise<SidecarGarbageCollectionResult> {
    const inspection = await this.inspect();
    if (inspection.eligible.length === 0) {
      return {
        failedTextAnnotations: 0,
        heldTextAnnotations: inspection.held,
        removedTextAnnotations: 0,
      };
    }
    const now = this.input.now();
    await this.input.graveyard.recordTextTombstones(inspection.eligible, now);
    const affectedPaths = new Set<string>();
    let failed = 0;
    let removed = 0;
    for (const record of inspection.eligible) {
      try {
        await this.input.repository.removeExactTombstonePayload(record);
        affectedPaths.add(record.filePath);
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    for (const filePath of affectedPaths) {
      await this.input.repository.rebuildSummary(filePath, now);
    }
    return {
      failedTextAnnotations: failed,
      heldTextAnnotations: inspection.held,
      removedTextAnnotations: removed,
    };
  }

  private async inspect(): Promise<{
    readonly eligible: readonly TextAnnotationRecord[];
    readonly held: number;
  }> {
    return this.input.repository.inspectTextTombstonesForPurge();
  }
}
