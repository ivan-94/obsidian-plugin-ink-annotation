# Ink v1 Fixed-Width Workspace and Manual Repositioning

## Status

- Created: 2026-07-15
- Status: automated implementation complete; native desktop and real-iPad HAT pending
- Scope: Ink only. Text annotation anchoring and text `unanchored` recovery are unchanged.

This incremental specification supersedes only the conflicting Ink layout, Reading-state visibility,
Markdown-change reconciliation, and Ink recovery requirements in:

- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`

Those two documents remain the historical S00–S15 baseline. When their Ink behavior conflicts with
this file, this file is authoritative.

## Product Decisions

| ID        | Decision                                                                                                                                                                | Status            | Rationale                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| INK-V1-01 | Ink Mode uses one per-note fixed logical content width on a continuous vertical canvas with no pages or visible tiles.                                                  | Confirmed by user | Fixed width gives Ink a usable horizontal coordinate basis without committing v1 to a complete fixed document renderer.                        |
| INK-V1-02 | The fixed-width workspace and coordinate-bound Ink overlay exist only while Ink Mode is active. Leaving Ink Mode restores Obsidian's normal view and hides the overlay. | Confirmed by user | Normal reading remains native to Obsidian; showing spatial Ink over a different responsive layout would imply alignment v1 cannot guarantee.   |
| INK-V1-03 | V1 does not automatically move, rebase, orphan, or reattach Ink after Markdown, font, theme, or other layout changes.                                                   | Confirmed by user | Content-aware spatial reconciliation is complex and can silently place Ink on the wrong content.                                               |
| INK-V1-04 | Ink Mode provides transient Select/Move with single selection, additive multi-selection, and drag repositioning of the selected set.                                    | Confirmed by user | Manual correction is explicit, understandable, and keeps the user in control.                                                                  |
| INK-V1-05 | V1 fixes width only. Fixed typography, line metrics, theme, pagination, and a complete fixed document layout are deferred.                                              | Confirmed by user | The first release should validate the simpler model before freezing more of Obsidian's renderer.                                               |
| INK-V1-06 | Select/Move exposes a direct delete action only while one or more logical strokes are selected.                                                                         | Confirmed by user | Selection already establishes destructive intent; one undoable batch command is faster and safer than switching to the eraser for each stroke. |

## User-Visible Contract

### Reading State

- Obsidian's normal Reading View layout is authoritative.
- The plugin removes every Ink-only width constraint and hides the coordinate-bound Ink overlay.
- Text selection, links, scrolling, native navigation, and text annotation actions work normally.
- No inactive Ink canvas intercepts pointer input.
- The sidebar may show Ink summaries and an entry action, but existing Ink is visible/editable only
  after entering Ink Mode.

### Ink Mode Entry and Exit

- Entering Ink Mode clears pending text-selection UI, makes Markdown read-only, applies the note's
  fixed logical width, mounts the continuous Ink workspace, and reveals the tool dock.
- The workspace is vertically continuous. Internal persistence/rendering chunks never appear as
  pages, tiles, separators, or user-managed objects.
- The canvas height is at least
  `max(current rendered document height, farthest stored Ink bound + safe editing margin)`.
- A narrow viewport may scale the whole Ink workspace to fit, but stored logical coordinates do not
  change. The exact width and scale limit remain implementation constants to validate on iPad.
- Leaving Ink Mode performs the existing forced local flush. On success it unmounts the overlay,
  removes the fixed-width constraint, and restores Obsidian's normal view near the same logical
  reading context.
- A failed flush keeps Ink Mode open and retains every in-memory stroke or movement with Retry.

Entering and leaving may reflow content. V1 preserves the nearest stable reading context rather than
promising identical pixel Y positions across the two layouts.

### Markdown and Layout Changes

- Passive Reading, plugin startup, view reconciliation, font/theme changes, and re-entering Ink Mode
  do not automatically change Ink coordinates, status, revision, or sidecar bytes.
- Source/layout fingerprints may remain readable as legacy diagnostics, but they do not trigger
  `relocated`, `needs-rebase`, `unanchored`, hidden rendering, or an automatic Rebase dialog.
- Existing vectors remain at their last explicitly saved note-global coordinates.
- Shortening Markdown must not make old Ink below the content unreachable.
- Historical `active`, `needs-rebase`, and `unanchored` Ink records remain readable, exportable, and
  non-destructively eligible for explicit manual placement.

This decision applies only to Ink. Compound text anchors continue to resolve, become text
`unanchored`, and use the existing text repair flow.

## Select/Move Interaction

### Selection Unit

- The smallest selectable unit is one logical user stroke ID.
- Linked fragments of one stroke across internal chunks select, move, undo, and persist as one item.
- Selection is transient UI state. It is never written to sidecars, indexes, thumbnails, or exports.
- V1 does not infer handwriting objects, persist groups, or provide lasso/marquee selection.

### Selection Gestures

- Clicking or tapping a stroke selects it and clears the previous selection.
- Desktop `Shift`/platform-modifier click toggles a stroke in the selection.
- A visible `Multiple` control in Select/Move provides the same additive toggle without requiring a
  hardware keyboard.
- Once at least one logical stroke is selected, the toolbar reveals `Delete selected Ink strokes`.
  The action is absent from the active control set when selection is empty.
- Delete removes the complete selected logical stroke IDs, including linked fragments in different
  chunks, clears transient selection, and records the whole batch as one Undo/Redo command. It does
  not require confirmation because Undo immediately restores the complete batch.
- Clicking empty workspace clears the selection.
- `Escape` cancels an active drag preview first, then clears the selection, then exits Ink Mode.

### Pointer Routing

- Desktop mouse/pen selects and drags in Select/Move.
- On iPad, Apple Pencil selects and drags while finger input continues to scroll by default.
- A future finger-move toggle requires real-device evidence and a separate product decision; v1 does
  not make one hidden gesture ambiguously scroll or move Ink.

### Movement

- Dragging any selected stroke previews one shared `(dx, dy)` translation for the full selection.
- Pointer move updates only an in-memory preview layer through RAF/dirty-region rendering.
- Pointer-up commits one command regardless of how many strokes/chunks are affected.
- `Escape` restores the exact pre-drag snapshot.
- The group delta is clamped or rejected as one value before persistence so no point enters negative
  or inaccessible coordinates and different strokes never receive different movement.
- Moving across chunk boundaries repartitions fragments while preserving logical stroke ID, temporal
  point order, tool, color, width, pressure, timestamps, relative spacing, and visual continuity.
- One batch drag is one Undo/Redo unit and reconstructs identically after reload.

## Canonical Coordinate Model

The current schema v1 orders and positions bounded surfaces indirectly through Markdown section
bindings and current layout fingerprints. Disabling Rebase without replacing that implicit ordering
would make changed-section Ink disappear or reorder. This feature therefore requires a real storage
migration, not only CSS or lifecycle changes.

### Schema v2 Direction

Each bounded Ink chunk must persist a stable note-global vertical origin:

```ts
interface InkChunkLayoutV2 {
  logicalWidth: number;
  logicalHeight: number;
  originY: number;
}
```

Invariants:

- Every active chunk for one note uses the same logical width.
- `originY` is independent of the note's current Markdown section geometry.
- Note-global point Y is `originY + localPointY`.
- Chunk order derives from persisted global bounds, never current DOM order.
- Source/block/typography fingerprints are optional legacy diagnostics, not placement truth.
- Internal chunks remain bounded files for viewport rendering, conflict isolation, and iCloud file
  granularity; they are not semantic Markdown anchors or pages.

### V1 Migration

- Migration is explicit and versioned; passive Reading never rewrites v1 records.
- A v1 record may migrate automatically only when its previous continuous order and origins can be
  reconstructed uniquely from canonical data and recorded layout evidence.
- Ambiguous legacy geometry fails closed into a manual-placement compatibility path. The plugin does
  not use the current DOM to guess a convenient position.
- Original v1 vectors, revisions, tombstones, conflict siblings, and export data remain available.
- Unknown newer schema versions remain fail-closed.

## Persistence, Undo, and Failure Safety

- A move preflights every affected source and destination chunk revision before writing any result.
- Cross-chunk movement uses the existing journal/recovery infrastructure extended to one batch
  transaction. Recovery exposes either the complete old batch or complete new batch, never a silent
  half-move.
- A stale revision or conflict prevents partial commit, preserves the live result and original
  snapshot, and exposes Retry/cancel/conflict repair.
- Undo/Redo writes only changed chunks rather than revising every chunk in the document.
- A stroke that exits and later re-enters the same chunk retains temporal point order; joining by
  chunk order must not create a false connecting segment.
- Selection chrome never appears in SVG/PNG exports or thumbnails.

## UI Changes

The Ink dock order becomes:

```text
Exit | Pen | Highlighter | Stroke eraser | Select/Move | Multiple | Delete selected | Color | Width | Undo | Redo | More
```

- Select/Move has a distinct icon, tooltip, accessible name, and pressed state.
- The existing dock drag handle moves only the dock and must not look like Select/Move.
- Selected, additive-selection, hover, and drag-preview states use shape/outline as well as color.
- Save failure remains persistent and actionable; routine saving/saved feedback stays unobtrusive.
- `Multiple` is visible within Select/Move on touch layouts and does not become a hidden long-press
  convention.

## Non-Goals

- Fixed font family, font size, line height, theme, or full page geometry.
- Pagination or user-visible internal chunks.
- Automatic Ink rebase, orphan detection, semantic Markdown attachment, or content-aware movement.
- Responsive Ink overlay in normal Reading View.
- Lasso/marquee selection, persistent grouping, shape recognition, handwriting recognition, or
  arbitrary point deformation.
- Changes to text annotation anchoring or repair.

## Acceptance Criteria

- Ink Mode alone applies the fixed width; successful exit, reload, disable, and unload leave no
  width class/style, Canvas, or pointer interception in normal Reading View.
- A long note is one continuous workspace with no page/tile UI.
- Markdown edits before, inside, and after Ink do not passively change Ink coordinates, status,
  revision, or bytes.
- One stroke and an additive multi-selection can each be dragged, cancelled, undone/redone, saved,
  and reconstructed after reload.
- A selected single stroke or additive multi-selection can be deleted in one action; selection
  clears, unrelated strokes remain, and one Undo restores the entire deleted set.
- Cross-chunk movement preserves one logical stroke identity and visual/temporal continuity.
- A multi-chunk write failure or stale revision never leaves a silent half-move and never discards
  the live result.
- Old v1 `active/needs-rebase/unanchored` records remain readable without vector loss.
- Shortened Markdown still permits scrolling to and selecting preserved Ink below the content.
- Drawing and selection-drag input-to-paint target P95 below 16.7 ms at 60 Hz on the validated
  device.
- iPad Pencil selection/drag and finger scrolling coexist on real hardware before the iPad Gate is
  marked complete.

## Execution Slice S16

### Coordinate and Migration Gate

- [x] Add failing schema-v2 codec/invariant/migration tests for `originY` and shared logical width.
- [x] Add v1 unique-migration, ambiguous-manual-placement, conflict, tombstone, and unknown-version
      fixtures.
- [x] Add continuous-canvas height tests covering Ink below shortened Markdown.
- [x] Document the final migration and rollback contract before changing lifecycle behavior.

### Lifecycle TDD

- [x] Add failing tests proving fixed width and Canvas mount only in Ink Mode.
- [x] Add failing tests proving successful exit/unload restores default Obsidian layout and hides
      Ink.
- [x] Add no-op hash tests for passive Reading, Markdown edits, and font/theme changes.
- [x] Remove passive committed-Canvas mounting and mutation-driven Ink source reconciliation.
- [x] Preserve stable reading context across enter/exit without promising pixel-identical Y.

### Select/Move TDD

- [x] Add logical-stroke hit-testing and linked-fragment selection tests.
- [x] Add single/additive/touch-multiple selection and Escape-order tests.
- [x] Add RAF preview, commit, cancel, group-bound, and one-command Undo/Redo tests.
- [x] Add leave-and-re-enter-same-chunk temporal-order regression before repartition work.
- [x] Add cross-chunk repartition, reload, export, and performance tests.

### Persistence TDD

- [x] Add all-target revision preflight and multi-chunk batch journal tests.
- [x] Inject stale revision, promotion failure, restart recovery, Retry, and cancel.
- [x] Prove recovery exposes the complete old or complete new batch only.
- [x] Keep in-memory movement recoverable when exit/background flush fails.

### UI and Accessibility

- [x] Add Select/Move and visible touch `Multiple` to the Preact Ink toolbar.
- [x] Distinguish stroke movement from dock movement in icon, tooltip, name, and focus order.
- [x] Render selection/hover/preview without polluting canonical vectors, thumbnails, or exports.
- [ ] Validate keyboard, reduced motion, contrast, 320/360/480 px, default themes, and Minimal.

### Verification and Evidence

- [x] Run `npm run format`, `npm run check`, and `npm run package:rc`.
- [x] Re-run 200k Markdown / 30-chunk / 10,000-stroke viewport, observer, hit-test, and drag
      profiles.
- [ ] Complete desktop native HAT for default-view exit, Markdown no-op, single/multi drag,
      cross-chunk movement, failure recovery, and shortened-content reachability.
- [ ] Complete real-iPad HAT for fixed-width fitting, Pencil move, finger scroll, and long Ink.
- [x] Write evidence under `docs/delivery/slices/S16-ink-fixed-width-manual-move/` with README,
      coordinate/migration contract, tests, performance report, HAT, risk register, and Source
      Manifest.

### Exit Gate

- [ ] Every acceptance criterion above has automated or native evidence.
- [x] Historical S09–S15 evidence remains intact and is identified as the superseded baseline.
- [x] No v1 vectors, conflicts, tombstones, exports, or canonical recovery paths regress.
- [x] Full fixed typography/layout remains explicitly deferred.

## Source Manifest

### Sources

- User decisions in the current Codex task on 2026-07-15: fixed-width continuous Ink Mode; normal
  Obsidian view outside Ink Mode; no automatic Ink handling after Markdown/layout changes; manual
  single/multi-selection and dragging; full fixed layout deferred.
- User instruction in the current Codex task: extract these new decisions into a new specification
  instead of accumulating them in the two historical master documents.
- User request in the 2026-07-17 Codex conversation: once Select/Move has selected strokes, add a
  direct delete button.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`
