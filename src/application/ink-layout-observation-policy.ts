import type { InkSurfaceRecord } from '../domain/ink-surface';
import type { InkLayoutObservation } from '../domain/ink-surface-layout';

/** Protects drawn coordinates while allowing empty provisional surfaces to adopt settled layout. */
export function selectInkLayoutObservation(
  record: InkSurfaceRecord,
  observed: InkLayoutObservation | undefined,
): InkLayoutObservation | undefined {
  if (observed === undefined || record.strokes.length === 0) return observed;
  return {
    ...observed,
    // A populated surface keeps its fixed logical box; viewport resize is presentation-only.
    logicalHeight: record.layout.logicalHeight,
    logicalWidth: record.layout.logicalWidth,
  };
}
