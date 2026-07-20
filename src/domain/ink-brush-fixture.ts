export const INK_BRUSH_FIXTURE_SCHEMA_VERSION = 1 as const;

export const INK_BRUSH_FIXTURE_IDS = Object.freeze([
  'tap-missing-sensors',
  'pressure-ramp-line',
  'pressure-impulse-straight',
  'same-path-slow-fast',
  'uneven-coalesced-s-curve',
  'tilt-compass-upright',
  'corner-hairpin-self-cross',
  'surface-boundary-crossing',
  'two-highlighter-crossings',
  'mixed-legacy-physical',
  'zoom-dpr-export',
  'real-pencil-small-writing',
] as const);

export type InkBrushFixtureId = (typeof INK_BRUSH_FIXTURE_IDS)[number];

export const INK_BRUSH_ACCEPTANCE_SLICES = Object.freeze([
  'S29',
  'S30',
  'S31',
  'S32',
  'S33',
  'S34',
] as const);

export type InkBrushAcceptanceSlice = (typeof INK_BRUSH_ACCEPTANCE_SLICES)[number];

export interface InkBrushAcceptanceMap {
  readonly acceptanceMapSchemaVersion: 1;
  readonly contractCases: readonly {
    readonly caseId: 'active-committed-reload-export-digest' | 'unknown-version-fail-closed';
    readonly owners: readonly InkBrushAcceptanceSlice[];
  }[];
  readonly fixtureOwners: readonly {
    readonly fixtureId: InkBrushFixtureId;
    readonly owners: readonly InkBrushAcceptanceSlice[];
  }[];
}

export interface InkBrushFixtureHeader {
  readonly fixtureSchemaVersion: typeof INK_BRUSH_FIXTURE_SCHEMA_VERSION;
  readonly id: InkBrushFixtureId;
}

export interface InkBrushSyntheticFixture extends InkBrushFixtureHeader {
  readonly cases: readonly InkBrushSyntheticCase[];
  readonly kind: 'synthetic';
}

export type InkBrushSyntheticCase =
  InkBrushLogicalSceneCase | InkBrushNormalizedContactCase | InkBrushProjectionCase;

export interface InkBrushNormalizedContactCase {
  readonly batchings: readonly InkBrushFixtureBatching[];
  readonly brush: InkBrushContractIdentity;
  readonly id: string;
  readonly kind: 'normalized-contact';
  readonly samples: readonly InkBrushFixtureSample[];
}

export interface InkBrushFixtureBatching {
  readonly batches: readonly {
    readonly phase: 'down' | 'move' | 'up';
    readonly sampleIndexes: readonly number[];
  }[];
  readonly id: string;
}

