export type InkInputAdapter = 'pointer' | 'stylus-touch';
export type InkInputPhase = 'cancel' | 'down' | 'move' | 'up';
export type InkFrameIntervalPhase = 'active-writing' | 'host-gap' | 'idle';
export type InkCommandKind =
  'delete-selection' | 'erase' | 'move' | 'redo' | 'restyle' | 'selection' | 'undo';
export type InkPerformanceWorkPhase =
  'active-frame' | 'cold' | 'command' | 'completion' | 'input' | 'preview' | 'save' | 'viewport';
export type InkPresentationOutcome = 'cancelled' | 'submitted' | 'superseded' | 'unpresented';
export type InkCausalRepair = 'front-loaded-parent';
export type InkPerformanceAuditGuard =
  'canonical-cold-materialization' | 'physical-finalize-no-recompile';
export type InkForbiddenWorkKind =
  | 'canonical-encode'
  | 'canonical-storage-write'
  | 'cold-snapshot'
  | 'dom-measurement'
  | 'historical-copy'
  | 'historical-scan'
  | 'historical-sort'
  | 'recovery-storage-write';
export type InkPerformanceSpanName =
  | 'ink-canonical-persistence-submit'
  | 'ink-command-apply'
  | 'ink-command-to-submit'
  | 'ink-done-first-feedback'
  | 'ink-done-total'
  | 'ink-frame-work'
  | 'ink-input-handler'
  | 'ink-input-to-submit'
  | 'ink-preview-cache-lookup'
  | 'ink-preview-cache-publish'
  | 'ink-preview-canonical-observation'
  | 'ink-preview-editable-hydration'
  | 'ink-preview-first-ink'
  | 'ink-preview-to-edit'
  | 'ink-preview-viewport-complete'
  | 'ink-recovery-journal'
  | 'ink-stroke-commit'
  | 'ink-viewport-redraw';

export interface InkPerformanceContact {
  readonly adapter: InkInputAdapter;
  readonly sequence: number;
}

export interface InkPerformanceSpan {
  cancel(): void;
  finish(input?: {
    readonly accepted?: boolean;
    readonly batchSequence?: number;
    readonly causalRepair?: InkCausalRepair;
    readonly contact?: InkPerformanceContact | null;
    readonly documentCommandProduced?: boolean;
    readonly entryBytes?: number;
    readonly entryWriteCount?: number;
    readonly historicalEncodeCount?: number;
    readonly presentationOutcome?: InkPresentationOutcome;
    readonly requestedGeneration?: number;
    readonly sampleCount?: number;
    readonly submittedGeneration?: number | null;
    readonly viewportResultCount?: number;
  }): void;
}

export interface InkPerformanceRecorder {
  armAuditGuard(guard: InkPerformanceAuditGuard): void;
  beginSpan(
    name: InkPerformanceSpanName,
    input: {
      readonly adapter?: InkInputAdapter;
      readonly commandKind?: InkCommandKind;
      readonly contact?: InkPerformanceContact | null;
      readonly inputPhase?: InkInputPhase;
      readonly workPhase: InkPerformanceWorkPhase;
    },
  ): InkPerformanceSpan;
  closeContact(contact: InkPerformanceContact): void;
  isEnabled(): boolean;
  openContact(adapter: InkInputAdapter): InkPerformanceContact;
  ownsContact(contact: InkPerformanceContact): boolean;
  recordFrameInterval(durationMs: number, phase: InkFrameIntervalPhase): void;
  recordAuditedWork(kind: InkForbiddenWorkKind, phase: InkPerformanceWorkPhase): void;
  recordForbiddenWork(kind: InkForbiddenWorkKind, phase: InkPerformanceWorkPhase): void;
  recordMemory(input: {
    readonly activeWorkingSetBytes: number;
    readonly backingStoreBytes: number;
    readonly disposableCacheBytes: number;
  }): void;
  recordSchedulerUnitOverrun(input: {
    readonly durationMs: number;
    readonly lane: 'cold' | 'visible';
    readonly unitKind?: string;
  }): void;
  recordSchedulerUnit(): void;
}

export interface InkPerformanceSpanSample {
  readonly accepted: boolean;
  readonly adapter?: InkInputAdapter;
  readonly batchSequence?: number;
  readonly causalRepair?: InkCausalRepair;
  readonly commandKind?: InkCommandKind;
  readonly contactSequence?: number;
  readonly documentCommandProduced?: boolean;
  readonly durationMs: number;
  readonly entryBytes?: number;
  readonly entryWriteCount?: number;
  readonly historicalEncodeCount?: number;
  readonly inputPhase?: InkInputPhase;
  readonly name: InkPerformanceSpanName;
  readonly presentationOutcome?: InkPresentationOutcome;
  readonly requestedGeneration?: number;
  readonly sampleCountBucket?: string;
  readonly submittedGeneration?: number | null;
  readonly viewportResultCount?: number;
  readonly workPhase: InkPerformanceWorkPhase;
}

