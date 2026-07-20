import type {
  InkBrushInputProfile,
  InkBrushRenderVersion,
  InkLegacyBrushInputProfile,
  InkPhysicalBrushInputProfile,
  InkVisibleBrushTool,
} from './ink-brush-contract';
import { digestInkBrushGolden } from './ink-brush-contract';

interface InkBrushLogicalStrokeHeaderBase {
  readonly color: string;
  readonly logicalStrokeId: string;
  readonly nominalWidth: number;
}

export interface InkLegacyBrushLogicalStrokeHeader extends InkBrushLogicalStrokeHeaderBase {
  readonly inputProfile: InkLegacyBrushInputProfile;
  readonly tool: InkVisibleBrushTool;
  readonly version: 'legacy-round-v1';
}

export interface InkPenPhysicalLogicalStrokeHeader extends InkBrushLogicalStrokeHeaderBase {
  readonly inputProfile: InkPhysicalBrushInputProfile;
  readonly tool: 'pen';
  readonly version: 'pen-physical-v1';
}

export interface InkHighlighterPhysicalLogicalStrokeHeader extends InkBrushLogicalStrokeHeaderBase {
  readonly inputProfile: InkPhysicalBrushInputProfile;
  readonly tool: 'highlighter';
  readonly version: 'highlighter-chisel-v1';
}

export type InkBrushLogicalStrokeHeader =
  | InkHighlighterPhysicalLogicalStrokeHeader
  | InkLegacyBrushLogicalStrokeHeader
  | InkPenPhysicalLogicalStrokeHeader;

