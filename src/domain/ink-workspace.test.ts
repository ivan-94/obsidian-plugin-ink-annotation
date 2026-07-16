import { describe, expect, it } from 'vitest';

import {
  fitInkWorkspaceScale,
  INK_DOCUMENT_LOGICAL_WIDTH,
  inkViewportGeometry,
  stepInkWorkspaceScale,
} from './ink-workspace';

describe('Ink zoomable workspace', () => {
  it('uses the iPad mini portrait document width and fits it inside 744 px with 20 px gutters', () => {
    expect(INK_DOCUMENT_LOGICAL_WIDTH).toBe(704);
    expect(fitInkWorkspaceScale(744, INK_DOCUMENT_LOGICAL_WIDTH)).toBe(1);
  });

  it('clamps responsive fit and manual zoom steps to the supported range', () => {
    expect(fitInkWorkspaceScale(2_000, 704)).toBe(1);
    expect(fitInkWorkspaceScale(300, 704)).toBe(0.5);
    expect(stepInkWorkspaceScale(1, 1)).toBeCloseTo(1.1);
    expect(stepInkWorkspaceScale(1, -1)).toBeCloseTo(0.9);
    expect(stepInkWorkspaceScale(2, 1)).toBe(2);
  });

  it('expresses the whole pane in stable document-relative coordinates', () => {
    expect(
      inkViewportGeometry({
        documentLeft: 300,
        documentTop: 100,
        paneHeight: 600,
        paneLeft: 100,
        paneTop: 40,
        paneWidth: 1_000,
        scale: 2,
      }),
    ).toEqual({ height: 300, left: -100, top: -30, width: 500 });
  });
});
