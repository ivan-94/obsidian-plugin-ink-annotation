# Ink 704 Zoomable Workspace and Pane-Wide Drawing

## Status

- Created: 2026-07-16
- Status: implemented; zoom/input/toolbar/sidebar follow-ups verified; physical iPad and native
  separator-drag gates remain
- Scope: canonical Ink document width, pane-wide drawing, synchronized zoom, and container-resize
  stability.

This focused specification supersedes the width capture and Canvas-horizontal-bound portions of
`2026-07-15-ink-three-state-view-and-toolbar-correction.md`. The raw/preview/edit lifecycle,
continuous vertical chunks, sidecar authority, manual movement, and persistence failure guarantees
remain unchanged.

## Problem Evidence

The user-provided Obsidian screenshots establish three failures:

1. The current fixture retains a 513 logical-pixel plane and wastes most of a desktop content pane.
2. The active Canvas ends at the Markdown document edge, so pointer input in the visible left/right
   workspace is clamped to the edge instead of remaining where the user drew it.
3. Resizing the Obsidian annotation sidebar changes the host width without a coherent stage-scale
   update, allowing the fixed document plane to move outside the visible pane.
4. A follow-up native walkthrough showed Markdown shrinking from 100% to 60% while committed Ink
   retained its 100% size and moved to the right. The pane-wide Canvas kept the same backing-store
   dimensions, so its context transform was not rebuilt when only the presentation scale changed.
5. The pane-wide Canvas boundary was visible, but the canonical 704 px Markdown document had no
   corresponding boundary, making the drawable pane and document plane visually ambiguous.
6. After zoom, new pointer input drifted horizontally because Chromium CSS zoom retained the
   unscaled auto-margin layout origin while the visible 704 px document was centered at its scaled
   width.
7. Select/Move remained active when a drawing tool was chosen, color/width/zoom controls could be
   exposed outside the More action, and the visible width samples were decorative spans rather than
   operable controls.
8. Each local stroke save triggered both a repository callback and Obsidian's canonical sidecar
   watcher. Both paths requested a full sidebar refresh, producing duplicate reloads and a visible
   Ink card flash; this was event fan-out rather than an inherent Preact diffing failure.
9. Obsidian's Reading View contributes inline and block padding outside the Markdown sizer. Fit
   measured the full `clientWidth`, so the 704 workspace plus host padding created a horizontal
   scrollbar; near the document bottom, the Canvas also clamped its viewport before the host's
   scrollable block padding was exhausted, causing Ink and Markdown to drift vertically.
10. The first padding repair still clamped negative `viewportTop` to zero, leaving Ink screen-fixed
    while the 32 px top padding scrolled away. The pane Canvas also added the current fractional
    `scrollLeft` back into its absolute CSS offset, creating a self-sustaining 1 px horizontal
    overflow even after the document itself fit.

## Confirmed Product Decisions

| ID          | Decision                                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INK-V1.2-01 | Ink preview/edit uses a canonical Markdown display width of **704 logical px**, selected for an iPad mini portrait viewport; new records persist 704.                                                                                              |
| INK-V1.2-02 | In Ink preview/edit, Markdown and Ink behave as one synchronized stage: zooming changes their presentation together and never rewrites canonical vectors.                                                                                          |
| INK-V1.2-03 | The visible Canvas covers the whole current Markdown pane, including whitespace outside the 704 px document. Horizontal Ink coordinates remain relative to the document's left edge, so negative X and X greater than 704 are valid.               |
| INK-V1.2-04 | The toolbar adds Zoom out, Zoom in, and Fit to pane controls with accessible names, icons, and a visible percentage.                                                                                                                               |
| INK-V1.2-05 | Fit mode reacts to sidebar/window resize and keeps the whole document inside the visible pane. Manual zoom keeps its chosen scale and exposes ordinary pane scrolling when larger than the viewport.                                               |
| INK-V1.2-06 | Ink edit shows two distinct boundaries: a stronger outline for the canonical 704 px document and a quieter outline for the pane-wide drawable Canvas.                                                                                              |
| INK-V1.2-07 | Choosing Pen, Highlighter, or Eraser always leaves Select/Move and enters drawing interaction. Re-clicking the active drawing tool never opens secondary options.                                                                                  |
| INK-V1.2-08 | More is the sole visibility control for color, width, and zoom controls. Width samples are accessible buttons whose selected value applies to the next stroke.                                                                                     |
| INK-V1.2-09 | A local Ink save updates only the matching current-file Ink summary and suppresses the plugin's own canonical-file watcher echo. Truly external sidecar changes still use full reconciliation.                                                     |
| INK-V1.2-10 | Fit reserves the host's real inline padding and overrides Obsidian's readable-line-width cap so the logical document remains 704 without horizontal overflow. Canvas viewport bounds may include visible block padding beyond the document bottom. |

