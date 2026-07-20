import {
  INK_PERFORMANCE_MAX_RECENT_SPANS,
  type InkPresentationOutcome,
  type InkPerformanceContact,
  type InkPerformanceRecorder,
  type InkPerformanceSpan,
} from './ink-performance-diagnostics';

interface PendingPresentationBatch {
  readonly batchSequence: number;
  readonly contact: InkPerformanceContact;
  readonly generation: number;
  readonly sampleCount: number;
  readonly span: InkPerformanceSpan;
}

/** Owns Presentation Frame Generations and their diagnostic batch attribution. */
export class InkPresentationGenerationLedger {
  private activeContact: InkPerformanceContact | null = null;
  private activeGeneration = 0;
  private batchSequence = 0;
  private readonly diagnostics: InkPerformanceRecorder;
  private readonly maxPendingBatches: number;
  private readonly now: () => number;
  private readonly onSubmitted: (durationMs: number) => void;
  private pendingGeneration: number | null = null;
  private pendingInputStartedAt: number | null = null;
  private readonly pending: PendingPresentationBatch[] = [];
  private retiredGeneration = 0;

  constructor(input: {
    readonly diagnostics: InkPerformanceRecorder;
    readonly maxPendingBatches?: number;
    readonly now?: () => number;
    readonly onSubmitted?: (durationMs: number) => void;
  }) {
    this.diagnostics = input.diagnostics;
    this.maxPendingBatches = input.maxPendingBatches ?? INK_PERFORMANCE_MAX_RECENT_SPANS;
    if (
      !Number.isSafeInteger(this.maxPendingBatches) ||
      this.maxPendingBatches <= 0 ||
      this.maxPendingBatches > INK_PERFORMANCE_MAX_RECENT_SPANS
    ) {
      throw new Error('Ink presentation pending capacity is invalid.');
    }
    this.now = input.now ?? (() => performance.now());
    this.onSubmitted = input.onSubmitted ?? (() => undefined);
  }

  begin(
    contact?: InkPerformanceContact,
    sampleCount?: number,
    span: InkPerformanceSpan | null = null,
  ): number {
    if (contact !== undefined && !sameContact(this.activeContact, contact)) {
      if (this.activeContact !== null) this.cancel('superseded');
      this.activeContact = contact;
      this.batchSequence = 0;
    }
    if (this.pendingGeneration === null) {
      this.activeGeneration += 1;
      this.pendingGeneration = this.activeGeneration;
    }
    if (contact === undefined || sampleCount === undefined) return this.pendingGeneration;
    this.pendingInputStartedAt ??= this.now();
    if (span !== null && this.diagnostics.isEnabled() && this.diagnostics.ownsContact(contact)) {
      this.batchSequence += 1;
      if (this.pending.length >= this.maxPendingBatches) {
        const superseded = this.pending.shift();
        if (superseded !== undefined) finishPendingBatch(superseded, 'superseded', null);
      }
      this.pending.push({
        batchSequence: this.batchSequence,
        contact,
        generation: this.pendingGeneration,
        sampleCount,
        span,
      });
    }
    return this.pendingGeneration;
  }

  cancel(outcome: Exclude<InkPresentationOutcome, 'submitted'>, generation?: number): void {
    if (generation !== undefined && generation !== this.pendingGeneration) return;
    const cancelledGeneration = generation ?? this.pendingGeneration;
    if (cancelledGeneration !== null) {
      this.retiredGeneration = Math.max(this.retiredGeneration, cancelledGeneration);
    }
    if (generation === undefined || generation === this.pendingGeneration) {
      this.pendingGeneration = null;
      this.pendingInputStartedAt = null;
    }
    let retainedCount = 0;
    for (const pending of this.pending) {
      if (generation === undefined || pending.generation === generation) {
        finishPendingBatch(pending, outcome, null);
      } else {
        this.pending[retainedCount] = pending;
        retainedCount += 1;
      }
    }
    this.pending.length = retainedCount;
  }

  settle(submittedGeneration: number | null, contact: InkPerformanceContact | null): void {
    if (
      submittedGeneration === null ||
      contact === null ||
      submittedGeneration <= this.retiredGeneration ||
      submittedGeneration !== this.pendingGeneration ||
      !sameContact(this.activeContact, contact)
    ) {
      return;
    }
    this.pendingGeneration = null;
    this.retiredGeneration = submittedGeneration;
    const startedAt = this.pendingInputStartedAt;
    this.pendingInputStartedAt = null;
    let retainedCount = 0;
    for (const pending of this.pending) {
      if (
        pending.generation === submittedGeneration &&
        pending.contact.adapter === contact.adapter &&
        pending.contact.sequence === contact.sequence
      ) {
        finishPendingBatch(pending, 'submitted', submittedGeneration);
      } else {
        this.pending[retainedCount] = pending;
        retainedCount += 1;
      }
    }
    this.pending.length = retainedCount;
    if (startedAt !== null) this.onSubmitted(Math.max(0, this.now() - startedAt));
  }
}

function sameContact(left: InkPerformanceContact | null, right: InkPerformanceContact): boolean {
  return left?.adapter === right.adapter && left.sequence === right.sequence;
}

function finishPendingBatch(
  pending: PendingPresentationBatch,
  outcome: InkPresentationOutcome,
  submittedGeneration: number | null,
): void {
  pending.span.finish({
    accepted: outcome === 'submitted',
    batchSequence: pending.batchSequence,
    contact: pending.contact,
    presentationOutcome: outcome,
    requestedGeneration: pending.generation,
    sampleCount: pending.sampleCount,
    submittedGeneration,
  });
}
