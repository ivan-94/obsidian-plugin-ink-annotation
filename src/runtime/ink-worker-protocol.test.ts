import { describe, expect, it } from 'vitest';

import {
  INK_WORKER_FRAME_HEADER_BYTES,
  InkWorkerFrameReceiver,
  decodeInkWorkerFrame,
  encodeInkWorkerFrame,
  validateInkWorkerFrameAck,
} from './ink-worker-protocol';

describe('Ink Worker presentation protocol', () => {
  it('round-trips presentation identity and Float64 XY payloads through a leased buffer', () => {
    const buffer = new ArrayBuffer(512);
    const stableXY = new Float64Array([10.25, 20.5, 30.75, 40.125]);
    const tailXY = new Float64Array([50.5, 60.25]);
    const provisionalXY = new Float64Array([70.75, 80.5, 90.125, 100.25]);

    const encoded = encodeInkWorkerFrame(buffer, {
      bufferId: 1,
      contactSequence: 7,
      frameEpoch: 11,
      generation: 13,
      leaseSequence: 17,
      sequence: 19,
      session: 23,
      stableStart: 5,
      stableXY,
      tailXY,
      provisionalXY,
    });
    const decoded = decodeInkWorkerFrame(encoded.buffer);

    expect(encoded.byteLength).toBe(
      INK_WORKER_FRAME_HEADER_BYTES + 10 * Float64Array.BYTES_PER_ELEMENT,
    );
    expect(encoded.bytes.buffer).toBe(buffer);
    expect(encoded.bytes.byteLength).toBe(encoded.byteLength);
    expect(decoded).toMatchObject({
      ok: true,
      frame: {
        bufferId: 1,
        byteLength: encoded.byteLength,
        contactSequence: 7,
        frameEpoch: 11,
        generation: 13,
        leaseSequence: 17,
        sequence: 19,
        session: 23,
        stableStart: 5,
      },
    });
    if (!decoded.ok) throw new Error('Expected a decoded Ink Worker frame.');
    expect([...decoded.frame.stableXY]).toEqual([...stableXY]);
    expect([...decoded.frame.tailXY]).toEqual([...tailXY]);
    expect([...decoded.frame.provisionalXY]).toEqual([...provisionalXY]);
  });

  it('copies all borrowed payload partitions synchronously during encoding', () => {
    const buffer = new ArrayBuffer(512);
    const stableXY = new Float64Array([1, 2]);
    const tailXY = new Float64Array([3, 4, 5, 6]);
    const provisionalXY = new Float64Array([7, 8, 9, 10]);

    encodeInkWorkerFrame(buffer, {
      bufferId: 0,
      contactSequence: 1,
      frameEpoch: 1,
      generation: 1,
      leaseSequence: 1,
      sequence: 1,
      session: 1,
      stableStart: 0,
      stableXY,
      tailXY,
      provisionalXY,
    });
    stableXY.fill(101);
    tailXY.fill(102);
    provisionalXY.fill(103);

    const decoded = decodeInkWorkerFrame(buffer);
    if (!decoded.ok) throw new Error('Expected a decoded Ink Worker frame.');
    expect([...decoded.frame.stableXY]).toEqual([1, 2]);
    expect([...decoded.frame.tailXY]).toEqual([3, 4, 5, 6]);
    expect([...decoded.frame.provisionalXY]).toEqual([7, 8, 9, 10]);
  });

  it('keeps provisional points out of the receiver stable-prefix watermark', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(
      receiver.accept(
        frameBuffer({
          provisionalXY: new Float64Array([50, 60, 70, 80]),
          tailXY: new Float64Array(0),
        }),
      ),
    ).toMatchObject({ ok: true, frame: { stableStart: 0 } });
    expect(
      receiver.accept(
        frameBuffer({
          sequence: 2,
          stableStart: 1,
          provisionalXY: new Float64Array([90, 100]),
          tailXY: new Float64Array(0),
        }),
      ),
    ).toMatchObject({ ok: true, frame: { stableStart: 1 } });
  });

  it('rejects a wrong session without consuming the expected sequence', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(frameBuffer({ session: 24 }))).toEqual({
      failure: 'wrong-session',
      ok: false,
    });
    expect(receiver.accept(frameBuffer({ session: 23 }))).toMatchObject({
      ok: true,
      frame: { sequence: 1 },
    });
  });

  it('rejects a frame owned by another contact', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(frameBuffer({ contactSequence: 8 }))).toEqual({
      failure: 'wrong-contact',
      ok: false,
    });
  });

  it('rejects a stale Stage Frame epoch', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(frameBuffer({ frameEpoch: 10 }))).toEqual({
      failure: 'wrong-frame',
      ok: false,
    });
  });

  it('rejects a duplicate packet sequence', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(frameBuffer())).toMatchObject({ ok: true });
    expect(receiver.accept(frameBuffer({ stableStart: 1 }))).toEqual({
      failure: 'duplicate-sequence',
      ok: false,
    });
  });

  it('rejects an out-of-order sequence without consuming the missing packet', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(frameBuffer({ sequence: 2 }))).toEqual({
      failure: 'out-of-order-sequence',
      ok: false,
    });
    expect(receiver.accept(frameBuffer({ sequence: 1 }))).toMatchObject({ ok: true });
  });

  it('rejects a stable-prefix gap without advancing sequence or stable ownership', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(frameBuffer())).toMatchObject({ ok: true });
    expect(receiver.accept(frameBuffer({ sequence: 2, stableStart: 2 }))).toEqual({
      failure: 'stable-gap',
      ok: false,
    });
    expect(receiver.accept(frameBuffer({ sequence: 2, stableStart: 1 }))).toMatchObject({
      ok: true,
      frame: { stableStart: 1 },
    });
  });

  it('allows repeated generations but rejects a generation regression', () => {
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(frameBuffer({ generation: 2 }))).toMatchObject({ ok: true });
    expect(
      receiver.accept(frameBuffer({ generation: 2, sequence: 2, stableStart: 1 })),
    ).toMatchObject({ ok: true });
    expect(receiver.accept(frameBuffer({ generation: 1, sequence: 3, stableStart: 2 }))).toEqual({
      failure: 'generation-regression',
      ok: false,
    });
  });

  it('refuses identifiers and counts that would silently wrap the Uint32 wire format', () => {
    const base: Parameters<typeof encodeInkWorkerFrame>[1] = {
      bufferId: 0,
      contactSequence: 1,
      frameEpoch: 1,
      generation: 1,
      leaseSequence: 1,
      sequence: 1,
      session: 1,
      stableStart: 0,
      stableXY: new Float64Array([1, 2]),
      tailXY: new Float64Array(0),
    };
    const invalid: Array<Partial<Parameters<typeof encodeInkWorkerFrame>[1]>> = [
      { bufferId: -1 },
      { bufferId: 3 },
      { contactSequence: 0 },
      { frameEpoch: 0 },
      { generation: 0 },
      { leaseSequence: 0 },
      { sequence: 0 },
      { session: 0 },
      { session: 0x1_0000_0000 },
      { stableStart: -1 },
      { stableStart: 0x1_0000_0000 },
      { stableStart: 0xffff_ffff },
      { stableXY: new Float64Array(0), tailXY: new Float64Array(0) },
      { provisionalXY: new Float64Array([1]) },
    ];

    for (const override of invalid) {
      expect(() => encodeInkWorkerFrame(new ArrayBuffer(256), { ...base, ...override })).toThrow(
        RangeError,
      );
    }
  });

  it('rejects more than 16 provisional points at the encoder boundary', () => {
    const base: Parameters<typeof encodeInkWorkerFrame>[1] = {
      bufferId: 0,
      contactSequence: 1,
      frameEpoch: 1,
      generation: 1,
      leaseSequence: 1,
      sequence: 1,
      session: 1,
      stableStart: 0,
      stableXY: new Float64Array([1, 2]),
      tailXY: new Float64Array(0),
    };
    const boundary = encodeInkWorkerFrame(new ArrayBuffer(1024), {
      ...base,
      provisionalXY: new Float64Array(16 * 2),
    });
    const decoded = decodeInkWorkerFrame(boundary.buffer);
    if (!decoded.ok) throw new Error('Expected the 16-point prediction boundary to decode.');
    expect(decoded.frame.provisionalXY).toHaveLength(16 * 2);

    expect(() =>
      encodeInkWorkerFrame(new ArrayBuffer(1024), {
        ...base,
        provisionalXY: new Float64Array(17 * 2),
      }),
    ).toThrow(/at most 16 provisional points/);
  });

  it('accepts a returned buffer only for its exact in-flight Ack identity', () => {
    expect(
      validateInkWorkerFrameAck(frameBuffer(), {
        bufferId: 0,
        contactSequence: 7,
        frameEpoch: 11,
        generation: 1,
        leaseSequence: 1,
        sequence: 1,
        session: 23,
      }),
    ).toMatchObject({
      ok: true,
      frame: {
        bufferId: 0,
        generation: 1,
        leaseSequence: 1,
        sequence: 1,
      },
    });
  });

  it('fails closed when any returned Ack identity differs from the in-flight lease', () => {
    const expected = {
      bufferId: 0,
      contactSequence: 7,
      frameEpoch: 11,
      generation: 1,
      leaseSequence: 1,
      sequence: 1,
      session: 23,
    };
    const cases: Array<readonly [Partial<Parameters<typeof encodeInkWorkerFrame>[1]>, string]> = [
      [{ bufferId: 1 }, 'wrong-buffer'],
      [{ leaseSequence: 2 }, 'wrong-lease'],
      [{ session: 24 }, 'wrong-session'],
      [{ contactSequence: 8 }, 'wrong-contact'],
      [{ frameEpoch: 12 }, 'wrong-frame'],
      [{ sequence: 2 }, 'wrong-sequence'],
      [{ generation: 2 }, 'wrong-generation'],
    ];

    for (const [override, failure] of cases) {
      expect(validateInkWorkerFrameAck(frameBuffer(override), expected)).toEqual({
        failure,
        ok: false,
      });
    }
  });

  it('rejects a truncated payload without advancing receiver state', () => {
    const full = frameBuffer();
    const decoded = decodeInkWorkerFrame(full);
    if (!decoded.ok) throw new Error('Expected a valid frame fixture.');
    const truncated = full.slice(0, decoded.frame.byteLength - Float64Array.BYTES_PER_ELEMENT);
    const receiver = new InkWorkerFrameReceiver({
      contactSequence: 7,
      frameEpoch: 11,
      session: 23,
    });

    expect(receiver.accept(truncated)).toEqual({ failure: 'bad-length', ok: false });
    expect(receiver.accept(frameBuffer())).toMatchObject({ ok: true, frame: { sequence: 1 } });
  });

  it('fails closed when the provisional count disagrees with the encoded byte length', () => {
    const malformed = frameBuffer({ provisionalXY: new Float64Array([50, 60]) });
    new DataView(malformed).setUint32(60, 2, true);

    expect(decodeInkWorkerFrame(malformed)).toEqual({ failure: 'bad-length', ok: false });
  });

  it('fails closed when a wire frame claims more than 16 provisional points', () => {
    const malformed = frameBuffer();
    new DataView(malformed).setUint32(60, 17, true);

    expect(decodeInkWorkerFrame(malformed)).toEqual({ failure: 'bad-header', ok: false });
  });

  it('rejects malformed wire identities even when bytes bypass the encoder', () => {
    const corruptions: Array<(header: DataView) => void> = [
      (header) => header.setUint32(16, 0, true),
      (header) => header.setUint32(20, 0, true),
      (header) => header.setUint32(24, 0, true),
      (header) => header.setUint32(28, 0, true),
      (header) => header.setUint32(32, 0, true),
      (header) => header.setUint32(48, 3, true),
      (header) => header.setUint32(52, 0, true),
      (header) => header.setUint32(56, 1, true),
      (header) => {
        header.setUint32(40, 0, true);
        header.setUint32(44, 0, true);
      },
    ];

    for (const corrupt of corruptions) {
      const malformed = frameBuffer();
      corrupt(new DataView(malformed));
      expect(decodeInkWorkerFrame(malformed)).toEqual({ failure: 'bad-header', ok: false });
    }
  });

  it('requires a valid receiver ownership fence before accepting any bytes', () => {
    for (const invalid of [
      { contactSequence: 0, frameEpoch: 1, session: 1 },
      { contactSequence: 1, frameEpoch: 0, session: 1 },
      { contactSequence: 1, frameEpoch: 1, session: 0 },
    ]) {
      expect(() => new InkWorkerFrameReceiver(invalid)).toThrow(RangeError);
    }
  });
});

function frameBuffer(
  override: Partial<Parameters<typeof encodeInkWorkerFrame>[1]> = {},
): ArrayBuffer {
  const buffer = new ArrayBuffer(256);
  encodeInkWorkerFrame(buffer, {
    bufferId: 0,
    contactSequence: 7,
    frameEpoch: 11,
    generation: 1,
    leaseSequence: 1,
    sequence: 1,
    session: 23,
    stableStart: 0,
    stableXY: new Float64Array([10, 20]),
    tailXY: new Float64Array([30, 40]),
    ...override,
  });
  return buffer;
}
