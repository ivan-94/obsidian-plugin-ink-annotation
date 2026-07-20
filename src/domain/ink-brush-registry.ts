import { FOUNDATION_LEGACY_TRACE_LIMITS } from './ink-control-trace';
import type { InkBrushRenderVersion } from './ink-brush-contract';

type InkBrushSlotValue = number | string;

export interface InkBrushFixedSlot<T extends InkBrushSlotValue = InkBrushSlotValue> {
  readonly kind: 'fixed';
  readonly semantics: string;
  readonly unit: string;
  readonly value: T;
}

export interface InkBrushPendingCalibration {
  readonly acceptance: string;
  readonly kind: 'awaiting-calibration';
  readonly owner: 'S34';
  readonly unit: string;
}

export type InkBrushContractSlot<T extends InkBrushSlotValue = InkBrushSlotValue> =
  InkBrushFixedSlot<T> | InkBrushPendingCalibration;

export interface InkBrushFilterContract {
  readonly algorithm: InkBrushFixedSlot<string>;
  readonly causality: InkBrushFixedSlot<'causal-no-lookahead'>;
  readonly orientationResponse: InkBrushContractSlot;
  readonly positionFastResponse: InkBrushContractSlot;
  readonly positionSlowResponse: InkBrushContractSlot;
  readonly pressureResponse: InkBrushContractSlot;
  readonly speedReference: InkBrushContractSlot;
}

export interface InkBrushEmissionContract {
  readonly arcSpacing: InkBrushContractSlot;
  readonly geometryError: InkBrushContractSlot;
  readonly maximumTimeGap: InkBrushContractSlot;
  readonly orientationError: InkBrushContractSlot;
  readonly pressureError: InkBrushContractSlot;
}

export interface InkBrushCurveContract {
  readonly maximumScale: InkBrushContractSlot;
  readonly minimumScale: InkBrushContractSlot;
  readonly model: InkBrushFixedSlot<string>;
  readonly referenceInput: InkBrushContractSlot;
}

export interface InkBrushTiltCurveContract extends InkBrushCurveContract {
  readonly defaultAzimuth: InkBrushContractSlot;
  readonly unreliableOrientation: InkBrushFixedSlot<string>;
  readonly uprightEnterAltitude: InkBrushContractSlot;
  readonly uprightExitAltitude: InkBrushContractSlot;
}

export interface InkBrushGeometryModelContract {
  readonly cap: InkBrushFixedSlot<string>;
  readonly coverage: InkBrushFixedSlot<'legacy-round-centerline' | 'quantized-filled-contours'>;
  readonly join: InkBrushFixedSlot<string>;
}

export interface InkBrushBlendContract {
  readonly alpha: InkBrushContractSlot;
  readonly application: InkBrushFixedSlot<'once-per-logical-stroke'>;
  readonly colorSpace: InkBrushFixedSlot<'srgb'>;
  readonly composite: InkBrushFixedSlot<'source-over'>;
}

export interface InkBrushQuantizationContract {
  readonly digestAlgorithm: InkBrushFixedSlot<'fnv1a32-canonical-v1'>;
  readonly geometryGrid: InkBrushContractSlot;
  readonly sensorGrid: InkBrushContractSlot;
  readonly traceCoordinateGrid: InkBrushContractSlot;
  readonly traceTimeGrid: InkBrushContractSlot;
}

export interface InkBrushActiveContract {
  readonly finishWork: InkBrushFixedSlot<'new-stable-plus-bounded-mutable-tail'>;
  readonly maximumMutableTailSamples: InkBrushContractSlot;
  readonly mutableOwnership: InkBrushFixedSlot<'replace-entire-tail'>;
  readonly stableOwnership: InkBrushFixedSlot<'append-only'>;
}

