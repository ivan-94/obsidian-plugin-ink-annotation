import type { InkPoint, InkStroke, InkSurfaceRecord } from './ink-surface';

export interface InkLayoutObservation {
  readonly fontAvailable: boolean;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly sourceRevision: string;
  readonly themeMode: 'dark' | 'light';
  readonly viewportWidth: number;
}

export interface InkSurfaceSection {
  readonly blockFingerprints: readonly string[];
  readonly headingPath: readonly string[];
  readonly sectionFingerprint: string;
  readonly sourceEnd: number;
  readonly sourceStart: number;
}

export interface InkMarkdownBlock {
  readonly fingerprint: string;
  readonly headingPath: readonly string[];
  readonly kind: 'block' | 'heading';
  readonly sourceEnd: number;
  readonly sourceStart: number;
}

export interface InkSurfacePartition extends InkSurfaceSection {
  readonly fullNoteFallback: boolean;
}

export function partitionInkBlocks(
  blocks: readonly InkMarkdownBlock[],
  options: { readonly maxBlocks: number },
): readonly InkSurfacePartition[] {
  if (!Number.isInteger(options.maxBlocks) || options.maxBlocks < 1) {
    throw new Error('Ink surface maxBlocks must be a positive integer.');
  }
  if (blocks.length === 0) {
    return [];
  }
  const groups: InkMarkdownBlock[][] = [];
  let current: InkMarkdownBlock[] = [];
  for (const block of blocks) {
    const startsHeading = block.kind === 'heading' && current.length > 0;
    if (startsHeading || current.length >= options.maxBlocks) {
      groups.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups.map((group) => {
    const first = group[0] as InkMarkdownBlock;
    const last = group.at(-1) as InkMarkdownBlock;
    const blockFingerprints = group.map((block) => block.fingerprint);
    return {
      blockFingerprints,
      fullNoteFallback: false,
      headingPath: first.headingPath,
      sectionFingerprint: stableSectionFingerprint(first.headingPath, blockFingerprints),
      sourceEnd: last.sourceEnd,
      sourceStart: first.sourceStart,
    };
  });
}

export function splitInkStrokeIntoSurfaceFragments(input: {
  readonly color: string;
  readonly linkedStrokeId: string;
  readonly points: readonly InkPoint[];
  readonly surfaces: readonly {
    readonly endY: number;
    readonly id: string;
    readonly startY: number;
  }[];
  readonly tool: InkStroke['tool'];
  readonly width: number;
}): readonly { readonly surfaceId: string; readonly stroke: InkStroke }[] {
  const fragments: Array<{ surfaceId: string; stroke: InkStroke }> = [];
  for (const surface of input.surfaces) {
    if (surface.endY <= surface.startY) {
      throw new Error(`Ink surface ${surface.id} has invalid bounds.`);
    }
    const globalPoints: InkPoint[] = [];
    if (input.points.length === 1) {
      const only = input.points[0];
      if (only !== undefined && only.y >= surface.startY && only.y <= surface.endY) {
        globalPoints.push(only);
      }
    }
    for (let index = 1; index < input.points.length; index += 1) {
      const start = input.points[index - 1];
      const end = input.points[index];
      if (start === undefined || end === undefined) continue;
      const clipped = clipSegment(start, end, surface.startY, surface.endY);
      if (clipped === null) continue;
      appendUnique(globalPoints, clipped[0]);
      appendUnique(globalPoints, clipped[1]);
    }
    if (globalPoints.length > 0) {
      fragments.push({
        surfaceId: surface.id,
        stroke: {
          color: input.color,
          id: `${input.linkedStrokeId}-${surface.id}`,
          linkedStrokeId: input.linkedStrokeId,
          points: globalPoints.map((point) => ({ ...point, y: point.y - surface.startY })),
          tool: input.tool,
          width: input.width,
        },
      });
    }
  }
  return fragments;
}

export type InkSurfaceReconciliation =
  | { readonly kind: 'active'; readonly record: InkSurfaceRecord }
  | { readonly kind: 'relocated'; readonly record: InkSurfaceRecord }
  | { readonly kind: 'needs-rebase'; readonly record: InkSurfaceRecord }
  | { readonly kind: 'unanchored'; readonly record: InkSurfaceRecord };

export function reconcileInkSurface(
  record: InkSurfaceRecord,
  sections: readonly InkSurfaceSection[],
  layout: InkLayoutObservation,
): InkSurfaceReconciliation {
  const binding = record.binding;
  if (binding === undefined) {
    return transitioned(record, 'unanchored');
  }
  const exact = sections.find(
    (section) => section.sectionFingerprint === binding.sectionFingerprint,
  );
  if (exact !== undefined) {
    if (!layoutMatches(record, layout)) {
      if (record.strokes.length === 0 && layout.fontAvailable) {
        return { kind: 'active', record: updateBinding(record, exact, layout, 'active') };
      }
      return transitioned(record, 'needs-rebase');
    }
    if (exact.sourceStart === binding.sourceStart && exact.sourceEnd === binding.sourceEnd) {
      return {
        kind: 'active',
        record:
          record.status === 'active'
            ? record
            : { ...record, revision: record.revision + 1, status: 'active' },
      };
    }
    return {
      kind: 'relocated',
      record: updateBinding(record, exact, layout, 'active'),
    };
  }
  const sameHeading = sections.find(
    (section) => JSON.stringify(section.headingPath) === JSON.stringify(binding.headingPath),
  );
  return sameHeading === undefined
    ? transitioned(record, 'unanchored')
    : transitioned(record, 'needs-rebase');
}

export interface InkRebasePreview {
  readonly baseRevision: number;
  readonly record: InkSurfaceRecord;
  readonly surfaceId: string;
}

export function previewInkRebase(
  record: InkSurfaceRecord,
  section: InkSurfaceSection,
  layout: InkLayoutObservation,
): InkRebasePreview {
  const scaleX = layout.logicalWidth / record.layout.logicalWidth;
  const scaleY = layout.logicalHeight / record.layout.logicalHeight;
  const preview: InkSurfaceRecord = {
    ...updateBinding(record, section, layout, 'active'),
    revision: record.revision,
    strokes: record.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point) => ({
        ...point,
        x: point.x * scaleX,
        y: point.y * scaleY,
      })),
    })),
  };
  return { baseRevision: record.revision, record: preview, surfaceId: record.id };
}

