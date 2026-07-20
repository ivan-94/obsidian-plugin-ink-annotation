import type {
  InkDocumentApplyResult,
  InkDocumentCommand,
  InkDocumentReadView,
  InkPreparedStrokeGeometry,
} from '../application/ink-document-session';
import type { InkPhysicalBrushInputProfile } from '../domain/ink-brush-contract';
import type {
  InkBrushActiveGeometryCompiler,
  InkBrushActiveGeometryUpdate,
} from '../domain/ink-brush-geometry-contract';
import type { InkContactBatch, InkContactStyleSnapshot } from '../domain/ink-contact';
import {
  createInkHighlighterPhysicalActiveGeometryCompiler,
  UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE,
} from '../domain/ink-highlighter-physical-geometry';
import { createInkPenPhysicalActiveGeometryCompiler } from '../domain/ink-pen-physical-geometry';
import {
  InkPhysicalControlTraceBuilder,
  type InkPhysicalTraceUpdate,
} from '../domain/ink-physical-control-trace';
import type { InkPhysicalHighlighterStroke, InkPhysicalPenStroke } from '../domain/ink-surface';
import type { InkBorrowedControlTraceDelta } from '../domain/ink-control-trace';

type InkPhysicalCandidateStroke = InkPhysicalHighlighterStroke | InkPhysicalPenStroke;

export interface InkPhysicalCandidateDocumentPort {
  apply(
    command: InkDocumentCommand,
    preparedGeometry?: InkPreparedStrokeGeometry,
  ): InkDocumentApplyResult;
  read(): InkDocumentReadView;
}

export type InkUnpublishedPhysicalCandidateRead =
  | { readonly kind: 'active' | 'completed'; readonly publication: 'unpublished' }
  | { readonly kind: 'failed'; readonly message: string; readonly publication: 'unpublished' }
  | { readonly kind: 'idle'; readonly publication: 'unpublished' }
  | {
      readonly kind: 'ready';
      readonly publication: 'unpublished';
      readonly readGeneration: number;
    };

interface CandidateReadyState {
  readonly kind: 'ready';
  readonly readGeneration: number;
}

interface CandidateActiveState {
  readonly compiler: InkBrushActiveGeometryCompiler | null;
  readonly id: string;
  readonly inputProfile: InkPhysicalBrushInputProfile;
  readonly kind: 'active';
  readonly presentation: 'degraded-legacy' | 'physical';
  readonly style: InkContactStyleSnapshot & { readonly tool: 'highlighter' | 'pen' };
  readonly traceBuilder: InkPhysicalControlTraceBuilder;
  readonly version: 'highlighter-chisel-v1' | 'pen-physical-v1';
}

interface CandidateCompletedState {
  readonly command: InkDocumentCommand;
  readonly diagnostic: 'known-version-geometry-failure' | null;
  readonly kind: 'completed';
  readonly preparedGeometry: InkPreparedStrokeGeometry;
  readonly presentation: 'degraded-legacy' | 'physical';
  readonly stroke: InkPhysicalCandidateStroke;
}

type CandidateState =
  | CandidateActiveState
  | CandidateCompletedState
  | CandidateReadyState
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'idle' };

interface InkPhysicalCandidateCaptureBase {
  readonly alpha: number;
  readonly presentationDelta: InkBorrowedControlTraceDelta;
  readonly strokeId: string;
  readonly style: InkContactStyleSnapshot & { readonly tool: 'highlighter' | 'pen' };
  readonly version: 'highlighter-chisel-v1' | 'pen-physical-v1';
}

type InkPhysicalCandidateActiveCapture =
  | (InkPhysicalCandidateCaptureBase & {
      readonly geometryUpdate: InkBrushActiveGeometryUpdate;
      readonly kind: 'active';
      readonly presentation: 'physical';
    })
  | (InkPhysicalCandidateCaptureBase & {
      readonly diagnostic: 'known-version-geometry-failure';
      readonly geometryUpdate?: never;
      readonly kind: 'active';
      readonly presentation: 'degraded-legacy';
    });

type InkPhysicalCandidateCompletedCapture =
  | (InkPhysicalCandidateCaptureBase & {
      readonly geometryUpdate: InkBrushActiveGeometryUpdate;
      readonly kind: 'completed';
      readonly presentation: 'physical';
      readonly stroke: InkPhysicalCandidateStroke;
    })
  | (InkPhysicalCandidateCaptureBase & {
      readonly diagnostic: 'known-version-geometry-failure';
      readonly geometryUpdate?: never;
      readonly kind: 'completed';
      readonly presentation: 'degraded-legacy';
      readonly stroke: InkPhysicalCandidateStroke;
    });

