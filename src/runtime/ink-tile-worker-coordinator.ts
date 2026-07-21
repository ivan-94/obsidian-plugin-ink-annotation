export type InkTileWorkerPriority = 'cold' | 'near-visible' | 'visible-dirty' | 'visible-preview';

export interface InkTileWorkerJobDescriptor {
  readonly byteSize: number;
  readonly id: string;
  readonly key: string;
  readonly mountId: string;
  readonly priority: InkTileWorkerPriority;
}

export interface InkTileWorkerResultResource {
  readonly byteSize: number;
  close(): void;
}

export interface InkTileWorkerPauseLease {
  readonly acknowledged: Promise<void>;
  release(): void;
}

export type InkTileWorkerSubmitResult =
  | { readonly jobId: string; readonly kind: 'accepted' | 'coalesced' }
  | {
      readonly kind: 'rejected-byte-cap' | 'rejected-mount-cap' | 'rejected-queue-cap';
    };

export type InkTileWorkerCompleteResult =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'rejected-byte-cap' | 'rejected-result-cap' | 'rejected-stale';
    };

interface QueuedJob {
  readonly descriptor: InkTileWorkerJobDescriptor;
  readonly sequence: number;
}

interface PendingResult {
  readonly job: InkTileWorkerJobDescriptor;
  readonly resource: InkTileWorkerResultResource;
}

const MAXIMUM_QUEUED_JOBS = 8;
const MAXIMUM_QUEUED_JOBS_PER_MOUNT = 4;
const MAXIMUM_PENDING_RESULTS = 2;
const DEFAULT_MAXIMUM_BYTES = 16 * 1024 * 1024;

/**
 * Plugin-runtime admission, pause, and transferable ownership for the single Tile Worker.
 * It intentionally does not know DOM, Canvas, projection contents, or Obsidian.
 */
export class InkTileWorkerCoordinator {
  private bytes = 0;
  private disposed = false;
  private readonly jobsByKey = new Map<string, string>();
  private readonly lastServedMountByPriority = new Map<InkTileWorkerPriority, string>();
  private readonly maximumBytes: number;
  private readonly mirrors = new Map<string, number>();
  private pauseLeaseCount = 0;
  private readonly pauseScopes = new Map<string, number>();
  private readonly pendingResults = new Map<string, PendingResult>();
  private readonly queue: QueuedJob[] = [];
  private running: InkTileWorkerJobDescriptor | null = null;
  private sequence = 0;

