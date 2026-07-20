import { describe, expect, it } from 'vitest';

import { INK_SAMPLE_FLAGS } from '../domain/ink-contact';
import { createInkStageFrame } from './ink-stage-frame';
import {
  InkContactArbiter,
  InkCapturePipeline,
  PointerEventInkAdapter,
  WebKitStylusTouchAdapter,
  type InkCaptureBatchContext,
  type InkCaptureResult,
} from './ink-capture-pipeline';

describe('Ink native contact adapters', () => {
  it('reuses an already frozen contact context instead of cloning style and bounds per move', () => {
    const adapter = new PointerEventInkAdapter();
    const source = context();
    const frozenContext: InkCaptureBatchContext = Object.freeze({
      ...source,
      logicalBounds: Object.freeze({ ...source.logicalBounds }),
      style: Object.freeze({ ...source.style }),
    });

    const batch = adapter.createBatch(pointerEvent(), 'move', frozenContext);

    expect(batch?.logicalBounds).toBe(frozenContext.logicalBounds);
    expect(batch?.style).toBe(frozenContext.style);
  });

  it('retains empty-coalesced down/up endpoints and measured pressure zero', () => {
    const adapter = new PointerEventInkAdapter();
    const batchContext = context();
    const down = adapter.createBatch(
      pointerEvent({ clientX: 10, clientY: 20, pressure: 0, timeStamp: 5 }),
      'down',
      batchContext,
    );
    const up = adapter.createBatch(
      pointerEvent({ clientX: 30, clientY: 40, pressure: 0, timeStamp: 4 }),
      'up',
      context(),
    );

    expect(down).toMatchObject({
      adapter: 'pointer',
      contactId: 'pointer:7',
      frameEpoch: 3,
      phase: 'down',
      samples: [
        {
          pressure: { kind: 'measured', value: 0 },
          time: 5,
          x: 10,
          y: 20,
        },
      ],
    });
    expect(up?.samples).toHaveLength(1);
    expect(up?.samples[0]).toMatchObject({
      pressure: { kind: 'measured', value: 0 },
      x: 30,
      y: 40,
    });
    expect(down?.style).toEqual(batchContext.style);
    expect(down?.style).not.toBe(batchContext.style);
    expect(Object.isFrozen(down?.style)).toBe(true);
    expect(down?.logicalBounds).not.toBe(batchContext.logicalBounds);
    expect(Object.isFrozen(down?.logicalBounds)).toBe(true);
  });

  it('reads every actual coalesced sample once in native order', () => {
    const adapter = new PointerEventInkAdapter();
    const event = pointerEvent({ clientX: 30, clientY: 40, pressure: 0.8, timeStamp: 30 });
    const first = pointerEvent({ clientX: 10, clientY: 20, pressure: 0.2, timeStamp: 10 });
    const second = pointerEvent({ clientX: 20, clientY: 30, pressure: 0.4, timeStamp: 20 });
    let reads = 0;
    event.getCoalescedEvents = () => {
      reads += 1;
      return [first, second, event];
    };

    const batch = adapter.createBatch(event, 'move', context());

    expect(reads).toBe(1);
    expect(batch?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 10, x: 10, y: 20 },
      { time: 20, x: 20, y: 30 },
      { time: 30, x: 30, y: 40 },
    ]);
  });

  it('does not append a display-aligned parent after confirmed coalesced move samples', () => {
    const adapter = new PointerEventInkAdapter();
    const event = pointerEvent({ clientX: 30, clientY: 40, pressure: 0.8, timeStamp: 30 });
    const first = pointerEvent({ clientX: 10, clientY: 20, pressure: 0.2, timeStamp: 10 });
    const second = pointerEvent({ clientX: 20, clientY: 30, pressure: 0.4, timeStamp: 20 });
    event.getCoalescedEvents = () => [first, second];

    const batch = adapter.createBatch(event, 'move', context());

    expect(batch?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 10, x: 10, y: 20 },
      { time: 20, x: 20, y: 30 },
    ]);
  });

  it('moves a front-loaded display parent behind its older coalesced curve samples', () => {
    const adapter = new PointerEventInkAdapter();
    const event = pointerEvent({ clientX: 30, clientY: 0, pressure: 0.8, timeStamp: 30 });
    const first = pointerEvent({ clientX: 5, clientY: 12, pressure: 0.3, timeStamp: 10 });
    const second = pointerEvent({ clientX: 18, clientY: 18, pressure: 0.5, timeStamp: 20 });
    event.getCoalescedEvents = () => [event, first, second];

    adapter.createBatch(
      pointerEvent({ clientX: 0, clientY: 0, pressure: 0.2, timeStamp: 0 }),
      'down',
      context(),
    );
    const batch = adapter.createBatch(event, 'move', context());

    expect(batch?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 10, x: 5, y: 12 },
      { time: 20, x: 18, y: 18 },
      { time: 30, x: 30, y: 0 },
    ]);
    expect(adapter.lastCausalRepairKind).toBe('front-loaded-parent');
  });

  it('drops a cumulative coalesced prefix already admitted by the active pointer contact', () => {
    const adapter = new PointerEventInkAdapter();
    const down = pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 });
    const first = pointerEvent({ clientX: 10, clientY: 10, timeStamp: 10 });
    const second = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    const third = pointerEvent({ clientX: 30, clientY: 30, timeStamp: 30 });
    const firstMove = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    firstMove.getCoalescedEvents = () => [first, second];
    const cumulativeMove = pointerEvent({ clientX: 30, clientY: 30, timeStamp: 30 });
    cumulativeMove.getCoalescedEvents = () => [first, second, third];

    adapter.createBatch(down, 'down', context());
    const admittedFirst = adapter.createBatch(firstMove, 'move', context());
    const admittedCumulative = adapter.createBatch(cumulativeMove, 'move', context());

    expect(admittedFirst?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 10, x: 10, y: 10 },
      { time: 20, x: 20, y: 20 },
    ]);
    expect(admittedCumulative?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 30, x: 30, y: 30 },
    ]);
    expect(adapter.lastOverlapDroppedSampleCount).toBe(2);
  });

  it('ignores a fully replayed cumulative coalesced move instead of accepting an empty batch', () => {
    const adapter = new PointerEventInkAdapter();
    const down = pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 });
    const first = pointerEvent({ clientX: 10, clientY: 10, timeStamp: 10 });
    const second = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    const firstMove = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    firstMove.getCoalescedEvents = () => [first, second];
    const replayedMove = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 21 });
    replayedMove.getCoalescedEvents = () => [first, second];

    adapter.createBatch(down, 'down', context());
    adapter.createBatch(firstMove, 'move', context());
    const replayed = adapter.createBatch(replayedMove, 'move', context());

    expect(replayed).toBeNull();
    expect(adapter.lastAdmissionKind).toBe('ignored');
    expect(adapter.lastOverlapDroppedSampleCount).toBe(2);
  });

  it('drops only the old-tail/new-prefix overlap when a valid trajectory returns to an old point', () => {
    const adapter = new PointerEventInkAdapter();
    const down = pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 });
    const first = pointerEvent({ clientX: 10, clientY: 10, timeStamp: 10 });
    const second = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    const bend = pointerEvent({ clientX: 30, clientY: 5, timeStamp: 30 });
    const returnToSecond = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    const end = pointerEvent({ clientX: 40, clientY: 20, timeStamp: 40 });
    const firstMove = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    firstMove.getCoalescedEvents = () => [first, second];
    const returningMove = pointerEvent({ clientX: 40, clientY: 20, timeStamp: 40 });
    returningMove.getCoalescedEvents = () => [first, second, bend, returnToSecond, end];

    adapter.createBatch(down, 'down', context());
    adapter.createBatch(firstMove, 'move', context());
    const admittedReturn = adapter.createBatch(returningMove, 'move', context());

    expect(admittedReturn?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 30, x: 30, y: 5 },
      { time: 20, x: 20, y: 20 },
      { time: 40, x: 40, y: 20 },
    ]);
    expect(adapter.lastOverlapDroppedSampleCount).toBe(2);
  });

  it('admits a new coalesced batch when native timestamps move backward without an exact overlap', () => {
    const adapter = new PointerEventInkAdapter();
    const down = pointerEvent({ clientX: 0, clientY: 0, timeStamp: 100 });
    const firstMove = pointerEvent({ clientX: 10, clientY: 10, timeStamp: 90 });
    firstMove.getCoalescedEvents = () => [
      pointerEvent({ clientX: 10, clientY: 10, timeStamp: 90 }),
    ];
    const backwardMove = pointerEvent({ clientX: 30, clientY: 30, timeStamp: 70 });
    backwardMove.getCoalescedEvents = () => [
      pointerEvent({ clientX: 20, clientY: 20, timeStamp: 80 }),
      pointerEvent({ clientX: 30, clientY: 30, timeStamp: 70 }),
    ];

    adapter.createBatch(down, 'down', context());
    adapter.createBatch(firstMove, 'move', context());
    const admittedBackward = adapter.createBatch(backwardMove, 'move', context());

    expect(admittedBackward?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 80, x: 20, y: 20 },
      { time: 70, x: 30, y: 30 },
    ]);
  });

  it('poisons an invalid coalesced move batch instead of keeping a bridgeable empty contact', () => {
    const adapter = new PointerEventInkAdapter();
    adapter.createBatch(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }), 'down', context());
    const move = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    move.getCoalescedEvents = () => [
      pointerEvent({ clientX: 500, clientY: 500, pointerId: 99, timeStamp: 10 }),
    ];

    const batch = adapter.createBatch(move, 'move', context());

    expect(batch).toBeNull();
    expect(adapter.lastAdmissionKind).toBe('invalid');
  });

  it('poisons a non-finite parent-only move', () => {
    const adapter = new PointerEventInkAdapter();
    adapter.createBatch(pointerEvent({ clientX: 0, clientY: 0, timeStamp: 0 }), 'down', context());

    const batch = adapter.createBatch(
      pointerEvent({ clientX: Number.NaN, clientY: 20, timeStamp: 20 }),
      'move',
      context(),
    );

    expect(batch).toBeNull();
    expect(adapter.lastAdmissionKind).toBe('invalid');
  });

  it('keeps causal tails isolated when another pointer contact is admitted by the adapter', () => {
    const adapter = new PointerEventInkAdapter();
    const first = pointerEvent({ clientX: 10, clientY: 10, timeStamp: 10 });
    const second = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    const third = pointerEvent({ clientX: 30, clientY: 30, timeStamp: 30 });
    const firstMove = pointerEvent({ clientX: 20, clientY: 20, timeStamp: 20 });
    firstMove.getCoalescedEvents = () => [first, second];
    const cumulativeMove = pointerEvent({ clientX: 30, clientY: 30, timeStamp: 30 });
    cumulativeMove.getCoalescedEvents = () => [first, second, third];

    adapter.createBatch(pointerEvent({ pointerId: 7, timeStamp: 0 }), 'down', context());
    adapter.createBatch(firstMove, 'move', context());
    adapter.createBatch(pointerEvent({ pointerId: 8, timeStamp: 25 }), 'down', context());
    const continuedFirst = adapter.createBatch(cumulativeMove, 'move', context());

    expect(continuedFirst?.samples.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 30, y: 30 }]);
  });

  it('exposes a bounded borrowed provisional tail without entering the confirmed batch', () => {
    const adapter = new PointerEventInkAdapter();
    const event = pointerEvent({ clientX: 10, clientY: 20, timeStamp: 10 });
    let reads = 0;
    event.getPredictedEvents = () => {
      reads += 1;
      return Array.from({ length: 40 }, (_value, index) =>
        pointerEvent({
          clientX: 20 + index,
          clientY: 30 + index,
          timeStamp: 11 + index,
        }),
      );
    };

    const predicted = adapter.createProvisionalTail(event, context());
    const points: Array<{ readonly x: number; readonly y: number }> = [];
    predicted?.forEachPoint((x, y) => points.push({ x, y }));
    const confirmed = adapter.createBatch(event, 'move', context());

    expect(reads).toBe(1);
    expect(predicted?.kind).toBe('borrowed-provisional-prediction-tail');
    expect(predicted?.frameEpoch).toBe(3);
    expect(points).toHaveLength(16);
    expect(points[0]).toEqual({ x: 20, y: 30 });
    expect(points.at(-1)).toEqual({ x: 35, y: 45 });
    expect(confirmed?.sampleCount).toBe(1);
  });

  it('fails a provisional tail closed without affecting confirmed input', () => {
    const invalidCases: TestPointerEvent[] = [
      pointerEvent({ clientX: Number.NaN, timeStamp: 11 }),
      pointerEvent({ pointerId: 8, timeStamp: 11 }),
      pointerEvent({ pointerType: 'mouse', timeStamp: 11 }),
      pointerEvent({ timeStamp: 9 }),
    ];

    for (const invalid of invalidCases) {
      const adapter = new PointerEventInkAdapter();
      const event = pointerEvent({ timeStamp: 10 });
      event.getPredictedEvents = () => [invalid];
      expect(adapter.createProvisionalTail(event, context())).toBeNull();
      expect(adapter.createBatch(event, 'move', context())?.sampleCount).toBe(1);
    }

    const adapter = new PointerEventInkAdapter();
    const throwing = pointerEvent();
    throwing.getPredictedEvents = () => {
      throw new Error('private prediction failure');
    };
    expect(adapter.createProvisionalTail(throwing, context())).toBeNull();
    expect(adapter.createBatch(throwing, 'move', context())?.sampleCount).toBe(1);
  });

  it('contains hostile prediction shapes and accessors without losing confirmed input', () => {
    const malformed = pointerEvent();
    malformed.getPredictedEvents = () => [null] as unknown as readonly TestPointerEvent[];

    const throwingAccessor = pointerEvent();
    Object.defineProperty(throwingAccessor, 'getPredictedEvents', {
      configurable: true,
      get: () => {
        throw new Error('private prediction accessor failure');
      },
    });

    const throwingSequence = pointerEvent();
    const hostileSequence = new Proxy([pointerEvent({ timeStamp: 6 })], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('private prediction sequence failure');
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    throwingSequence.getPredictedEvents = () => hostileSequence;

    for (const event of [malformed, throwingAccessor, throwingSequence]) {
      const adapter = new PointerEventInkAdapter();
      const confirmed = adapter.createBatch(event, 'move', context());

      expect(confirmed?.sampleCount).toBe(1);
      expect(adapter.createProvisionalTail(event, context())).toBeNull();
      expect(confirmed?.samples).toHaveLength(1);
    }
  });

  it('invalidates a borrowed provisional view when the next native event overwrites its buffer', () => {
    const adapter = new PointerEventInkAdapter();
    const firstEvent = pointerEvent({ timeStamp: 10 });
    firstEvent.getPredictedEvents = () => [pointerEvent({ clientX: 20, timeStamp: 11 })];
    const first = adapter.createProvisionalTail(firstEvent, context());
    if (first === null) throw new Error('Missing first provisional tail.');

    const secondEvent = pointerEvent({ timeStamp: 20 });
    secondEvent.getPredictedEvents = () => [pointerEvent({ clientX: 30, timeStamp: 21 })];
    expect(adapter.createProvisionalTail(secondEvent, context())).not.toBeNull();

    expect(() => first.forEachPoint(() => undefined)).toThrow(
      'Borrowed Ink prediction tail is no longer current.',
    );
  });

  it('invalidates a borrowed provisional view when the next native event has no predictions', () => {
    const adapter = new PointerEventInkAdapter();
    const firstEvent = pointerEvent({ clientX: 10, timeStamp: 10 });
    firstEvent.getPredictedEvents = () => [pointerEvent({ clientX: 20, timeStamp: 11 })];
    const first = adapter.createProvisionalTail(firstEvent, context());
    if (first === null) throw new Error('Missing first provisional tail.');

    adapter.createBatch(pointerEvent({ clientX: 30, timeStamp: 20 }), 'up', context());

    expect(() => first.forEachPoint(() => undefined)).toThrow(
      'Borrowed Ink prediction tail is no longer current.',
    );
  });

  it('keeps finalized canonical trace identical when extreme predictions are presented', () => {
    const run = (withPrediction: boolean) => {
      const adapter = new PointerEventInkAdapter();
      const pipeline = new InkCapturePipeline({ createId: () => 'prediction-isolation' });
      const events = [
        pointerEvent({ clientX: 10, clientY: 20, timeStamp: 10 }),
        pointerEvent({ clientX: 20, clientY: 30, timeStamp: 20 }),
        pointerEvent({ clientX: 30, clientY: 40, timeStamp: 30 }),
      ];
      if (withPrediction) {
        events[1]!.getPredictedEvents = () => [
          pointerEvent({ clientX: 700, clientY: 900, timeStamp: 21 }),
        ];
      }
      const phases = ['down', 'move', 'up'] as const;
      let result: InkCaptureResult | undefined;
      for (const [index, event] of events.entries()) {
        const batch = adapter.createBatch(
          event,
          phases[index] as (typeof phases)[number],
          context(),
        );
        if (batch === null) throw new Error('Missing prediction-isolation batch.');
        result = pipeline.accept(batch);
        if (phases[index] !== 'up') adapter.createProvisionalTail(event, context());
      }
      if (result?.kind !== 'completed') throw new Error('Missing completed prediction trace.');
      return result;
    };

    const baseline = run(false);
    const predicted = run(true);

    expect(predicted.trace).toEqual(baseline.trace);
    expect(predicted.stroke).toEqual(baseline.stroke);
  });

  it('uses the parent endpoint for non-move events even with an untrusted coalesced list', () => {
    const adapter = new PointerEventInkAdapter();
    const event = pointerEvent({ clientX: 30, clientY: 40, timeStamp: 30 });
    event.getCoalescedEvents = () => [pointerEvent({ clientX: 20, clientY: 30, timeStamp: 20 })];

    const batch = adapter.createBatch(event, 'up', context());

    expect(batch?.samples.map(({ time, x, y }) => ({ time, x, y }))).toEqual([
      { time: 30, x: 30, y: 40 },
    ]);
  });

  it('keeps unavailable mouse sensors distinct from measured zero', () => {
    const adapter = new PointerEventInkAdapter();

    const batch = adapter.createBatch(
      pointerEvent({ pointerType: 'mouse', pressure: 0, tiltX: 0, tiltY: 0 }),
      'down',
      context(),
    );

    expect(batch?.capabilities).toEqual({ orientation: 'unavailable', pressure: 'unavailable' });
    expect(batch?.samples[0]).toMatchObject({
      orientation: {
        altitude: { kind: 'unavailable' },
        azimuth: { kind: 'unavailable' },
      },
      pressure: { kind: 'unavailable' },
    });
  });

  it('does not invent Pointer pressure or orientation when the native readings are missing', () => {
    const adapter = new PointerEventInkAdapter();

    const batch = adapter.createBatch(
      pointerEvent({
        altitudeAngle: undefined,
        azimuthAngle: undefined,
        pressure: Number.NaN,
        tiltX: Number.NaN,
        tiltY: Number.NaN,
      }),
      'down',
      context(),
    );

    expect(batch?.capabilities).toEqual({ orientation: 'unavailable', pressure: 'unavailable' });
    expect(batch?.samples[0]).toMatchObject({
      orientation: {
        altitude: { kind: 'unavailable' },
        azimuth: { kind: 'unavailable' },
      },
      pressure: { kind: 'unavailable' },
    });
  });

  it('uses native altitude/azimuth first and the W3C tilt conversion as strict fallback', () => {
    const adapter = new PointerEventInkAdapter();
    const angles = adapter.createBatch(
      pointerEvent({ altitudeAngle: Math.PI / 4, azimuthAngle: Math.PI * 2, tiltX: 30, tiltY: 30 }),
      'move',
      context(),
    );
    const tilt = adapter.createBatch(
      pointerEvent({ altitudeAngle: undefined, azimuthAngle: undefined, tiltX: 0, tiltY: 45 }),
      'move',
      context(),
    );
    const partial = adapter.createBatch(
      pointerEvent({ altitudeAngle: Math.PI / 6, azimuthAngle: undefined, tiltX: -45, tiltY: 0 }),
      'move',
      context(),
    );

    expect(angles?.samples[0]?.orientation).toEqual({
      altitude: { kind: 'measured', value: Math.PI / 4 },
      azimuth: { kind: 'measured', value: 0 },
    });
    expect(tilt?.samples[0]?.orientation).toEqual({
      altitude: { kind: 'measured', value: Math.PI / 4 },
      azimuth: { kind: 'measured', value: Math.PI / 2 },
    });
    expect(partial?.samples[0]?.orientation).toEqual({
      altitude: { kind: 'measured', value: Math.PI / 4 },
      azimuth: { kind: 'measured', value: Math.PI },
    });
  });

  it('maps WebKit stylus force and orientation while leaving direct touch unclaimed', () => {
    const adapter = new WebKitStylusTouchAdapter();
    const stylus = touchEvent('stylus', {
      altitudeAngle: Math.PI / 3,
      azimuthAngle: Math.PI * 2,
      force: 0,
    });
    const direct = touchEvent('direct', { force: 0 });

    const batch = adapter.createBatch(stylus, 'down', context());

    expect(batch).toMatchObject({
      adapter: 'stylus-touch',
      capabilities: { orientation: 'measured', pressure: 'measured' },
      contactId: 'stylus-touch:9',
      samples: [
        {
          orientation: {
            altitude: { kind: 'measured', value: Math.PI / 3 },
            azimuth: { kind: 'measured', value: 0 },
          },
          pressure: { kind: 'measured', value: 0 },
        },
      ],
    });
    expect(adapter.createBatch(direct, 'down', context())).toBeNull();
  });
});

