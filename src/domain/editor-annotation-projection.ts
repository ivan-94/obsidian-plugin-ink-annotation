import type { ResolvedHighlight } from '../application/annotation-service';
import { buildIntervalRenderPlan, type AnnotationRenderInterval } from './interval-render-plan';

export interface EditorVisibleRange {
  readonly from: number;
  readonly to: number;
}

export interface EditorMarkProjection {
  readonly annotationId: string;
  readonly annotationIds: readonly string[];
  readonly from: number;
  readonly kind: 'highlight' | 'underline';
  readonly styleId: string;
  readonly to: number;
  readonly underlineStyleId?: string;
}

export interface EditorNoteAnchorProjection {
  readonly annotationId: string;
  readonly offset: number;
  readonly quoteEnd: number;
}

export interface EditorAnnotationProjection {
  readonly marks: readonly EditorMarkProjection[];
  readonly noteAnchors: readonly EditorNoteAnchorProjection[];
}

export interface EditorPositionMapper {
  mapPos(position: number, assoc?: -1 | 1): number;
}

export function buildEditorAnnotationProjection(
  resolved: readonly ResolvedHighlight[],
  visibleRanges: readonly EditorVisibleRange[],
  documentLength: number,
): EditorAnnotationProjection {
  const marks: EditorMarkProjection[] = [];
  const noteAnchors: EditorNoteAnchorProjection[] = [];
  if (!Number.isInteger(documentLength) || documentLength < 0) {
    return { marks, noteAnchors };
  }

  const visible = visibleRanges.filter(isValidVisibleRange);
  const intervals: AnnotationRenderInterval[] = [];
  for (const item of resolved) {
    if (!isValidAnnotationRange(item.start, item.end, documentLength)) {
      continue;
    }
    const record = item.record;
    if (record.mark !== undefined) {
      if (!visible.some((range) => rangesIntersect(item.start, item.end, range))) {
        continue;
      }
      intervals.push({
        annotationId: record.id,
        end: item.end,
        kind: record.mark.kind,
        start: item.start,
        styleId: record.mark.styleId,
        updatedAt: record.updatedAt,
      });
      continue;
    }
    if (
      (record.body !== undefined || record.tags.length > 0) &&
      visible.some((range) => pointIsVisible(item.start, range))
    ) {
      noteAnchors.push({ annotationId: record.id, offset: item.start, quoteEnd: item.end });
    }
  }

  for (const segment of buildIntervalRenderPlan(intervals)) {
    const annotationId = segment.backgroundAnnotationId ?? segment.underlineAnnotationIds[0];
    const styleId = segment.backgroundStyleId ?? segment.underlineStyleIds[0];
    if (annotationId === undefined || styleId === undefined) continue;
    const underlineStyleId = segment.underlineStyleIds[0];
    marks.push({
      annotationId,
      annotationIds: segment.annotationIds,
      from: segment.start,
      kind: segment.backgroundAnnotationId === undefined ? 'underline' : 'highlight',
      styleId,
      to: segment.end,
      ...(segment.backgroundAnnotationId !== undefined && underlineStyleId !== undefined
        ? { underlineStyleId }
        : {}),
    });
  }

  marks.sort(compareMarks);
  noteAnchors.sort(
    (left, right) =>
      left.offset - right.offset || left.annotationId.localeCompare(right.annotationId),
  );
  return { marks, noteAnchors };
}

export function mapEditorAnnotationProjection(
  projection: EditorAnnotationProjection,
  mapper: EditorPositionMapper,
): EditorAnnotationProjection {
  const marks = projection.marks
    .map((mark): EditorMarkProjection | null => {
      const from = mapper.mapPos(mark.from, 1);
      const to = mapper.mapPos(mark.to, -1);
      return to <= from ? null : { ...mark, from, to };
    })
    .filter((mark): mark is EditorMarkProjection => mark !== null);
  const noteAnchors = projection.noteAnchors.map((anchor) => {
    const offset = mapper.mapPos(anchor.offset, 1);
    const quoteEnd = Math.max(offset, mapper.mapPos(anchor.quoteEnd, -1));
    return { ...anchor, offset, quoteEnd };
  });
  return { marks, noteAnchors };
}

function isValidAnnotationRange(start: number, end: number, documentLength: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= documentLength
  );
}

function isValidVisibleRange(range: EditorVisibleRange): boolean {
  return (
    Number.isInteger(range.from) &&
    Number.isInteger(range.to) &&
    range.from >= 0 &&
    range.to >= range.from
  );
}

function rangesIntersect(start: number, end: number, visible: EditorVisibleRange): boolean {
  return start < visible.to && end > visible.from;
}

function pointIsVisible(point: number, visible: EditorVisibleRange): boolean {
  return point >= visible.from && point <= visible.to;
}

function compareMarks(left: EditorMarkProjection, right: EditorMarkProjection): number {
  return (
    left.from - right.from ||
    left.to - right.to ||
    left.kind.localeCompare(right.kind) ||
    left.annotationId.localeCompare(right.annotationId)
  );
}
