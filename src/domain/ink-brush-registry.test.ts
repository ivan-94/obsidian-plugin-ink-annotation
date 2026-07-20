import { describe, expect, it } from 'vitest';

import { getInkBrushRegistration } from './ink-brush-registry';

describe('Ink Brush closed registry', () => {
  it('freezes every named version contract slot and the Foundation legacy limits', () => {
    const legacy = getInkBrushRegistration('legacy-round-v1');

    expect(legacy.publication).toBe('published');
    expect(Object.keys(legacy.contract).sort()).toEqual(
      [
        'active',
        'blend',
        'emission',
        'filter',
        'geometry',
        'pressureCurve',
        'quantization',
        'tiltCurve',
        'velocityCurve',
      ].sort(),
    );
    expect(legacy.contract).toMatchObject({
      active: {
        finishWork: { kind: 'fixed', value: 'new-stable-plus-bounded-mutable-tail' },
        maximumMutableTailSamples: { kind: 'fixed', unit: 'samples', value: 8 },
        mutableOwnership: { kind: 'fixed', value: 'replace-entire-tail' },
        stableOwnership: { kind: 'fixed', value: 'append-only' },
      },
      blend: {
        alpha: { kind: 'fixed', value: 'from-canonical-color' },
        application: { kind: 'fixed', value: 'once-per-logical-stroke' },
        colorSpace: { kind: 'fixed', value: 'srgb' },
        composite: { kind: 'fixed', value: 'source-over' },
      },
      emission: {
        arcSpacing: { kind: 'fixed', unit: 'logical-px', value: 6 },
        geometryError: { kind: 'fixed', unit: 'logical-px', value: 0.8 },
        maximumTimeGap: { kind: 'fixed', unit: 'ms', value: 32 },
        orientationError: { kind: 'fixed', unit: 'radians', value: 0.01 },
        pressureError: { kind: 'fixed', unit: 'normalized', value: 0.02 },
      },
      filter: {
        algorithm: { kind: 'fixed', value: 'foundation-causal-legacy-v1' },
        causality: { kind: 'fixed', value: 'causal-no-lookahead' },
      },
      geometry: {
        cap: { kind: 'fixed', value: 'round' },
        coverage: { kind: 'fixed', value: 'legacy-round-centerline' },
        join: { kind: 'fixed', value: 'round' },
      },
      quantization: {
        digestAlgorithm: { kind: 'fixed', value: 'fnv1a32-canonical-v1' },
        geometryGrid: { kind: 'fixed', unit: 'logical-px', value: 0.0001 },
        sensorGrid: { kind: 'fixed', unit: 'normalized-or-radians', value: 0.0001 },
        traceCoordinateGrid: { kind: 'fixed', unit: 'logical-px', value: 0.0001 },
        traceTimeGrid: { kind: 'fixed', unit: 'ms', value: 0.0001 },
      },
    });
    expect(isDeepFrozen(legacy)).toBe(true);
  });

  it('keeps physical numeric slots visibly uncalibrated while freezing the physical models', () => {
    const pen = getInkBrushRegistration('pen-physical-v1');
    const highlighter = getInkBrushRegistration('highlighter-chisel-v1');

    expect([pen.candidateRevision, highlighter.candidateRevision]).toEqual([
      's28-contract-r1',
      's28-contract-r1',
    ]);
    expect([pen.publication, highlighter.publication]).toEqual([
      'reserved-candidate',
      'reserved-candidate',
    ]);
    expect(pen.contract).toMatchObject({
      blend: { alpha: { kind: 'fixed', value: 1 } },
      geometry: {
        cap: { kind: 'fixed', value: 'round-contact-footprint' },
        coverage: { kind: 'fixed', value: 'quantized-filled-contours' },
        join: { kind: 'fixed', value: 'bounded-round' },
      },
      pressureCurve: { model: { kind: 'fixed', value: 'monotonic-nondecreasing-bounded' } },
      tiltCurve: { model: { kind: 'fixed', value: 'preserved-not-rendered' } },
      velocityCurve: { model: { kind: 'fixed', value: 'monotonic-nonincreasing-bounded' } },
    });
    expect(highlighter.contract).toMatchObject({
      blend: {
        alpha: { kind: 'awaiting-calibration', owner: 'S34' },
        application: { kind: 'fixed', value: 'once-per-logical-stroke' },
      },
      geometry: {
        cap: { kind: 'fixed', value: 'rounded-chisel-footprint' },
        coverage: { kind: 'fixed', value: 'quantized-filled-contours' },
        join: { kind: 'fixed', value: 'swept-chisel-union' },
      },
      pressureCurve: { model: { kind: 'fixed', value: 'bounded-chisel-scale' } },
      tiltCurve: {
        model: { kind: 'fixed', value: 'reliable-chisel-with-upright-hysteresis' },
        unreliableOrientation: { kind: 'fixed', value: 'hold-last-reliable' },
      },
      velocityCurve: { model: { kind: 'fixed', value: 'none' } },
    });

    expect(pendingPaths(pen.contract)).toEqual([
      'active.maximumMutableTailSamples',
      'emission.arcSpacing',
      'emission.geometryError',
      'emission.maximumTimeGap',
      'emission.orientationError',
      'emission.pressureError',
      'filter.orientationResponse',
      'filter.positionFastResponse',
      'filter.positionSlowResponse',
      'filter.pressureResponse',
      'filter.speedReference',
      'pressureCurve.maximumScale',
      'pressureCurve.minimumScale',
      'pressureCurve.referenceInput',
      'quantization.geometryGrid',
      'quantization.sensorGrid',
      'quantization.traceCoordinateGrid',
      'quantization.traceTimeGrid',
      'velocityCurve.maximumScale',
      'velocityCurve.minimumScale',
      'velocityCurve.referenceInput',
    ]);
    expect(pendingPaths(highlighter.contract)).toEqual([
      'active.maximumMutableTailSamples',
      'blend.alpha',
      'emission.arcSpacing',
      'emission.geometryError',
      'emission.maximumTimeGap',
      'emission.orientationError',
      'emission.pressureError',
      'filter.orientationResponse',
      'filter.positionFastResponse',
      'filter.positionSlowResponse',
      'filter.pressureResponse',
      'filter.speedReference',
      'pressureCurve.maximumScale',
      'pressureCurve.minimumScale',
      'pressureCurve.referenceInput',
      'quantization.geometryGrid',
      'quantization.sensorGrid',
      'quantization.traceCoordinateGrid',
      'quantization.traceTimeGrid',
      'tiltCurve.defaultAzimuth',
      'tiltCurve.maximumScale',
      'tiltCurve.minimumScale',
      'tiltCurve.referenceInput',
      'tiltCurve.uprightEnterAltitude',
      'tiltCurve.uprightExitAltitude',
    ]);
    expect(Object.hasOwn(pen.contract, 'candidateRevision')).toBe(false);
    expect(Object.hasOwn(highlighter.contract, 'candidateRevision')).toBe(false);
    expect(isDeepFrozen(pen)).toBe(true);
    expect(isDeepFrozen(highlighter)).toBe(true);
  });

  it('fails closed at runtime for a version outside the closed registry', () => {
    expect(() => getInkBrushRegistration('future-brush-v9' as 'legacy-round-v1')).toThrow(
      'Unknown Ink Brush Render Version: future-brush-v9',
    );
  });

  it('maps all twelve frozen S28 registry obligations into the structured contract', () => {
    const requiredSlots = {
      alpha: 'blend.alpha',
      cap: 'geometry.cap',
      filter: 'filter.algorithm',
      geometryError: 'emission.geometryError',
      join: 'geometry.join',
      maximumTimeGap: 'emission.maximumTimeGap',
      mutableTail: 'active.maximumMutableTailSamples',
      pressureCurve: 'pressureCurve.model',
      quantization: 'quantization.geometryGrid',
      spacing: 'emission.arcSpacing',
      tiltResponse: 'tiltCurve.model',
      velocityCurve: 'velocityCurve.model',
    } as const;

    expect(Object.keys(requiredSlots)).toHaveLength(12);
    for (const version of [
      'legacy-round-v1',
      'pen-physical-v1',
      'highlighter-chisel-v1',
    ] as const) {
      const contract = getInkBrushRegistration(version).contract;
      for (const path of Object.values(requiredSlots)) {
        expect(readPath(contract, path), `${version}:${path}`).toBeDefined();
      }
    }
  });
});

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value)) return true;
  seen.add(value);
  return (
    Object.isFrozen(value) &&
    Reflect.ownKeys(value).every((key) => isDeepFrozen(Reflect.get(value, key), seen))
  );
}

function pendingPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  if (Reflect.get(value, 'kind') === 'awaiting-calibration') {
    expect(Reflect.get(value, 'owner')).toBe('S34');
    expect(Reflect.get(value, 'acceptance')).toEqual(expect.any(String));
    expect(Reflect.get(value, 'unit')).toEqual(expect.any(String));
    return [prefix];
  }
  return Object.keys(value)
    .flatMap((key) =>
      pendingPaths(Reflect.get(value, key), prefix === '' ? key : `${prefix}.${key}`),
    )
    .sort();
}

function readPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined,
      value,
    );
}