export interface InkPerformanceDistribution {
  readonly adapter?: InkInputAdapter;
  readonly commandKind?: InkCommandKind;
  readonly inputPhase?: InkInputPhase;
  readonly maximumMs: number;
  readonly name: InkPerformanceSpanName;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly sampleCount: number;
  readonly workPhase: InkPerformanceWorkPhase;
}

// One S27 physical condition may contain several span types for >=1,000 move batches plus
// completion samples. Keep the capture local and bounded while retaining the complete condition.
export const INK_PERFORMANCE_MAX_RECENT_SPANS = 16_384;
// Physical and local Gate captures must retain a complete >=100-stroke condition. Production
// diagnostics remain opt-in; this larger bound is used only by the plugin-owned Gate recorder.
export const INK_PERFORMANCE_LOCAL_GATE_MAX_RECENT_SPANS = 65_536;
const MAX_FRAME_INTERVALS = 4_096;

export const NOOP_INK_PERFORMANCE_SPAN: InkPerformanceSpan = Object.freeze({
  cancel: () => undefined,
  finish: () => undefined,
});

const NOOP_INK_PERFORMANCE_CONTACTS: Readonly<Record<InkInputAdapter, InkPerformanceContact>> =
  Object.freeze({
    pointer: Object.freeze({ adapter: 'pointer', sequence: 0 }),
    'stylus-touch': Object.freeze({ adapter: 'stylus-touch', sequence: 0 }),
  });

export const NOOP_INK_PERFORMANCE_RECORDER: InkPerformanceRecorder = Object.freeze({
  armAuditGuard: () => undefined,
  beginSpan: () => NOOP_INK_PERFORMANCE_SPAN,
  closeContact: () => undefined,
  isEnabled: () => false,
  openContact: (adapter: InkInputAdapter) => NOOP_INK_PERFORMANCE_CONTACTS[adapter],
  ownsContact: () => false,
  recordFrameInterval: () => undefined,
  recordAuditedWork: () => undefined,
  recordForbiddenWork: () => undefined,
  recordMemory: () => undefined,
  recordSchedulerUnit: () => undefined,
  recordSchedulerUnitOverrun: () => undefined,
});

/** Keeps opt-in Ink timing local, bounded, and free of authored geometry. */
export class InkPerformanceDiagnostics implements InkPerformanceRecorder {
  private readonly armedAuditGuards = new Set<InkPerformanceAuditGuard>();
  private readonly activeSpans = new Set<number>();
  private epoch = 0;
  private nextContactSequence = 0;
  private nextSpanSequence = 0;
  private memory = {
    activeWorkingSetBytes: 0,
    backingStoreBytes: 0,
    disposableCacheBytes: 0,
  };
  private readonly forbiddenWork = new Map<
    string,
    { count: number; readonly kind: InkForbiddenWorkKind; readonly phase: InkPerformanceWorkPhase }
  >();
  private readonly auditedWork = new Map<
    string,
    { count: number; readonly kind: InkForbiddenWorkKind; readonly phase: InkPerformanceWorkPhase }
  >();
  private readonly frameIntervalsMs: Record<InkFrameIntervalPhase, number[]> = {
    'active-writing': [],
    'host-gap': [],
    idle: [],
  };
  private readonly openContacts = new Set<number>();
  private readonly recentSpans: InkPerformanceSpanSample[] = [];
  private readonly schedulerUnitOverruns: Array<{
    readonly durationMs: number;
    readonly lane: 'cold' | 'visible';
    readonly unitKind?: string;
  }> = [];
  private schedulerUnitCount = 0;
  private droppedSpanCount = 0;