  constructor(input: { readonly maximumBytes?: number } = {}) {
    this.maximumBytes = input.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes <= 0) {
      throw new Error('Ink Tile Worker byte cap must be a positive safe integer.');
    }
  }

  submit(job: InkTileWorkerJobDescriptor): InkTileWorkerSubmitResult {
    this.assertUsable();
    assertJob(job);
    const existing = this.jobsByKey.get(job.key);
    if (existing !== undefined) return Object.freeze({ jobId: existing, kind: 'coalesced' });
    const queuedForMount = this.queue.filter(
      ({ descriptor }) => descriptor.mountId === job.mountId,
    ).length;
    if (queuedForMount >= MAXIMUM_QUEUED_JOBS_PER_MOUNT) {
      return Object.freeze({ kind: 'rejected-mount-cap' });
    }
    if (this.queue.length >= MAXIMUM_QUEUED_JOBS) {
      return Object.freeze({ kind: 'rejected-queue-cap' });
    }
    if (job.byteSize > this.maximumBytes - this.bytes) {
      return Object.freeze({ kind: 'rejected-byte-cap' });
    }
    this.sequence += 1;
    this.queue.push({ descriptor: Object.freeze({ ...job }), sequence: this.sequence });
    this.jobsByKey.set(job.key, job.id);
    this.bytes += job.byteSize;
    return Object.freeze({ jobId: job.id, kind: 'accepted' });
  }

  reserveMirror(identity: string, byteSize: number): boolean {
    this.assertUsable();
    if (identity.length === 0)
      throw new Error('Ink Tile Worker mirror identity must not be empty.');
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error('Ink Tile Worker mirror bytes must be a non-negative safe integer.');
    }
    const existing = this.mirrors.get(identity);
    if (existing !== undefined) return existing === byteSize;
    if (byteSize > this.maximumBytes - this.bytes) return false;
    this.mirrors.set(identity, byteSize);
    this.bytes += byteSize;
    return true;
  }

  releaseMirror(identity: string): boolean {
    this.assertUsable();
    const byteSize = this.mirrors.get(identity);
    if (byteSize === undefined) return false;
    this.mirrors.delete(identity);
    this.bytes -= byteSize;
    return true;
  }

  takeNext(): InkTileWorkerJobDescriptor | null {
    this.assertUsable();
    if (this.running !== null || this.pauseLeaseCount > 0 || this.queue.length === 0) return null;
    this.queue.sort(compareQueuedJobs);
    const highestPriority = this.queue[0]?.descriptor.priority;
    if (highestPriority === undefined) return null;
    const lastMount = this.lastServedMountByPriority.get(highestPriority);
    const alternateIndex = this.queue.findIndex(
      ({ descriptor }) =>
        descriptor.priority === highestPriority && descriptor.mountId !== lastMount,
    );
    const nextIndex = alternateIndex < 0 ? 0 : alternateIndex;
    const [next] = this.queue.splice(nextIndex, 1);
    if (next === undefined) return null;
    this.running = next.descriptor;
    this.lastServedMountByPriority.set(next.descriptor.priority, next.descriptor.mountId);
    return next.descriptor;
  }

  cancel(jobId: string): 'missing' | 'queued' | 'running' {
    this.assertUsable();
    if (this.running?.id === jobId) return 'running';
    const queuedIndex = this.queue.findIndex(({ descriptor }) => descriptor.id === jobId);
    if (queuedIndex < 0) return 'missing';
    const [removed] = this.queue.splice(queuedIndex, 1);
    if (removed === undefined) return 'missing';
    this.jobsByKey.delete(removed.descriptor.key);
    this.bytes -= removed.descriptor.byteSize;
    return 'queued';
  }

  abandonRunning(jobId: string): boolean {
    this.assertUsable();
    const running = this.running;
    if (running === null || running.id !== jobId) return false;
    this.running = null;
    this.jobsByKey.delete(running.key);
    this.bytes -= running.byteSize;
    return true;
  }

  complete(jobId: string, resource: InkTileWorkerResultResource): InkTileWorkerCompleteResult {
    this.assertUsable();
    assertResource(resource);
    const running = this.running;
    if (running === null || running.id !== jobId) {
      closeResource(resource);
      return Object.freeze({ kind: 'rejected-stale' });
    }
    this.abandonRunning(jobId);
    if (this.pendingResults.size >= MAXIMUM_PENDING_RESULTS) {
      closeResource(resource);
      return Object.freeze({ kind: 'rejected-result-cap' });
    }
    if (resource.byteSize > this.maximumBytes - this.bytes) {
      closeResource(resource);
      return Object.freeze({ kind: 'rejected-byte-cap' });
    }
    this.pendingResults.set(jobId, { job: running, resource });
    this.bytes += resource.byteSize;
    return Object.freeze({ kind: 'accepted' });
  }

  adoptResult(jobId: string): InkTileWorkerResultResource | null {
    this.assertUsable();
    const pending = this.pendingResults.get(jobId);
    if (pending === undefined) return null;
    this.pendingResults.delete(jobId);
    this.bytes -= pending.resource.byteSize;
    return pending.resource;
  }

  acquirePause(scope: string): InkTileWorkerPauseLease {
    this.assertUsable();
    if (scope.length === 0) throw new Error('Ink Tile Worker pause scope must not be empty.');
    this.pauseScopes.set(scope, (this.pauseScopes.get(scope) ?? 0) + 1);
    this.pauseLeaseCount += 1;
    let released = false;
    return Object.freeze({
      acknowledged: Promise.resolve(),
      release: () => {
        if (released || this.disposed) return;
        released = true;
        const count = this.pauseScopes.get(scope) ?? 0;
        if (count <= 1) this.pauseScopes.delete(scope);
        else this.pauseScopes.set(scope, count - 1);
        this.pauseLeaseCount = Math.max(0, this.pauseLeaseCount - 1);
      },
    });
  }

  stats(): Readonly<{
    bytes: number;
    mirrorCount: number;
    pausedScopeCount: number;
    pendingResultCount: number;
    queuedJobCount: number;
    runningJobCount: 0 | 1;
  }> {
    return Object.freeze({
      bytes: this.bytes,
      mirrorCount: this.mirrors.size,
      pausedScopeCount: this.pauseLeaseCount,
      pendingResultCount: this.pendingResults.size,
      queuedJobCount: this.queue.length,
      runningJobCount: this.running === null ? 0 : 1,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { resource } of this.pendingResults.values()) closeResource(resource);
    this.pendingResults.clear();
    this.queue.length = 0;
    this.jobsByKey.clear();
    this.lastServedMountByPriority.clear();
    this.mirrors.clear();
    this.pauseScopes.clear();
    this.pauseLeaseCount = 0;
    this.running = null;
    this.bytes = 0;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Ink Tile Worker coordinator has been disposed.');
  }
}

function compareQueuedJobs(left: QueuedJob, right: QueuedJob): number {
  return (
    priorityRank(right.descriptor.priority) - priorityRank(left.descriptor.priority) ||
    left.sequence - right.sequence
  );
}

function priorityRank(priority: InkTileWorkerPriority): number {
  switch (priority) {
    case 'visible-dirty':
      return 3;
    case 'visible-preview':
      return 2;
    case 'near-visible':
      return 1;
    case 'cold':
      return 0;
  }
}

function assertJob(job: InkTileWorkerJobDescriptor): void {
  if (job.id.length === 0 || job.key.length === 0 || job.mountId.length === 0) {
    throw new Error('Ink Tile Worker job identities must not be empty.');
  }
  if (!Number.isSafeInteger(job.byteSize) || job.byteSize < 0) {
    throw new Error('Ink Tile Worker job bytes must be a non-negative safe integer.');
  }
}

function assertResource(resource: InkTileWorkerResultResource): void {
  if (!Number.isSafeInteger(resource.byteSize) || resource.byteSize < 0) {
    throw new Error('Ink Tile Worker result bytes must be a non-negative safe integer.');
  }
}

function closeResource(resource: InkTileWorkerResultResource): void {
  try {
    resource.close();
  } catch {
    // The epoch fence remains authoritative when a platform closer has already failed.
  }
}
