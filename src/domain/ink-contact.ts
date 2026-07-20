import type { InkStroke } from './ink-surface';

export type InkContactAdapter = 'pointer' | 'stylus-touch';
export type InkContactPhase = 'cancel' | 'down' | 'move' | 'up';

export type InkSensorReading =
  { readonly kind: 'measured'; readonly value: number } | { readonly kind: 'unavailable' };

export interface InkSampleOrientation {
  readonly altitude: InkSensorReading;
  readonly azimuth: InkSensorReading;
}

export interface InkContactSample {
  readonly orientation: InkSampleOrientation;
  readonly pressure: InkSensorReading;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export const INK_SAMPLE_FLAGS = Object.freeze({
  altitudeMeasured: 1 << 1,
  azimuthMeasured: 1 << 2,
  pressureMeasured: 1 << 0,
});

/** Mutable scalar cursor whose lifetime is limited to one synchronous sequence callback. */
export interface InkSampleCursor {
  altitude: number;
  azimuth: number;
  flags: number;
  pressure: number;
  time: number;
  x: number;
  y: number;
}

/** Borrowed scalar view. Consumers must copy values during the synchronous callback. */
export interface InkSampleView {
  readonly length: number;
  forEachSample(consumer: (sample: InkSampleCursor) => void): void;
}

/** Borrowed normalized native sequence consumed synchronously by InkCapturePipeline. */
export interface InkSampleSequence extends InkSampleView {
  readonly copiedNativeSampleCount: number;
  readonly materializedSampleCount: number;
  materialize(): readonly InkContactSample[];
}

export interface InkContactStyleSnapshot {
  readonly color: string;
  readonly tool: InkStroke['tool'];
  readonly width: number;
}

export interface InkContactLogicalBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InkContactBatch {
  readonly adapter: InkContactAdapter;
  readonly capabilities: {
    readonly orientation: 'measured' | 'unavailable';
    readonly pressure: 'measured' | 'unavailable';
  };
  readonly contactId: string;
  readonly frameEpoch: number;
  readonly logicalBounds: InkContactLogicalBounds;
  readonly phase: InkContactPhase;
  readonly sampleCount: number;
  readonly sampleSequence: InkSampleSequence;
  readonly samples: readonly InkContactSample[];
  readonly style: InkContactStyleSnapshot;
}
