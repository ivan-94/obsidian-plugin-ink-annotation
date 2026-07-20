const LITTLE_ENDIAN = true;
const INK_WORKER_FRAME_MAGIC = 0x494e4b57;
const INK_WORKER_FRAME_VERSION = 1;
const INK_WORKER_FRAME_KIND = 1;
const MAX_UINT32 = 0xffff_ffff;

export const INK_WORKER_FRAME_HEADER_BYTES = 64;
export const INK_WORKER_MAX_PROVISIONAL_POINTS = 16;

const OFFSET = Object.freeze({
  magic: 0,
  version: 4,
  kind: 6,
  headerBytes: 8,
  byteLength: 12,
  session: 16,
  contactSequence: 20,
  frameEpoch: 24,
  generation: 28,
  sequence: 32,
  stableStart: 36,
  stableCount: 40,
  tailCount: 44,
  bufferId: 48,
  leaseSequence: 52,
  flags: 56,
  provisionalCount: 60,
});

export interface InkWorkerFrameInput {
  readonly bufferId: number;
  readonly contactSequence: number;
  readonly frameEpoch: number;
  readonly generation: number;
  readonly leaseSequence: number;
  readonly sequence: number;
  readonly session: number;
  readonly stableStart: number;
  /** Newly confirmed stable-prefix points. */
  readonly stableXY: Float64Array;
  /** Confirmed mutable-tail points. Predictions must never be merged into this partition. */
  readonly tailXY: Float64Array;
  /** Borrowed prediction-only points copied synchronously by the encoder. */
  readonly provisionalXY?: Float64Array;
}

export interface InkWorkerEncodedFrame {
  readonly buffer: ArrayBuffer;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

export interface InkWorkerDecodedFrame {
  readonly bufferId: number;
  readonly byteLength: number;
  readonly contactSequence: number;
  readonly frameEpoch: number;
  readonly generation: number;
  readonly leaseSequence: number;
  readonly sequence: number;
  readonly session: number;
  readonly stableStart: number;
  /** Newly confirmed stable-prefix points. */
  readonly stableXY: Float64Array;
  /** Confirmed mutable-tail points. */
  readonly tailXY: Float64Array;
  /** Prediction-only points that never advance the stable-prefix watermark. */
  readonly provisionalXY: Float64Array;
}

export interface InkWorkerFrameAckIdentity {
  readonly bufferId: number;
  readonly contactSequence: number;
  readonly frameEpoch: number;
  readonly generation: number;
  readonly leaseSequence: number;
  readonly sequence: number;
  readonly session: number;
}

export type InkWorkerFrameDecodeResult =
  | { readonly ok: true; readonly frame: InkWorkerDecodedFrame }
  | {
      readonly ok: false;
      readonly failure:
        | 'bad-header'
        | 'bad-length'
        | 'duplicate-sequence'
        | 'generation-regression'
        | 'out-of-order-sequence'
        | 'stable-gap'
        | 'wrong-buffer'
        | 'wrong-contact'
        | 'wrong-frame'
        | 'wrong-generation'
        | 'wrong-lease'
        | 'wrong-sequence'
        | 'wrong-session';
    };

export class InkWorkerFrameReceiver {
  private readonly contactSequence: number;
  private readonly frameEpoch: number;
  private lastGeneration = 0;
  private lastSequence = 0;
  private readonly session: number;
  private stablePointCount = 0;

  constructor(input: {
    readonly contactSequence: number;
    readonly frameEpoch: number;
    readonly session: number;
  }) {
    assertPositiveUint32(input.contactSequence, 'contactSequence');
    assertPositiveUint32(input.frameEpoch, 'frameEpoch');
    assertPositiveUint32(input.session, 'session');
    this.contactSequence = input.contactSequence;
    this.frameEpoch = input.frameEpoch;
    this.session = input.session;
  }