export type InkUnpublishedPhysicalCandidateCapture =
  | InkPhysicalCandidateActiveCapture
  | InkPhysicalCandidateCompletedCapture
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly strokeId: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly strokeId: string }
  | { readonly kind: 'ignored'; readonly reason: string };

/**
 * Candidate-only orchestration from one normalized Contact Batch stream to S30 trace, S31/S32
 * active coverage, and one live-first Add. Construction is the feature flag: production code
 * never creates this module unless the compile-time HAT build explicitly opts in.
 */
export class InkUnpublishedPhysicalInkCandidate {
  private contactOwner: string | null = null;
  private state: CandidateState = { kind: 'idle' };

  constructor(
    private readonly input: {
      readonly createId?: () => string;
      readonly onStateChange?: (state: InkUnpublishedPhysicalCandidateRead) => void;
      readonly session: InkPhysicalCandidateDocumentPort;
    },
  ) {}

  read(): InkUnpublishedPhysicalCandidateRead {
    const state = this.state;
    if (state.kind === 'ready') {
      return Object.freeze({
        kind: 'ready',
        publication: 'unpublished',
        readGeneration: state.readGeneration,
      });
    }
    if (state.kind === 'failed') {
      return Object.freeze({
        kind: 'failed',
        message: state.message,
        publication: 'unpublished',
      });
    }
    return Object.freeze({ kind: state.kind, publication: 'unpublished' });
  }

  enter(): Promise<InkUnpublishedPhysicalCandidateRead> {
    this.setState({ kind: 'ready', readGeneration: this.input.session.read().generation });
    return Promise.resolve(this.read());
  }

  synchronizePreparation(): Promise<InkUnpublishedPhysicalCandidateRead> {
    if (this.state.kind === 'ready') {
      this.setState({ kind: 'ready', readGeneration: this.input.session.read().generation });
    }
    return Promise.resolve(this.read());
  }

  discardUnused(): Promise<void> {
    if (this.state.kind === 'completed') return Promise.resolve();
    this.setState({ kind: 'idle' });
    return Promise.resolve();
  }

  accept(batch: InkContactBatch): InkUnpublishedPhysicalCandidateCapture {
    if (batch.style.tool !== 'pen' && batch.style.tool !== 'highlighter') {
      return Object.freeze({ kind: 'ignored', reason: 'non-physical-tool' });
    }
    if (batch.phase === 'down') {
      if (this.state.kind !== 'ready') {
        return Object.freeze({ kind: 'blocked', reason: `candidate-${this.state.kind}` });
      }
      if (this.contactOwner !== null) {
        return Object.freeze({ kind: 'ignored', reason: 'another-contact-active' });
      }
      const started = this.begin(batch);
      if (started.kind !== 'active') return started;
      this.contactOwner = batch.contactId;
      return started;
    }

    if (this.contactOwner !== batch.contactId || this.state.kind !== 'active') {
      return Object.freeze({ kind: 'ignored', reason: 'inactive-contact' });
    }
    if (batch.phase === 'cancel') {
      const strokeId = this.state.id;
      const ready: CandidateReadyState = {
        kind: 'ready',
        readGeneration: this.input.session.read().generation,
      };
      this.contactOwner = null;
      this.setState(ready);
      return Object.freeze({ kind: 'cancelled', strokeId });
    }
    return this.extend(batch, this.state);
  }

  cancelActive(): void {
    const active = this.state;
    if (active.kind !== 'active') return;
    this.contactOwner = null;
    this.setState({
      kind: 'ready',
      readGeneration: this.input.session.read().generation,
    });
  }

  /** Seals the confirmed prefix before the host adopts a forced replacement Stage Frame. */
  sealActive(): InkUnpublishedPhysicalCandidateCapture {
    const active = this.state;
    if (active.kind !== 'active') {
      return Object.freeze({ kind: 'ignored', reason: 'inactive-contact' });
    }
    const traceUpdate = active.traceBuilder.seal();
    if (traceUpdate.kind === 'invalid-input') {
      return this.failCapture(`Physical Ink trace failed: ${traceUpdate.reason}.`, active.id);
    }
    if (traceUpdate.kind !== 'completed') {
      return this.failCapture('Physical Ink trace seal did not complete.', active.id);
    }
    if (active.compiler === null) return this.continueDegradedTrace(active, traceUpdate);
    try {
      return this.complete(active, traceUpdate, active.compiler.finish(traceUpdate.brushDelta));
    } catch {
      return this.continueDegradedTrace(active, traceUpdate);
    }
  }

