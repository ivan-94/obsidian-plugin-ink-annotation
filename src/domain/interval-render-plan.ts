export interface AnnotationRenderInterval {
  readonly annotationId: string;
  readonly end: number;
  readonly kind: 'highlight' | 'underline';
  readonly start: number;
  readonly styleId: string;
  readonly updatedAt: string;
}

export interface AnnotationRenderSegment {
  readonly annotationIds: readonly string[];
  readonly backgroundAnnotationId?: string;
  readonly backgroundStyleId?: string;
  readonly end: number;
  readonly start: number;
  readonly underlineAnnotationIds: readonly string[];
  readonly underlineStyleIds: readonly string[];
}

export function buildIntervalRenderPlan(
  intervals: readonly AnnotationRenderInterval[],
): readonly AnnotationRenderSegment[] {
  for (const interval of intervals) {
    if (interval.start < 0 || interval.end <= interval.start) {
      throw new Error(`Invalid render interval for ${interval.annotationId}.`);
    }
  }
  const boundaries = [
    ...new Set(intervals.flatMap((interval) => [interval.start, interval.end])),
  ].sort((left, right) => left - right);
  const segments: AnnotationRenderSegment[] = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] as number;
    const end = boundaries[index + 1] as number;
    const active = intervals.filter((interval) => interval.start < end && interval.end > start);
    if (active.length === 0) {
      continue;
    }
    const backgrounds = active
      .filter((interval) => interval.kind === 'highlight')
      .sort((left, right) => {
        const specificity = left.end - left.start - (right.end - right.start);
        return specificity !== 0
          ? specificity
          : right.updatedAt.localeCompare(left.updatedAt) ||
              left.annotationId.localeCompare(right.annotationId);
      });
    const underlines = active
      .filter((interval) => interval.kind === 'underline')
      .sort((left, right) => left.annotationId.localeCompare(right.annotationId));
    const background = backgrounds[0];
    segments.push({
      annotationIds: active.map((interval) => interval.annotationId).sort(),
      ...(background === undefined
        ? {}
        : {
            backgroundAnnotationId: background.annotationId,
            backgroundStyleId: background.styleId,
          }),
      end,
      start,
      underlineAnnotationIds: underlines.map((interval) => interval.annotationId),
      underlineStyleIds: underlines.map((interval) => interval.styleId),
    });
  }
  return segments;
}
