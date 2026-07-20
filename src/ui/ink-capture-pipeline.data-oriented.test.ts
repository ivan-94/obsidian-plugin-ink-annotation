import { describe, expect, it } from 'vitest';

import {
  InkCapturePipeline,
  PointerEventInkAdapter,
  type InkCaptureBatchContext,
} from './ink-capture-pipeline';
import { createInkStageFrame } from './ink-stage-frame';

describe('Ink data-oriented capture seam', () => {
  it('consumes a large coalesced batch without materializing native-rate sample objects or copying its prefix', () => {
    const adapter = new PointerEventInkAdapter();
    const coalesced = Array.from({ length: 2_048 }, (_value, index) =>
      pointer(index + 1, (index + 1) / 2, index + 1),
    );
    const parent = pointer(2_048, 1_024, 2_048);
    parent.getCoalescedEvents = () => coalesced;
    const down = adapter.createBatch(pointer(0, 0, 0), 'down', captureContext());
    const batch = adapter.createBatch(parent, 'move', captureContext());
    if (down === null || batch === null) throw new Error('Missing Pointer batch.');

    expect(batch.sampleSequence.materializedSampleCount).toBe(0);
    expect(batch.sampleSequence.copiedNativeSampleCount).toBe(0);

    const pipeline = new InkCapturePipeline({ createId: () => 'numeric' });
    pipeline.accept(down);
    const result = pipeline.accept(batch);

    expect(result.kind).toBe('active');
    if (result.kind !== 'active') return;
    expect('delta' in result).toBe(false);
    expect(result.presentationDelta.kind).toBe('borrowed-numeric');
    const presented: Array<{ readonly flags: number; readonly x: number; readonly y: number }> = [];
    for (const samples of [
      result.presentationDelta.stablePrefixDelta,
      result.presentationDelta.mutableTail,
    ]) {
      samples.forEachSample(({ flags, x, y }) => presented.push({ flags, x, y }));
    }
    expect(presented.length).toBeGreaterThan(0);
    expect(presented[0]?.x).toBeGreaterThan(0);
    expect(presented.at(-1)).toMatchObject({ x: 2_048, y: 1_000 });
    expect(batch.sampleSequence.materializedSampleCount).toBe(0);
    expect(batch.samples).toHaveLength(2_048);
    expect(batch.sampleSequence.materializedSampleCount).toBe(2_048);
  });

  it('fails closed when a borrowed presentation delta is read after the next reducer mutation', () => {
    const adapter = new PointerEventInkAdapter();
    const pipeline = new InkCapturePipeline({ createId: () => 'epoch-owned' });
    const down = adapter.createBatch(pointer(0, 0, 0), 'down', captureContext());
    const move = adapter.createBatch(pointer(20, 20, 1), 'move', captureContext());
    if (down === null || move === null) throw new Error('Missing Pointer batch.');
    const first = pipeline.accept(down);
    if (first.kind !== 'active') throw new Error('Missing first Active update.');

    expect(pipeline.accept(move).kind).toBe('active');

    expect(() => first.presentationDelta.stablePrefixDelta.length).toThrow(
      'Borrowed Ink presentation delta is no longer current.',
    );
    expect(() => first.presentationDelta.mutableTail.forEachSample(() => undefined)).toThrow(
      'Borrowed Ink presentation delta is no longer current.',
    );
  });
});

function captureContext(): InkCaptureBatchContext {
  return {
    frame: createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 1_000, left: 0, top: 0, width: 704 },
      documentClientOrigin: { x: 0, y: 0 },
    }),
    frameEpoch: 1,
    logicalBounds: { height: 1_000, width: 704, x: 0, y: 0 },
    style: { color: '#111111', tool: 'pen', width: 2 },
  };
}

interface TestPointerEvent {
  altitudeAngle: number | undefined;
  azimuthAngle: number | undefined;
  clientX: number;
  clientY: number;
  getCoalescedEvents: () => readonly TestPointerEvent[];
  pointerId: number;
  pointerType: string;
  pressure: number;
  tiltX: number;
  tiltY: number;
  timeStamp: number;
}

function pointer(clientX: number, clientY: number, timeStamp: number): TestPointerEvent {
  return {
    altitudeAngle: Math.PI / 3,
    azimuthAngle: Math.PI / 4,
    clientX,
    clientY,
    getCoalescedEvents: () => [],
    pointerId: 7,
    pointerType: 'pen',
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    timeStamp,
  };
}