export interface InkBrushRegistryContract {
  readonly active: InkBrushActiveContract;
  readonly blend: InkBrushBlendContract;
  readonly emission: InkBrushEmissionContract;
  readonly filter: InkBrushFilterContract;
  readonly geometry: InkBrushGeometryModelContract;
  readonly pressureCurve: InkBrushCurveContract;
  readonly quantization: InkBrushQuantizationContract;
  readonly tiltCurve: InkBrushTiltCurveContract;
  readonly velocityCurve: InkBrushCurveContract;
}

export interface InkLegacyBrushRegistration {
  readonly contract: InkBrushRegistryContract;
  readonly publication: 'published';
  readonly tools: readonly ['pen', 'highlighter'];
  readonly version: 'legacy-round-v1';
}

export interface InkCandidateBrushRegistration<
  Version extends 'highlighter-chisel-v1' | 'pen-physical-v1',
  Tool extends 'highlighter' | 'pen',
> {
  /** Test/build metadata only; never copy this field into stroke, trace, coverage, or digest. */
  readonly candidateRevision: string;
  readonly contract: InkBrushRegistryContract;
  readonly publication: 'reserved-candidate';
  readonly tools: readonly [Tool];
  readonly version: Version;
}

export type InkBrushRegistration =
  | InkCandidateBrushRegistration<'highlighter-chisel-v1', 'highlighter'>
  | InkCandidateBrushRegistration<'pen-physical-v1', 'pen'>
  | InkLegacyBrushRegistration;

export type InkBrushRegistrationFor<Version extends InkBrushRenderVersion> = Extract<
  InkBrushRegistration,
  { readonly version: Version }
>;

const NOT_APPLIED = 'not-applied' as const;

const LEGACY_CONTRACT = deepFreeze<InkBrushRegistryContract>({
  active: {
    finishWork: fixed(
      'new-stable-plus-bounded-mutable-tail',
      'work-scope',
      'Pen-up finalizes only newly stable geometry and the bounded mutable tail.',
    ),
    maximumMutableTailSamples: fixed(
      FOUNDATION_LEGACY_TRACE_LIMITS.maximumMutableTailSamples,
      'samples',
      'Foundation hard bound for the mutable control-trace tail.',
    ),
    mutableOwnership: fixed(
      'replace-entire-tail',
      'ownership',
      'Each generation replaces all mutable-tail coverage.',
    ),
    stableOwnership: fixed('append-only', 'ownership', 'Stable coverage is appended exactly once.'),
  },
  blend: blendContract(fixed('from-canonical-color', 'alpha', 'Preserve historical color alpha.')),
  emission: {
    arcSpacing: fixed(
      FOUNDATION_LEGACY_TRACE_LIMITS.maximumArcGap,
      'logical-px',
      'Maximum emitted Foundation legacy arc gap.',
    ),
    geometryError: fixed(
      FOUNDATION_LEGACY_TRACE_LIMITS.xyError,
      'logical-px',
      'Maximum Foundation legacy XY contour error.',
    ),
    maximumTimeGap: fixed(
      FOUNDATION_LEGACY_TRACE_LIMITS.maximumTimeGapMs,
      'ms',
      'Maximum time between emitted Foundation legacy points.',
    ),
    orientationError: fixed(
      FOUNDATION_LEGACY_TRACE_LIMITS.orientationExtremumEpsilon,
      'radians',
      'Orientation extremum admission epsilon.',
    ),
    pressureError: fixed(
      FOUNDATION_LEGACY_TRACE_LIMITS.pressureExtremumEpsilon,
      'normalized',
      'Pressure extremum admission epsilon.',
    ),
  },
  filter: {
    algorithm: fixed(
      'foundation-causal-legacy-v1',
      'algorithm',
      'Frozen Foundation causal reducer.',
    ),
    causality: fixed('causal-no-lookahead', 'policy', 'Future samples never affect stable state.'),
    orientationResponse: notApplied('Legacy geometry does not filter orientation.'),
    positionFastResponse: notApplied('Legacy reduction has no fast-response filter cutoff.'),
    positionSlowResponse: notApplied('Legacy reduction has no slow-response filter cutoff.'),
    pressureResponse: notApplied('Legacy geometry does not filter pressure for width.'),
    speedReference: notApplied('Legacy reduction has no speed-adaptive transition.'),
  },
  geometry: {
    cap: fixed('round', 'shape', 'Historical round-cap semantics.'),
    coverage: fixed(
      'legacy-round-centerline',
      'coverage',
      'Renderer-neutral equivalent of the historical round centerline.',
    ),
    join: fixed('round', 'shape', 'Historical round-join semantics.'),
  },
  pressureCurve: noCurve('fixed-width', 'Legacy pressure does not alter geometry width.'),
  quantization: {
    digestAlgorithm: fixed(
      'fnv1a32-canonical-v1',
      'algorithm',
      'Deterministic canonical byte digest.',
    ),
    geometryGrid: fixed(0.0001, 'logical-px', 'Frozen legacy geometry digest grid.'),
    sensorGrid: fixed(0.0001, 'normalized-or-radians', 'Frozen legacy sensor digest grid.'),
    traceCoordinateGrid: fixed(0.0001, 'logical-px', 'Frozen legacy trace digest grid.'),
    traceTimeGrid: fixed(0.0001, 'ms', 'Frozen legacy time digest grid.'),
  },
  tiltCurve: {
    ...noCurve('preserved-not-rendered', 'Legacy orientation is retained but not rendered.'),
    defaultAzimuth: notApplied('Legacy round geometry has no nib direction.'),
    unreliableOrientation: fixed(
      'preserve-availability',
      'policy',
      'Availability is retained without inventing a physical orientation.',
    ),
    uprightEnterAltitude: notApplied('Legacy round geometry has no upright hysteresis.'),
    uprightExitAltitude: notApplied('Legacy round geometry has no upright hysteresis.'),
  },
  velocityCurve: noCurve('none', 'Legacy geometry has no velocity response.'),
});