export interface InkBrushFixtureSample {
  readonly orientation: {
    readonly altitude: InkBrushFixtureOrientationReading;
    readonly azimuth: InkBrushFixtureOrientationReading;
  };
  readonly pressure: InkBrushFixturePressureReading;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export type InkBrushFixtureOrientationReading =
  | { readonly kind: 'measured'; readonly reliable: boolean; readonly value: number }
  | { readonly kind: 'unavailable' };

export type InkBrushFixturePressureReading =
  { readonly kind: 'measured'; readonly value: number } | { readonly kind: 'unavailable' };

export interface InkBrushLogicalSceneCase {
  readonly id: string;
  readonly kind: 'logical-scene';
  readonly strokes: readonly {
    readonly brush: InkBrushContractIdentity;
    readonly id: string;
    readonly points: readonly InkBrushFixtureSample[];
  }[];
  readonly surfaces: readonly {
    readonly id: string;
    readonly maximumY: number;
    readonly minimumY: number;
  }[];
}

export interface InkBrushProjectionCase {
  readonly adapters: readonly ('canvas' | 'png' | 'svg')[];
  readonly devicePixelRatios: readonly number[];
  readonly id: string;
  readonly kind: 'projection';
  readonly logicalBounds: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly scales: readonly number[];
}

export interface InkBrushPhysicalPlaceholderFixture extends InkBrushFixtureHeader {
  readonly captureStatus: 'deferred-to-s34';
  readonly id: 'real-pencil-small-writing';
  readonly kind: 'physical-placeholder';
  readonly privacy: {
    readonly forbiddenFields: readonly InkBrushPrivateField[];
    readonly reviewStatus: 'pending';
  };
}

export interface InkBrushPhysicalCaptureFixture extends InkBrushFixtureHeader {
  readonly batchings: readonly InkBrushFixtureBatching[];
  readonly brush: InkBrushContractIdentity;
  readonly captureStatus: 'captured';
  readonly id: 'real-pencil-small-writing';
  readonly kind: 'physical-capture';
  readonly privacy: {
    readonly reviewedAt: string;
    readonly reviewer: string;
    readonly reviewStatus: 'approved';
  };
  readonly samples: readonly InkBrushFixtureSample[];
}

export type InkBrushFixture =
  InkBrushPhysicalCaptureFixture | InkBrushPhysicalPlaceholderFixture | InkBrushSyntheticFixture;

export type InkBrushPrivateField = (typeof INK_BRUSH_PRIVATE_FIELDS)[number];

const INK_BRUSH_PRIVATE_FIELDS = Object.freeze([
  'account-identifiers',
  'device-serial-numbers',
  'note-content',
  'user-identifying-text',
  'user-vault-paths',
] as const);

export function decodeInkBrushFixture(value: unknown): InkBrushFixture {
  if (!isRecord(value) || value.fixtureSchemaVersion !== INK_BRUSH_FIXTURE_SCHEMA_VERSION) {
    throw new Error('Ink Brush fixture schema version is unsupported.');
  }
  if (!isFixtureId(value.id)) {
    throw new Error('Ink Brush fixture ID is unknown.');
  }
  if (value.id === 'real-pencil-small-writing') {
    if (value.kind === 'physical-placeholder') return decodePhysicalPlaceholder(value);
    if (value.kind === 'physical-capture') return decodePhysicalCapture(value);
    throw new Error('Ink Brush physical fixture kind is unknown.');
  }
  if (
    !hasExactKeys(value, ['cases', 'fixtureSchemaVersion', 'id', 'kind']) ||
    value.kind !== 'synthetic' ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0
  ) {
    throw new Error('Ink Brush synthetic fixture envelope is malformed.');
  }
  const cases = value.cases.map(decodeSyntheticCase);
  assertUniqueNonEmptyIds(cases, 'Ink Brush synthetic fixture case');
  return Object.freeze({
    cases: Object.freeze(cases),
    fixtureSchemaVersion: INK_BRUSH_FIXTURE_SCHEMA_VERSION,
    id: value.id,
    kind: 'synthetic',
  });
}

export function decodeInkBrushFixtureCorpus(
  values: readonly unknown[],
): readonly InkBrushFixture[] {
  const byId = new Map<InkBrushFixtureId, InkBrushFixture>();
  for (const value of values) {
    const fixture = decodeInkBrushFixture(value);
    if (byId.has(fixture.id)) throw new Error(`Ink Brush fixture ${fixture.id} is duplicated.`);
    byId.set(fixture.id, fixture);
  }
  if (byId.size !== INK_BRUSH_FIXTURE_IDS.length) {
    throw new Error('Ink Brush fixture corpus must contain exactly the twelve specified fixtures.');
  }
  return Object.freeze(
    INK_BRUSH_FIXTURE_IDS.map((id) => {
      const fixture = byId.get(id);
      if (fixture === undefined) {
        throw new Error('Ink Brush fixture corpus is missing a specified fixture.');
      }
      return fixture;
    }),
  );
}

export function decodeInkBrushAcceptanceMap(value: unknown): InkBrushAcceptanceMap {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['acceptanceMapSchemaVersion', 'contractCases', 'fixtureOwners']) ||
    value.acceptanceMapSchemaVersion !== 1 ||
    !Array.isArray(value.fixtureOwners) ||
    !Array.isArray(value.contractCases)
  ) {
    throw new Error('Ink Brush acceptance map envelope is malformed.');
  }
  const fixtureOwners = new Map<
    InkBrushFixtureId,
    InkBrushAcceptanceMap['fixtureOwners'][number]
  >();
  for (const source of value.fixtureOwners) {
    if (
      !isRecord(source) ||
      !hasExactKeys(source, ['fixtureId', 'owners']) ||
      !isFixtureId(source.fixtureId)
    ) {
      throw new Error('Ink Brush acceptance fixture owner is malformed.');
    }
    if (fixtureOwners.has(source.fixtureId)) {
      throw new Error(`Ink Brush acceptance fixture ${source.fixtureId} is duplicated.`);
    }
    fixtureOwners.set(
      source.fixtureId,
      Object.freeze({ fixtureId: source.fixtureId, owners: decodeAcceptanceOwners(source.owners) }),
    );
  }
  if (fixtureOwners.size !== INK_BRUSH_FIXTURE_IDS.length) {
    throw new Error('Ink Brush acceptance map must own every specified fixture.');
  }

  const contractCases = value.contractCases.map(decodeContractAcceptanceCase);
  assertUniqueNonEmptyIds(
    contractCases.map(({ caseId, ...entry }) => ({ ...entry, id: caseId })),
    'Ink Brush acceptance contract case',
  );
  const expectedContractCases = [
    'unknown-version-fail-closed',
    'active-committed-reload-export-digest',
  ];
  if (
    contractCases.length !== expectedContractCases.length ||
    !expectedContractCases.every((caseId) =>
      contractCases.some((candidate) => candidate.caseId === caseId),
    )
  ) {
    throw new Error('Ink Brush acceptance map is missing a cross-cutting contract case.');
  }

  return Object.freeze({
    acceptanceMapSchemaVersion: 1,
    contractCases: Object.freeze(
      expectedContractCases.map((caseId) => {
        const entry = contractCases.find((candidate) => candidate.caseId === caseId);
        if (entry === undefined)
          throw new Error('Ink Brush acceptance contract map is inconsistent.');
        return entry;
      }),
    ),
    fixtureOwners: Object.freeze(
      INK_BRUSH_FIXTURE_IDS.map((fixtureId) => {
        const entry = fixtureOwners.get(fixtureId);
        if (entry === undefined)
          throw new Error('Ink Brush acceptance fixture map is inconsistent.');
        return entry;
      }),
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFixtureId(value: unknown): value is InkBrushFixtureId {
  return typeof value === 'string' && (INK_BRUSH_FIXTURE_IDS as readonly string[]).includes(value);
}

function decodePhysicalPlaceholder(
  value: Record<string, unknown>,
): InkBrushPhysicalPlaceholderFixture {
  if ('samples' in value) {
    throw new Error('Ink Brush physical placeholder must not contain samples before S34.');
  }
  if (
    !hasExactKeys(value, ['captureStatus', 'fixtureSchemaVersion', 'id', 'kind', 'privacy']) ||
    value.captureStatus !== 'deferred-to-s34' ||
    value.id !== 'real-pencil-small-writing' ||
    value.kind !== 'physical-placeholder' ||
    !isRecord(value.privacy) ||
    !hasExactKeys(value.privacy, ['forbiddenFields', 'reviewStatus']) ||
    value.privacy.reviewStatus !== 'pending' ||
    !isExactStringArray(value.privacy.forbiddenFields, INK_BRUSH_PRIVATE_FIELDS)
  ) {
    throw new Error('Ink Brush physical placeholder privacy envelope is malformed.');
  }
  return Object.freeze({
    captureStatus: 'deferred-to-s34',
    fixtureSchemaVersion: INK_BRUSH_FIXTURE_SCHEMA_VERSION,
    id: value.id,
    kind: 'physical-placeholder',
    privacy: Object.freeze({
      forbiddenFields: INK_BRUSH_PRIVATE_FIELDS,
      reviewStatus: 'pending',
    }),
  });
}

function decodePhysicalCapture(value: Record<string, unknown>): InkBrushPhysicalCaptureFixture {
  if (
    !hasExactKeys(value, [
      'batchings',
      'brush',
      'captureStatus',
      'fixtureSchemaVersion',
      'id',
      'kind',
      'privacy',
      'samples',
    ]) ||
    value.captureStatus !== 'captured' ||
    value.id !== 'real-pencil-small-writing' ||
    value.kind !== 'physical-capture' ||
    !isRecord(value.privacy) ||
    !hasExactKeys(value.privacy, ['reviewedAt', 'reviewer', 'reviewStatus']) ||
    value.privacy.reviewStatus !== 'approved' ||
    !nonBlank(value.privacy.reviewer) ||
    !isCanonicalIsoTimestamp(value.privacy.reviewedAt) ||
    !Array.isArray(value.samples) ||
    value.samples.length < 2 ||
    !Array.isArray(value.batchings) ||
    value.batchings.length === 0
  ) {
    throw new Error('Ink Brush physical capture privacy envelope is malformed.');
  }
  const samples = Object.freeze(value.samples.map(decodeSample));
  assertNondecreasingSampleTimes(samples);
  const batchings = Object.freeze(
    value.batchings.map((batching) => decodeBatching(batching, samples.length)),
  );
  assertUniqueNonEmptyIds(batchings, 'Ink Brush fixture batching');
  const brush = decodeBrushIdentity(value.brush);
  assertProfileCapabilities(brush, samples);
  return Object.freeze({
    batchings,
    brush,
    captureStatus: 'captured',
    fixtureSchemaVersion: INK_BRUSH_FIXTURE_SCHEMA_VERSION,
    id: value.id,
    kind: 'physical-capture',
    privacy: Object.freeze({
      reviewedAt: value.privacy.reviewedAt,
      reviewer: value.privacy.reviewer,
      reviewStatus: 'approved',
    }),
    samples,
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function decodeSyntheticCase(value: unknown): InkBrushSyntheticCase {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Ink Brush synthetic fixture case is malformed.');
  }
  switch (value.kind) {
    case 'logical-scene':
      return decodeLogicalScene(value);
    case 'normalized-contact':
      return decodeNormalizedContact(value);
    case 'projection':
      return decodeProjection(value);
    default:
      throw new Error('Ink Brush synthetic fixture case kind is unknown.');
  }
}

function decodeNormalizedContact(value: Record<string, unknown>): InkBrushNormalizedContactCase {
  if (
    !hasExactKeys(value, ['batchings', 'brush', 'id', 'kind', 'samples']) ||
    !nonEmpty(value.id) ||
    !Array.isArray(value.samples) ||
    value.samples.length < 2 ||
    !Array.isArray(value.batchings) ||
    value.batchings.length === 0
  ) {
    throw new Error('Ink Brush normalized-contact case is malformed.');
  }
  const samples = Object.freeze(value.samples.map(decodeSample));
  assertNondecreasingSampleTimes(samples);
  const batchings = Object.freeze(
    value.batchings.map((batching) => decodeBatching(batching, samples.length)),
  );
  assertUniqueNonEmptyIds(batchings, 'Ink Brush fixture batching');
  const brush = decodeBrushIdentity(value.brush);
  assertProfileCapabilities(brush, samples);
  return Object.freeze({
    batchings,
    brush,
    id: value.id,
    kind: 'normalized-contact',
    samples,
  });
}

function decodeLogicalScene(value: Record<string, unknown>): InkBrushLogicalSceneCase {
  if (
    !hasExactKeys(value, ['id', 'kind', 'strokes', 'surfaces']) ||
    !nonEmpty(value.id) ||
    !Array.isArray(value.strokes) ||
    value.strokes.length === 0 ||
    !Array.isArray(value.surfaces) ||
    value.surfaces.length === 0
  ) {
    throw new Error('Ink Brush logical-scene case is malformed.');
  }
  const strokes = Object.freeze(value.strokes.map(decodeSceneStroke));
  const surfaces = Object.freeze(value.surfaces.map(decodeSceneSurface));
  assertUniqueNonEmptyIds(strokes, 'Ink Brush scene stroke');
  assertUniqueNonEmptyIds(surfaces, 'Ink Brush scene surface');
  return Object.freeze({ id: value.id, kind: 'logical-scene', strokes, surfaces });
}

function decodeProjection(value: Record<string, unknown>): InkBrushProjectionCase {
  if (
    !hasExactKeys(value, [
      'adapters',
      'devicePixelRatios',
      'id',
      'kind',
      'logicalBounds',
      'scales',
    ]) ||
    !nonEmpty(value.id) ||
    !isRecord(value.logicalBounds) ||
    !hasExactKeys(value.logicalBounds, ['height', 'width', 'x', 'y']) ||
    !finite(value.logicalBounds.x) ||
    !finite(value.logicalBounds.y) ||
    !positive(value.logicalBounds.width) ||
    !positive(value.logicalBounds.height) ||
    !isPositiveNumberArray(value.scales) ||
    !isPositiveNumberArray(value.devicePixelRatios) ||
    !isExactStringArray(value.adapters, ['canvas', 'svg', 'png'])
  ) {
    throw new Error('Ink Brush projection case is malformed.');
  }
  return Object.freeze({
    adapters: Object.freeze(['canvas', 'svg', 'png'] as const),
    devicePixelRatios: Object.freeze([...value.devicePixelRatios]),
    id: value.id,
    kind: 'projection',
    logicalBounds: Object.freeze({
      height: value.logicalBounds.height,
      width: value.logicalBounds.width,
      x: value.logicalBounds.x,
      y: value.logicalBounds.y,
    }),
    scales: Object.freeze([...value.scales]),
  });
}

function decodeBrushIdentity(value: unknown): InkBrushContractIdentity {
  const resolution = resolveInkBrushContract(value);
  if (
    resolution.kind !== 'supported' ||
    !isRecord(value) ||
    !nonEmpty(value.color) ||
    !isRecord(value.inputProfile) ||
    (value.tool !== 'pen' && value.tool !== 'highlighter') ||
    (value.version !== 'legacy-round-v1' &&
      value.version !== 'pen-physical-v1' &&
      value.version !== 'highlighter-chisel-v1') ||
    (value.inputProfile.pressure !== 'legacy-unknown' &&
      value.inputProfile.pressure !== 'measured' &&
      value.inputProfile.pressure !== 'unavailable') ||
    (value.inputProfile.tilt !== 'legacy-unknown' &&
      value.inputProfile.tilt !== 'measured' &&
      value.inputProfile.tilt !== 'unavailable')
  ) {
    throw new Error('Ink Brush fixture brush identity is unsupported.');
  }
  if (value.version === 'legacy-round-v1') {
    if (
      value.inputProfile.pressure !== 'legacy-unknown' ||
      value.inputProfile.tilt !== 'legacy-unknown'
    ) {
      throw new Error('Ink Brush fixture brush identity is unsupported.');
    }
    return Object.freeze({
      color: value.color,
      inputProfile: Object.freeze({ pressure: 'legacy-unknown', tilt: 'legacy-unknown' }),
      tool: value.tool,
      version: value.version,
    });
  }
  if (
    value.inputProfile.pressure === 'legacy-unknown' ||
    value.inputProfile.tilt === 'legacy-unknown'
  ) {
    throw new Error('Ink Brush fixture brush identity is unsupported.');
  }
  return Object.freeze({
    color: value.color,
    inputProfile: Object.freeze({
      pressure: value.inputProfile.pressure,
      tilt: value.inputProfile.tilt,
    }),
    tool: value.tool,
    version: value.version,
  });
}

function decodeSample(value: unknown): InkBrushFixtureSample {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['orientation', 'pressure', 'time', 'x', 'y']) ||
    !finite(value.x) ||
    !finite(value.y) ||
    !finite(value.time) ||
    !isRecord(value.orientation) ||
    !hasExactKeys(value.orientation, ['altitude', 'azimuth'])
  ) {
    throw new Error('Ink Brush normalized sample is malformed.');
  }
  return Object.freeze({
    orientation: Object.freeze({
      altitude: decodeOrientationReading(value.orientation.altitude, 'altitude'),
      azimuth: decodeOrientationReading(value.orientation.azimuth, 'azimuth'),
    }),
    pressure: decodePressureReading(value.pressure),
    time: value.time,
    x: value.x,
    y: value.y,
  });
}

function decodeOrientationReading(
  value: unknown,
  axis: 'altitude' | 'azimuth',
): InkBrushFixtureOrientationReading {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Ink Brush normalized orientation reading is malformed.');
  }
  if (value.kind === 'unavailable' && hasExactKeys(value, ['kind'])) {
    return Object.freeze({ kind: 'unavailable' });
  }
  if (
    value.kind === 'measured' &&
    hasExactKeys(value, ['kind', 'reliable', 'value']) &&
    typeof value.reliable === 'boolean' &&
    isValidOrientationAngle(value.value, axis)
  ) {
    return Object.freeze({ kind: 'measured', reliable: value.reliable, value: value.value });
  }
  throw new Error('Ink Brush normalized orientation reading is malformed.');
}

function decodePressureReading(value: unknown): InkBrushFixturePressureReading {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Ink Brush normalized pressure reading is malformed.');
  }
  if (value.kind === 'unavailable' && hasExactKeys(value, ['kind'])) {
    return Object.freeze({ kind: 'unavailable' });
  }
  if (
    value.kind === 'measured' &&
    hasExactKeys(value, ['kind', 'value']) &&
    inClosedRange(value.value, 0, 1)
  ) {
    return Object.freeze({ kind: 'measured', value: value.value });
  }
  throw new Error('Ink Brush normalized pressure reading is malformed.');
}

function decodeBatching(value: unknown, sampleCount: number): InkBrushFixtureBatching {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['batches', 'id']) ||
    !nonEmpty(value.id) ||
    !Array.isArray(value.batches) ||
    value.batches.length < 2
  ) {
    throw new Error('Ink Brush fixture batching is malformed.');
  }
  const batches = Object.freeze(
    value.batches.map((batch): InkBrushFixtureBatching['batches'][number] => {
      if (
        !isRecord(batch) ||
        !hasExactKeys(batch, ['phase', 'sampleIndexes']) ||
        (batch.phase !== 'down' && batch.phase !== 'move' && batch.phase !== 'up') ||
        !isSampleIndexArray(batch.sampleIndexes, sampleCount)
      ) {
        throw new Error('Ink Brush fixture batch is malformed.');
      }
      return Object.freeze({
        phase: batch.phase,
        sampleIndexes: Object.freeze([...batch.sampleIndexes]),
      });
    }),
  );
  if (batches[0]?.phase !== 'down' || batches.at(-1)?.phase !== 'up') {
    throw new Error('Ink Brush fixture batching must begin down and end up.');
  }
  const indexes = batches.flatMap(({ sampleIndexes }) => [...sampleIndexes]);
  if (indexes.length !== sampleCount || indexes.some((index, position) => index !== position)) {
    throw new Error('Ink Brush fixture batching must preserve ordered samples exactly once.');
  }
  return Object.freeze({ batches, id: value.id });
}