  commitCompleted(): InkDocumentApplyResult {
    const completed = this.state;
    if (completed.kind !== 'completed') {
      throw new Error('There is no completed physical Ink candidate to commit.');
    }
    const result = this.input.session.apply(completed.command, completed.preparedGeometry);
    this.setState({ kind: 'ready', readGeneration: result.change.generation });
    return result;
  }

  private begin(batch: InkContactBatch): InkUnpublishedPhysicalCandidateCapture {
    const inputProfile: InkPhysicalBrushInputProfile = Object.freeze({
      pressure: batch.capabilities.pressure,
      tilt: batch.capabilities.orientation,
    });
    const createdTrace = InkPhysicalControlTraceBuilder.create(inputProfile);
    if (createdTrace.kind !== 'ready') {
      return this.failCapture('Physical Ink input profile is invalid.', null);
    }
    let id: string | null = null;
    try {
      id = this.input.createId?.() ?? globalThis.crypto.randomUUID();
      const style = Object.freeze({
        color: requireOpaqueColor(batch.style.color),
        tool: batch.style.tool,
        width: batch.style.width,
      }) as CandidateActiveState['style'];
      const version = style.tool === 'pen' ? 'pen-physical-v1' : 'highlighter-chisel-v1';
      const header = Object.freeze({
        color: style.color,
        inputProfile,
        logicalStrokeId: id,
        nominalWidth: style.width,
        tool: style.tool,
        version,
      });
      const createdCompiler =
        style.tool === 'pen'
          ? createInkPenPhysicalActiveGeometryCompiler(header)
          : createInkHighlighterPhysicalActiveGeometryCompiler(header);
      if (createdCompiler.kind !== 'ready') {
        return this.failCapture('Physical Ink active geometry is unavailable.', id);
      }
      const active: CandidateActiveState = {
        compiler: createdCompiler.compiler,
        id,
        inputProfile,
        kind: 'active',
        presentation: 'physical',
        style,
        traceBuilder: createdTrace.builder,
        version,
      };
      this.setState(active);
      return this.applyTraceUpdate(batch, active, 'down');
    } catch (error) {
      return this.failCapture(
        error instanceof Error ? error.message : 'Physical Ink contact could not start.',
        id,
      );
    }
  }

  private extend(
    batch: InkContactBatch,
    active: CandidateActiveState,
  ): InkUnpublishedPhysicalCandidateCapture {
    const phase = batch.phase;
    if (phase !== 'move' && phase !== 'up') {
      return this.failCapture('Physical Ink received an invalid active phase.', active.id);
    }
    return this.applyTraceUpdate(batch, active, phase);
  }

  private applyTraceUpdate(
    batch: InkContactBatch,
    active: CandidateActiveState,
    phase: 'down' | 'move' | 'up',
  ): InkUnpublishedPhysicalCandidateCapture {
    const traceUpdate = active.traceBuilder.update(phase, batch.sampleSequence);
    if (traceUpdate.kind === 'invalid-input') {
      return this.failCapture(`Physical Ink trace failed: ${traceUpdate.reason}.`, active.id);
    }
    if (active.compiler === null) return this.continueDegradedTrace(active, traceUpdate);

    let geometryUpdate: InkBrushActiveGeometryUpdate;
    try {
      geometryUpdate =
        traceUpdate.kind === 'completed'
          ? active.compiler.finish(traceUpdate.brushDelta)
          : active.compiler.extend(traceUpdate.brushDelta);
    } catch {
      return this.continueDegradedTrace(active, traceUpdate);
    }

    if (traceUpdate.kind !== 'completed') {
      this.setState(active);
      return Object.freeze({
        alpha: activeAlpha(active.version),
        geometryUpdate,
        kind: 'active',
        presentation: 'physical',
        presentationDelta: traceUpdate.presentationDelta,
        strokeId: active.id,
        style: active.style,
        version: active.version,
      });
    }
    return this.complete(active, traceUpdate, geometryUpdate);
  }

