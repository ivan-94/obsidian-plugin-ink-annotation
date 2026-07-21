import type { NoteMeta, SidecarRepository } from '../storage/sidecar-repository';
import type { InkSurfaceRepository } from '../storage/ink-surface-repository';
import type { InkDocumentSnapshotRepository } from '../storage/ink-document-snapshot-repository';

export class SidecarLifecycleService {
  private readonly annotations: SidecarRepository;
  private readonly ink: InkSurfaceRepository;
  private readonly inkSnapshot: InkDocumentSnapshotRepository | undefined;
  private readonly now: () => string;

  constructor(input: {
    readonly annotations: SidecarRepository;
    readonly ink: InkSurfaceRepository;
    readonly inkSnapshot?: InkDocumentSnapshotRepository;
    readonly now?: () => string;
  }) {
    this.annotations = input.annotations;
    this.ink = input.ink;
    this.inkSnapshot = input.inkSnapshot;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async reconcileObservedRename(oldPath: string, newPath: string): Promise<NoteMeta | null> {
    const now = this.now();
    const reconciled = await this.annotations.reconcileObservedRename({ newPath, now, oldPath });
    if (reconciled === null) return null;
    await this.inkSnapshot?.reconcileFilePath(reconciled.filePath, now);
    await this.ink.reconcileNotePath(reconciled.filePath, now);
    return reconciled;
  }

  markSourceMissing(filePath: string): Promise<NoteMeta | null> {
    return this.annotations.markNoteSourceMissing(filePath, this.now());
  }
}