function decodeSceneStroke(value: unknown): InkBrushLogicalSceneCase['strokes'][number] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['brush', 'id', 'points']) ||
    !nonEmpty(value.id) ||
    !Array.isArray(value.points) ||
    value.points.length === 0
  ) {
    throw new Error('Ink Brush scene stroke is malformed.');
  }
  const points = Object.freeze(value.points.map(decodeSample));
  assertNondecreasingSampleTimes(points);
  const brush = decodeBrushIdentity(value.brush);
  assertProfileCapabilities(brush, points);
  return Object.freeze({
    brush,
    id: value.id,
    points,
  });
}

function decodeSceneSurface(value: unknown): InkBrushLogicalSceneCase['surfaces'][number] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['id', 'maximumY', 'minimumY']) ||
    !nonEmpty(value.id) ||
    !finite(value.minimumY) ||
    !finite(value.maximumY) ||
    value.maximumY <= value.minimumY
  ) {
    throw new Error('Ink Brush scene surface is malformed.');
  }
  return Object.freeze({
    id: value.id,
    maximumY: value.maximumY,
    minimumY: value.minimumY,
  });
}

function assertUniqueNonEmptyIds(values: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const { id } of values) {
    if (!nonEmpty(id) || ids.has(id)) throw new Error(`${label} IDs must be non-empty and unique.`);
    ids.add(id);
  }
}