## Coordinate Model

- The Markdown document top-left is the stable logical origin `(0, 0)`.
- The canonical Ink document display width is 704 for both existing and newly created surfaces.
- Y remains non-negative and bounded by the continuous document extent.
- X is finite but not clamped to `[0, documentWidth]`; this permits notes and sketches in visible
  margins without moving the document origin when a sidebar changes width.
- The active viewport derives a transient logical `left`, `top`, `width`, and `height` from the host
  rectangle and current zoom. These values are presentation state and are never written to a
  sidecar.
- Existing records with widths other than 704 keep their stored width and stroke coordinates, but
  the Ink workspace displays Markdown at 704. No sidecar is silently rewritten; after this explicit
  layout change, the existing manual reposition tool is the recovery path for displaced strokes.

## Zoom Contract

- Zoom is runtime-only view state.
- Default mode is `fit` for Ink preview and edit.
- Fit leaves a 20 px visual gutter on each side when possible and clamps scale to 50%–100%; a wide
  desktop pane never enlarges the 704 px document automatically.
- Existing host inline padding counts toward the Fit gutter. The scaled document plus the larger of
  the requested gutter or host padding on each side must not exceed `scrollContainer.clientWidth`.
- Manual Zoom out/in changes scale in 10 percentage-point steps within the 50%–200% range.
- Zoom is centered on the document; Markdown and both Canvas layers use the same scale.
- Horizontal pointer geometry derives the visible document origin from pane width,
  `704 × presentationScale`, scroll offset, and scaled content inset. It must not use the unscaled
  `layoutRoot.getBoundingClientRect().left` produced by Chromium CSS zoom.
- A scale change must reset each Canvas backing-store transform and apply
  `devicePixelRatio × presentationScale`, even when the pane's CSS width and height did not change.
  Canvas dimensions alone are not a sufficient invalidation signal.
- The percentage reports the actual presentation scale relative to the 704 px display plane.
- Entering edit from preview does not change zoom or scroll position.

## Visual Boundary Contract

- The canonical 704 px document uses the stronger accent outline in Ink edit.
- The pane-wide drawable Canvas uses a quieter accent outline in Ink edit.
- Both outlines are presentation-only and do not change layout, pointer coordinates, persistence,
  preview behavior, or raw Obsidian mode.
- When zoom changes, the 704 document outline scales with Markdown; the pane Canvas outline stays
  attached to the current content pane.

## Pane-Wide Canvas Contract

- The viewport Canvas covers `scrollContainer.clientWidth × clientHeight`, excluding native
  scrollbars.
- Pointer mapping converts viewport CSS coordinates through the current scale into document-relative
  logical coordinates.
- Committed, active, selection, hit-test, undo/redo, persistence, thumbnails, and exports retain
  outside-document points.
- Preview remains pointer-transparent even though its committed Canvas covers the pane.
- Ink below shortened Markdown remains available through the existing continuous safe extent.
- Near the document bottom, `viewportTop` follows the document-to-pane geometry even when the
  viewport bottom extends into host padding; it is not capped at `logicalHeight - viewportHeight`.

## Resize Contract

- Observe both the document layout root and its scroll container; a sidebar drag can resize only the
  latter.
- In fit mode, resize recomputes scale, recenters the document, updates the viewport logical bounds,
  resizes Canvas backing stores, and redraws committed/selection layers in one update.
- No resize mutates sidecars, revisions, strokes, or the user's manual toolbar position.
- At a 744 px iPad mini portrait viewport, a new 704 px document fits at approximately 100% with the
  requested 20 px gutters.

## Toolbar Order

```text
Move dock | Finish | Pen | Highlighter | Eraser | Select/Move | Undo | Redo | More

More open: Color | Width 2/4/8 | Zoom out | Zoom percentage/Fit | Zoom in
```

