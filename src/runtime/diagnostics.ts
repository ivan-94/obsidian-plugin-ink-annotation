export type DiagnosticMetricName =
  | 'plugin-shutdown'
  | 'plugin-startup'
  | 'quick-toolbar-open'
  | 'reading-section-render'
  | 'workspace-ready';

export type DiagnosticMemoryMetricName =
  'ink-mode-memory' | 'manual-memory-checkpoint' | 'plugin-load-memory';

export type DiagnosticLatencyMetricName = 'ink-input-to-paint';

const MAX_LATENCY_SAMPLES = 240;

export interface DiagnosticDurationMetric {
  readonly durationMs: number;
  readonly name: DiagnosticMetricName;
  readonly recordedAt: string;
}

export interface DiagnosticMemoryMetric {
  readonly jsHeapLimitMb: number;
  readonly name: DiagnosticMemoryMetricName;
  readonly recordedAt: string;
  readonly totalJsHeapMb: number;
  readonly usedJsHeapMb: number;
}

export interface DiagnosticLatencyMetric {
  readonly maximumMs: number;
  readonly name: DiagnosticLatencyMetricName;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly recordedAt: string;
  readonly sampleCount: number;
}

export type DiagnosticMetric =
  DiagnosticDurationMetric | DiagnosticLatencyMetric | DiagnosticMemoryMetric;

export class Diagnostics {
  private readonly latencySamples = new Map<
    DiagnosticLatencyMetricName,
    { readonly recordedAt: string; readonly values: number[] }
  >();
  private readonly metrics: DiagnosticMetric[] = [];

  constructor(
    private enabled: boolean,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;

    if (!enabled) {
      this.metrics.splice(0);
      this.latencySamples.clear();
    }
  }

  recordLatency(name: DiagnosticLatencyMetricName, durationMs: number): void {
    if (!this.enabled) return;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('Latency diagnostics require a finite non-negative duration.');
    }
    const existing = this.latencySamples.get(name);
    if (existing === undefined) {
      this.latencySamples.set(name, { recordedAt: this.now(), values: [durationMs] });
      return;
    }
    existing.values.push(durationMs);
    if (existing.values.length > MAX_LATENCY_SAMPLES) {
      existing.values.splice(0, existing.values.length - MAX_LATENCY_SAMPLES);
    }
  }

  recordDuration(name: DiagnosticMetricName, durationMs: number): void {
    if (!this.enabled) {
      return;
    }

    this.metrics.push({
      durationMs: Math.round(durationMs * 100) / 100,
      name,
      recordedAt: this.now(),
    });
  }

  recordMemory(
    name: DiagnosticMemoryMetricName,
    sample: {
      readonly jsHeapSizeLimit: number;
      readonly totalJSHeapSize: number;
      readonly usedJSHeapSize: number;
    },
  ): void {
    if (!this.enabled) return;
    const values = [sample.jsHeapSizeLimit, sample.totalJSHeapSize, sample.usedJSHeapSize];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('Browser memory diagnostics require finite non-negative byte counts.');
    }
    this.metrics.push({
      jsHeapLimitMb: megabytes(sample.jsHeapSizeLimit),
      name,
      recordedAt: this.now(),
      totalJsHeapMb: megabytes(sample.totalJSHeapSize),
      usedJsHeapMb: megabytes(sample.usedJSHeapSize),
    });
  }

  snapshot(): readonly DiagnosticMetric[] {
    return [
      ...this.metrics.map((metric) => ({ ...metric })),
      ...[...this.latencySamples].map(([name, sample]) => {
        const values = [...sample.values].sort((left, right) => left - right);
        return {
          maximumMs: round(values.at(-1) ?? 0),
          name,
          p50Ms: round(percentile(values, 0.5)),
          p95Ms: round(percentile(values, 0.95)),
          recordedAt: sample.recordedAt,
          sampleCount: values.length,
        };
      }),
    ];
  }
}

function megabytes(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(percentileValue * sorted.length) - 1] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