describe('Ink contact arbiter', () => {
  it('owns one adapter for a contact and rejects Pointer/Touch double delivery', () => {
    const pointer = new PointerEventInkAdapter();
    const touch = new WebKitStylusTouchAdapter();
    const arbiter = new InkContactArbiter();
    const pointerDown = pointer.createBatch(pointerEvent(), 'down', context());
    const touchDown = touch.createBatch(touchEvent('stylus'), 'down', context());
    if (pointerDown === null || touchDown === null) throw new Error('Missing test batch.');

    expect(arbiter.accept(pointerDown)).toBe('accepted');
    expect(arbiter.accept(touchDown)).toBe('duplicate-adapter');
    expect(arbiter.accept({ ...pointerDown, phase: 'move' })).toBe('accepted');
    expect(arbiter.accept({ ...pointerDown, phase: 'up' })).toBe('accepted');
    expect(arbiter.accept(touchDown)).toBe('accepted');
  });
});

describe('InkCapturePipeline', () => {
  it('freezes the canonical Pointer sensor and coalesced-endpoint trace before PF-42', () => {
    const adapter = new PointerEventInkAdapter();
    const pipeline = new InkCapturePipeline({ createId: () => 'pf42-cycle-0' });
    const down = adapter.createBatch(
      pointerEvent({
        altitudeAngle: undefined,
        azimuthAngle: undefined,
        clientX: 10,
        clientY: 20,
        pressure: 0,
        tiltX: 10,
        tiltY: 20,
        timeStamp: 100,
      }),
      'down',
      context(),
    );
    const moveEvent = pointerEvent({
      altitudeAngle: undefined,
      azimuthAngle: undefined,
      clientX: 40,
      clientY: 50,
      pressure: 0.8,
      tiltX: 0,
      tiltY: 0,
      timeStamp: 100,
    });
    moveEvent.getCoalescedEvents = () => [
      pointerEvent({
        altitudeAngle: undefined,
        azimuthAngle: undefined,
        clientX: 20,
        clientY: 30,
        pressure: 0.25,
        tiltX: 0,
        tiltY: 0,
        timeStamp: 100,
      }),
      pointerEvent({
        altitudeAngle: undefined,
        azimuthAngle: undefined,
        clientX: 30,
        clientY: 40,
        pressure: Number.NaN,
        tiltX: Number.NaN,
        tiltY: Number.NaN,
        timeStamp: 100,
      }),
      moveEvent,
    ];
    const move = adapter.createBatch(moveEvent, 'move', context());
    const up = adapter.createBatch(
      pointerEvent({
        altitudeAngle: undefined,
        azimuthAngle: undefined,
        clientX: 50,
        clientY: 60,
        pressure: Number.NaN,
        tiltX: Number.NaN,
        tiltY: Number.NaN,
        timeStamp: 100,
      }),
      'up',
      context(),
    );
    if (down === null || move === null || up === null) throw new Error('Missing PF-42 batch.');

    pipeline.accept(down);
    pipeline.accept(move);
    const result = pipeline.accept(up);

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.trace.rawSampleCount).toBe(5);
    expect(result.trace.points).toEqual([
      {
        pressure: 0,
        tiltX: 10.000000000000004,
        tiltY: 20.000000000000004,
        time: 100,
        x: 10,
        y: 20,
      },
      { pressure: 0.25, tiltX: 0, tiltY: 0, time: 100, x: 20, y: 30 },
      { pressure: 0.5, time: 100, x: 30, y: 40 },
      { pressure: 0.8, tiltX: 0, tiltY: 0, time: 100, x: 40, y: 50 },
      { pressure: 0.5, time: 100, x: 50, y: 60 },
    ]);
    expect(result.trace.samples).toEqual([
      {
        orientation: {
          altitude: { kind: 'measured', value: 1.1864747974457859 },
          azimuth: { kind: 'measured', value: 1.119662363149681 },
        },
        pressure: { kind: 'measured', value: 0 },
        time: 100,
        x: 10,
        y: 20,
      },
      {
        orientation: {
          altitude: { kind: 'measured', value: Math.PI / 2 },
          azimuth: { kind: 'measured', value: 0 },
        },
        pressure: { kind: 'measured', value: 0.25 },
        time: 100,
        x: 20,
        y: 30,
      },
      {
        orientation: {
          altitude: { kind: 'unavailable' },
          azimuth: { kind: 'unavailable' },
        },
        pressure: { kind: 'unavailable' },
        time: 100,
        x: 30,
        y: 40,
      },
      {
        orientation: {
          altitude: { kind: 'measured', value: Math.PI / 2 },
          azimuth: { kind: 'measured', value: 0 },
        },
        pressure: { kind: 'measured', value: 0.8 },
        time: 100,
        x: 40,
        y: 50,
      },
      {
        orientation: {
          altitude: { kind: 'unavailable' },
          azimuth: { kind: 'unavailable' },
        },
        pressure: { kind: 'unavailable' },
        time: 100,
        x: 50,
        y: 60,
      },
    ]);
    expect(result.stroke.points).toEqual(result.trace.points);
    const presentationPoints: Array<{
      readonly pressure: number;
      readonly time: number;
      readonly x: number;
      readonly y: number;
    }> = [];
    result.presentationDelta.stablePrefixDelta.forEachSample((sample) => {
      presentationPoints.push({
        pressure: (sample.flags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0.5 : sample.pressure,
        time: sample.time,
        x: sample.x,
        y: sample.y,
      });
    });
    expect(result.presentationDelta.mutableTail.length).toBe(0);
    expect(presentationPoints).toEqual(
      result.delta.stablePrefixDelta.map(({ pressure, time, x, y }) => ({
        pressure,
        time,
        x,
        y,
      })),
    );
  });

  it('produces equivalent legacy traces for matching Pointer and stylus Touch contacts', () => {
    const pointer = new PointerEventInkAdapter();
    const touch = new WebKitStylusTouchAdapter();
    const pointerPipeline = new InkCapturePipeline({ createId: () => 'pointer-stroke' });
    const touchPipeline = new InkCapturePipeline({ createId: () => 'touch-stroke' });
    const phases = ['down', 'move', 'up'] as const;
    const coordinates = [10, 20, 30];
    let pointerResult;
    let touchResult;

    for (const [index, phase] of phases.entries()) {
      const coordinate = coordinates[index] as number;
      const pointerBatch = pointer.createBatch(
        pointerEvent({
          altitudeAngle: Math.PI / 4,
          azimuthAngle: Math.PI / 3,
          clientX: coordinate,
          clientY: coordinate + 5,
          pressure: 0.6,
          timeStamp: index * 16,
        }),
        phase,
        context(),
      );
      const touchBatch = touch.createBatch(
        {
          changedTouches: [
            {
              altitudeAngle: Math.PI / 4,
              azimuthAngle: Math.PI / 3,
              clientX: coordinate,
              clientY: coordinate + 5,
              force: 0.6,
              identifier: 9,
              touchType: 'stylus',
            },
          ],
          timeStamp: index * 16,
        },
        phase,
        context(),
      );
      if (pointerBatch === null || touchBatch === null) throw new Error('Missing parity batch.');
      pointerResult = pointerPipeline.accept(pointerBatch);
      touchResult = touchPipeline.accept(touchBatch);
    }

    expect(pointerResult?.kind).toBe('completed');
    expect(touchResult?.kind).toBe('completed');
    if (pointerResult?.kind !== 'completed' || touchResult?.kind !== 'completed') return;
    expect(pointerResult.trace.points).toEqual(touchResult.trace.points);
    expect(pointerResult.trace.samples).toEqual(touchResult.trace.samples);
  });

  it('produces the same causal completed trace across event regrouping and monotonizes timestamps', () => {
    const adapter = new PointerEventInkAdapter();
    const samples = Array.from({ length: 100 }, (_value, index) =>
      pointerEvent({ clientX: index, clientY: Math.sin(index / 10), timeStamp: 100 - index }),
    );
    const groupedEvent = pointerEvent({
      clientX: 99,
      clientY: Math.sin(9.9),
      timeStamp: 1,
    });
    groupedEvent.getCoalescedEvents = () => samples;
    const grouped = new InkCapturePipeline({ createId: () => 'grouped' });
    const individual = new InkCapturePipeline({ createId: () => 'individual' });

    const groupedDown = adapter.createBatch(samples[0] as TestPointerEvent, 'down', context());
    const groupedMove = adapter.createBatch(groupedEvent, 'move', context());
    const groupedUp = adapter.createBatch(samples.at(-1) as TestPointerEvent, 'up', context());
    if (groupedDown === null || groupedMove === null || groupedUp === null)
      throw new Error('Missing batch.');
    grouped.accept(groupedDown);
    grouped.accept(groupedMove);
    const groupedResult = grouped.accept(groupedUp);

    const first = adapter.createBatch(samples[0] as TestPointerEvent, 'down', context());
    if (first === null) throw new Error('Missing batch.');
    individual.accept(first);
    for (const event of samples.slice(1, -1)) {
      const batch = adapter.createBatch(event, 'move', context());
      if (batch !== null) individual.accept(batch);
    }
    const last = adapter.createBatch(samples.at(-1) as TestPointerEvent, 'up', context());
    if (last === null) throw new Error('Missing batch.');
    const individualResult = individual.accept(last);

    expect(groupedResult.kind).toBe('completed');
    expect(individualResult.kind).toBe('completed');
    if (groupedResult.kind !== 'completed' || individualResult.kind !== 'completed') return;
    expect(groupedResult.stroke.points).toEqual(individualResult.stroke.points);
    expect(groupedResult.stroke.points.at(-1)).toMatchObject({ x: 99, y: 0 });
    expect(groupedResult.stroke.points.map(({ time }) => time)).toEqual(
      [...groupedResult.stroke.points.map(({ time }) => time)].sort((left, right) => left - right),
    );
  });

  it('keeps the down style snapshot, accepts a replacement frame epoch, and blocks double delivery', () => {
    const pointer = new PointerEventInkAdapter();
    const touch = new WebKitStylusTouchAdapter();
    const pipeline = new InkCapturePipeline({ createId: () => 'stroke-id' });
    const downContext = context();
    const movedContext: InkCaptureBatchContext = {
      ...context(),
      frame: createInkStageFrame({
        actualScale: 2,
        canvasClientRect: { height: 1_000, left: 0, top: 0, width: 704 },
        documentClientOrigin: { x: 0, y: 0 },
      }),
      frameEpoch: 4,
      style: { color: '#ff0000', tool: 'highlighter', width: 20 },
    };
    const down = pointer.createBatch(
      pointerEvent({ clientX: 20, clientY: 20 }),
      'down',
      downContext,
    );
    const duplicate = touch.createBatch(touchEvent('stylus'), 'down', downContext);
    const move = pointer.createBatch(
      pointerEvent({ clientX: 40, clientY: 50 }),
      'move',
      movedContext,
    );
    const up = pointer.createBatch(pointerEvent({ clientX: 60, clientY: 60 }), 'up', movedContext);
    if (down === null || duplicate === null || move === null || up === null)
      throw new Error('Missing batch.');

    expect(pipeline.accept(down).kind).toBe('active');
    expect(pipeline.accept(duplicate)).toEqual({ kind: 'ignored', reason: 'duplicate-adapter' });
    const moved = pipeline.accept(move);
    expect(moved).toMatchObject({ frameEpoch: 4, kind: 'active' });
    const result = pipeline.accept(up);

    expect(result).toMatchObject({
      delta: {
        mutableTail: [],
        stablePrefixDelta: [
          { x: 20, y: 25 },
          { x: 30, y: 30 },
        ],
      },
      kind: 'completed',
      stroke: { color: '#111111', id: 'stroke-id', tool: 'pen', width: 2 },
    });
    if (result.kind !== 'completed') return;
    expect(result.stroke.points).toMatchObject([
      { x: 20, y: 20 },
      { x: 20, y: 25 },
      { x: 30, y: 30 },
    ]);
  });

  it('rejects an oversized completed trace without blocking the next contact', () => {
    const adapter = new PointerEventInkAdapter();
    const pipeline = new InkCapturePipeline({ createId: () => 'too-large', maximumTracePoints: 2 });
    const down = adapter.createBatch(pointerEvent({ clientX: 0, clientY: 0 }), 'down', context());
    const move = adapter.createBatch(pointerEvent({ clientX: 20, clientY: 0 }), 'move', context());
    const up = adapter.createBatch(pointerEvent({ clientX: 40, clientY: 0 }), 'up', context());
    if (down === null || move === null || up === null) throw new Error('Missing batch.');
    pipeline.accept(down);
    pipeline.accept(move);

    const rejected = pipeline.accept(up);

    expect(rejected).toEqual({
      kind: 'rejected',
      reason: 'trace-too-large',
      strokeId: 'too-large',
    });
    expect(pipeline.accept(down).kind).toBe('active');
  });

  it('cancels ownership and accepts a clean contact after host replacement reset', () => {
    const adapter = new PointerEventInkAdapter();
    const pipeline = new InkCapturePipeline({ createId: () => 'stroke-id' });
    const down = adapter.createBatch(pointerEvent(), 'down', context());
    const cancel = adapter.createBatch(pointerEvent(), 'cancel', context());
    if (down === null || cancel === null) throw new Error('Missing batch.');

    expect(pipeline.accept(down).kind).toBe('active');
    expect(pipeline.accept(cancel)).toEqual({ kind: 'cancelled', strokeId: 'stroke-id' });
    expect(pipeline.accept(down).kind).toBe('active');
    pipeline.reset();
    expect(pipeline.accept(down).kind).toBe('active');
  });

  it('seals only the confirmed prefix before a forced Stage Frame epoch change', () => {
    const adapter = new PointerEventInkAdapter();
    const pipeline = new InkCapturePipeline({ createId: () => 'sealed-prefix' });
    const down = adapter.createBatch(
      pointerEvent({ clientX: 10, clientY: 20, timeStamp: 0 }),
      'down',
      context(),
    );
    const move = adapter.createBatch(
      pointerEvent({ clientX: 30, clientY: 40, timeStamp: 10 }),
      'move',
      context(),
    );
    if (down === null || move === null) throw new Error('Missing confirmed prefix batch.');
    pipeline.accept(down);
    pipeline.accept(move);

    const sealed = pipeline.sealActive();

    expect(sealed.kind).toBe('completed');
    if (sealed.kind !== 'completed') throw new Error('Expected a sealed legacy trace.');
    expect(sealed.stroke.points.at(-1)).toMatchObject({ x: 30, y: 40 });
  });
});