export function confirmInkRebase(
  current: InkSurfaceRecord,
  preview: InkRebasePreview,
  now: string,
): InkSurfaceRecord {
  if (current.id !== preview.surfaceId || current.revision !== preview.baseRevision) {
    throw new Error('Ink surface changed after the preview; create a new rebase preview.');
  }
  return { ...preview.record, revision: current.revision + 1, updatedAt: now };
}

function updateBinding(
  record: InkSurfaceRecord,
  section: InkSurfaceSection,
  layout: InkLayoutObservation,
  status: InkSurfaceRecord['status'],
): InkSurfaceRecord {
  return {
    ...record,
    binding: { ...section },
    layout: {
      blockFingerprints: section.blockFingerprints,
      fontFamily: layout.fontFamily,
      fontSize: layout.fontSize,
      lineHeight: layout.lineHeight,
      logicalHeight: layout.logicalHeight,
      logicalWidth: layout.logicalWidth,
      sourceRevision: layout.sourceRevision,
      themeMode: layout.themeMode,
    },
    revision: record.revision + 1,
    status,
  };
}

function transitioned(
  record: InkSurfaceRecord,
  status: 'needs-rebase' | 'unanchored',
): InkSurfaceReconciliation {
  return {
    kind: status,
    record:
      record.status === status ? record : { ...record, revision: record.revision + 1, status },
  };
}

function layoutMatches(record: InkSurfaceRecord, observed: InkLayoutObservation): boolean {
  return (
    observed.fontAvailable &&
    observed.fontFamily === record.layout.fontFamily &&
    observed.fontSize === record.layout.fontSize &&
    observed.lineHeight === record.layout.lineHeight &&
    observed.logicalHeight === record.layout.logicalHeight &&
    observed.logicalWidth === record.layout.logicalWidth &&
    observed.themeMode === record.layout.themeMode
  );
}

function stableSectionFingerprint(
  headingPath: readonly string[],
  blockFingerprints: readonly string[],
): string {
  return `${headingPath.join(' / ')}\u0000${blockFingerprints.join('\u0000')}`;
}

function clipSegment(
  start: InkPoint,
  end: InkPoint,
  minimumY: number,
  maximumY: number,
): readonly [InkPoint, InkPoint] | null {
  const dy = end.y - start.y;
  if (dy === 0) {
    return start.y >= minimumY && start.y <= maximumY ? [start, end] : null;
  }
  const firstBoundaryRatio = (minimumY - start.y) / dy;
  const secondBoundaryRatio = (maximumY - start.y) / dy;
  const entryRatio = Math.max(0, Math.min(firstBoundaryRatio, secondBoundaryRatio));
  const exitRatio = Math.min(1, Math.max(firstBoundaryRatio, secondBoundaryRatio));
  if (entryRatio > exitRatio) {
    return null;
  }
  return [interpolate(start, end, entryRatio), interpolate(start, end, exitRatio)];
}

function interpolate(start: InkPoint, end: InkPoint, ratio: number): InkPoint {
  return {
    pressure: start.pressure + (end.pressure - start.pressure) * ratio,
    time: start.time + (end.time - start.time) * ratio,
    x: start.x + (end.x - start.x) * ratio,
    y: start.y + (end.y - start.y) * ratio,
    ...(start.tiltX === undefined && end.tiltX === undefined
      ? {}
      : { tiltX: (start.tiltX ?? 0) + ((end.tiltX ?? 0) - (start.tiltX ?? 0)) * ratio }),
    ...(start.tiltY === undefined && end.tiltY === undefined
      ? {}
      : { tiltY: (start.tiltY ?? 0) + ((end.tiltY ?? 0) - (start.tiltY ?? 0)) * ratio }),
  };
}

function appendUnique(points: InkPoint[], point: InkPoint): void {
  const previous = points.at(-1);
  if (previous === undefined || previous.x !== point.x || previous.y !== point.y) {
    points.push(point);
  }
}
