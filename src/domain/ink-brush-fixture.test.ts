import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { digestInkBrushGolden, serializeInkBrushGolden } from './ink-brush-contract';
import {
  compareInkBrushRasterReplays,
  type InkBrushRasterSnapshot,
} from './ink-brush-raster-oracle';
import { CausalLegacyInkReducer } from './ink-control-trace';
import { LegacyRoundInkStrokeGeometry } from './ink-stroke-geometry';
import {
  decodeInkBrushAcceptanceMap,
  decodeInkBrushFixture,
  decodeInkBrushFixtureCorpus,
  INK_BRUSH_FIXTURE_IDS,
} from './ink-brush-fixture';

describe('Ink Brush fixture corpus', () => {
  it('fails closed on an unknown fixture schema version', () => {
    expect(() =>
      decodeInkBrushFixture({
        fixtureSchemaVersion: 2,
        id: 'tap-missing-sensors',
        kind: 'synthetic',
      }),
    ).toThrow('Ink Brush fixture schema version is unsupported.');
  });

  it('contains exactly the twelve named specification fixtures', () => {
    const corpus = decodeInkBrushFixtureCorpus(loadFixtureFiles());

    expect(corpus.map(({ id }) => id)).toEqual(INK_BRUSH_FIXTURE_IDS);
    expect(corpus).toHaveLength(12);
  });

  it('keeps the real Pencil placeholder privacy-fenced and free of fabricated samples', () => {
    const source = loadFixtureRecord('real-pencil-small-writing.json');
    const fixture = decodeInkBrushFixture(source);

    expect(fixture).toEqual({
      captureStatus: 'deferred-to-s34',
      fixtureSchemaVersion: 1,
      id: 'real-pencil-small-writing',
      kind: 'physical-placeholder',
      privacy: {
        forbiddenFields: [
          'account-identifiers',
          'device-serial-numbers',
          'note-content',
          'user-identifying-text',
          'user-vault-paths',
        ],
        reviewStatus: 'pending',
      },
    });
    expect('samples' in fixture).toBe(false);
    expect(() => decodeInkBrushFixture({ ...source, samples: [] })).toThrow(
      'Ink Brush physical placeholder must not contain samples before S34.',
    );
  });

  it('reserves an exact privacy-reviewed physical-capture branch for future S34 data', () => {
    const capture = physicalCaptureValidationDatum();

    expect(decodeInkBrushFixture(capture)).toEqual(capture);
    expect(() =>
      decodeInkBrushFixture({
        ...capture,
        privacy: { ...capture.privacy, deviceSerial: 'must-not-be-captured' },
      }),
    ).toThrow('Ink Brush physical capture privacy envelope is malformed.');
  });

  it('decodes every synthetic fixture into auditable normalized input, scene, or projection cases', () => {
    const corpus = decodeInkBrushFixtureCorpus(loadFixtureFiles());
    const synthetic = corpus.filter((fixture) => fixture.kind === 'synthetic');
    const caseKinds = synthetic.flatMap((fixture) => fixture.cases.map(({ kind }) => kind));

    expect(synthetic).toHaveLength(11);
    expect(synthetic.every(({ cases }) => cases.length > 0)).toBe(true);
    expect(new Set(caseKinds)).toEqual(
      new Set(['logical-scene', 'normalized-contact', 'projection']),
    );
  });

  it('rejects measured orientation readings that omit their reliability', () => {
    const fixture = decodeInkBrushFixture(loadFixtureRecord('tilt-compass-upright.json'));
    if (fixture.kind !== 'synthetic') throw new Error('Expected a synthetic tilt fixture.');
    const testCase = fixture.cases.find(({ id }) => id === 'four-directions-and-upright');
    if (testCase?.kind !== 'normalized-contact') throw new Error('Missing tilt compass case.');
    const sample = testCase.samples[0];
    const altitude = sample?.orientation.altitude;
    if (sample === undefined || altitude?.kind !== 'measured') {
      throw new Error('Missing measured altitude validation sample.');
    }
    const missingReliability = {
      ...fixture,
      cases: fixture.cases.map((candidate) =>
        candidate.id === testCase.id
          ? {
              ...testCase,
              samples: testCase.samples.map((candidateSample, index) =>
                index === 0
                  ? {
                      ...sample,
                      orientation: {
                        ...sample.orientation,
                        altitude: { kind: 'measured', value: altitude.value },
                      },
                    }
                  : candidateSample,
              ),
            }
          : candidate,
      ),
    };

    expect(() => decodeInkBrushFixture(missingReliability)).toThrow(
      'Ink Brush normalized orientation reading is malformed.',
    );
  });

  it('rejects measured pressure outside the normalized zero-to-one range', () => {
    const fixture = decodeInkBrushFixture(loadFixtureRecord('pressure-ramp-line.json'));
    if (fixture.kind !== 'synthetic') throw new Error('Expected a synthetic pressure fixture.');
    const testCase = fixture.cases.find(({ id }) => id === 'monotonic-pressure-ramp');
    if (testCase?.kind !== 'normalized-contact') throw new Error('Missing pressure ramp case.');
    const sample = testCase.samples[0];
    if (sample === undefined) throw new Error('Missing pressure validation sample.');
    const outOfRangePressure = {
      ...fixture,
      cases: fixture.cases.map((candidate) =>
        candidate.id === testCase.id
          ? {
              ...testCase,
              samples: testCase.samples.map((candidateSample, index) =>
                index === 0
                  ? { ...sample, pressure: { kind: 'measured', value: 7 } }
                  : candidateSample,
              ),
            }
          : candidate,
      ),
    };

    expect(() => decodeInkBrushFixture(outOfRangePressure)).toThrow(
      'Ink Brush normalized pressure reading is malformed.',
    );
  });

  it('rejects backward sample time within a normalized case', () => {
    const fixture = decodeInkBrushFixture(loadFixtureRecord('pressure-ramp-line.json'));
    if (fixture.kind !== 'synthetic') throw new Error('Expected a synthetic pressure fixture.');
    const testCase = fixture.cases.find(({ id }) => id === 'monotonic-pressure-ramp');
    if (testCase?.kind !== 'normalized-contact') throw new Error('Missing pressure ramp case.');
    const sample = testCase.samples[1];
    if (sample === undefined) throw new Error('Missing time validation sample.');
    const backwardTime = {
      ...fixture,
      cases: fixture.cases.map((candidate) =>
        candidate.id === testCase.id
          ? {
              ...testCase,
              samples: testCase.samples.map((candidateSample, index) =>
                index === 1 ? { ...sample, time: -1 } : candidateSample,
              ),
            }
          : candidate,
      ),
    };

    expect(() => decodeInkBrushFixture(backwardTime)).toThrow(
      'Ink Brush fixture sample times must be nondecreasing.',
    );
  });

  it.each([
    { axis: 'altitude' as const, value: Math.PI / 2 + 0.01 },
    { axis: 'azimuth' as const, value: Math.PI * 2 },
  ])('rejects an out-of-range $axis orientation angle', ({ axis, value }) => {
    const fixture = decodeInkBrushFixture(loadFixtureRecord('tilt-compass-upright.json'));
    if (fixture.kind !== 'synthetic') throw new Error('Expected a synthetic tilt fixture.');
    const testCase = fixture.cases.find(({ id }) => id === 'four-directions-and-upright');
    if (testCase?.kind !== 'normalized-contact') throw new Error('Missing tilt compass case.');
    const sample = testCase.samples[0];
    const reading = sample?.orientation[axis];
    if (sample === undefined || reading?.kind !== 'measured') {
      throw new Error(`Missing measured ${axis} validation sample.`);
    }
    const outOfRangeAngle = {
      ...fixture,
      cases: fixture.cases.map((candidate) =>
        candidate.id === testCase.id
          ? {
              ...testCase,
              samples: testCase.samples.map((candidateSample, index) =>
                index === 0
                  ? {
                      ...sample,
                      orientation: {
                        ...sample.orientation,
                        [axis]: { ...reading, value },
                      },
                    }
                  : candidateSample,
              ),
            }
          : candidate,
      ),
    };

    expect(() => decodeInkBrushFixture(outOfRangeAngle)).toThrow(
      'Ink Brush normalized orientation reading is malformed.',
    );
  });

  it('rejects measured readings declared unavailable by the brush input profile', () => {
    const pressureFixture = decodeInkBrushFixture(loadFixtureRecord('pressure-ramp-line.json'));
    if (pressureFixture.kind !== 'synthetic') {
      throw new Error('Expected a synthetic pressure fixture.');
    }
    const pressureCase = pressureFixture.cases.find(({ id }) => id === 'monotonic-pressure-ramp');
    if (pressureCase?.kind !== 'normalized-contact') throw new Error('Missing pressure ramp case.');
    const unavailablePressure = {
      ...pressureFixture,
      cases: pressureFixture.cases.map((candidate) =>
        candidate.id === pressureCase.id
          ? {
              ...pressureCase,
              brush: {
                ...pressureCase.brush,
                inputProfile: { ...pressureCase.brush.inputProfile, pressure: 'unavailable' },
              },
            }
          : candidate,
      ),
    };

    const tiltFixture = decodeInkBrushFixture(loadFixtureRecord('tilt-compass-upright.json'));
    if (tiltFixture.kind !== 'synthetic') throw new Error('Expected a synthetic tilt fixture.');
    const tiltCase = tiltFixture.cases.find(({ id }) => id === 'four-directions-and-upright');
    if (tiltCase?.kind !== 'normalized-contact') throw new Error('Missing tilt compass case.');
    const unavailableTilt = {
      ...tiltFixture,
      cases: tiltFixture.cases.map((candidate) =>
        candidate.id === tiltCase.id
          ? {
              ...tiltCase,
              brush: {
                ...tiltCase.brush,
                inputProfile: { ...tiltCase.brush.inputProfile, tilt: 'unavailable' },
              },
            }
          : candidate,
      ),
    };

    for (const contradiction of [unavailablePressure, unavailableTilt]) {
      expect(() => decodeInkBrushFixture(contradiction)).toThrow(
        'Ink Brush fixture input profile contradicts its samples.',
      );
    }
  });

  it('rejects measured input profiles with no measurable sample', () => {
    const pressureFixture = decodeInkBrushFixture(loadFixtureRecord('pressure-ramp-line.json'));
    if (pressureFixture.kind !== 'synthetic') {
      throw new Error('Expected a synthetic pressure fixture.');
    }
    const pressureCase = pressureFixture.cases.find(({ id }) => id === 'monotonic-pressure-ramp');
    if (pressureCase?.kind !== 'normalized-contact') throw new Error('Missing pressure ramp case.');
    const missingPressure = {
      ...pressureFixture,
      cases: pressureFixture.cases.map((candidate) =>
        candidate.id === pressureCase.id
          ? {
              ...pressureCase,
              samples: pressureCase.samples.map((sample) => ({
                ...sample,
                pressure: { kind: 'unavailable' },
              })),
            }
          : candidate,
      ),
    };

    const tiltFixture = decodeInkBrushFixture(loadFixtureRecord('tilt-compass-upright.json'));
    if (tiltFixture.kind !== 'synthetic') throw new Error('Expected a synthetic tilt fixture.');
    const tiltCase = tiltFixture.cases.find(({ id }) => id === 'four-directions-and-upright');
    if (tiltCase?.kind !== 'normalized-contact') throw new Error('Missing tilt compass case.');
    const missingTilt = {
      ...tiltFixture,
      cases: tiltFixture.cases.map((candidate) =>
        candidate.id === tiltCase.id
          ? {
              ...tiltCase,
              samples: tiltCase.samples.map((sample) => ({
                ...sample,
                orientation: {
                  altitude: { kind: 'unavailable' },
                  azimuth: { kind: 'unavailable' },
                },
              })),
            }
          : candidate,
      ),
    };

    for (const contradiction of [missingPressure, missingTilt]) {
      expect(() => decodeInkBrushFixture(contradiction)).toThrow(
        'Ink Brush fixture input profile contradicts its samples.',
      );
    }
  });

  it('preserves partial sensor loss as unavailable without inventing zero readings', () => {
    const pressureFixture = decodeInkBrushFixture(loadFixtureRecord('pressure-ramp-line.json'));
    if (pressureFixture.kind !== 'synthetic') {
      throw new Error('Expected a synthetic pressure fixture.');
    }
    const pressureCase = pressureFixture.cases.find(({ id }) => id === 'monotonic-pressure-ramp');
    if (pressureCase?.kind !== 'normalized-contact') throw new Error('Missing pressure ramp case.');
    const pressureSample = pressureCase.samples[0];
    if (pressureSample === undefined) throw new Error('Missing partial pressure sample.');
    const partialPressure = decodeInkBrushFixture({
      ...pressureFixture,
      cases: pressureFixture.cases.map((candidate) =>
        candidate.id === pressureCase.id
          ? {
              ...pressureCase,
              samples: pressureCase.samples.map((sample, index) =>
                index === 0 ? { ...pressureSample, pressure: { kind: 'unavailable' } } : sample,
              ),
            }
          : candidate,
      ),
    });
    if (partialPressure.kind !== 'synthetic') throw new Error('Expected decoded pressure fixture.');
    const decodedPressure = partialPressure.cases.find(
      ({ id }) => id === 'monotonic-pressure-ramp',
    );
    if (decodedPressure?.kind !== 'normalized-contact') {
      throw new Error('Missing decoded pressure ramp case.');
    }

    const tiltFixture = decodeInkBrushFixture(loadFixtureRecord('tilt-compass-upright.json'));
    if (tiltFixture.kind !== 'synthetic') throw new Error('Expected a synthetic tilt fixture.');
    const tiltCase = tiltFixture.cases.find(({ id }) => id === 'four-directions-and-upright');
    if (tiltCase?.kind !== 'normalized-contact') throw new Error('Missing tilt compass case.');
    const tiltSample = tiltCase.samples[0];
    if (tiltSample === undefined) throw new Error('Missing partial tilt sample.');
    const partialTilt = decodeInkBrushFixture({
      ...tiltFixture,
      cases: tiltFixture.cases.map((candidate) =>
        candidate.id === tiltCase.id
          ? {
              ...tiltCase,
              samples: tiltCase.samples.map((sample) => ({
                ...sample,
                orientation: {
                  ...sample.orientation,
                  azimuth: { kind: 'unavailable' },
                },
              })),
            }
          : candidate,
      ),
    });
    if (partialTilt.kind !== 'synthetic') throw new Error('Expected decoded tilt fixture.');
    const decodedTilt = partialTilt.cases.find(({ id }) => id === 'four-directions-and-upright');
    if (decodedTilt?.kind !== 'normalized-contact') {
      throw new Error('Missing decoded tilt compass case.');
    }

    expect(decodedPressure.samples[0]?.pressure).toEqual({ kind: 'unavailable' });
    expect(decodedTilt.samples[0]?.orientation.azimuth).toEqual({ kind: 'unavailable' });
  });

  it('assigns every fixture and cross-cutting contract to S29 through S34 owners', () => {
    const acceptance = decodeInkBrushAcceptanceMap(loadInkBrushJson('../acceptance-map.json'));

    expect(acceptance.fixtureOwners.map(({ fixtureId }) => fixtureId)).toEqual(
      INK_BRUSH_FIXTURE_IDS,
    );
    expect(
      Object.fromEntries(
        acceptance.fixtureOwners.map(({ fixtureId, owners }) => [fixtureId, owners]),
      ),
    ).toEqual({
      'corner-hairpin-self-cross': ['S30', 'S31'],
      'mixed-legacy-physical': ['S29', 'S33'],
      'pressure-impulse-straight': ['S30', 'S31'],
      'pressure-ramp-line': ['S31'],
      'real-pencil-small-writing': ['S34'],
      'same-path-slow-fast': ['S31', 'S32'],
      'surface-boundary-crossing': ['S29', 'S30', 'S32', 'S33'],
      'tap-missing-sensors': ['S30', 'S31', 'S32'],
      'tilt-compass-upright': ['S30', 'S32'],
      'two-highlighter-crossings': ['S32', 'S33'],
      'uneven-coalesced-s-curve': ['S30'],
      'zoom-dpr-export': ['S33'],
    });
    expect(acceptance.contractCases).toEqual([
      { caseId: 'unknown-version-fail-closed', owners: ['S29'] },
      {
        caseId: 'active-committed-reload-export-digest',
        owners: ['S31', 'S32', 'S33'],
      },
    ]);
    expect(
      new Set([
        ...acceptance.fixtureOwners.flatMap(({ owners }) => owners),
        ...acceptance.contractCases.flatMap(({ owners }) => owners),
      ]),
    ).toEqual(new Set(['S29', 'S30', 'S31', 'S32', 'S33', 'S34']));
  });

  it('replays the legacy mouse fallback into its exact trace and geometry golden', () => {
    const fixture = decodeInkBrushFixture(loadFixtureRecord('tap-missing-sensors.json'));
    if (fixture.kind !== 'synthetic') throw new Error('Expected a synthetic tap fixture.');
    const testCase = fixture.cases.find(({ id }) => id === 'legacy-mouse-fallback');
    if (testCase?.kind !== 'normalized-contact') {
      throw new Error('Missing normalized legacy mouse fallback case.');
    }
    const reducer = new CausalLegacyInkReducer();
    reducer.extend(testCase.samples);
    const trace = reducer.finalize();
    const geometry = new LegacyRoundInkStrokeGeometry().compile({
      color: testCase.brush.color,
      id: 'tap-missing-sensors:legacy-mouse-fallback',
      points: trace.points,
      tool: testCase.brush.tool,
      width: 4,
    });

    expect({
      caseId: testCase.id,
      fixtureId: fixture.id,
      geometry,
      goldenSchemaVersion: 1,
      trace,
    }).toEqual(
      loadInkBrushJson(
        '../goldens/legacy-round-v1/tap-missing-sensors.legacy-mouse-fallback.golden.json',
      ),
    );
  });

  it('keeps canonical serializer bytes and digest pinned by an auditable harness golden', () => {
    const golden = loadInkBrushJson('../goldens/harness-v1/canonical-serializer.golden.json');
    if (!isTestRecord(golden) || typeof golden.expectedSerialized !== 'string') {
      throw new Error('Canonical serializer harness golden is malformed.');
    }

    expect(serializeInkBrushGolden(golden.input)).toBe(golden.expectedSerialized);
    expect(digestInkBrushGolden(golden.input)).toBe(golden.expectedDigest);
  });

  it('replays identical and known-delta raster harness goldens into exact oracle results', () => {
    for (const name of ['raster-identical.golden.json', 'raster-known-delta.golden.json']) {
      const golden = loadInkBrushJson(`../goldens/harness-v1/${name}`);
      if (!isTestRecord(golden) || (golden.tool !== 'pen' && golden.tool !== 'highlighter')) {
        throw new Error(`Raster harness golden ${name} is malformed.`);
      }
      const reference = decodeTestRasterSnapshot(golden.reference);
      const candidate = decodeTestRasterSnapshot(golden.candidate);

      expect(
        compareInkBrushRasterReplays({
          candidate: { first: candidate, replay: candidate },
          reference: { first: reference, replay: reference },
          tool: golden.tool,
        }),
      ).toEqual(golden.expected);
    }
  });

  it('rejects batching indexes that regroup samples out of their original order', () => {
    const fixture = decodeInkBrushFixture(loadFixtureRecord('tap-missing-sensors.json'));
    if (fixture.kind !== 'synthetic') throw new Error('Expected a synthetic tap fixture.');
    const testCase = fixture.cases.find(({ id }) => id === 'legacy-tap');
    if (testCase?.kind !== 'normalized-contact') throw new Error('Missing legacy tap case.');
    const reordered = {
      ...fixture,
      cases: fixture.cases.map((candidate) =>
        candidate.id === testCase.id
          ? {
              ...testCase,
              batchings: [
                {
                  batches: [
                    { phase: 'down', sampleIndexes: [1] },
                    { phase: 'up', sampleIndexes: [0] },
                  ],
                  id: 'reordered',
                },
              ],
            }
          : candidate,
      ),
    };

    expect(() => decodeInkBrushFixture(reordered)).toThrow(
      'Ink Brush fixture batching must preserve ordered samples exactly once.',
    );
  });
});