const PEN_CANDIDATE_CONTRACT = deepFreeze<InkBrushRegistryContract>({
  active: physicalActive('Pen'),
  blend: blendContract(fixed(1, 'alpha', 'Pen is opaque sRGB source-over.')),
  emission: physicalEmission('Pen'),
  filter: physicalFilter('Pen'),
  geometry: {
    cap: fixed('round-contact-footprint', 'shape', 'A Pen cap is its circular contact footprint.'),
    coverage: fixed(
      'quantized-filled-contours',
      'coverage',
      'Pen emits renderer-neutral filled contours.',
    ),
    join: fixed('bounded-round', 'shape', 'Pen joins are round with bounded extent.'),
  },
  pressureCurve: physicalCurve(
    'monotonic-nondecreasing-bounded',
    'Pen pressure is the primary diameter signal.',
    'Pen pressure',
  ),
  quantization: physicalQuantization('Pen'),
  tiltCurve: {
    ...noCurve('preserved-not-rendered', 'Pen remains circular while retaining orientation data.'),
    defaultAzimuth: notApplied('A circular Pen nib has no default direction.'),
    unreliableOrientation: fixed(
      'preserve-availability',
      'policy',
      'Pen preserves orientation reliability without changing the circular nib.',
    ),
    uprightEnterAltitude: notApplied('A circular Pen nib has no upright hysteresis.'),
    uprightExitAltitude: notApplied('A circular Pen nib has no upright hysteresis.'),
  },
  velocityCurve: physicalCurve(
    'monotonic-nonincreasing-bounded',
    'Pen velocity adds restrained thinning and never removes contact.',
    'Pen velocity',
  ),
});