function assertNondecreasingSampleTimes(samples: readonly InkBrushFixtureSample[]): void {
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    const previous = samples[index - 1];
    if (current === undefined || previous === undefined) {
      throw new Error('Ink Brush fixture sample sequence is malformed.');
    }
    if (current.time < previous.time) {
      throw new Error('Ink Brush fixture sample times must be nondecreasing.');
    }
  }
}

function assertProfileCapabilities(
  brush: InkBrushContractIdentity,
  samples: readonly InkBrushFixtureSample[],
): void {
  const measuredPressure = samples.some(({ pressure }) => pressure.kind === 'measured');
  const anyMeasuredTilt = samples.some(
    ({ orientation }) =>
      orientation.altitude.kind === 'measured' || orientation.azimuth.kind === 'measured',
  );
  if (
    (brush.inputProfile.pressure === 'unavailable' && measuredPressure) ||
    (brush.inputProfile.pressure === 'measured' && !measuredPressure) ||
    (brush.inputProfile.tilt === 'unavailable' && anyMeasuredTilt) ||
    (brush.inputProfile.tilt === 'measured' && !anyMeasuredTilt)
  ) {
    throw new Error('Ink Brush fixture input profile contradicts its samples.');
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function inClosedRange(value: unknown, minimum: number, maximum: number): value is number {
  return finite(value) && value >= minimum && value <= maximum;
}

function isValidOrientationAngle(value: unknown, axis: 'altitude' | 'azimuth'): value is number {
  if (!finite(value) || value < 0) return false;
  return axis === 'altitude' ? value <= Math.PI / 2 : value < Math.PI * 2;
}

function isPositiveNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(positive);
}

function isSampleIndexArray(value: unknown, sampleCount: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (index): index is number =>
        typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < sampleCount,
    )
  );
}

function decodeAcceptanceOwners(value: unknown): readonly InkBrushAcceptanceSlice[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isAcceptanceSlice)) {
    throw new Error('Ink Brush acceptance owners are malformed.');
  }
  if (new Set(value).size !== value.length) {
    throw new Error('Ink Brush acceptance owners must be unique.');
  }
  return Object.freeze([...value]);
}

function decodeContractAcceptanceCase(
  value: unknown,
): InkBrushAcceptanceMap['contractCases'][number] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['caseId', 'owners']) ||
    (value.caseId !== 'unknown-version-fail-closed' &&
      value.caseId !== 'active-committed-reload-export-digest')
  ) {
    throw new Error('Ink Brush acceptance contract case is malformed.');
  }
  return Object.freeze({
    caseId: value.caseId,
    owners: decodeAcceptanceOwners(value.owners),
  });
}

function isAcceptanceSlice(value: unknown): value is InkBrushAcceptanceSlice {
  return (
    typeof value === 'string' && (INK_BRUSH_ACCEPTANCE_SLICES as readonly string[]).includes(value)
  );
}
import { resolveInkBrushContract, type InkBrushContractIdentity } from './ink-brush-contract';