- `docs/specs/2026_07_15_refactor_to_preact.md`
- `docs/delivery/slices/S09-ink-feasibility/` through `docs/delivery/slices/S15-ui-v2/`, especially
  S10/S11/S12/S14 Ink evidence.
- `/Users/ivan/.agents/docs/agents/workflows.md` and
  `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

### Produced artifacts

- `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`
- Follow-up S16 delivery directory after implementation.

### Key decisions

- Treat this file as a forward-only superseding Ink specification; do not rewrite historical Slice
  completion evidence.
- Keep normal Reading View native to Obsidian and hide coordinate-bound Ink outside Ink Mode.
- Use explicit note-global chunk origins in schema v2 before disabling section reconciliation.
- Use transient logical-stroke selection and one atomic batch translation for manual correction.
- Defer full fixed typography/layout and automatic Ink rebase.

### Verification evidence

- `git diff --check` passed after extraction.
- All six `docs/specs/*.md` files have balanced fenced blocks, and this specification's local links
  resolve.
- Searches for `S16`, `Select/Move`, `D-27`, `D-28`, and `originY` in the two historical master
  documents now return only their short supersession pointers, not duplicated requirements.
- No plugin implementation or canonical data is changed by this specification extraction.

### Open questions / risks

- The safe editing margin is currently fixed at 512 logical px and covered by automated extent
  tests; its native feel, exact logical width, narrow-viewport scale limit, and selection hit
  tolerance still require device measurement.
- Real iPad Pointer Events and Pencil/finger routing remain unverified.
- Multi-chunk journal recovery and ambiguous v1 migration are implemented and automated, but native
  failure-injection and compatibility fixtures remain part of desktop HAT.