function context(): InkCaptureBatchContext {
  return {
    frame: createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 1_000, left: 0, top: 0, width: 704 },
      documentClientOrigin: { x: 0, y: 0 },
    }),
    frameEpoch: 3,
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
  getPredictedEvents?: () => readonly TestPointerEvent[];
  pointerId: number;
  pointerType: string;
  pressure: number;
  tiltX: number;
  tiltY: number;
  timeStamp: number;
}

function pointerEvent(overrides: Partial<TestPointerEvent> = {}): TestPointerEvent {
  return {
    altitudeAngle: Math.PI / 2,
    azimuthAngle: 0,
    clientX: 10,
    clientY: 20,
    getCoalescedEvents: () => [],
    pointerId: 7,
    pointerType: 'pen',
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    timeStamp: 5,
    ...overrides,
  };
}

interface TestTouch {
  altitudeAngle?: number;
  azimuthAngle?: number;
  clientX: number;
  clientY: number;
  force: number;
  identifier: number;
  touchType: 'direct' | 'stylus';
}

function touchEvent(
  touchType: TestTouch['touchType'],
  overrides: Partial<TestTouch> = {},
): { readonly changedTouches: readonly TestTouch[]; readonly timeStamp: number } {
  return {
    changedTouches: [
      {
        altitudeAngle: Math.PI / 2,
        azimuthAngle: 0,
        clientX: 10,
        clientY: 20,
        force: 0.5,
        identifier: 9,
        touchType,
        ...overrides,
      },
    ],
    timeStamp: 5,
  };
}
