import { describe, expect, it } from 'vitest';

import { INK_TRANSFER_BUFFER_SLOT_COUNT, InkTransferBufferPool } from './ink-transfer-buffer-pool';

describe('InkTransferBufferPool', () => {
  it('leases at most three buffers and applies backpressure instead of allocating a fourth', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 512,
    });

    const leases = Array.from({ length: INK_TRANSFER_BUFFER_SLOT_COUNT }, () => pool.lease(64));

    expect(leases.map((lease) => lease?.bufferId)).toEqual([0, 1, 2]);
    expect(leases.every((lease) => lease?.buffer.byteLength === 64)).toBe(true);
    expect(pool.lease(64)).toBeNull();
  });

  it('reclaims a transferred buffer only through its exact lease identity', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 512,
    });
    const lease = pool.lease(96);
    if (lease === null) throw new Error('Expected an Ink transfer buffer lease.');
    const returned = structuredClone(lease.buffer, { transfer: [lease.buffer] });
    expect(lease.buffer.byteLength).toBe(0);

    expect(
      pool.returnLease({
        buffer: returned,
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence,
      }),
    ).toEqual({ ok: true });

    const reused = pool.lease(96);
    expect(reused?.bufferId).toBe(lease.bufferId);
    expect(reused?.buffer).toBe(returned);
    expect(reused?.leaseSequence).toBeGreaterThan(lease.leaseSequence);
  });

  it('fails closed for wrong, stale, and duplicate returns without releasing the lease', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 512,
    });
    const lease = pool.lease(64);
    if (lease === null) throw new Error('Expected an Ink transfer buffer lease.');
    const returned = structuredClone(lease.buffer, { transfer: [lease.buffer] });

    expect(
      pool.returnLease({ buffer: returned, bufferId: 3, leaseSequence: lease.leaseSequence }),
    ).toEqual({ failure: 'invalid-buffer-id', ok: false });
    expect(
      pool.returnLease({
        buffer: returned,
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence + 1,
      }),
    ).toEqual({ failure: 'stale-lease', ok: false });
    expect(
      pool.returnLease({
        buffer: returned,
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence,
      }),
    ).toEqual({ ok: true });
    expect(
      pool.returnLease({
        buffer: returned,
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence,
      }),
    ).toEqual({ failure: 'not-in-flight', ok: false });
  });

  it('does not reclaim a returned buffer shorter than the lease requirement', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 512,
    });
    const lease = pool.lease(128);
    if (lease === null) throw new Error('Expected an Ink transfer buffer lease.');

    expect(
      pool.returnLease({
        buffer: new ArrayBuffer(64),
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence,
      }),
    ).toEqual({ failure: 'returned-buffer-too-small', ok: false });
    expect(pool.lease(64)?.bufferId).toBe(1);
  });

  it('abandons a detached lease and rejects its late return after the slot is recycled', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 512,
    });
    const lease = pool.lease(64);
    if (lease === null) throw new Error('Expected an Ink transfer buffer lease.');
    const lateBuffer = structuredClone(lease.buffer, { transfer: [lease.buffer] });

    expect(
      pool.abandonLease({
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence,
      }),
    ).toEqual({ ok: true });
    const replacement = pool.lease(64);
    expect(replacement?.bufferId).toBe(lease.bufferId);
    expect(replacement?.leaseSequence).toBeGreaterThan(lease.leaseSequence);
    expect(
      pool.returnLease({
        buffer: lateBuffer,
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence,
      }),
    ).toEqual({ failure: 'stale-lease', ok: false });
  });

  it('supports a two-slot bake-off configuration while keeping three as the default hard cap', () => {
    const twoSlotPool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 512,
      slotCount: 2,
    });

    expect([twoSlotPool.lease(64)?.bufferId, twoSlotPool.lease(64)?.bufferId]).toEqual([0, 1]);
    expect(twoSlotPool.lease(64)).toBeNull();
    expect(twoSlotPool.stats()).toMatchObject({ inFlightSlotCount: 2, slotCount: 2 });
  });

  it('grows an available slot geometrically without exceeding the configured maximum', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 200,
    });

    const first = pool.lease(65);
    expect(first?.buffer.byteLength).toBe(128);
    if (first === null) throw new Error('Expected an Ink transfer buffer lease.');
    expect(
      pool.returnLease({
        buffer: first.buffer,
        bufferId: first.bufferId,
        leaseSequence: first.leaseSequence,
      }),
    ).toEqual({ ok: true });
    const grown = pool.lease(150);
    expect(grown?.buffer.byteLength).toBe(200);
    expect(pool.lease(201)).toBeNull();
  });

  it('rejects non-positive, fractional, and inverted byte-length contracts', () => {
    expect(
      () => new InkTransferBufferPool({ initialByteLength: 0, maximumByteLength: 64 }),
    ).toThrow(RangeError);
    expect(
      () => new InkTransferBufferPool({ initialByteLength: 64.5, maximumByteLength: 128 }),
    ).toThrow(RangeError);
    expect(
      () => new InkTransferBufferPool({ initialByteLength: 128, maximumByteLength: 64 }),
    ).toThrow(RangeError);
    expect(
      () =>
        new InkTransferBufferPool({
          initialByteLength: 64,
          maximumByteLength: 0x1_0000_0000,
        }),
    ).toThrow(RangeError);

    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 128,
    });
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(() => pool.lease(invalid)).toThrow(RangeError);
    }
  });

  it('abandons every detached in-flight slot after a Worker crash', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 128,
    });
    const leases = Array.from({ length: 3 }, () => pool.lease(64));
    for (const lease of leases) {
      if (lease === null) throw new Error('Expected three Ink transfer buffer leases.');
      structuredClone(lease.buffer, { transfer: [lease.buffer] });
    }

    expect(pool.stats().pooledByteLength).toBe(3 * 64);
    expect(pool.abandonAll()).toBe(3);
    expect(pool.stats()).toEqual({
      abandonedLeaseCount: 3,
      availableSlotCount: 3,
      inFlightSlotCount: 0,
      pooledByteLength: 0,
      slotCount: 3,
    });
    expect(pool.abandonAll()).toBe(0);
    expect(pool.lease(64)?.buffer.byteLength).toBe(64);
  });

  it('never admits a returned buffer beyond the configured memory cap', () => {
    const pool = new InkTransferBufferPool({
      initialByteLength: 64,
      maximumByteLength: 128,
    });
    const lease = pool.lease(64);
    if (lease === null) throw new Error('Expected an Ink transfer buffer lease.');

    expect(
      pool.returnLease({
        buffer: new ArrayBuffer(256),
        bufferId: lease.bufferId,
        leaseSequence: lease.leaseSequence,
      }),
    ).toEqual({ failure: 'returned-buffer-too-large', ok: false });
    expect(pool.stats().inFlightSlotCount).toBe(1);
  });
});