export interface InkLegacyBrushControlPoint {
  readonly orientation: { readonly kind: 'legacy-unknown' };
  readonly pressure: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export interface InkLegacyBrushControlTrace {
  readonly kind: 'legacy-round-control-trace';
  readonly points: readonly InkLegacyBrushControlPoint[];
}

export interface InkPhysicalBrushOrientation {
  readonly altitude: number;
  readonly azimuth: number;
  readonly kind: 'measured';
  readonly reliable: boolean;
}

export interface InkUnavailableBrushOrientation {
  readonly kind: 'unavailable';
}

export interface InkPhysicalBrushControlPoint {
  readonly orientation: InkPhysicalBrushOrientation | InkUnavailableBrushOrientation;
  readonly pressure: {
    readonly kind: 'measured' | 'unavailable';
    readonly value: number;
  };
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export interface InkPhysicalBrushControlTrace {
  readonly kind: 'physical-control-trace';
  readonly points: readonly InkPhysicalBrushControlPoint[];
}

export type InkBrushControlTrace = InkLegacyBrushControlTrace | InkPhysicalBrushControlTrace;

export type InkBrushLogicalStroke =
  | {
      readonly header: InkHighlighterPhysicalLogicalStrokeHeader;
      readonly trace: InkPhysicalBrushControlTrace;
    }
  | {
      readonly header: InkLegacyBrushLogicalStrokeHeader;
      readonly trace: InkLegacyBrushControlTrace;
    }
  | {
      readonly header: InkPenPhysicalLogicalStrokeHeader;
      readonly trace: InkPhysicalBrushControlTrace;
    };

export type InkBrushLogicalStrokeDecodeResult =
  | { readonly kind: 'invalid'; readonly reason: 'invalid-canonical-stroke' }
  | { readonly kind: 'unsupported'; readonly reason: 'unknown-version'; readonly version: string }
  | { readonly kind: 'valid'; readonly stroke: InkBrushLogicalStroke };

export interface InkBrushTraceQuantization {
  readonly coordinateGrid: number;
  readonly sensorGrid: number;
  readonly timeGridMs: number;
}

export interface InkQuantizedBrushPoint {
  readonly x: number;
  readonly y: number;
}

export interface InkLegacyRoundCoverage {
  readonly centerline: readonly InkQuantizedBrushPoint[];
  readonly diameterUnits: number;
  readonly kind: 'legacy-round-centerline';
}

export interface InkFilledContourCoverage {
  readonly contours: readonly (readonly InkQuantizedBrushPoint[])[];
  readonly kind: 'quantized-filled-contours';
}

export type InkBrushCoverage = InkFilledContourCoverage | InkLegacyRoundCoverage;

export interface InkBrushGeometryBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export type InkBrushHitShape =
  | { readonly kind: 'filled-contour-distance'; readonly fillRule: 'nonzero' }
  | { readonly kind: 'round-centerline-distance'; readonly radius: number };

export type InkBrushBlendAlpha =
  { readonly kind: 'fixed'; readonly value: number } | { readonly kind: 'from-canonical-color' };

export interface InkBrushBlendSemantics<Alpha extends InkBrushBlendAlpha = InkBrushBlendAlpha> {
  readonly alpha: Alpha;
  readonly application: 'once-per-logical-stroke';
  readonly colorSpace: 'srgb';
  readonly composite: 'source-over';
}

interface InkCompiledBrushGeometryBase {
  readonly bounds: InkBrushGeometryBounds;
  readonly color: string;
  readonly geometryDigest: string;
  readonly logicalStrokeId: string;
  readonly quantization: { readonly logicalGrid: number };
  readonly traceDigest: string;
}

export type InkCompiledBrushGeometry =
  | (InkCompiledBrushGeometryBase & {
      readonly blend: InkBrushBlendSemantics<{ readonly kind: 'fixed'; readonly value: number }>;
      readonly coverage: InkFilledContourCoverage;
      readonly hitShape: Extract<InkBrushHitShape, { readonly kind: 'filled-contour-distance' }>;
      readonly tool: 'highlighter';
      readonly version: 'highlighter-chisel-v1';
    })
  | (InkCompiledBrushGeometryBase & {
      readonly blend: InkBrushBlendSemantics<{ readonly kind: 'from-canonical-color' }>;
      readonly coverage: InkLegacyRoundCoverage;
      readonly hitShape: Extract<InkBrushHitShape, { readonly kind: 'round-centerline-distance' }>;
      readonly tool: InkVisibleBrushTool;
      readonly version: 'legacy-round-v1';
    })
  | (InkCompiledBrushGeometryBase & {
      readonly blend: InkBrushBlendSemantics<{ readonly kind: 'fixed'; readonly value: 1 }>;
      readonly coverage: InkFilledContourCoverage;
      readonly hitShape: Extract<InkBrushHitShape, { readonly kind: 'filled-contour-distance' }>;
      readonly tool: 'pen';
      readonly version: 'pen-physical-v1';
    });

/**
 * Process-local ownership transfer from the incremental Active compiler to the committed renderer.
 *
 * Unlike `InkCompiledBrushGeometry`, this transient representation deliberately has no trace or
 * geometry digest and keeps immutable coverage chunks instead of materializing one full contour
 * array. It is never serialized; a cold reload may compile canonical geometry normally.
 */
export interface InkPromotedBrushGeometry {
  readonly blend: InkBrushBlendSemantics<{ readonly kind: 'fixed'; readonly value: number }>;
  readonly bounds: InkBrushGeometryBounds;
  readonly color: string;
  readonly coverageChunks: readonly (readonly InkFilledContourCoverage[])[];
  readonly hitShape: Extract<InkBrushHitShape, { readonly kind: 'filled-contour-distance' }>;
  readonly logicalStrokeId: string;
  readonly ownershipTransfer: 'active-to-committed-without-recompile';
  readonly quantization: { readonly logicalGrid: number };
  readonly tool: 'highlighter' | 'pen';
  readonly version: 'highlighter-chisel-v1' | 'pen-physical-v1';
}

export type InkBrushCompiledGeometryDecodeResult =
  | { readonly kind: 'invalid'; readonly reason: 'invalid-geometry' }
  | { readonly kind: 'unsupported'; readonly reason: 'unknown-version'; readonly version: string }
  | { readonly geometry: InkCompiledBrushGeometry; readonly kind: 'valid' };

export type InkBrushCompilationResult =
  | {
      readonly diagnostic: 'known-version-geometry-failure';
      readonly geometry: InkCompiledBrushGeometry;
      readonly kind: 'degraded';
      readonly requestedVersion: Exclude<InkBrushRenderVersion, 'legacy-round-v1'>;
    }
  | { readonly geometry: InkCompiledBrushGeometry; readonly kind: 'exact' }
  | {
      readonly kind: 'unsupported';
      readonly reason: 'invalid-canonical-stroke' | 'unknown-version';
      readonly requestedVersion: string;
    }
  | { readonly geometry: InkCompiledBrushGeometry; readonly kind: 'unpublished' };

export type InkBrushCompilationResultDecode =
  | { readonly kind: 'invalid'; readonly reason: 'invalid-compilation-result' }
  | { readonly kind: 'valid'; readonly result: InkBrushCompilationResult };

export interface InkBrushActiveTraceDelta {
  /** Newly stable points only; previously stable points are never supplied again. */
  readonly stableAppend: InkBrushControlTrace;
  /** The complete bounded mutable tail replacement for this generation. */
  readonly mutableReplacement: InkBrushControlTrace;
}

export interface InkBrushStableCoverageAppend {
  readonly coverage: readonly InkBrushCoverage[];
  readonly kind: 'append-only-stable';
}

export interface InkBrushMutableCoverageReplacement {
  readonly coverage: readonly InkBrushCoverage[];
  readonly generation: number;
  readonly kind: 'replace-bounded-mutable-tail';
}

interface InkBrushActiveGeometryUpdateBase {
  readonly logicalStrokeId: string;
  readonly mutable: InkBrushMutableCoverageReplacement;
  readonly quantization: { readonly logicalGrid: number };
  readonly stable: InkBrushStableCoverageAppend;
  readonly version: InkBrushRenderVersion;
  readonly workScope: 'new-stable-plus-bounded-mutable-tail';
}

export interface InkBrushActiveGeometryDelta extends InkBrushActiveGeometryUpdateBase {
  readonly kind: 'active-delta';
}

export interface InkBrushActiveGeometryFinish extends InkBrushActiveGeometryUpdateBase {
  /** Whole-stroke bounds accumulated incrementally; no finish-time prefix scan is permitted. */
  readonly bounds: InkBrushGeometryBounds;
  readonly kind: 'active-finish';
  readonly ownershipTransfer: 'active-to-committed-without-blank-frame';
}

export type InkBrushActiveGeometryUpdate =
  InkBrushActiveGeometryDelta | InkBrushActiveGeometryFinish;

/**
 * Closed incremental compiler seam. `finish` accepts the same delta-only shape as `extend`; there
 * is deliberately no full-prefix or full-stroke input that could authorize a pen-up rescan.
 */
export interface InkBrushActiveGeometryCompiler {
  extend(delta: InkBrushActiveTraceDelta): InkBrushActiveGeometryDelta;
  finish(delta: InkBrushActiveTraceDelta): InkBrushActiveGeometryFinish;
}

const COMPILED_GEOMETRY_INPUT_KEYS = Object.freeze([
  'blend',
  'bounds',
  'color',
  'coverage',
  'hitShape',
  'logicalStrokeId',
  'quantization',
  'tool',
  'traceDigest',
  'version',
] as const);

const COMPILED_GEOMETRY_KEYS = Object.freeze([
  ...COMPILED_GEOMETRY_INPUT_KEYS,
  'geometryDigest',
] as const);

export function createInkBrushLogicalStroke(input: unknown): InkBrushLogicalStroke {
  const decoded = decodeInkBrushLogicalStroke(input);
  if (decoded.kind !== 'valid') {
    throw new Error(
      decoded.kind === 'unsupported'
        ? `Unsupported Ink Brush Render Version: ${decoded.version}`
        : 'Invalid canonical Ink Brush Logical Stroke.',
    );
  }
  return decoded.stroke;
}

export function decodeInkBrushLogicalStroke(input: unknown): InkBrushLogicalStrokeDecodeResult {
  try {
    if (!isExactRecord(input, ['header', 'trace'])) return invalidStroke();
    const decodedHeader = decodeHeader(input.header);
    if (decodedHeader.kind !== 'valid-header') return decodedHeader.result;
    const trace =
      decodedHeader.header.version === 'legacy-round-v1'
        ? decodeLegacyTrace(input.trace)
        : decodePhysicalTrace(input.trace);
    if (trace === null || !traceMatchesHeader(trace, decodedHeader.header)) return invalidStroke();
    return Object.freeze({
      kind: 'valid',
      stroke: Object.freeze({ header: decodedHeader.header, trace }) as InkBrushLogicalStroke,
    });
  } catch {
    return invalidStroke();
  }
}

export function digestInkBrushControlTrace(
  stroke: InkBrushLogicalStroke,
  quantization: InkBrushTraceQuantization,
): string {
  assertTraceQuantization(quantization);
  const points = stroke.trace.points.map((point) => {
    if (stroke.trace.kind === 'legacy-round-control-trace') {
      const legacyPoint = point as InkLegacyBrushControlPoint;
      return {
        orientation: 'legacy-unknown',
        pressure: quantizeToGrid(legacyPoint.pressure, quantization.sensorGrid),
        time: quantizeToGrid(legacyPoint.time, quantization.timeGridMs),
        x: quantizeToGrid(legacyPoint.x, quantization.coordinateGrid),
        y: quantizeToGrid(legacyPoint.y, quantization.coordinateGrid),
      };
    }
    const physicalPoint = point as InkPhysicalBrushControlPoint;
    return {
      orientation:
        physicalPoint.orientation.kind === 'unavailable'
          ? { kind: 'unavailable' }
          : {
              altitude: quantizeToGrid(physicalPoint.orientation.altitude, quantization.sensorGrid),
              azimuth: quantizeToGrid(physicalPoint.orientation.azimuth, quantization.sensorGrid),
              kind: 'measured',
              reliable: physicalPoint.orientation.reliable,
            },
      pressure: {
        kind: physicalPoint.pressure.kind,
        value: quantizeToGrid(physicalPoint.pressure.value, quantization.sensorGrid),
      },
      time: quantizeToGrid(physicalPoint.time, quantization.timeGridMs),
      x: quantizeToGrid(physicalPoint.x, quantization.coordinateGrid),
      y: quantizeToGrid(physicalPoint.y, quantization.coordinateGrid),
    };
  });
  return digestInkBrushGolden({
    inputProfile: stroke.header.inputProfile,
    kind: stroke.trace.kind,
    points,
    quantization,
    version: stroke.header.version,
  });
}

export function createInkBrushCompiledGeometry(input: unknown): InkCompiledBrushGeometry {
  const decoded = decodeInkBrushCompiledGeometry(input);
  if (decoded.kind !== 'valid') {
    throw new Error(
      decoded.kind === 'unsupported'
        ? `Unsupported Ink Brush Render Version: ${decoded.version}`
        : 'Invalid renderer-neutral Ink Brush geometry.',
    );
  }
  return decoded.geometry;
}

export function decodeInkBrushCompiledGeometry(
  input: unknown,
): InkBrushCompiledGeometryDecodeResult {
  try {
    if (
      isExactRecord(input, COMPILED_GEOMETRY_INPUT_KEYS) &&
      typeof input.version === 'string' &&
      !isBrushVersion(input.version)
    ) {
      return Object.freeze({
        kind: 'unsupported',
        reason: 'unknown-version',
        version: input.version,
      });
    }
    return Object.freeze({ geometry: constructInkBrushCompiledGeometry(input), kind: 'valid' });
  } catch {
    return Object.freeze({ kind: 'invalid', reason: 'invalid-geometry' });
  }
}

export function createInkBrushCompilationResult(input: unknown): InkBrushCompilationResult {
  const decoded = decodeInkBrushCompilationResult(input);
  if (decoded.kind !== 'valid') throw new Error('Invalid Ink Brush compilation result.');
  return decoded.result;
}

export function decodeInkBrushCompilationResult(input: unknown): InkBrushCompilationResultDecode {
  try {
    const kind =
      typeof input === 'object' && input !== null ? (Reflect.get(input, 'kind') as unknown) : null;
    if (!isExactRecord(input, compilationResultKeys(kind))) return invalidCompilationResult();
    if (input.kind === 'unsupported') {
      if (
        typeof input.requestedVersion !== 'string' ||
        input.requestedVersion.length === 0 ||
        (input.reason !== 'unknown-version' && input.reason !== 'invalid-canonical-stroke') ||
        (input.reason === 'unknown-version' && isBrushVersion(input.requestedVersion))
      ) {
        return invalidCompilationResult();
      }
      return validCompilationResult(
        Object.freeze({
          kind: 'unsupported',
          reason: input.reason,
          requestedVersion: input.requestedVersion,
        }),
      );
    }
    const geometry = decodeExistingCompiledGeometry(input.geometry);
    if (geometry === null) return invalidCompilationResult();
    if (input.kind === 'exact') {
      return validCompilationResult(Object.freeze({ geometry, kind: 'exact' }));
    }
    if (input.kind === 'unpublished') {
      if (geometry.version === 'legacy-round-v1') return invalidCompilationResult();
      return validCompilationResult(Object.freeze({ geometry, kind: 'unpublished' }));
    }
    if (
      input.kind !== 'degraded' ||
      input.diagnostic !== 'known-version-geometry-failure' ||
      (input.requestedVersion !== 'pen-physical-v1' &&
        input.requestedVersion !== 'highlighter-chisel-v1') ||
      geometry.version !== 'legacy-round-v1'
    ) {
      return invalidCompilationResult();
    }
    return validCompilationResult(
      Object.freeze({
        diagnostic: 'known-version-geometry-failure',
        geometry,
        kind: 'degraded',
        requestedVersion: input.requestedVersion,
      }),
    );
  } catch {
    return invalidCompilationResult();
  }
}

export function createInkBrushActiveGeometryUpdate(input: unknown): InkBrushActiveGeometryUpdate {
  try {
    const kind =
      typeof input === 'object' && input !== null ? (Reflect.get(input, 'kind') as unknown) : null;
    if (
      !isExactRecord(input, activeGeometryUpdateKeys(kind)) ||
      (input.kind !== 'active-delta' && input.kind !== 'active-finish') ||
      typeof input.logicalStrokeId !== 'string' ||
      input.logicalStrokeId.length === 0 ||
      typeof input.version !== 'string' ||
      !isBrushVersion(input.version) ||
      !isExactRecord(input.quantization, ['logicalGrid']) ||
      !isPositiveFinite(input.quantization.logicalGrid)
    ) {
      throw new Error('invalid-update');
    }
    const stable = decodeStableCoverageAppend(input.stable, input.version);
    const mutable = decodeMutableCoverageReplacement(input.mutable, input.version);
    if (
      stable === null ||
      mutable === null ||
      input.workScope !== 'new-stable-plus-bounded-mutable-tail'
    ) {
      throw new Error('invalid-ownership');
    }
    const base = {
      logicalStrokeId: input.logicalStrokeId,
      mutable,
      quantization: Object.freeze({ logicalGrid: input.quantization.logicalGrid }),
      stable,
      version: input.version,
      workScope: 'new-stable-plus-bounded-mutable-tail' as const,
    };
    if (input.kind === 'active-delta') {
      return Object.freeze({ ...base, kind: 'active-delta' });
    }
    if (input.ownershipTransfer !== 'active-to-committed-without-blank-frame') {
      throw new Error('invalid-transfer');
    }
    const bounds = decodeBounds(input.bounds);
    if (bounds === null) throw new Error('invalid-bounds');
    return Object.freeze({
      ...base,
      bounds,
      kind: 'active-finish',
      ownershipTransfer: 'active-to-committed-without-blank-frame',
    });
  } catch {
    throw new Error('Invalid active Ink Brush geometry update.');
  }
}

function constructInkBrushCompiledGeometry(input: unknown): InkCompiledBrushGeometry {
  try {
    if (
      !isExactRecord(input, COMPILED_GEOMETRY_INPUT_KEYS) ||
      typeof input.version !== 'string' ||
      !isBrushVersion(input.version) ||
      typeof input.logicalStrokeId !== 'string' ||
      input.logicalStrokeId.length === 0 ||
      typeof input.color !== 'string' ||
      input.color.length === 0 ||
      (input.tool !== 'pen' && input.tool !== 'highlighter') ||
      typeof input.traceDigest !== 'string' ||
      !/^[0-9a-f]{8}$/u.test(input.traceDigest) ||
      !isExactRecord(input.quantization, ['logicalGrid']) ||
      !isPositiveFinite(input.quantization.logicalGrid)
    ) {
      throw new Error('invalid-header');
    }
    const coverage =
      input.version === 'legacy-round-v1'
        ? decodeLegacyCoverage(input.coverage)
        : decodeFilledContourCoverage(input.coverage);
    const bounds = decodeBounds(input.bounds);
    const hitShape =
      input.version === 'legacy-round-v1'
        ? decodeLegacyHitShape(input.hitShape)
        : decodeFilledContourHitShape(input.hitShape);
    const blend = decodeBlend(input.blend);
    if (
      coverage === null ||
      bounds === null ||
      hitShape === null ||
      blend === null ||
      !geometryIdentityMatchesVersion(input.version, input.tool, input.color, coverage, blend) ||
      !boundsContainCoverage(bounds, coverage, input.quantization.logicalGrid) ||
      !hitShapeMatchesCoverage(hitShape, coverage, input.quantization.logicalGrid)
    ) {
      throw new Error('invalid-geometry');
    }
    const geometryWithoutDigest = Object.freeze({
      blend,
      bounds,
      color: input.color,
      coverage,
      hitShape,
      logicalStrokeId: input.logicalStrokeId,
      quantization: Object.freeze({ logicalGrid: input.quantization.logicalGrid }),
      tool: input.tool,
      traceDigest: input.traceDigest,
      version: input.version,
    });
    return Object.freeze({
      ...geometryWithoutDigest,
      geometryDigest: digestGeometry(geometryWithoutDigest),
    }) as InkCompiledBrushGeometry;
  } catch {
    throw new Error('Invalid renderer-neutral Ink Brush geometry.');
  }
}

function decodeExistingCompiledGeometry(value: unknown): InkCompiledBrushGeometry | null {
  if (!isExactRecord(value, COMPILED_GEOMETRY_KEYS) || typeof value.geometryDigest !== 'string') {
    return null;
  }
  const decoded = decodeInkBrushCompiledGeometry({
    blend: value.blend,
    bounds: value.bounds,
    color: value.color,
    coverage: value.coverage,
    hitShape: value.hitShape,
    logicalStrokeId: value.logicalStrokeId,
    quantization: value.quantization,
    tool: value.tool,
    traceDigest: value.traceDigest,
    version: value.version,
  });
  return decoded.kind === 'valid' && decoded.geometry.geometryDigest === value.geometryDigest
    ? decoded.geometry
    : null;
}

function compilationResultKeys(kind: unknown): readonly string[] {
  if (kind === 'unsupported') return ['kind', 'reason', 'requestedVersion'];
  if (kind === 'degraded') {
    return ['diagnostic', 'geometry', 'kind', 'requestedVersion'];
  }
  return ['geometry', 'kind'];
}

function activeGeometryUpdateKeys(kind: unknown): readonly string[] {
  return kind === 'active-finish'
    ? [
        'bounds',
        'kind',
        'logicalStrokeId',
        'mutable',
        'ownershipTransfer',
        'quantization',
        'stable',
        'version',
        'workScope',
      ]
    : ['kind', 'logicalStrokeId', 'mutable', 'quantization', 'stable', 'version', 'workScope'];
}

function invalidCompilationResult(): Extract<
  InkBrushCompilationResultDecode,
  { readonly kind: 'invalid' }
> {
  return Object.freeze({ kind: 'invalid', reason: 'invalid-compilation-result' });
}

function validCompilationResult(
  result: InkBrushCompilationResult,
): Extract<InkBrushCompilationResultDecode, { readonly kind: 'valid' }> {
  return Object.freeze({ kind: 'valid', result });
}

type HeaderDecode =
  | { readonly header: InkBrushLogicalStrokeHeader; readonly kind: 'valid-header' }
  | {
      readonly kind: 'invalid-header';
      readonly result: Exclude<InkBrushLogicalStrokeDecodeResult, { readonly kind: 'valid' }>;
    };

function decodeHeader(value: unknown): HeaderDecode {
  if (
    !isExactRecord(value, [
      'color',
      'inputProfile',
      'logicalStrokeId',
      'nominalWidth',
      'tool',
      'version',
    ]) ||
    typeof value.version !== 'string'
  ) {
    return invalidHeader(invalidStroke());
  }
  if (!isBrushVersion(value.version)) {
    return invalidHeader(
      Object.freeze({ kind: 'unsupported', reason: 'unknown-version', version: value.version }),
    );
  }
  if (
    typeof value.color !== 'string' ||
    value.color.length === 0 ||
    typeof value.logicalStrokeId !== 'string' ||
    value.logicalStrokeId.length === 0 ||
    !isPositiveFinite(value.nominalWidth) ||
    (value.tool !== 'pen' && value.tool !== 'highlighter') ||
    !isInputProfile(value.inputProfile)
  ) {
    return invalidHeader(invalidStroke());
  }
  if (
    (value.version === 'legacy-round-v1' &&
      (value.inputProfile.pressure !== 'legacy-unknown' ||
        value.inputProfile.tilt !== 'legacy-unknown')) ||
    (value.version !== 'legacy-round-v1' &&
      (value.inputProfile.pressure === 'legacy-unknown' ||
        (value.version === 'pen-physical-v1'
          ? value.tool !== 'pen'
          : value.tool !== 'highlighter')))
  ) {
    return invalidHeader(invalidStroke());
  }
  return {
    header: Object.freeze({
      color: value.color,
      inputProfile: Object.freeze({ ...value.inputProfile }),
      logicalStrokeId: value.logicalStrokeId,
      nominalWidth: value.nominalWidth,
      tool: value.tool,
      version: value.version,
    }) as InkBrushLogicalStrokeHeader,
    kind: 'valid-header',
  };
}

function decodeLegacyTrace(value: unknown): InkLegacyBrushControlTrace | null {
  if (
    !isExactRecord(value, ['kind', 'points']) ||
    value.kind !== 'legacy-round-control-trace' ||
    !Array.isArray(value.points) ||
    value.points.length === 0
  ) {
    return null;
  }
  const points: InkLegacyBrushControlPoint[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const source of value.points as unknown[]) {
    if (
      !isExactRecord(source, ['orientation', 'pressure', 'time', 'x', 'y']) ||
      !isExactRecord(source.orientation, ['kind']) ||
      source.orientation.kind !== 'legacy-unknown' ||
      !isFiniteNumber(source.pressure) ||
      !isFiniteNumber(source.time) ||
      !isFiniteNumber(source.x) ||
      !isFiniteNumber(source.y) ||
      source.time < previousTime
    ) {
      return null;
    }
    previousTime = source.time;
    points.push(
      Object.freeze({
        orientation: Object.freeze({ kind: 'legacy-unknown' }),
        pressure: source.pressure,
        time: source.time,
        x: source.x,
        y: source.y,
      }),
    );
  }
  return Object.freeze({
    kind: 'legacy-round-control-trace',
    points: Object.freeze(points),
  });
}

function decodePhysicalTrace(value: unknown): InkPhysicalBrushControlTrace | null {
  if (
    !isExactRecord(value, ['kind', 'points']) ||
    value.kind !== 'physical-control-trace' ||
    !Array.isArray(value.points) ||
    value.points.length === 0
  ) {
    return null;
  }
  const points: InkPhysicalBrushControlPoint[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const source of value.points as unknown[]) {
    if (
      !isExactRecord(source, ['orientation', 'pressure', 'time', 'x', 'y']) ||
      !isFiniteNumber(source.time) ||
      !isFiniteNumber(source.x) ||
      !isFiniteNumber(source.y) ||
      source.time < previousTime
    ) {
      return null;
    }
    const pressure = decodePhysicalPressure(source.pressure);
    const orientation = decodePhysicalOrientation(source.orientation);
    if (pressure === null || orientation === null) return null;
    previousTime = source.time;
    points.push(
      Object.freeze({
        orientation,
        pressure,
        time: source.time,
        x: source.x,
        y: source.y,
      }),
    );
  }
  return Object.freeze({ kind: 'physical-control-trace', points: Object.freeze(points) });
}

function decodeLegacyCoverage(value: unknown): InkLegacyRoundCoverage | null {
  if (
    !isExactRecord(value, ['centerline', 'diameterUnits', 'kind']) ||
    value.kind !== 'legacy-round-centerline' ||
    !Array.isArray(value.centerline) ||
    value.centerline.length === 0 ||
    !isPositiveInteger(value.diameterUnits)
  ) {
    return null;
  }
  const centerline = decodeQuantizedPoints(value.centerline);
  if (centerline === null) return null;
  return Object.freeze({
    centerline,
    diameterUnits: value.diameterUnits,
    kind: 'legacy-round-centerline',
  });
}

function decodeFilledContourCoverage(value: unknown): InkFilledContourCoverage | null {
  if (
    !isExactRecord(value, ['contours', 'kind']) ||
    value.kind !== 'quantized-filled-contours' ||
    !Array.isArray(value.contours) ||
    value.contours.length === 0
  ) {
    return null;
  }
  const contours: (readonly InkQuantizedBrushPoint[])[] = [];
  for (const source of value.contours as unknown[]) {
    if (!Array.isArray(source) || source.length < 4) return null;
    const contour = decodeQuantizedPoints(source);
    if (contour === null || !isClosedNonDegenerateContour(contour)) return null;
    contours.push(contour);
  }
  return Object.freeze({ contours: Object.freeze(contours), kind: 'quantized-filled-contours' });
}

function decodeStableCoverageAppend(
  value: unknown,
  version: InkBrushRenderVersion,
): InkBrushStableCoverageAppend | null {
  if (!isExactRecord(value, ['coverage', 'kind']) || value.kind !== 'append-only-stable') {
    return null;
  }
  const coverage = decodeCoverageList(value.coverage, version);
  return coverage === null ? null : Object.freeze({ coverage, kind: 'append-only-stable' });
}

function decodeMutableCoverageReplacement(
  value: unknown,
  version: InkBrushRenderVersion,
): InkBrushMutableCoverageReplacement | null {
  if (
    !isExactRecord(value, ['coverage', 'generation', 'kind']) ||
    value.kind !== 'replace-bounded-mutable-tail' ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) {
    return null;
  }
  const coverage = decodeCoverageList(value.coverage, version);
  return coverage === null
    ? null
    : Object.freeze({
        coverage,
        generation: value.generation,
        kind: 'replace-bounded-mutable-tail',
      });
}

function decodeCoverageList(
  value: unknown,
  version: InkBrushRenderVersion,
): readonly InkBrushCoverage[] | null {
  if (!Array.isArray(value)) return null;
  const coverage: InkBrushCoverage[] = [];
  for (const source of value as unknown[]) {
    const decoded =
      version === 'legacy-round-v1'
        ? decodeLegacyCoverage(source)
        : decodeFilledContourCoverage(source);
    if (decoded === null) return null;
    coverage.push(decoded);
  }
  return Object.freeze(coverage);
}

function decodeQuantizedPoints(
  value: readonly unknown[],
): readonly InkQuantizedBrushPoint[] | null {
  const points: InkQuantizedBrushPoint[] = [];
  for (const source of value) {
    if (
      !isExactRecord(source, ['x', 'y']) ||
      typeof source.x !== 'number' ||
      typeof source.y !== 'number' ||
      !Number.isSafeInteger(source.x) ||
      !Number.isSafeInteger(source.y)
    ) {
      return null;
    }
    points.push(Object.freeze({ x: source.x, y: source.y }));
  }
  return Object.freeze(points);
}

function decodeBounds(value: unknown): InkBrushGeometryBounds | null {
  if (
    !isExactRecord(value, ['height', 'width', 'x', 'y']) ||
    !isFiniteNumber(value.height) ||
    value.height < 0 ||
    !isFiniteNumber(value.width) ||
    value.width < 0 ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y)
  ) {
    return null;
  }
  return Object.freeze({ height: value.height, width: value.width, x: value.x, y: value.y });
}

function decodeLegacyHitShape(
  value: unknown,
): Extract<InkBrushHitShape, { readonly kind: 'round-centerline-distance' }> | null {
  if (
    !isExactRecord(value, ['kind', 'radius']) ||
    value.kind !== 'round-centerline-distance' ||
    !isPositiveFinite(value.radius)
  ) {
    return null;
  }
  return Object.freeze({ kind: 'round-centerline-distance', radius: value.radius });
}

function decodeFilledContourHitShape(
  value: unknown,
): Extract<InkBrushHitShape, { readonly kind: 'filled-contour-distance' }> | null {
  if (
    !isExactRecord(value, ['fillRule', 'kind']) ||
    value.fillRule !== 'nonzero' ||
    value.kind !== 'filled-contour-distance'
  ) {
    return null;
  }
  return Object.freeze({ fillRule: 'nonzero', kind: 'filled-contour-distance' });
}

function decodeBlend(value: unknown): InkBrushBlendSemantics | null {
  if (
    !isExactRecord(value, ['alpha', 'application', 'colorSpace', 'composite']) ||
    value.application !== 'once-per-logical-stroke' ||
    value.colorSpace !== 'srgb' ||
    value.composite !== 'source-over'
  ) {
    return null;
  }
  const alpha = decodeBlendAlpha(value.alpha);
  if (alpha === null) return null;
  return Object.freeze({
    alpha,
    application: 'once-per-logical-stroke',
    colorSpace: 'srgb',
    composite: 'source-over',
  });
}

function decodeBlendAlpha(value: unknown): InkBrushBlendAlpha | null {
  if (!isExactRecord(value, valueIsFixedAlpha(value) ? ['kind', 'value'] : ['kind'])) return null;
  if (value.kind === 'from-canonical-color') return Object.freeze({ kind: value.kind });
  if (
    value.kind !== 'fixed' ||
    !isFiniteNumber(value.value) ||
    value.value <= 0 ||
    value.value > 1
  ) {
    return null;
  }
  return Object.freeze({ kind: 'fixed', value: value.value });
}

function boundsContainCoverage(
  bounds: InkBrushGeometryBounds,
  coverage: InkBrushCoverage,
  logicalGrid: number,
): boolean {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const points =
    coverage.kind === 'legacy-round-centerline'
      ? coverage.centerline
      : coverage.contours.flatMap((contour) => contour);
  for (const point of points) {
    minimumX = Math.min(minimumX, point.x * logicalGrid);
    minimumY = Math.min(minimumY, point.y * logicalGrid);
    maximumX = Math.max(maximumX, point.x * logicalGrid);
    maximumY = Math.max(maximumY, point.y * logicalGrid);
  }
  const radius =
    coverage.kind === 'legacy-round-centerline' ? (coverage.diameterUnits * logicalGrid) / 2 : 0;
  return containsExtents(
    bounds,
    minimumX - radius,
    minimumY - radius,
    maximumX + radius,
    maximumY + radius,
  );
}

function geometryIdentityMatchesVersion(
  version: InkBrushRenderVersion,
  tool: InkVisibleBrushTool,
  color: string,
  coverage: InkBrushCoverage,
  blend: InkBrushBlendSemantics,
): boolean {
  if (version === 'legacy-round-v1') {
    return (
      coverage.kind === 'legacy-round-centerline' && blend.alpha.kind === 'from-canonical-color'
    );
  }
  if (
    coverage.kind !== 'quantized-filled-contours' ||
    !/^#[0-9a-f]{6}$/iu.test(color) ||
    blend.alpha.kind !== 'fixed'
  ) {
    return false;
  }
  if (version === 'pen-physical-v1') {
    return tool === 'pen' && blend.alpha.value === 1;
  }
  return tool === 'highlighter';
}

function hitShapeMatchesCoverage(
  hitShape: InkBrushHitShape,
  coverage: InkBrushCoverage,
  logicalGrid: number,
): boolean {
  if (coverage.kind === 'quantized-filled-contours') {
    return hitShape.kind === 'filled-contour-distance';
  }
  return (
    hitShape.kind === 'round-centerline-distance' &&
    hitShape.radius === (coverage.diameterUnits * logicalGrid) / 2
  );
}

function isClosedNonDegenerateContour(contour: readonly InkQuantizedBrushPoint[]): boolean {
  const first = contour[0];
  const last = contour.at(-1);
  if (first === undefined || last === undefined || first.x !== last.x || first.y !== last.y) {
    return false;
  }
  return new Set(contour.slice(0, -1).map((point) => `${point.x},${point.y}`)).size >= 3;
}

function containsExtents(
  bounds: InkBrushGeometryBounds,
  minimumX: number,
  minimumY: number,
  maximumX: number,
  maximumY: number,
): boolean {
  const epsilon = Number.EPSILON * 64;
  return (
    bounds.x <= minimumX + epsilon &&
    bounds.y <= minimumY + epsilon &&
    bounds.x + bounds.width >= maximumX - epsilon &&
    bounds.y + bounds.height >= maximumY - epsilon
  );
}

function digestGeometry(geometry: {
  readonly blend: InkBrushBlendSemantics;
  readonly bounds: InkBrushGeometryBounds;
  readonly color: string;
  readonly coverage: InkBrushCoverage;
  readonly hitShape: InkBrushHitShape;
  readonly logicalStrokeId: string;
  readonly quantization: { readonly logicalGrid: number };
  readonly tool: InkVisibleBrushTool;
  readonly traceDigest: string;
  readonly version: InkBrushRenderVersion;
}): string {
  return digestInkBrushGolden({
    blend: geometry.blend,
    bounds: geometry.bounds,
    color: geometry.color,
    coverage: geometry.coverage,
    hitShape: geometry.hitShape,
    quantization: geometry.quantization,
    tool: geometry.tool,
    traceDigest: geometry.traceDigest,
    version: geometry.version,
  });
}

function valueIsFixedAlpha(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'kind') === 'fixed';
}