  constructor(
    private enabled: boolean,
    private readonly now: () => number = () => performance.now(),
    private readonly maxRecentSpans: number = INK_PERFORMANCE_MAX_RECENT_SPANS,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  armAuditGuard(guard: InkPerformanceAuditGuard): void {
    this.armedAuditGuards.add(guard);
  }

  openContact(adapter: InkInputAdapter): InkPerformanceContact {
    if (!this.enabled) return NOOP_INK_PERFORMANCE_CONTACTS[adapter];
    this.nextContactSequence += 1;
    this.openContacts.add(this.nextContactSequence);
    return Object.freeze({ adapter, sequence: this.nextContactSequence });
  }

  ownsContact(contact: InkPerformanceContact): boolean {
    return this.enabled && this.openContacts.has(contact.sequence);
  }

  closeContact(contact: InkPerformanceContact): void {
    this.openContacts.delete(contact.sequence);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.epoch += 1;
    if (enabled) return;
    this.clear();
  }

  reset(): void {
    this.epoch += 1;
    this.clear();
  }

  recordFrameInterval(durationMs: number, phase: InkFrameIntervalPhase): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('Ink frame intervals require a finite non-negative duration.');
    }
    if (!this.enabled) return;
    const intervals = this.frameIntervalsMs[phase];
    intervals.push(round(durationMs));
    if (intervals.length > MAX_FRAME_INTERVALS) {
      intervals.splice(0, intervals.length - MAX_FRAME_INTERVALS);
    }
  }

  recordSchedulerUnitOverrun(input: {
    readonly durationMs: number;
    readonly lane: 'cold' | 'visible';
    readonly unitKind?: string;
  }): void {
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) {
      throw new Error('Ink scheduler unit overrun must have a finite positive duration.');
    }
    if (!this.enabled) return;
    this.schedulerUnitOverruns.push({
      durationMs: round(input.durationMs),
      lane: input.lane,
      ...(input.unitKind === undefined ? {} : { unitKind: input.unitKind }),
    });
    if (this.schedulerUnitOverruns.length > 1_024) this.schedulerUnitOverruns.shift();
  }

  recordSchedulerUnit(): void {
    if (this.enabled) this.schedulerUnitCount += 1;
  }

  recordForbiddenWork(kind: InkForbiddenWorkKind, phase: InkPerformanceWorkPhase): void {
    if (!this.enabled) return;
    const key = `${phase}\u0000${kind}`;
    const existing = this.forbiddenWork.get(key);
    if (existing === undefined) {
      this.forbiddenWork.set(key, { count: 1, kind, phase });
    } else {
      existing.count += 1;
    }
  }

  recordAuditedWork(kind: InkForbiddenWorkKind, phase: InkPerformanceWorkPhase): void {
    if (!this.enabled) return;
    const key = `${phase}\u0000${kind}`;
    const existing = this.auditedWork.get(key);
    if (existing === undefined) {
      this.auditedWork.set(key, { count: 1, kind, phase });
    } else {
      existing.count += 1;
    }
    if (phase !== 'cold') this.recordForbiddenWork(kind, phase);
  }

  recordMemory(input: {
    readonly activeWorkingSetBytes: number;
    readonly backingStoreBytes: number;
    readonly disposableCacheBytes: number;
  }): void {
    if (!this.enabled) return;
    assertPrivacySafeFields(input, [
      'activeWorkingSetBytes',
      'backingStoreBytes',
      'disposableCacheBytes',
    ]);
    if (
      !Number.isFinite(input.activeWorkingSetBytes) ||
      input.activeWorkingSetBytes < 0 ||
      !Number.isFinite(input.backingStoreBytes) ||
      input.backingStoreBytes < 0 ||
      !Number.isFinite(input.disposableCacheBytes) ||
      input.disposableCacheBytes < 0
    ) {
      throw new Error('Ink performance memory requires finite non-negative byte counts.');
    }
    this.memory = { ...input };
  }

  beginSpan(
    name: InkPerformanceSpanName,
    input: {
      readonly adapter?: InkInputAdapter;
      readonly commandKind?: InkCommandKind;
      readonly contact?: InkPerformanceContact | null;
      readonly inputPhase?: InkInputPhase;
      readonly workPhase: InkPerformanceWorkPhase;
    },
  ): InkPerformanceSpan {
    if (!this.enabled) return NOOP_INK_PERFORMANCE_SPAN;
    assertPrivacySafeFields(input, [
      'adapter',
      'commandKind',
      'contact',
      'inputPhase',
      'workPhase',
    ]);
    if (input.commandKind !== undefined && !isInkCommandKind(input.commandKind)) {
      throw new Error('Ink command kind is invalid.');
    }
    if (input.contact !== undefined && input.contact !== null) {
      assertPrivacySafeFields(input.contact, ['adapter', 'sequence']);
    }
    const startedAt = this.now();
    const startedEpoch = this.epoch;
    this.nextSpanSequence += 1;
    const spanSequence = this.nextSpanSequence;
    this.activeSpans.add(spanSequence);
    let finished = false;
    const complete = (): boolean => {
      if (finished) return false;
      finished = true;
      this.activeSpans.delete(spanSequence);
      return true;
    };
    return {
      cancel: () => {
        complete();
      },
      finish: (result = {}) => {
        if (!complete()) return;
        assertPrivacySafeFields(result, [
          'accepted',
          'batchSequence',
          'causalRepair',
          'contact',
          'documentCommandProduced',
          'entryBytes',
          'entryWriteCount',
          'historicalEncodeCount',
          'presentationOutcome',
          'requestedGeneration',
          'sampleCount',
          'submittedGeneration',
          'viewportResultCount',
        ]);
        if (result.contact !== undefined && result.contact !== null) {
          assertPrivacySafeFields(result.contact, ['adapter', 'sequence']);
        }
        if (
          result.presentationOutcome !== undefined &&
          result.presentationOutcome !== 'cancelled' &&
          result.presentationOutcome !== 'submitted' &&
          result.presentationOutcome !== 'superseded' &&
          result.presentationOutcome !== 'unpresented'
        ) {
          throw new Error('Ink presentation outcome is invalid.');
        }
        if (result.causalRepair !== undefined && result.causalRepair !== 'front-loaded-parent') {
          throw new Error('Ink causal repair is invalid.');
        }
        for (const [name, value] of [
          ['batchSequence', result.batchSequence],
          ['requestedGeneration', result.requestedGeneration],
          ['submittedGeneration', result.submittedGeneration],
        ] as const) {
          if (
            value !== undefined &&
            value !== null &&
            (!Number.isSafeInteger(value) || value <= 0)
          ) {
            throw new Error(`${name} must be a positive safe integer.`);
          }
        }
        if (!this.enabled || startedEpoch !== this.epoch) return;
        for (const [name, value] of [
          ['entryBytes', result.entryBytes],
          ['entryWriteCount', result.entryWriteCount],
          ['historicalEncodeCount', result.historicalEncodeCount],
        ] as const) {
          if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
            throw new Error(`${name} must be a non-negative integer.`);
          }
        }
        const contact = result.contact ?? input.contact ?? null;
        const adapter = input.adapter ?? contact?.adapter;
        this.recentSpans.push({
          accepted: result.accepted ?? true,
          ...(adapter === undefined ? {} : { adapter }),
          ...(result.batchSequence === undefined ? {} : { batchSequence: result.batchSequence }),
          ...(result.causalRepair === undefined ? {} : { causalRepair: result.causalRepair }),
          ...(input.commandKind === undefined ? {} : { commandKind: input.commandKind }),
          ...(contact === null ? {} : { contactSequence: contact.sequence }),
          ...(result.documentCommandProduced === undefined
            ? {}
            : { documentCommandProduced: result.documentCommandProduced }),
          durationMs: round(Math.max(0, this.now() - startedAt)),
          ...(result.entryBytes === undefined ? {} : { entryBytes: result.entryBytes }),
          ...(result.entryWriteCount === undefined
            ? {}
            : { entryWriteCount: result.entryWriteCount }),
          ...(result.historicalEncodeCount === undefined
            ? {}
            : { historicalEncodeCount: result.historicalEncodeCount }),
          ...(input.inputPhase === undefined ? {} : { inputPhase: input.inputPhase }),
          name,
          ...(result.presentationOutcome === undefined
            ? {}
            : { presentationOutcome: result.presentationOutcome }),
          ...(result.requestedGeneration === undefined
            ? {}
            : { requestedGeneration: result.requestedGeneration }),
          ...(result.sampleCount === undefined
            ? {}
            : { sampleCountBucket: sampleCountBucket(result.sampleCount) }),
          ...(result.submittedGeneration === undefined
            ? {}
            : { submittedGeneration: result.submittedGeneration }),
          ...(result.viewportResultCount === undefined
            ? {}
            : { viewportResultCount: result.viewportResultCount }),
          workPhase: input.workPhase,
        });
        if (this.recentSpans.length > this.maxRecentSpans) {
          const dropped = this.recentSpans.length - this.maxRecentSpans;
          this.recentSpans.splice(0, dropped);
          this.droppedSpanCount += dropped;
        }
      },
    };
  }

  snapshot(): {
    readonly armedAuditGuards: readonly InkPerformanceAuditGuard[];
    readonly auditedWork: readonly {
      readonly count: number;
      readonly kind: InkForbiddenWorkKind;
      readonly phase: InkPerformanceWorkPhase;
    }[];
    readonly distributions: readonly InkPerformanceDistribution[];
    readonly droppedSpanCount: number;
    readonly forbiddenWork: readonly {
      readonly count: number;
      readonly kind: InkForbiddenWorkKind;
      readonly phase: InkPerformanceWorkPhase;
    }[];
    readonly hangingSpanCount: number;
    readonly frameIntervalsMs: {
      readonly activeWriting: readonly number[];
      readonly hostGaps: readonly number[];
      readonly idle: readonly number[];
    };
    readonly memory: {
      readonly activeWorkingSetBytes: number;
      readonly backingStoreBytes: number;
      readonly disposableCacheBytes: number;
    };
    readonly openContactCount: number;
    readonly recentSpans: readonly InkPerformanceSpanSample[];
    readonly schedulerUnitOverruns: readonly {
      readonly durationMs: number;
      readonly lane: 'cold' | 'visible';
      readonly unitKind?: string;
    }[];
    readonly schedulerUnitCount: number;
  } {
    return {
      armedAuditGuards: [...this.armedAuditGuards],
      auditedWork: [...this.auditedWork.values()].map((counter) => ({ ...counter })),
      distributions: distributions(this.recentSpans),
      droppedSpanCount: this.droppedSpanCount,
      forbiddenWork: [...this.forbiddenWork.values()].map((counter) => ({ ...counter })),
      frameIntervalsMs: {
        activeWriting: [...this.frameIntervalsMs['active-writing']],
        hostGaps: [...this.frameIntervalsMs['host-gap']],
        idle: [...this.frameIntervalsMs.idle],
      },
      hangingSpanCount: this.activeSpans.size,
      memory: { ...this.memory },
      openContactCount: this.openContacts.size,
      recentSpans: this.recentSpans.map((sample) => ({ ...sample })),
      schedulerUnitOverruns: this.schedulerUnitOverruns.map((overrun) => ({ ...overrun })),
      schedulerUnitCount: this.schedulerUnitCount,
    };
  }

  private clear(): void {
    this.activeSpans.clear();
    this.auditedWork.clear();
    this.forbiddenWork.clear();
    this.frameIntervalsMs['active-writing'].splice(0);
    this.frameIntervalsMs['host-gap'].splice(0);
    this.frameIntervalsMs.idle.splice(0);
    this.droppedSpanCount = 0;
    this.memory = {
      activeWorkingSetBytes: 0,
      backingStoreBytes: 0,
      disposableCacheBytes: 0,
    };
    this.openContacts.clear();
    this.recentSpans.splice(0);
    this.schedulerUnitOverruns.splice(0);
    this.schedulerUnitCount = 0;
  }
}