  accept(buffer: ArrayBuffer): InkWorkerFrameDecodeResult {
    const decoded = decodeInkWorkerFrame(buffer);
    if (!decoded.ok) return decoded;
    if (decoded.frame.session !== this.session) return failure('wrong-session');
    if (decoded.frame.contactSequence !== this.contactSequence) return failure('wrong-contact');
    if (decoded.frame.frameEpoch !== this.frameEpoch) return failure('wrong-frame');
    if (decoded.frame.sequence === this.lastSequence) return failure('duplicate-sequence');
    if (decoded.frame.sequence !== this.lastSequence + 1) {
      return failure('out-of-order-sequence');
    }
    if (decoded.frame.generation < this.lastGeneration) {
      return failure('generation-regression');
    }
    if (decoded.frame.stableStart !== this.stablePointCount) return failure('stable-gap');
    this.lastGeneration = decoded.frame.generation;
    this.lastSequence = decoded.frame.sequence;
    this.stablePointCount += decoded.frame.stableXY.length / 2;
    return decoded;
  }
}

export function encodeInkWorkerFrame(
  buffer: ArrayBuffer,
  input: InkWorkerFrameInput,
): InkWorkerEncodedFrame {
  assertBufferId(input.bufferId);
  assertPositiveUint32(input.contactSequence, 'contactSequence');
  assertPositiveUint32(input.frameEpoch, 'frameEpoch');
  assertPositiveUint32(input.generation, 'generation');
  assertPositiveUint32(input.leaseSequence, 'leaseSequence');
  assertPositiveUint32(input.sequence, 'sequence');
  assertPositiveUint32(input.session, 'session');
  assertNonNegativeUint32(input.stableStart, 'stableStart');
  const provisionalXY = input.provisionalXY ?? EMPTY_XY;
  if (
    input.stableXY.length % 2 !== 0 ||
    input.tailXY.length % 2 !== 0 ||
    provisionalXY.length % 2 !== 0
  ) {
    throw new RangeError('Ink Worker XY payloads must contain complete x/y pairs.');
  }
  const stableCount = input.stableXY.length / 2;
  const tailCount = input.tailXY.length / 2;
  const provisionalCount = provisionalXY.length / 2;
  if (stableCount + tailCount === 0) {
    throw new RangeError(
      'Ink Worker presentation frames must contain at least one confirmed point.',
    );
  }
  if (provisionalCount > INK_WORKER_MAX_PROVISIONAL_POINTS) {
    throw new RangeError(
      `Ink Worker presentation frames may contain at most ${INK_WORKER_MAX_PROVISIONAL_POINTS} provisional points.`,
    );
  }
  assertNonNegativeUint32(stableCount, 'stableCount');
  assertNonNegativeUint32(tailCount, 'tailCount');
  assertNonNegativeUint32(provisionalCount, 'provisionalCount');
  if (input.stableStart + stableCount > MAX_UINT32) {
    throw new RangeError('Ink Worker stable prefix must fit the Uint32 wire format.');
  }
  const byteLength =
    INK_WORKER_FRAME_HEADER_BYTES +
    (input.stableXY.length + input.tailXY.length + provisionalXY.length) *
      Float64Array.BYTES_PER_ELEMENT;
  assertPositiveUint32(byteLength, 'byteLength');
  if (buffer.byteLength < byteLength) {
    throw new RangeError('Ink Worker buffer is too small for the presentation frame.');
  }

  const header = new DataView(buffer, 0, INK_WORKER_FRAME_HEADER_BYTES);
  header.setUint32(OFFSET.magic, INK_WORKER_FRAME_MAGIC, LITTLE_ENDIAN);
  header.setUint16(OFFSET.version, INK_WORKER_FRAME_VERSION, LITTLE_ENDIAN);
  header.setUint16(OFFSET.kind, INK_WORKER_FRAME_KIND, LITTLE_ENDIAN);
  header.setUint32(OFFSET.headerBytes, INK_WORKER_FRAME_HEADER_BYTES, LITTLE_ENDIAN);
  header.setUint32(OFFSET.byteLength, byteLength, LITTLE_ENDIAN);
  header.setUint32(OFFSET.session, input.session, LITTLE_ENDIAN);
  header.setUint32(OFFSET.contactSequence, input.contactSequence, LITTLE_ENDIAN);
  header.setUint32(OFFSET.frameEpoch, input.frameEpoch, LITTLE_ENDIAN);
  header.setUint32(OFFSET.generation, input.generation, LITTLE_ENDIAN);
  header.setUint32(OFFSET.sequence, input.sequence, LITTLE_ENDIAN);
  header.setUint32(OFFSET.stableStart, input.stableStart, LITTLE_ENDIAN);
  header.setUint32(OFFSET.stableCount, stableCount, LITTLE_ENDIAN);
  header.setUint32(OFFSET.tailCount, tailCount, LITTLE_ENDIAN);
  header.setUint32(OFFSET.bufferId, input.bufferId, LITTLE_ENDIAN);
  header.setUint32(OFFSET.leaseSequence, input.leaseSequence, LITTLE_ENDIAN);
  header.setUint32(OFFSET.flags, 0, LITTLE_ENDIAN);
  header.setUint32(OFFSET.provisionalCount, provisionalCount, LITTLE_ENDIAN);

  const payload = new Float64Array(
    buffer,
    INK_WORKER_FRAME_HEADER_BYTES,
    input.stableXY.length + input.tailXY.length + provisionalXY.length,
  );
  payload.set(input.stableXY);
  payload.set(input.tailXY, input.stableXY.length);
  payload.set(provisionalXY, input.stableXY.length + input.tailXY.length);
  return Object.freeze({ buffer, byteLength, bytes: new Uint8Array(buffer, 0, byteLength) });
}

export function decodeInkWorkerFrame(buffer: ArrayBuffer): InkWorkerFrameDecodeResult {
  if (buffer.byteLength < INK_WORKER_FRAME_HEADER_BYTES) return failure('bad-length');
  const header = new DataView(buffer, 0, INK_WORKER_FRAME_HEADER_BYTES);
  if (
    header.getUint32(OFFSET.magic, LITTLE_ENDIAN) !== INK_WORKER_FRAME_MAGIC ||
    header.getUint16(OFFSET.version, LITTLE_ENDIAN) !== INK_WORKER_FRAME_VERSION ||
    header.getUint16(OFFSET.kind, LITTLE_ENDIAN) !== INK_WORKER_FRAME_KIND ||
    header.getUint32(OFFSET.headerBytes, LITTLE_ENDIAN) !== INK_WORKER_FRAME_HEADER_BYTES
  ) {
    return failure('bad-header');
  }
  const byteLength = header.getUint32(OFFSET.byteLength, LITTLE_ENDIAN);
  const session = header.getUint32(OFFSET.session, LITTLE_ENDIAN);
  const contactSequence = header.getUint32(OFFSET.contactSequence, LITTLE_ENDIAN);
  const frameEpoch = header.getUint32(OFFSET.frameEpoch, LITTLE_ENDIAN);
  const generation = header.getUint32(OFFSET.generation, LITTLE_ENDIAN);
  const sequence = header.getUint32(OFFSET.sequence, LITTLE_ENDIAN);
  const stableStart = header.getUint32(OFFSET.stableStart, LITTLE_ENDIAN);
  const stableCount = header.getUint32(OFFSET.stableCount, LITTLE_ENDIAN);
  const tailCount = header.getUint32(OFFSET.tailCount, LITTLE_ENDIAN);
  const bufferId = header.getUint32(OFFSET.bufferId, LITTLE_ENDIAN);
  const leaseSequence = header.getUint32(OFFSET.leaseSequence, LITTLE_ENDIAN);
  const provisionalCount = header.getUint32(OFFSET.provisionalCount, LITTLE_ENDIAN);
  if (
    session === 0 ||
    contactSequence === 0 ||
    frameEpoch === 0 ||
    generation === 0 ||
    sequence === 0 ||
    leaseSequence === 0 ||
    bufferId >= 3 ||
    stableCount + tailCount === 0 ||
    provisionalCount > INK_WORKER_MAX_PROVISIONAL_POINTS ||
    stableStart + stableCount > MAX_UINT32 ||
    header.getUint32(OFFSET.flags, LITTLE_ENDIAN) !== 0
  ) {
    return failure('bad-header');
  }
  const expectedByteLength =
    INK_WORKER_FRAME_HEADER_BYTES +
    (stableCount + tailCount + provisionalCount) * 2 * Float64Array.BYTES_PER_ELEMENT;
  if (byteLength !== expectedByteLength || byteLength > buffer.byteLength) {
    return failure('bad-length');
  }
  const stableValueCount = stableCount * 2;
  const tailValueCount = tailCount * 2;
  const provisionalValueCount = provisionalCount * 2;
  const tailOffset =
    INK_WORKER_FRAME_HEADER_BYTES + stableValueCount * Float64Array.BYTES_PER_ELEMENT;
  const provisionalOffset = tailOffset + tailValueCount * Float64Array.BYTES_PER_ELEMENT;
  return {
    frame: Object.freeze({
      bufferId,
      byteLength,
      contactSequence,
      frameEpoch,
      generation,
      leaseSequence,
      sequence,
      session,
      stableStart,
      stableXY: new Float64Array(buffer, INK_WORKER_FRAME_HEADER_BYTES, stableValueCount),
      tailXY: new Float64Array(buffer, tailOffset, tailValueCount),
      provisionalXY: new Float64Array(buffer, provisionalOffset, provisionalValueCount),
    }),
    ok: true,
  };
}

const EMPTY_XY = new Float64Array(0);

export function validateInkWorkerFrameAck(
  buffer: ArrayBuffer,
  expected: InkWorkerFrameAckIdentity,
): InkWorkerFrameDecodeResult {
  const decoded = decodeInkWorkerFrame(buffer);
  if (!decoded.ok) return decoded;
  if (decoded.frame.bufferId !== expected.bufferId) return failure('wrong-buffer');
  if (decoded.frame.leaseSequence !== expected.leaseSequence) return failure('wrong-lease');
  if (decoded.frame.session !== expected.session) return failure('wrong-session');
  if (decoded.frame.contactSequence !== expected.contactSequence) return failure('wrong-contact');
  if (decoded.frame.frameEpoch !== expected.frameEpoch) return failure('wrong-frame');
  if (decoded.frame.sequence !== expected.sequence) return failure('wrong-sequence');
  if (decoded.frame.generation !== expected.generation) return failure('wrong-generation');
  return decoded;
}

function failure(
  category: Extract<InkWorkerFrameDecodeResult, { readonly ok: false }>['failure'],
): InkWorkerFrameDecodeResult {
  return Object.freeze({ failure: category, ok: false });
}

function assertBufferId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 3) {
    throw new RangeError('Ink Worker bufferId must address one of the three transferable slots.');
  }
}

function assertNonNegativeUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new RangeError(`Ink Worker ${name} must be an unsigned 32-bit integer.`);
  }
}

function assertPositiveUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_UINT32) {
    throw new RangeError(`Ink Worker ${name} must be a positive unsigned 32-bit integer.`);
  }
}
