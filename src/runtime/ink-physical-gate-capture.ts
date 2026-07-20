import type { InkPerformanceDiagnostics } from './ink-performance-diagnostics';
import {
  probeActiveInkWorkerCapabilities,
  probeInkRuntimeCapabilities,
  type InkActiveWorkerCapabilities,
  type InkRuntimeCapabilities,
} from './ink-runtime-capabilities';

export interface S27ConditionMarker {
  readonly adapter: 'pointer' | 'stylus-touch';
  readonly buildDigest: string;
  readonly conditionId: string;
  readonly deviceDigest: string;
  readonly fixtureDigest: string;
  readonly presentationAdapter: 'main-canvas-2d' | 'worker-offscreen-2d';
  readonly protocolDigest: string;
  readonly runIndex: 1 | 2 | 3;
  readonly schemaVersion: 2;
  readonly tester: string;
}

export type S27PresentationAdapter = S27ConditionMarker['presentationAdapter'];

export interface S27PresentationAdapterState {
  readonly adapter: S27PresentationAdapter;
  readonly epoch: number;
  readonly requestedAdapter: S27PresentationAdapter;
}

interface LongTaskObservation {
  readonly available: boolean;
  disconnect(): void;
}

const IDLE_INTERVAL_COUNT = 120;
const MAX_LONG_TASKS = 512;

/** Owns one bounded, privacy-safe physical Gate capture inside the production WebView. */
export class S27PhysicalGateCapture {
  private readonly cancelFrame: (handle: number) => void;
  private condition: S27ConditionMarker | null = null;
  private readonly diagnostics: InkPerformanceDiagnostics;
  private longTaskDurationsMs: number[] = [];
  private longTaskObservation: LongTaskObservation | null = null;
  private heartbeatActive = false;
  private heartbeatFrame: number | null = null;
  private heartbeatPreviousTimestamp: number | null = null;
  private readonly now: () => string;
  private readonly observeLongTasks: (record: (durationMs: number) => void) => LongTaskObservation;
  private readonly probeActiveWorkerCapabilities: () => Promise<InkActiveWorkerCapabilities>;
  private readonly probeCapabilities: () => InkRuntimeCapabilities;
  private ready = false;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private runtimeCapabilities: InkRuntimeCapabilities | null = null;
  private readonly selectedPresentationAdapterState: () => S27PresentationAdapterState | null;
  private expectedPresentationAdapterState: S27PresentationAdapterState | null = null;
  private presentationAdapterFenceBreached = false;
  private startGeneration = 0;

  constructor(input: {
    readonly cancelFrame?: (handle: number) => void;
    readonly diagnostics: InkPerformanceDiagnostics;
    readonly now?: () => string;
    readonly observeLongTasks?: (record: (durationMs: number) => void) => LongTaskObservation;
    readonly probeActiveWorkerCapabilities?: () => Promise<InkActiveWorkerCapabilities>;
    readonly probeCapabilities?: () => InkRuntimeCapabilities;
    readonly requestFrame?: (callback: FrameRequestCallback) => number;
    readonly selectedPresentationAdapterState?: () => S27PresentationAdapterState | null;
  }) {
    this.cancelFrame =
      input.cancelFrame ??
      ((handle) => {
        if (typeof globalThis.cancelAnimationFrame === 'function') {
          globalThis.cancelAnimationFrame(handle);
        }
      });
    this.diagnostics = input.diagnostics;
    this.now = input.now ?? (() => new Date().toISOString());
    this.observeLongTasks = input.observeLongTasks ?? observeBrowserLongTasks;
    this.probeActiveWorkerCapabilities =
      input.probeActiveWorkerCapabilities ?? probeActiveInkWorkerCapabilities;
    this.probeCapabilities = input.probeCapabilities ?? probeInkRuntimeCapabilities;
    this.requestFrame = input.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.selectedPresentationAdapterState =
      input.selectedPresentationAdapterState ??
      (() =>
        Object.freeze({
          adapter: 'main-canvas-2d',
          epoch: 1,
          requestedAdapter: 'main-canvas-2d',
        }));
  }