function distributions(
  samples: readonly InkPerformanceSpanSample[],
): readonly InkPerformanceDistribution[] {
  const grouped = new Map<
    string,
    { readonly sample: InkPerformanceSpanSample; readonly values: number[] }
  >();
  for (const sample of samples) {
    if (!sample.accepted) continue;
    const key = [
      sample.name,
      sample.workPhase,
      sample.adapter ?? '',
      sample.inputPhase ?? '',
      sample.commandKind ?? '',
    ].join('\u0000');
    const group = grouped.get(key);
    if (group === undefined) {
      grouped.set(key, { sample, values: [sample.durationMs] });
    } else {
      group.values.push(sample.durationMs);
    }
  }
  return [...grouped.values()].map(({ sample, values }) => {
    const sorted = [...values].sort((left, right) => left - right);
    return {
      ...(sample.adapter === undefined ? {} : { adapter: sample.adapter }),
      ...(sample.commandKind === undefined ? {} : { commandKind: sample.commandKind }),
      ...(sample.inputPhase === undefined ? {} : { inputPhase: sample.inputPhase }),
      maximumMs: round(sorted.at(-1) ?? 0),
      name: sample.name,
      p50Ms: round(percentile(sorted, 0.5)),
      p95Ms: round(percentile(sorted, 0.95)),
      p99Ms: round(percentile(sorted, 0.99)),
      sampleCount: sorted.length,
      workPhase: sample.workPhase,
    };
  });
}

function isInkCommandKind(value: string): value is InkCommandKind {
  return (
    value === 'delete-selection' ||
    value === 'erase' ||
    value === 'move' ||
    value === 'redo' ||
    value === 'restyle' ||
    value === 'selection' ||
    value === 'undo'
  );
}

function assertPrivacySafeFields(input: object, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error('Ink performance diagnostics accept only privacy-safe fields.');
  }
}

function sampleCountBucket(sampleCount: number): string {
  if (sampleCount <= 0) return '0';
  if (sampleCount === 1) return '1';
  if (sampleCount <= 4) return '2-4';
  if (sampleCount <= 8) return '5-8';
  if (sampleCount <= 16) return '9-16';
  if (sampleCount <= 32) return '17-32';
  return '33+';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(percentileValue * sorted.length) - 1] ?? 0;
}
