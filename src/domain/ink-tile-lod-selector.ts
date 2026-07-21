export class InkTileLodSelector {
  private readonly hysteresisRatio: number;
  private readonly maximumLod: number;
  private readonly minimumLod: number;

  constructor(input: {
    readonly hysteresisRatio: number;
    readonly maximumLod: number;
    readonly minimumLod: number;
  }) {
    if (
      !Number.isFinite(input.hysteresisRatio) ||
      input.hysteresisRatio < 0 ||
      input.hysteresisRatio >= 1
    ) {
      throw new Error('Ink tile LOD hysteresis ratio must be finite and in [0, 1).');
    }
    if (
      !Number.isSafeInteger(input.minimumLod) ||
      !Number.isSafeInteger(input.maximumLod) ||
      input.minimumLod > input.maximumLod
    ) {
      throw new Error('Ink tile LOD bounds must be ordered safe integers.');
    }
    this.hysteresisRatio = input.hysteresisRatio;
    this.maximumLod = input.maximumLod;
    this.minimumLod = input.minimumLod;
  }

  select(effectivePixelsPerLogicalUnit: number, retainedLod?: number): number {
    if (!Number.isFinite(effectivePixelsPerLogicalUnit) || effectivePixelsPerLogicalUnit <= 0) {
      throw new Error('Ink tile effective density must be finite and positive.');
    }
    if (retainedLod === undefined) {
      return this.clamp(Math.floor(Math.log2(effectivePixelsPerLogicalUnit)));
    }
    if (!Number.isSafeInteger(retainedLod)) {
      throw new Error('Ink retained tile LOD must be a safe integer.');
    }
    let lod = this.clamp(retainedLod);
    while (
      lod < this.maximumLod &&
      effectivePixelsPerLogicalUnit >= 2 ** (lod + 1) * (1 + this.hysteresisRatio)
    ) {
      lod += 1;
    }
    while (
      lod > this.minimumLod &&
      effectivePixelsPerLogicalUnit < 2 ** lod * (1 - this.hysteresisRatio)
    ) {
      lod -= 1;
    }
    return lod;
  }

  private clamp(lod: number): number {
    return Math.max(this.minimumLod, Math.min(this.maximumLod, lod));
  }
}