const HIGHLIGHTER_CANDIDATE_CONTRACT = deepFreeze<InkBrushRegistryContract>({
  active: physicalActive('Highlighter'),
  blend: blendContract(
    pending('alpha', 'Freeze one optical density per Highlighter Logical Stroke.'),
  ),
  emission: physicalEmission('Highlighter'),
  filter: physicalFilter('Highlighter'),
  geometry: {
    cap: fixed(
      'rounded-chisel-footprint',
      'shape',
      'Start and end retain the oriented chisel footprint.',
    ),
    coverage: fixed(
      'quantized-filled-contours',
      'coverage',
      'Highlighter emits the union of swept rounded-chisel contours.',
    ),
    join: fixed(
      'swept-chisel-union',
      'shape',
      'Adjacent chisel footprints form one coverage union.',
    ),
  },
  pressureCurve: physicalCurve(
    'bounded-chisel-scale',
    'Pressure changes chisel footprint size, never alpha.',
    'Highlighter pressure',
  ),
  quantization: physicalQuantization('Highlighter'),
  tiltCurve: {
    maximumScale: pending('aspect-ratio', 'Freeze maximum Highlighter chisel aspect ratio.'),
    minimumScale: pending('aspect-ratio', 'Freeze minimum Highlighter chisel aspect ratio.'),
    model: fixed(
      'reliable-chisel-with-upright-hysteresis',
      'curve',
      'Reliable logical orientation controls one rounded chisel nib.',
    ),
    referenceInput: pending('radians', 'Freeze the Highlighter reference altitude.'),
    defaultAzimuth: pending('radians', 'Freeze the no-reliable-orientation default azimuth.'),
    unreliableOrientation: fixed(
      'hold-last-reliable',
      'policy',
      'Unreliable samples hold the prior reliable nib direction.',
    ),
    uprightEnterAltitude: pending('radians', 'Freeze upright-hysteresis enter altitude.'),
    uprightExitAltitude: pending('radians', 'Freeze upright-hysteresis exit altitude.'),
  },
  velocityCurve: noCurve(
    'none',
    'Velocity affects filtering and emission only, not Highlighter size or density.',
  ),
});

const REGISTRY = deepFreeze<Record<InkBrushRenderVersion, InkBrushRegistration>>({
  'highlighter-chisel-v1': {
    candidateRevision: 's28-contract-r1',
    contract: HIGHLIGHTER_CANDIDATE_CONTRACT,
    publication: 'reserved-candidate',
    tools: ['highlighter'],
    version: 'highlighter-chisel-v1',
  },
  'legacy-round-v1': {
    contract: LEGACY_CONTRACT,
    publication: 'published',
    tools: ['pen', 'highlighter'],
    version: 'legacy-round-v1',
  },
  'pen-physical-v1': {
    candidateRevision: 's28-contract-r1',
    contract: PEN_CANDIDATE_CONTRACT,
    publication: 'reserved-candidate',
    tools: ['pen'],
    version: 'pen-physical-v1',
  },
});

/** Closed lookup: versions are frozen here; no registration or mutation Interface is exposed. */
export function getInkBrushRegistration<Version extends InkBrushRenderVersion>(
  version: Version,
): InkBrushRegistrationFor<Version> {
  const registration = (REGISTRY as Readonly<Record<string, InkBrushRegistration>>)[version];
  if (registration === undefined) throw new Error(`Unknown Ink Brush Render Version: ${version}`);
  return registration as InkBrushRegistrationFor<Version>;
}

function physicalActive(brush: 'Highlighter' | 'Pen'): InkBrushActiveContract {
  return {
    finishWork: fixed(
      'new-stable-plus-bounded-mutable-tail',
      'work-scope',
      `${brush} pen-up never scans the full stable prefix.`,
    ),
    maximumMutableTailSamples: pending(
      'samples',
      `Freeze the ${brush} mutable-tail hard bound and prove O(new + tail) work.`,
    ),
    mutableOwnership: fixed(
      'replace-entire-tail',
      'ownership',
      `${brush} mutable coverage is replaced as one bounded tail.`,
    ),
    stableOwnership: fixed(
      'append-only',
      'ownership',
      `${brush} stable coverage is appended exactly once.`,
    ),
  };
}