function loadFixtureFiles(): readonly unknown[] {
  const fixtureDirectory = new URL('../../test-fixtures/ink-brush/v1/cases/', import.meta.url);
  return readdirSync(fixtureDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(name, fixtureDirectory), 'utf8')) as unknown);
}

function physicalCaptureValidationDatum() {
  const unavailable = { kind: 'unavailable' } as const;
  return {
    batchings: [
      {
        batches: [
          { phase: 'down', sampleIndexes: [0] },
          { phase: 'up', sampleIndexes: [1] },
        ],
        id: 'test-only-ordered-capture',
      },
    ],
    brush: {
      color: '#111111',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      tool: 'pen',
      version: 'pen-physical-v1',
    },
    captureStatus: 'captured',
    fixtureSchemaVersion: 1,
    id: 'real-pencil-small-writing',
    kind: 'physical-capture',
    privacy: {
      reviewedAt: '2026-07-18T00:00:00.000Z',
      reviewer: 'S34 fixture reviewer',
      reviewStatus: 'approved',
    },
    samples: [
      {
        orientation: { altitude: unavailable, azimuth: unavailable },
        pressure: { kind: 'measured', value: 0.25 },
        time: 0,
        x: 0,
        y: 0,
      },
      {
        orientation: { altitude: unavailable, azimuth: unavailable },
        pressure: { kind: 'measured', value: 0.5 },
        time: 8,
        x: 2,
        y: 1,
      },
    ],
  } as const;
}