function decodePhysicalPressure(value: unknown): InkPhysicalBrushControlPoint['pressure'] | null {
  if (
    !isExactRecord(value, ['kind', 'value']) ||
    (value.kind !== 'measured' && value.kind !== 'unavailable') ||
    !isFiniteNumber(value.value) ||
    value.value < 0 ||
    value.value > 1
  ) {
    return null;
  }
  return Object.freeze({ kind: value.kind, value: value.value });
}

function decodePhysicalOrientation(
  value: unknown,
): InkPhysicalBrushControlPoint['orientation'] | null {
  if (
    !isExactRecord(
      value,
      valueIsUnavailable(value) ? ['kind'] : ['altitude', 'azimuth', 'kind', 'reliable'],
    )
  ) {
    return null;
  }
  if (value.kind === 'unavailable') return Object.freeze({ kind: 'unavailable' });
  if (
    value.kind !== 'measured' ||
    !isFiniteNumber(value.altitude) ||
    value.altitude < 0 ||
    value.altitude > Math.PI / 2 ||
    !isFiniteNumber(value.azimuth) ||
    value.azimuth < 0 ||
    value.azimuth >= Math.PI * 2 ||
    typeof value.reliable !== 'boolean'
  ) {
    return null;
  }
  return Object.freeze({
    altitude: value.altitude,
    azimuth: value.azimuth,
    kind: 'measured',
    reliable: value.reliable,
  });
}

