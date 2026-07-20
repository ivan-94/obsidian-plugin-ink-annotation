export type InkBrushRenderVersion = 'highlighter-chisel-v1' | 'legacy-round-v1' | 'pen-physical-v1';

export interface InkLegacyBrushInputProfile {
  readonly pressure: 'legacy-unknown';
  readonly tilt: 'legacy-unknown';
}

export interface InkPhysicalBrushInputProfile {
  readonly pressure: 'measured' | 'unavailable';
  readonly tilt: 'measured' | 'unavailable';
}

export type InkBrushInputProfile = InkLegacyBrushInputProfile | InkPhysicalBrushInputProfile;

export type InkVisibleBrushTool = 'highlighter' | 'pen';

export type InkBrushContractResolution =
  | {
      readonly kind: 'supported';
      readonly publication: 'published' | 'reserved';
      readonly tool: InkVisibleBrushTool;
      readonly version: InkBrushRenderVersion;
    }
  | {
      readonly kind: 'unsupported';
      readonly reason:
        | 'color-contract-mismatch'
        | 'input-profile-mismatch'
        | 'malformed-identity'
        | 'tool-version-mismatch'
        | 'unknown-version';
    };

export interface InkBrushContractIdentity {
  readonly color: string;
  readonly inputProfile: InkBrushInputProfile;
  readonly tool: InkVisibleBrushTool;
  readonly version: InkBrushRenderVersion;
}

export function resolveInkBrushContract(input: unknown): InkBrushContractResolution {
  const identity = decodeIdentity(input);
  if (identity.kind === 'unsupported') return identity;
  const decoded = identity.value;
  if (decoded.version === 'legacy-round-v1') {
    if (
      decoded.inputProfile.pressure !== 'legacy-unknown' ||
      decoded.inputProfile.tilt !== 'legacy-unknown'
    ) {
      return unsupported('input-profile-mismatch');
    }
    return Object.freeze({
      kind: 'supported',
      publication: 'published',
      tool: decoded.tool,
      version: decoded.version,
    });
  }

  const expectedTool = decoded.version === 'pen-physical-v1' ? 'pen' : 'highlighter';
  if (decoded.tool !== expectedTool) return unsupported('tool-version-mismatch');
  if (decoded.inputProfile.pressure === 'legacy-unknown') {
    return unsupported('input-profile-mismatch');
  }
  if (!/^#[0-9a-f]{6}$/iu.test(decoded.color)) {
    return unsupported('color-contract-mismatch');
  }
  return Object.freeze({
    kind: 'supported',
    publication: 'reserved',
    tool: decoded.tool,
    version: decoded.version,
  });
}

export function serializeInkBrushGolden(value: unknown): string {
  try {
    return `${JSON.stringify(canonicalizeGolden(value, new Set()))}\n`;
  } catch {
    throw new Error('Ink Brush golden contains unsupported data.');
  }
}

export function digestInkBrushGolden(value: unknown): string {
  let digest = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(serializeInkBrushGolden(value))) {
    digest ^= byte;
    digest = Math.imul(digest, 0x01000193) >>> 0;
  }
  return digest.toString(16).padStart(8, '0');
}

type InkBrushGoldenValue =
  | boolean
  | null
  | number
  | string
  | readonly InkBrushGoldenValue[]
  | { readonly [key: string]: InkBrushGoldenValue };

function canonicalizeGolden(value: unknown, ancestors: Set<object>): InkBrushGoldenValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new Error('non-json');
  if (ancestors.has(value)) throw new Error('cyclic');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index)) ||
        Reflect.ownKeys(value).length !== keys.length + 1
      ) {
        throw new Error('sparse-or-extended-array');
      }
      return Object.freeze(
        keys.map((key) => canonicalizeGolden(requireDataValue(descriptors[key]), ancestors)),
      );
    }
    if (!isPlainRecord(value)) {
      throw new Error('non-plain-record');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new Error('hidden-record-property');
    }
    const result = Object.create(null) as Record<string, InkBrushGoldenValue>;
    for (const key of keys.sort()) {
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: canonicalizeGolden(requireDataValue(descriptors[key]), ancestors),
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function requireDataValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new Error('accessor-or-hidden-property');
  }
  return descriptor.value as unknown;
}

type DecodedIdentity =
  | { readonly kind: 'decoded'; readonly value: InkBrushContractIdentity }
  | UnsupportedInkBrushContract;

type UnsupportedInkBrushContract = Extract<
  InkBrushContractResolution,
  { readonly kind: 'unsupported' }
>;

function decodeIdentity(value: unknown): DecodedIdentity {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ['color', 'inputProfile', 'tool', 'version'])
    ) {
      return unsupported('malformed-identity');
    }
    if (typeof value.version !== 'string') return unsupported('malformed-identity');
    if (!isBrushRenderVersion(value.version)) return unsupported('unknown-version');
    if (
      typeof value.color !== 'string' ||
      value.color.length === 0 ||
      (value.tool !== 'pen' && value.tool !== 'highlighter') ||
      !isInputProfile(value.inputProfile)
    ) {
      return unsupported('malformed-identity');
    }
    return {
      kind: 'decoded',
      value: {
        color: value.color,
        inputProfile: value.inputProfile,
        tool: value.tool,
        version: value.version,
      },
    };
  } catch {
    return unsupported('malformed-identity');
  }
}

function isBrushRenderVersion(value: string): value is InkBrushRenderVersion {
  return (
    value === 'legacy-round-v1' || value === 'pen-physical-v1' || value === 'highlighter-chisel-v1'
  );
}

function isInputProfile(value: unknown): value is InkBrushInputProfile {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['pressure', 'tilt'])) return false;
  if (value.pressure === 'legacy-unknown' || value.tilt === 'legacy-unknown') {
    return value.pressure === 'legacy-unknown' && value.tilt === 'legacy-unknown';
  }
  return isPhysicalSensorProfile(value.pressure) && isPhysicalSensorProfile(value.tilt);
}

function isPhysicalSensorProfile(
  value: unknown,
): value is InkPhysicalBrushInputProfile['pressure'] {
  return value === 'measured' || value === 'unavailable';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function unsupported(reason: UnsupportedInkBrushContract['reason']): UnsupportedInkBrushContract {
  return Object.freeze({ kind: 'unsupported', reason });
}
