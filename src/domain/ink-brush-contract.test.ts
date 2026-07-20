import { describe, expect, it } from 'vitest';

import {
  digestInkBrushGolden,
  resolveInkBrushContract,
  serializeInkBrushGolden,
} from './ink-brush-contract';

describe('Ink Brush contract registry', () => {
  it('resolves published legacy and reserved physical contracts without accepting mismatched metadata', () => {
    const legacyUnknown = { pressure: 'legacy-unknown', tilt: 'legacy-unknown' } as const;
    const physicalMeasured = { pressure: 'measured', tilt: 'unavailable' } as const;

    expect([
      resolveInkBrushContract({
        color: '#11111188',
        inputProfile: legacyUnknown,
        tool: 'highlighter',
        version: 'legacy-round-v1',
      }),
      resolveInkBrushContract({
        color: '#111111',
        inputProfile: physicalMeasured,
        tool: 'pen',
        version: 'pen-physical-v1',
      }),
      resolveInkBrushContract({
        color: '#111111',
        inputProfile: physicalMeasured,
        tool: 'highlighter',
        version: 'pen-physical-v1',
      }),
      resolveInkBrushContract({
        color: '#111111',
        inputProfile: legacyUnknown,
        tool: 'pen',
        version: 'pen-physical-v1',
      }),
      resolveInkBrushContract({
        color: '#ffff0088',
        inputProfile: physicalMeasured,
        tool: 'highlighter',
        version: 'highlighter-chisel-v1',
      }),
      resolveInkBrushContract({
        color: '#111111',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'measured' },
        tool: 'pen',
        version: 'pen-physical-v1',
      }),
      resolveInkBrushContract({
        color: '#11111188',
        inputProfile: physicalMeasured,
        tool: 'pen',
        version: 'pen-physical-v1',
      }),
    ]).toEqual([
      expect.objectContaining({ kind: 'supported', publication: 'published' }),
      expect.objectContaining({ kind: 'supported', publication: 'reserved' }),
      { kind: 'unsupported', reason: 'tool-version-mismatch' },
      { kind: 'unsupported', reason: 'input-profile-mismatch' },
      { kind: 'unsupported', reason: 'color-contract-mismatch' },
      { kind: 'unsupported', reason: 'malformed-identity' },
      { kind: 'unsupported', reason: 'color-contract-mismatch' },
    ]);
  });

  it('fails closed for unknown, inherited, or hostile runtime brush identity', () => {
    const inherited = Object.create({
      color: '#111111',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      tool: 'pen',
      version: 'pen-physical-v1',
    }) as unknown;
    const target = {
      color: '#111111',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      tool: 'pen',
      version: 'pen-physical-v1',
    };
    const hostile = new Proxy(target, {
      getOwnPropertyDescriptor: () => {
        throw new Error('private hostile identity');
      },
    });

    expect([
      resolveInkBrushContract(null),
      resolveInkBrushContract({ ...target, version: 'future-brush-v9' }),
      resolveInkBrushContract(inherited),
      resolveInkBrushContract(hostile),
    ]).toEqual([
      { kind: 'unsupported', reason: 'malformed-identity' },
      { kind: 'unsupported', reason: 'unknown-version' },
      { kind: 'unsupported', reason: 'malformed-identity' },
      { kind: 'unsupported', reason: 'malformed-identity' },
    ]);
  });

  it('serializes golden values with deterministic key order and rejects non-finite evidence', () => {
    const left = { version: 1, list: [3, -0], a: { z: 2, x: 1 } };
    const right = { a: { x: 1, z: 2 }, list: [3, 0], version: 1 };

    expect(serializeInkBrushGolden(left)).toBe('{"a":{"x":1,"z":2},"list":[3,0],"version":1}\n');
    expect(digestInkBrushGolden(left)).toBe(digestInkBrushGolden(right));
    expect(() => serializeInkBrushGolden({ coordinate: Number.NaN })).toThrow(
      'Ink Brush golden contains unsupported data.',
    );
  });

  it('hashes canonical UTF-8 bytes and rejects evidence hidden from JSON review', () => {
    const hidden = { visible: true };
    Object.defineProperty(hidden, 'secret', { enumerable: false, value: 1 });

    expect(digestInkBrushGolden({ glyph: '😀' })).not.toBe(digestInkBrushGolden({ glyph: '😁' }));
    expect(() => serializeInkBrushGolden(hidden)).toThrow(
      'Ink Brush golden contains unsupported data.',
    );
  });

  it('preserves poisoned JSON keys as visible canonical evidence', () => {
    const poisoned = JSON.parse('{"visible":true,"__proto__":{"polluted":true}}') as unknown;
    const plain = { visible: true };

    expect(serializeInkBrushGolden(poisoned)).toBe(
      '{"__proto__":{"polluted":true},"visible":true}\n',
    );
    expect(digestInkBrushGolden(poisoned)).not.toBe(digestInkBrushGolden(plain));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