  private continueDegradedTrace(
    active: CandidateActiveState,
    traceUpdate: Exclude<InkPhysicalTraceUpdate, { readonly kind: 'invalid-input' }>,
  ): InkUnpublishedPhysicalCandidateCapture {
    const degraded = Object.freeze({
      ...active,
      compiler: null,
      presentation: 'degraded-legacy' as const,
    });
    if (traceUpdate.kind === 'completed') {
      return this.complete(degraded, traceUpdate, null);
    }
    this.setState(degraded);
    return Object.freeze({
      alpha: activeAlpha(degraded.version),
      diagnostic: 'known-version-geometry-failure',
      kind: 'active',
      presentation: 'degraded-legacy',
      presentationDelta: traceUpdate.presentationDelta,
      strokeId: degraded.id,
      style: degraded.style,
      version: degraded.version,
    });
  }

  private complete(
    active: CandidateActiveState,
    traceUpdate: Extract<InkPhysicalTraceUpdate, { readonly kind: 'completed' }>,
    geometryUpdate: InkBrushActiveGeometryUpdate | null,
  ): InkUnpublishedPhysicalCandidateCapture {
    try {
      const stroke = Object.freeze({
        brushRenderVersion: active.version,
        color: active.style.color,
        id: active.id,
        inputProfile: active.inputProfile,
        points: traceUpdate.points,
        tool: active.style.tool,
        width: active.style.width,
      }) as InkPhysicalCandidateStroke;
      const presentation =
        active.presentation === 'physical' && geometryUpdate?.kind === 'active-finish'
          ? 'physical'
          : 'degraded-legacy';
      const preparedGeometry = Object.freeze({
        bounds:
          geometryUpdate?.kind === 'active-finish'
            ? geometryUpdate.bounds
            : expandTraceBounds(traceUpdate.bounds, stroke.width * 2),
        color: stroke.color,
        logicalStrokeId: stroke.id,
        tool: stroke.tool,
        version: stroke.brushRenderVersion,
      }) satisfies InkPreparedStrokeGeometry;
      const command = Object.freeze({ id: `draw:${stroke.id}`, kind: 'add' as const, stroke });
      const completed: CandidateCompletedState = Object.freeze({
        command,
        diagnostic: presentation === 'degraded-legacy' ? 'known-version-geometry-failure' : null,
        kind: 'completed',
        preparedGeometry,
        presentation,
        stroke,
      });
      this.contactOwner = null;
      this.setState(completed);
      if (presentation === 'degraded-legacy') {
        return Object.freeze({
          alpha: activeAlpha(active.version),
          diagnostic: 'known-version-geometry-failure',
          kind: 'completed',
          presentation,
          presentationDelta: traceUpdate.presentationDelta,
          stroke,
          strokeId: stroke.id,
          style: active.style,
          version: active.version,
        });
      }
      if (geometryUpdate === null || geometryUpdate.kind !== 'active-finish') {
        throw new Error('Physical Ink completion lost its exact active geometry.');
      }
      return Object.freeze({
        alpha: activeAlpha(active.version),
        geometryUpdate,
        kind: 'completed',
        presentation,
        presentationDelta: traceUpdate.presentationDelta,
        stroke,
        strokeId: stroke.id,
        style: active.style,
        version: active.version,
      });
    } catch (error) {
      return this.failCapture(
        error instanceof Error ? error.message : 'Physical Ink completion failed.',
        active.id,
      );
    }
  }

  private failCapture(
    message: string,
    strokeId: string | null,
  ): Extract<InkUnpublishedPhysicalCandidateCapture, { readonly kind: 'failed' }> {
    this.contactOwner = null;
    this.setState({ kind: 'failed', message });
    return Object.freeze({
      kind: 'failed',
      reason: message,
      strokeId: strokeId ?? 'unavailable-physical-stroke',
    });
  }

  private setState(state: CandidateState): void {
    this.state = state;
    this.input.onStateChange?.(this.read());
  }
}

function expandTraceBounds(
  bounds: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
  padding: number,
): { readonly height: number; readonly width: number; readonly x: number; readonly y: number } {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new Error('Physical Ink fallback bounds padding must be finite and non-negative.');
  }
  return Object.freeze({
    height: bounds.height + padding * 2,
    width: bounds.width + padding * 2,
    x: bounds.x - padding,
    y: bounds.y - padding,
  });
}

function activeAlpha(version: CandidateActiveState['version']): number {
  return version === 'pen-physical-v1'
    ? 1
    : UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity;
}

function requireOpaqueColor(color: string): string {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new Error('Physical Ink requires one opaque canonical sRGB color.');
  }
  return color;
}