function loadFixtureRecord(name: string): Record<string, unknown> {
  const value = loadInkBrushJson(name);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Ink Brush test fixture ${name} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function loadInkBrushJson(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../test-fixtures/ink-brush/v1/cases/${name}`, import.meta.url),
      'utf8',
    ),
  ) as unknown;
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeTestRasterSnapshot(value: unknown): InkBrushRasterSnapshot {
  if (
    !isTestRecord(value) ||
    !Array.isArray(value.alpha) ||
    !value.alpha.every((alpha) => Number.isInteger(alpha) && alpha >= 0 && alpha <= 255) ||
    !Array.isArray(value.coverage) ||
    !value.coverage.every(
      (coverage) => Number.isInteger(coverage) && coverage >= 0 && coverage <= 255,
    ) ||
    !isTestRecord(value.bounds) ||
    typeof value.bounds.x !== 'number' ||
    typeof value.bounds.y !== 'number' ||
    typeof value.bounds.width !== 'number' ||
    typeof value.bounds.height !== 'number' ||
    typeof value.height !== 'number' ||
    typeof value.scale !== 'number' ||
    typeof value.width !== 'number'
  ) {
    throw new Error('Raster harness snapshot is malformed.');
  }
  return {
    alpha: Uint8Array.from(value.alpha as number[]),
    bounds: {
      height: value.bounds.height,
      width: value.bounds.width,
      x: value.bounds.x,
      y: value.bounds.y,
    },
    coverage: Uint8Array.from(value.coverage as number[]),
    height: value.height,
    scale: value.scale,
    width: value.width,
  };
}
