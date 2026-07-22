const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PngImageDimensions {
  readonly height: number;
  readonly width: number;
}

/** Reads the fixed PNG signature and IHDR dimensions without decoding image pixels. */
export function readPngImageDimensions(bytes: Uint8Array): PngImageDimensions {
  if (
    bytes.byteLength < 33 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value) ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  ) {
    throw new Error('Snapshot capture did not produce a structurally valid PNG.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) {
    throw new Error('Snapshot capture PNG dimensions must be positive.');
  }
  return Object.freeze({ height, width });
}