function physicalEmission(brush: 'Highlighter' | 'Pen'): InkBrushEmissionContract {
  return {
    arcSpacing: pending('logical-px', `Freeze ${brush} arc-length emission spacing.`),
    geometryError: pending('logical-px', `Freeze ${brush} quantized contour error.`),
    maximumTimeGap: pending('ms', `Freeze ${brush} maximum trace emission interval.`),
    orientationError: pending('radians', `Freeze ${brush} orientation contour error.`),
    pressureError: pending('normalized', `Freeze ${brush} pressure contour error.`),
  };
}

function physicalFilter(brush: 'Highlighter' | 'Pen'): InkBrushFilterContract {
  return {
    algorithm: fixed(
      'causal-speed-adaptive-v1',
      'algorithm',
      `${brush} uses a causal speed-adaptive filter without look-ahead.`,
    ),
    causality: fixed('causal-no-lookahead', 'policy', 'Future samples never affect stable state.'),
    orientationResponse: pending('response', `Freeze ${brush} orientation filter response.`),
    positionFastResponse: pending('response', `Freeze ${brush} high-speed position response.`),
    positionSlowResponse: pending('response', `Freeze ${brush} low-speed position response.`),
    pressureResponse: pending('response', `Freeze ${brush} pressure filter response.`),
    speedReference: pending('logical-px-per-ms', `Freeze ${brush} filter speed reference.`),
  };
}

function physicalCurve(model: string, semantics: string, label: string): InkBrushCurveContract {
  return {
    maximumScale: pending('ratio', `Freeze ${label} maximum scale.`),
    minimumScale: pending('ratio', `Freeze ${label} minimum non-zero scale.`),
    model: fixed(model, 'curve', semantics),
    referenceInput: pending('normalized', `Freeze ${label} reference input.`),
  };
}

function physicalQuantization(brush: 'Highlighter' | 'Pen'): InkBrushQuantizationContract {
  return {
    digestAlgorithm: fixed(
      'fnv1a32-canonical-v1',
      'algorithm',
      'Deterministic canonical byte digest.',
    ),
    geometryGrid: pending('logical-px', `Freeze ${brush} geometry quantization grid.`),
    sensorGrid: pending(
      'normalized-or-radians',
      `Freeze ${brush} pressure/orientation quantization grid.`,
    ),
    traceCoordinateGrid: pending('logical-px', `Freeze ${brush} trace coordinate grid.`),
    traceTimeGrid: pending('ms', `Freeze ${brush} trace time grid.`),
  };
}

function blendContract(alpha: InkBrushContractSlot): InkBrushBlendContract {
  return {
    alpha,
    application: fixed(
      'once-per-logical-stroke',
      'application',
      'Coverage is unioned before optical density is applied.',
    ),
    colorSpace: fixed('srgb', 'color-space', 'Canonical brush colors use sRGB.'),
    composite: fixed('source-over', 'composite', 'Distinct Logical Strokes use source-over.'),
  };
}

function noCurve(model: string, semantics: string): InkBrushCurveContract {
  return {
    maximumScale: notApplied('This curve does not alter the upper scale.'),
    minimumScale: notApplied('This curve does not alter the lower scale.'),
    model: fixed(model, 'curve', semantics),
    referenceInput: notApplied('This curve has no reference input.'),
  };
}

function notApplied(semantics: string): InkBrushFixedSlot<typeof NOT_APPLIED> {
  return fixed(NOT_APPLIED, 'not-applicable', semantics);
}

function fixed<T extends InkBrushSlotValue>(
  value: T,
  unit: string,
  semantics: string,
): InkBrushFixedSlot<T> {
  return { kind: 'fixed', semantics, unit, value };
}

function pending(unit: string, acceptance: string): InkBrushPendingCalibration {
  return { acceptance, kind: 'awaiting-calibration', owner: 'S34', unit };
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen);
  }
  return Object.freeze(value);
}
