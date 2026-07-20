export const INK_TRANSFER_BUFFER_SLOT_COUNT = 3;
const MAX_TRANSFER_BUFFER_BYTE_LENGTH = 0xffff_ffff;

export interface InkTransferBufferLease {
  readonly buffer: ArrayBuffer;
  readonly bufferId: number;
  readonly leaseSequence: number;
  readonly minimumByteLength: number;
}

export type InkTransferBufferPoolResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure:
        | 'invalid-buffer-id'
        | 'not-in-flight'
        | 'returned-buffer-too-large'
        | 'returned-buffer-too-small'
        | 'stale-lease';
    };

interface InkTransferBufferSlot {
  buffer: ArrayBuffer | null;
  capacityByteLength: number;
  inFlight: boolean;
  leaseSequence: number;
  minimumByteLength: number;
}

export interface InkTransferBufferPoolStats {
  readonly abandonedLeaseCount: number;
  readonly availableSlotCount: number;
  readonly inFlightSlotCount: number;
  readonly pooledByteLength: number;
  readonly slotCount: 2 | 3;
}

export class InkTransferBufferPool {
  private abandonedLeaseCount = 0;
  private readonly initialByteLength: number;
  private readonly maximumByteLength: number;
  private nextLeaseSequence = 1;
  private readonly slotCount: 2 | 3;
  private readonly slots: InkTransferBufferSlot[];

  constructor(input: {
    readonly initialByteLength: number;
    readonly maximumByteLength: number;
    readonly slotCount?: 2 | 3;
  }) {
    assertPositiveInteger(input.initialByteLength, 'initialByteLength');
    assertPositiveInteger(input.maximumByteLength, 'maximumByteLength');
    if (input.maximumByteLength > MAX_TRANSFER_BUFFER_BYTE_LENGTH) {
      throw new RangeError('Ink transfer buffers must fit the Uint32 Worker wire format.');
    }
    if (input.maximumByteLength < input.initialByteLength) {
      throw new RangeError('Ink transfer buffer maximum must cover its initial capacity.');
    }
    if (input.slotCount !== undefined && input.slotCount !== 2 && input.slotCount !== 3) {
      throw new RangeError('Ink transfer buffer pool supports only two or three slots.');
    }
    this.initialByteLength = input.initialByteLength;
    this.maximumByteLength = input.maximumByteLength;
    this.slotCount = input.slotCount ?? INK_TRANSFER_BUFFER_SLOT_COUNT;
    this.slots = Array.from({ length: this.slotCount }, () => ({
      buffer: null,
      capacityByteLength: 0,
      inFlight: false,
      leaseSequence: 0,
      minimumByteLength: 0,
    }));
  }

  lease(minimumByteLength: number): InkTransferBufferLease | null {
    assertPositiveInteger(minimumByteLength, 'minimumByteLength');
    if (minimumByteLength > this.maximumByteLength) return null;
    const bufferId = this.slots.findIndex((slot) => !slot.inFlight);
    if (bufferId < 0) return null;
    const slot = this.slots[bufferId];
    if (slot === undefined) return null;
    if (slot.buffer === null || slot.buffer.byteLength < minimumByteLength) {
      const capacityByteLength = geometricCapacity(
        slot.capacityByteLength || this.initialByteLength,
        minimumByteLength,
        this.maximumByteLength,
      );
      slot.buffer = new ArrayBuffer(capacityByteLength);
      slot.capacityByteLength = capacityByteLength;
    }
    slot.inFlight = true;
    slot.leaseSequence = this.nextLeaseSequence;
    slot.minimumByteLength = minimumByteLength;
    this.nextLeaseSequence += 1;
    return Object.freeze({
      buffer: slot.buffer,
      bufferId,
      leaseSequence: slot.leaseSequence,
      minimumByteLength,
    });
  }

  returnLease(input: {
    readonly buffer: ArrayBuffer;
    readonly bufferId: number;
    readonly leaseSequence: number;
  }): InkTransferBufferPoolResult {
    const slot = this.slots[input.bufferId];
    if (slot === undefined) return failed('invalid-buffer-id');
    if (!slot.inFlight) return failed('not-in-flight');
    if (slot.leaseSequence !== input.leaseSequence) return failed('stale-lease');
    if (input.buffer.byteLength < slot.minimumByteLength) {
      return failed('returned-buffer-too-small');
    }
    if (input.buffer.byteLength > this.maximumByteLength) {
      return failed('returned-buffer-too-large');
    }
    slot.buffer = input.buffer;
    slot.capacityByteLength = input.buffer.byteLength;
    slot.inFlight = false;
    slot.minimumByteLength = 0;
    return SUCCESS;
  }

  abandonLease(input: {
    readonly bufferId: number;
    readonly leaseSequence: number;
  }): InkTransferBufferPoolResult {
    const slot = this.slots[input.bufferId];
    if (slot === undefined) return failed('invalid-buffer-id');
    if (!slot.inFlight) return failed('not-in-flight');
    if (slot.leaseSequence !== input.leaseSequence) return failed('stale-lease');
    slot.buffer = null;
    slot.capacityByteLength = 0;
    slot.inFlight = false;
    slot.minimumByteLength = 0;
    this.abandonedLeaseCount += 1;
    return SUCCESS;
  }

  abandonAll(): number {
    let abandoned = 0;
    for (const slot of this.slots) {
      if (!slot.inFlight) continue;
      slot.buffer = null;
      slot.capacityByteLength = 0;
      slot.inFlight = false;
      slot.minimumByteLength = 0;
      abandoned += 1;
    }
    this.abandonedLeaseCount += abandoned;
    return abandoned;
  }

  stats(): InkTransferBufferPoolStats {
    const inFlightSlotCount = this.slots.filter((slot) => slot.inFlight).length;
    return Object.freeze({
      abandonedLeaseCount: this.abandonedLeaseCount,
      availableSlotCount: this.slotCount - inFlightSlotCount,
      inFlightSlotCount,
      pooledByteLength: this.slots.reduce((total, slot) => total + slot.capacityByteLength, 0),
      slotCount: this.slotCount,
    });
  }
}

const SUCCESS = Object.freeze({ ok: true } as const);

function failed(
  failure: Extract<InkTransferBufferPoolResult, { readonly ok: false }>['failure'],
): InkTransferBufferPoolResult {
  return Object.freeze({ failure, ok: false });
}

function geometricCapacity(current: number, minimum: number, maximum: number): number {
  let capacity = current;
  while (capacity < minimum && capacity < maximum) capacity = Math.min(maximum, capacity * 2);
  return capacity;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Ink transfer buffer ${name} must be a positive safe integer.`);
  }
}
