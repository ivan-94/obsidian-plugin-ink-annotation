import type { SnapshotSourceBinding } from './snapshot-annotation';
import { createTextAnchor } from './text-anchor';
import { resolveTextAnchor, type AnchorResolution } from './text-anchor-resolver';
import type { TextAnnotationTarget, TextStructuralScope } from './text-annotation';

export interface SnapshotAnchorBlockInput {
  readonly displayText?: string;
  readonly end: number;
  readonly scope: TextStructuralScope;
  readonly start: number;
}

export type SnapshotSourceLinkProjection =
  | {
      readonly anchors: readonly SnapshotResolvedSourceAnchor[];
      readonly state: 'linked' | 'source-changed';
    }
  | {
      readonly anchors: readonly [];
      readonly failure: {
        readonly candidateCount: number;
        readonly reason: 'ambiguous' | 'not-found';
      };
      readonly state: 'unanchored';
    };

export interface SnapshotResolvedSourceAnchor {
  readonly end: number;
  readonly focus: boolean;
  readonly start: number;
  readonly target: TextAnnotationTarget;
}

export async function createSnapshotSourceBinding(input: {
  readonly blocks: readonly SnapshotAnchorBlockInput[];
  readonly focusBlockIndex: number;
  readonly source: string;
}): Promise<SnapshotSourceBinding> {
  assertBlocks(input.blocks, input.focusBlockIndex, input.source.length);
  const selectedIndexes = selectCoverageIndexes(input.blocks.length, input.focusBlockIndex);
  const anchors = new Map<number, TextAnnotationTarget>();
  await Promise.all(
    selectedIndexes.map(async (index) => {
      const block = input.blocks[index] as SnapshotAnchorBlockInput;
      anchors.set(
        index,
        await createTextAnchor({
          ...(block.displayText === undefined ? {} : { displayText: block.displayText }),
          end: block.end,
          scope: block.scope,
          source: input.source,
          start: block.start,
        }),
      );
    }),
  );
  const focus = anchors.get(input.focusBlockIndex);
  if (focus === undefined) throw new Error('Snapshot Focus Anchor was not created.');
  const sourceRevision = focus.sourceRevision;
  if (sourceRevision === undefined)
    throw new Error('Snapshot Focus Anchor has no source revision.');
  const coverage = selectedIndexes.map((index) => anchors.get(index) as TextAnnotationTarget);
  return Object.freeze({
    coverage: Object.freeze(coverage),
    focus,
    headingPath: Object.freeze([...(focus.scope.headingPath ?? [])]),
    sourceRevision,
  });
}

export function projectSnapshotSourceLink(
  source: string,
  binding: SnapshotSourceBinding,
): SnapshotSourceLinkProjection {
  const anchors: SnapshotResolvedSourceAnchor[] = [];
  const failures: Array<Extract<AnchorResolution, { kind: 'unanchored' }>> = [];
  let focusResolved = false;
  let unchanged = true;
  for (const target of binding.coverage) {
    const resolution = resolveTextAnchor(source, target);
    if (resolution.kind === 'unanchored') {
      failures.push(resolution);
      unchanged = false;
      continue;
    }
    const focus = sameAnchor(target, binding.focus);
    focusResolved ||= focus;
    unchanged &&= contextIsUnchanged(source, resolution.start, resolution.end, target);
    anchors.push({ end: resolution.end, focus, start: resolution.start, target });
  }
  if (anchors.length === 0) {
    return {
      anchors: [],
      failure: {
        candidateCount: Math.max(0, ...failures.map(({ candidates }) => candidates)),
        reason: failures.some(({ reason }) => reason === 'ambiguous') ? 'ambiguous' : 'not-found',
      },
      state: 'unanchored',
    };
  }
  return {
    anchors,
    state: focusResolved && unchanged ? 'linked' : 'source-changed',
  };
}

function selectCoverageIndexes(blockCount: number, focusBlockIndex: number): readonly number[] {
  const last = blockCount - 1;
  const indexes = new Set([
    0,
    Math.round(last * 0.25),
    focusBlockIndex,
    Math.round(last * 0.75),
    last,
  ]);
  return [...indexes].sort((left, right) => left - right).slice(0, 5);
}

function contextIsUnchanged(
  source: string,
  start: number,
  end: number,
  target: TextAnnotationTarget,
): boolean {
  const prefix = source.slice(Math.max(0, start - target.quote.prefix.length), start);
  const suffix = source.slice(end, end + target.quote.suffix.length);
  return prefix.endsWith(target.quote.prefix) && suffix.startsWith(target.quote.suffix);
}

function sameAnchor(left: TextAnnotationTarget, right: TextAnnotationTarget): boolean {
  return (
    left.position.start === right.position.start &&
    left.position.end === right.position.end &&
    left.quote.exact === right.quote.exact
  );
}

function assertBlocks(
  blocks: readonly SnapshotAnchorBlockInput[],
  focusBlockIndex: number,
  sourceLength: number,
): void {
  if (
    blocks.length === 0 ||
    !Number.isSafeInteger(focusBlockIndex) ||
    focusBlockIndex < 0 ||
    focusBlockIndex >= blocks.length
  ) {
    throw new Error('Snapshot Source Binding requires one valid Focus block.');
  }
  let previousEnd = -1;
  for (const block of blocks) {
    if (
      !Number.isSafeInteger(block.start) ||
      !Number.isSafeInteger(block.end) ||
      block.start < 0 ||
      block.end <= block.start ||
      block.end > sourceLength ||
      block.start < previousEnd
    ) {
      throw new Error('Snapshot Source Binding blocks must be ordered source ranges.');
    }
    previousEnd = block.end;
  }
}