The zoom percentage/Fit control returns to responsive fit mode. Zoom out or Zoom in enters manual
mode. More is the only action that opens or closes the secondary controls. Narrow docks remain
horizontally scrollable.

## Acceptance Criteria

- A newly created Ink surface persists `logicalWidth: 704` regardless of the incidental pane width.
- Existing non-704 Ink opens without canonical rewrites.
- Pen input beginning in visible whitespace left or right of the document persists at the same
  document-relative X after reload and sidebar resize.
- Zoom out/in/fit scale Markdown and Ink together; hit-testing and pointer drawing remain accurate
  at 50%, 100%, 150%, and fit scale.
- At every zoom, pointer input at the visible document origin maps to logical X near zero rather
  than inheriting the unscaled centered-layout offset.
- A 100% → 60% manual zoom with unchanged pane dimensions visibly scales existing committed Ink,
  Markdown, and the 704 document boundary together without horizontal drift.
- Ink edit visibly distinguishes the 704 document boundary from the pane-wide drawable boundary.
- Dragging the sidebar narrower/wider in fit mode never pushes any part of the document outside the
  visible content pane.
- Manual zoom survives sidebar resize without silently changing percentage; overflow remains
  scrollable.
- Raw mode removes every Ink width/zoom/stage style and restores native Obsidian layout.
- Pen, Highlighter, and Eraser immediately close Select/Move; only More exposes color, width, and
  zoom controls; choosing a width sample changes the width of the next persisted stroke.
- Saving a local stroke preserves the existing current-file Ink card DOM identity, updates its
  summary once, and does not rebuild unrelated sidebar rows.
- In Fit mode with host padding, `scrollWidth === clientWidth` when content itself does not
  overflow.
- Scrolling near the document bottom moves Markdown and committed Ink by the same CSS-pixel delta.
- Targeted TDD, full checks, performance checks, native desktop Obsidian resize walkthrough, and an
  iPad mini portrait-equivalent 744 px verification pass.

## Non-Goals

- Automatic semantic rebase after Markdown edits.
- Silent rewriting of existing non-704 coordinate planes.
- Infinite vertical storage, pagination, fixed typography, or a raster screenshot persisted in the
  sidecar.
- Pinch gesture support in this Slice; toolbar zoom is the required interaction.

## Execution Plan

1. Add pure workspace geometry and zoom tests, then define the 704/fit/step constants.
2. Change new surface creation to 704 while retaining legacy-width compatibility.
3. Add toolbar state/component tests for Zoom out, Fit, and Zoom in.
4. Change the controller viewport Canvas to cover the pane and map pointer/render coordinates
   through transient viewport geometry.
5. Extend domain validation, movement, export, and persistence tests for outside-document X.
6. Observe container resize and verify fit/manual behavior.
7. Install into the fixture Vault and run native Obsidian desktop plus 744 px equivalent
   walkthroughs.

## Source Manifest

### Sources

- User decisions and two native Obsidian screenshots supplied in the 2026-07-16 Codex task:
  canonical width 704, pane-wide drawing, synchronized zoom controls, and sidebar-resize repair.
- User follow-up and three native Obsidian screenshots supplied in the same task: committed Ink did
  not follow 100% → 60% zoom, and the 704 document boundary needed to be visible alongside the
  pane-wide Canvas boundary.
- User follow-up and four native Obsidian screenshots supplied in the same task: zoomed drawing
  offset, drawing-tool/Select conflict, More-only secondary controls, Current File Ink-row flashing,
  and inert width samples.
- User follow-up and two native Obsidian screenshots supplied in the same task: an unexplained
  horizontal scrollbar and vertical Ink/Markdown drift while scrolling.
- User follow-up and three additional native Obsidian screenshots supplied in the same task: the
  top-padding scroll drift remained after the bottom-only repair, and the horizontal scrollbar was
  still visible despite the document itself fitting.