  async start(marker: S27ConditionMarker): Promise<void> {
    decodeS27ConditionMarker(marker);
    const presentationAdapterState = this.readPresentationAdapterState();
    if (
      presentationAdapterState === null ||
      marker.presentationAdapter !== presentationAdapterState.adapter ||
      marker.presentationAdapter !== presentationAdapterState.requestedAdapter
    ) {
      throw new Error('S27 condition renderer does not match the selected Ink renderer.');
    }
    this.startGeneration += 1;
    const startGeneration = this.startGeneration;
    this.stopHostHeartbeat();
    this.longTaskObservation?.disconnect();
    this.condition = Object.freeze({ ...marker });
    this.diagnostics.reset();
    this.longTaskDurationsMs = [];
    this.expectedPresentationAdapterState = Object.freeze({ ...presentationAdapterState });
    this.presentationAdapterFenceBreached = false;
    this.ready = false;
    this.runtimeCapabilities = null;
    this.longTaskObservation = this.observeLongTasks((durationMs) => {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      this.longTaskDurationsMs.push(round(durationMs));
      if (this.longTaskDurationsMs.length > MAX_LONG_TASKS) {
        this.longTaskDurationsMs.splice(0, this.longTaskDurationsMs.length - MAX_LONG_TASKS);
      }
    });
    try {
      const synchronousCapabilities = this.probeCapabilities();
      const [activeWorkerCapabilities, intervals] = await Promise.all([
        this.probeActiveWorkerCapabilities(),
        collectAnimationFrameIntervals(
          this.requestFrame,
          IDLE_INTERVAL_COUNT,
          () => startGeneration === this.startGeneration,
        ),
      ]);
      if (startGeneration !== this.startGeneration) return;
      if (!this.matchesPresentationAdapterState()) {
        this.presentationAdapterFenceBreached = true;
        throw new PresentationAdapterFenceError();
      }
      for (const interval of intervals) this.diagnostics.recordFrameInterval(interval, 'idle');
      this.runtimeCapabilities = Object.freeze({
        ...synchronousCapabilities,
        ...activeWorkerCapabilities,
      });
      this.ready = true;
      this.startHostHeartbeat();
    } catch {
      const presentationAdapterFenceBreached = this.presentationAdapterFenceBreached;
      if (startGeneration === this.startGeneration) {
        this.startGeneration += 1;
        this.invalidateCapture();
      }
      if (presentationAdapterFenceBreached) {
        throw new Error('S27 production renderer changed during physical Gate capture.');
      }
      throw new Error('S27 active Worker capability probe failed.');
    }
  }

  cancel(): void {
    this.startGeneration += 1;
    this.invalidateCapture();
  }

  finish(): {
    readonly capturedAt: string;
    readonly condition: S27ConditionMarker;
    readonly diagnostics: ReturnType<InkPerformanceDiagnostics['snapshot']>;
    readonly longTasks: { readonly available: boolean; readonly durationsMs: readonly number[] };
    readonly runtimeCapabilities: InkRuntimeCapabilities;
    readonly schemaVersion: 2;
  } {
    if (
      !this.ready ||
      this.condition === null ||
      this.longTaskObservation === null ||
      this.runtimeCapabilities === null
    ) {
      throw new Error('S27 capture has not completed idle refresh calibration.');
    }
    if (this.presentationAdapterFenceBreached || !this.matchesPresentationAdapterState()) {
      this.startGeneration += 1;
      this.invalidateCapture();
      throw new Error('S27 production renderer changed during physical Gate capture.');
    }
    this.stopHostHeartbeat();
    this.longTaskObservation.disconnect();
    const result = {
      capturedAt: this.now(),
      condition: { ...this.condition },
      diagnostics: this.diagnostics.snapshot(),
      longTasks: {
        available: this.longTaskObservation.available,
        durationsMs: [...this.longTaskDurationsMs],
      },
      runtimeCapabilities: this.runtimeCapabilities,
      schemaVersion: 2 as const,
    };
    this.longTaskObservation = null;
    this.ready = false;
    this.runtimeCapabilities = null;
    return result;
  }

  private startHostHeartbeat(): void {
    this.heartbeatActive = true;
    this.heartbeatPreviousTimestamp = null;
    this.scheduleHostHeartbeat();
  }

  private scheduleHostHeartbeat(): void {
    if (!this.heartbeatActive || this.heartbeatFrame !== null) return;
    let completedSynchronously = false;
    const handle = this.requestFrame((timestamp) => {
      completedSynchronously = true;
      this.heartbeatFrame = null;
      if (!this.heartbeatActive) return;
      if (this.condition !== null && !this.matchesPresentationAdapterState()) {
        this.presentationAdapterFenceBreached = true;
      }
      const previous = this.heartbeatPreviousTimestamp;
      if (previous !== null) {
        this.diagnostics.recordFrameInterval(round(Math.max(0, timestamp - previous)), 'host-gap');
      }
      this.heartbeatPreviousTimestamp = timestamp;
      this.scheduleHostHeartbeat();
    });
    if (!completedSynchronously) this.heartbeatFrame = handle;
  }