function traceMatchesHeader(
  trace: InkBrushControlTrace,
  header: InkBrushLogicalStrokeHeader,
): boolean {
  if (header.version === 'legacy-round-v1') {
    return (
      trace.kind === 'legacy-round-control-trace' &&
      header.inputProfile.pressure === 'legacy-unknown' &&
      header.inputProfile.tilt === 'legacy-unknown'
    );
  }
  if (
    trace.kind !== 'physical-control-trace' ||
    !/^#[0-9a-f]{6}$/iu.test(header.color) ||
    (header.version === 'pen-physical-v1' ? header.tool !== 'pen' : header.tool !== 'highlighter')
  ) {
    return false;
  }
  return trace.points.every(
    (point) =>
      (header.inputProfile.pressure === 'measured' || point.pressure.kind === 'unavailable') &&
      (header.inputProfile.tilt === 'measured' || point.orientation.kind === 'unavailable'),
  );
}

function valueIsUnavailable(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && Reflect.get(value, 'kind') === 'unavailable'
  );
}

function invalidHeader(
  result: Exclude<InkBrushLogicalStrokeDecodeResult, { readonly kind: 'valid' }>,
): HeaderDecode {
  return { kind: 'invalid-header', result };
}

function invalidStroke(): Extract<InkBrushLogicalStrokeDecodeResult, { readonly kind: 'invalid' }> {
  return Object.freeze({ kind: 'invalid', reason: 'invalid-canonical-stroke' });
}

function isBrushVersion(value: string): value is InkBrushRenderVersion {
  return (
    value === 'legacy-round-v1' || value === 'pen-physical-v1' || value === 'highlighter-chisel-v1'
  );
}

function isInputProfile(value: unknown): value is InkBrushInputProfile {
  if (!isExactRecord(value, ['pressure', 'tilt'])) return false;
  if (value.pressure === 'legacy-unknown' || value.tilt === 'legacy-unknown') {
    return value.pressure === 'legacy-unknown' && value.tilt === 'legacy-unknown';
  }
  return (
    (value.pressure === 'measured' || value.pressure === 'unavailable') &&
    (value.tilt === 'measured' || value.tilt === 'unavailable')
  );
}

function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertTraceQuantization(quantization: InkBrushTraceQuantization): void {
  if (
    !isPositiveFinite(quantization.coordinateGrid) ||
    !isPositiveFinite(quantization.sensorGrid) ||
    !isPositiveFinite(quantization.timeGridMs)
  ) {
    throw new Error('Ink Brush trace quantization must be finite and positive.');
  }
}

function quantizeToGrid(value: number, grid: number): number {
  const quantized = Math.round(value / grid);
  return Object.is(quantized, -0) ? 0 : quantized;
}