- `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`
- `docs/specs/2026-07-15-ink-three-state-view-and-toolbar-correction.md`
- `docs/delivery/slices/S16-ink-fixed-width-manual-move/`
- `docs/delivery/slices/S17-ink-three-state-view-toolbar-correction/`
- `src/domain/ink-surface.ts`
- `src/application/ink-document-session.ts`
- `src/adapters/obsidian/ink-mode-manager.ts`
- `src/ui/ink-canvas-controller.ts`
- `src/ui/ink/ink-toolbar-app.tsx`
- `styles.css`
- `/Users/ivan/.agents/docs/agents/workflows.md`
- `/Users/ivan/.agents/docs/agents/handoff-policy.md`
- `/Users/ivan/.agents/skills/tdd/SKILL.md`
- `/Users/ivan/.agents/skills/diagnose/SKILL.md`
- `/Users/ivan/.agents/skills/visual-fidelity-loop/SKILL.md`
- `/Users/ivan/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000387/skills/computer-use/SKILL.md`

### Produced artifacts

- `docs/specs/2026-07-16-ink-704-zoomable-workspace.md`
- `docs/delivery/slices/S18-ink-704-zoomable-workspace/`
- Workspace geometry, pane-wide Canvas, zoom toolbar, resize reaction, outside-X persistence,
  thumbnail, and export changes under `src/` and `styles.css`.

### Key decisions

- Separate stable document coordinates from transient viewport Canvas bounds.
- Display every Ink workspace at 704 and persist new records at 704 without rewriting existing
  non-704 sidecars.
- Treat Fit as responsive presentation state, not a persistence migration.
- Cap automatic Fit at 100%; enlargement above 100% requires an explicit Zoom in action.
- Keep the pane Canvas viewport-fixed. Its transient viewport may begin above logical Y zero, while
  persisted stroke Y remains non-negative; Fit removes the pane's horizontal scroll mechanism and
  manual zoom restores it.

### Verification evidence

- The latest `npm run check` passed on 2026-07-16: 93 files / 481 tests, 4 performance files / 8
  tests, formatting, ESLint, typecheck, production build, and mobile bundle verification.
- Native Obsidian 1.12.7 confirmed Fit 100%, manual 90%, pane-whitespace input, persistence, reload,
  and synchronized Markdown/Ink scaling. The persisted native margin stroke had `x = -111.0390625`.
- Follow-up native Obsidian 1.12.7 verification on `Anchor Mutation Lab.md` confirmed that existing
  committed Ink, Markdown, and the 704 outline remain aligned at 100% and shrink together through
  90%, 80%, 70%, and 60%; the pane outline remains attached to the viewport.
- Latest targeted regressions passed: 6 files / 49 tests. They cover scaled pointer origin,
  drawing-tool mutual exclusion, More-only controls, width application, local sidebar row identity,
  and canonical watcher deduplication.
- Native Obsidian 1.12.7 at 60% persisted a boundary probe at `x = 10.190104166666856`, accepted a
  selected 2 px width, switched Select/Move off when Highlighter was chosen, and kept the same Ink
  row accessibility identity while its count changed from 65 to 66.
- Automated ResizeObserver coverage confirmed a 500 px pane recomputes Fit to `460 / 704` and keeps
  the document inside the pane.
- The follow-up native diagnosis found the residual horizontal track was created by the pane Canvas,
  not Markdown: the old runtime reported `clientWidth = 746`, `scrollWidth = 747`, and
  `scrollLeft = 0.5`; hiding only `.inkstone-ink-surface` restored `scrollWidth = 746`. The Canvas
  now uses viewport-fixed positioning, never feeds `scrollLeft` back into its own offset, and Fit
  explicitly disables horizontal overflow. A freshly restarted plugin instance reported
  `is-ink-fit`, computed `overflow-x: hidden`, `clientWidth = scrollWidth = 746`, and
  `scrollLeft = 0` with no bottom track.
- Native top-to-bottom coordinate sampling at Fit `0.96875` reported `scrollTop / viewportTop` pairs
  `0 / -33.0323`, `16 / -16.5161`, `32 / 0`, `120 / 90.8387`, and `771 / 762.8387`. The pane Canvas
  stayed at CSS top `70` throughout, proving that the host's 32 px top padding is represented as a
  negative transient viewport origin instead of being clamped away.

### Open questions / risks

- Physical iPad Pencil/finger behavior remains a separate hardware gate.
- Existing non-704 records display in the 704 workspace without a canonical rewrite; layout-related
  displacement uses the manual reposition recovery path.
- The native automation could not reliably grab Obsidian's narrow sidebar separator, so that exact
  mouse gesture remains a human/native acceptance item despite the container-resize regression test.