  private stopHostHeartbeat(): void {
    this.heartbeatActive = false;
    this.heartbeatPreviousTimestamp = null;
    if (this.heartbeatFrame !== null) this.cancelFrame(this.heartbeatFrame);
    this.heartbeatFrame = null;
  }

  private invalidateCapture(): void {
    this.stopHostHeartbeat();
    this.longTaskObservation?.disconnect();
    this.longTaskObservation = null;
    this.condition = null;
    this.expectedPresentationAdapterState = null;
    this.presentationAdapterFenceBreached = false;
    this.ready = false;
    this.runtimeCapabilities = null;
  }

  private matchesPresentationAdapterState(): boolean {
    const expected = this.expectedPresentationAdapterState;
    if (expected === null) return false;
    const current = this.readPresentationAdapterState();
    return (
      current !== null &&
      current.adapter === expected.adapter &&
      current.epoch === expected.epoch &&
      current.requestedAdapter === expected.requestedAdapter
    );
  }

  private readPresentationAdapterState(): S27PresentationAdapterState | null {
    try {
      const state = this.selectedPresentationAdapterState();
      if (
        state === null ||
        (state.adapter !== 'main-canvas-2d' && state.adapter !== 'worker-offscreen-2d') ||
        (state.requestedAdapter !== 'main-canvas-2d' &&
          state.requestedAdapter !== 'worker-offscreen-2d') ||
        !Number.isSafeInteger(state.epoch) ||
        state.epoch <= 0
      ) {
        return null;
      }
      return state;
    } catch {
      return null;
    }
  }
}

class PresentationAdapterFenceError extends Error {}

function collectAnimationFrameIntervals(
  requestFrame: (callback: FrameRequestCallback) => number,
  intervalCount: number,
  isActive: () => boolean,
): Promise<readonly number[]> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let previous: number | null = null;
    const sample = (timestamp: number): void => {
      if (!isActive()) {
        resolve([]);
        return;
      }
      if (previous !== null) intervals.push(round(Math.max(0, timestamp - previous)));
      previous = timestamp;
      if (intervals.length >= intervalCount) {
        resolve(intervals);
      } else {
        requestFrame(sample);
      }
    };
    requestFrame(sample);
  });
}

function observeBrowserLongTasks(record: (durationMs: number) => void): LongTaskObservation {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes.includes('longtask')
  ) {
    return { available: false, disconnect: () => undefined };
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record(entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
    return { available: true, disconnect: () => observer.disconnect() };
  } catch {
    return { available: false, disconnect: () => undefined };
  }
}

export function decodeS27ConditionMarker(value: unknown): S27ConditionMarker {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid S27 condition marker.');
  }
  const marker = value as Record<string, unknown>;
  if (
    marker.schemaVersion !== 2 ||
    typeof marker.conditionId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(marker.conditionId) ||
    (marker.adapter !== 'pointer' && marker.adapter !== 'stylus-touch') ||
    (marker.runIndex !== 1 && marker.runIndex !== 2 && marker.runIndex !== 3) ||
    typeof marker.tester !== 'string' ||
    marker.tester.trim().length === 0 ||
    typeof marker.buildDigest !== 'string' ||
    !isDigest(marker.buildDigest) ||
    typeof marker.fixtureDigest !== 'string' ||
    !isDigest(marker.fixtureDigest) ||
    (marker.presentationAdapter !== 'main-canvas-2d' &&
      marker.presentationAdapter !== 'worker-offscreen-2d') ||
    typeof marker.deviceDigest !== 'string' ||
    !isDigest(marker.deviceDigest) ||
    typeof marker.protocolDigest !== 'string' ||
    !isDigest(marker.protocolDigest)
  ) {
    throw new Error('Invalid S27 condition marker.');
  }
  return Object.freeze({
    adapter: marker.adapter,
    buildDigest: marker.buildDigest,
    conditionId: marker.conditionId,
    deviceDigest: marker.deviceDigest,
    fixtureDigest: marker.fixtureDigest,
    presentationAdapter: marker.presentationAdapter,
    protocolDigest: marker.protocolDigest,
    runIndex: marker.runIndex,
    schemaVersion: 2,
    tester: marker.tester,
  });
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
