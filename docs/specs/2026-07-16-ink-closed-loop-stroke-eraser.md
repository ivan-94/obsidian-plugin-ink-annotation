# Ink Closed-Loop Stroke Eraser

## Status

- Created: 2026-07-16
- Status: automated implementation and development installation complete; native desktop and
  physical-iPad HAT pending
- Scope: a closed-loop batch gesture for the existing whole-stroke Eraser in Ink Edit.

This focused specification supersedes only the conflicting statements in the historical Ink
specifications that defer every lasso-like gesture. The exception is limited to closed-loop deletion
inside the existing Stroke eraser. Select/Move still does not provide lasso or marquee selection,
and Ink still does not persist groups or infer handwriting objects.

It does not change the three-state view lifecycle, 704 logical document width, Stage Frame,
pane-wide Canvas, sidecar schema, preview behavior, or the existing point-erase contract.

## Problem Evidence

The current Stroke eraser collects the pointer path for active-layer feedback, but pointer-up uses
only the final point for `eraseStrokeAt`. Drawing around several strokes therefore removes at most
one logical stroke at the endpoint.

This creates unnecessary repeated targeting when a user wants to remove a word, sketch, or other
small cluster. The existing application model already treats linked fragments as one logical user
stroke and already records whole-stroke deletion as an undoable command, so closed-loop deletion can
reuse those guarantees without introducing partial-stroke editing or a storage migration.

Initial device feedback found the fixed 20 CSS px closure gap and 100% centerline containment too
strict: a natural Pencil circle often ends with a moderate gap or lets a short stroke endpoint
protrude just outside the hand-drawn boundary. Requiring a nearly perfect geometric loop makes the
feature feel unreliable even when user intent is visually clear.

A second physical-use report found the first adaptive revision (`35%` of bounds diagonal, capped at
64 CSS px, with 80% stroke coverage) still too conservative. The revised contract accepts a visibly
deliberate near-complete orbit with a larger pen-lift gap and allows a tighter loop around stroke
endpoints, while retaining clearly open paths and 50/50 crossing strokes.

## Product Decisions

| ID           | Decision                                                                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INK-ERASE-01 | Stroke eraser has two gestures: a tap/open path keeps the existing one-stroke endpoint erase, while a qualifying closed path deletes every logical stroke whose centerline meets the region coverage rule.                                                                                                 |
| INK-ERASE-02 | A loop qualifies in presentation space when path length is at least 48 CSS px; width and height are at least 16 CSS px; endpoint gap is at most `clamp(60% × bounds diagonal, 32, 120)` CSS px and at most 30% of path length; and effective fan area is at least `max(64 CSS px², 12% × bounds area)`.    |
| INK-ERASE-03 | Region membership uses boundary-inclusive centerline-length coverage. At least 70% of one logical stroke's aggregate centerline must be inside or on the loop. Up to 30% endpoint protrusion is tolerated; a 50/50 crossing or mostly outside stroke is retained. Stroke width does not change membership. |
| INK-ERASE-04 | All strokes removed by one closed loop form one Undo/Redo command and one atomic multi-chunk persistence operation.                                                                                                                                                                                        |
| INK-ERASE-05 | The loop and its closure cue are transient UI only. They never become an `InkStroke`, sidecar field, thumbnail path, export path, index entry, or selection.                                                                                                                                               |
| INK-ERASE-06 | Closed-loop erase uses the existing Stage Frame and input adapters, so mouse, Pointer pen, and WebKit stylus Touch share logical coordinates while direct finger input remains native scrolling.                                                                                                           |
| INK-ERASE-07 | No sidecar schema or migration is required. Successful deletion persists only the changed canonical stroke arrays and ordinary revision updates.                                                                                                                                                           |
| INK-ERASE-08 | Pointer input consumes coalesced samples when present and falls back to the parent event when the list is empty, preserving Pencil down/up endpoints on standards-compliant WebKit.                                                                                                                        |

The numeric gesture thresholds are initial interaction constants. They may be tuned from native
desktop or physical-iPad evidence, but they must remain CSS-pixel based so the gesture feels the
same at Fit, 50%, 100%, 150%, and 200% presentation scales.

## User-Visible Interaction Contract

### Gesture Classification

- The gesture is available only in `ink-edit` while Stroke eraser is the active drawing tool.
- Pointer-down begins one transient eraser path. Pointer moves append input through the existing
  coalesced Pointer or WebKit stylus Touch pipeline.
- `getCoalescedEvents()` is an optional move-sample refinement, not a replacement for every Pointer
  event. An empty list on `pointerdown` or `pointerup` must retain the parent event coordinates.
- The controller measures path length, path bounds, endpoint gap, and an effective-area proxy in CSS
  presentation space. Canonical hit geometry still uses Stage Frame logical coordinates.
- Endpoint closure is adaptive to the gesture size but remains capped. The endpoint gap must pass
  both the bounds-diagonal threshold and the gap-to-path-length ratio in `INK-ERASE-02`.
- Effective fan area is the sum of the absolute triangle areas formed by the first sample and each
  adjacent sample pair. It rejects retraced scribbles whose endpoints happen to be near each other
  without rejecting concave or self-intersecting user loops solely because their signed area cancels
  to zero.
- A path is a closed-loop erase only when all `INK-ERASE-02` thresholds pass. Pointer-up closes the
  polygon with an implicit final segment from the last sample to the first.
- A path that does not qualify remains the existing point erase and hit-tests at its final sample
  with the current eraser radius.
- A qualifying closed loop that contains no stroke is a no-op. It must not fall back to erasing a
  stroke at the endpoint.
- Pointer cancellation, tool switching, view replacement, finishing Ink Edit, plugin unload, or an
  ownership change before pointer-up cancels the transient path and deletes nothing.
- The gesture commits at most once even when WKWebView emits both Pointer Events and stylus Touch
  Events for one Apple Pencil sequence.

Self-intersecting closed paths use the even-odd fill rule. This keeps the result deterministic
without adding shape recognition or silently repairing the user's path.

### Enclosed-Stroke Semantics

- The unit of consideration is one composite logical user stroke ID, not one stored chunk fragment.
- Every linked fragment is considered in note-global logical coordinates, and covered/total lengths
  are aggregated by logical stroke ID before the threshold is applied.
- A zero-length or single-point logical stroke qualifies only when every stationary fragment point
  is inside or on the polygon boundary.
- A polyline is split at every loop-boundary intersection. Each resulting centerline interval is
  classified by its midpoint, so coverage is based on geometric length rather than stored sample
  count. Boundary intervals count as covered.
- A logical stroke qualifies when covered centerline length is at least 70% of total centerline
  length. Having only a bounding-box center or a majority of sampled points inside is insufficient;
  a small centerline protrusion is tolerated, while a material crossing remains safe from deletion.
- Pen and Highlighter use the same containment rule. Stored legacy `tool: eraser` paths are ignored
  as deletion candidates, matching existing rendering and hit-test behavior.
- Negative X, X greater than 704, and all reachable non-negative Y coordinates are valid. Region
  hit-testing must not clamp candidates to the Markdown document width.
- Each matching logical ID appears once even when it spans several chunks or re-enters a chunk.

### Visual Feedback and Discoverability

- The active eraser path uses a destructive-color outline plus a dashed or otherwise non-solid
  shape. It must not look like committed Pen or Highlighter Ink.
- The starting point has a non-color closure marker. When the endpoint enters the closure threshold,
  the cue visibly changes so closure is not communicated by color alone.
- Committed strokes remain unchanged while the pointer is down. Containment is evaluated once on
  pointer-up; the implementation does not repeatedly scan the document on every pointer move.
- On successful deletion, the loop disappears, affected strokes disappear together, and Undo becomes
  available. No modal confirmation is required because the operation is immediately undoable.
- The existing eraser button remains in the same toolbar slot and keeps ordinary pressed-state
  semantics. Its tooltip and accessible name become `Stroke eraser: tap a stroke or circle strokes`.
- Eraser width continues to control point-erase hit radius and preview weight. It does not expand or
  shrink the closed-loop containment region.

## Command, Persistence, and Failure Contract

- The application layer resolves the enclosed logical IDs from the current composite document,
  captures one before snapshot, and removes every fragment with a matching logical ID from every
  bounded surface.
- If no logical ID matches, Undo/Redo stacks, dirty state, surface revisions, canonical bytes, and
  repository writers remain unchanged.
- If one or more IDs match, the complete before/after stroke sets form exactly one document command.
  One Undo restores every removed fragment in its original chunk, order, style, points, timestamps,
  and identity. Redo removes the same logical IDs again.
- The redo stack is cleared only by a successful non-empty deletion command, consistent with other
  new Ink edits.
- Only chunks whose stroke arrays change are written. Multi-chunk deletion uses the existing atomic
  writer/coalescing boundary so canonical storage exposes either all old chunks or all new chunks,
  never a silent partial deletion.
- A stale revision, conflict, or write failure must not restore only part of the deletion or discard
  the live in-memory result. Ink Edit remains recoverable with the existing Retry/error path.
- Existing successful-exit reclamation of zero-stroke surfaces is unchanged. Circle erase does not
  directly tombstone a surface while the edit session remains active.

## Architecture Contract

### Domain

Add pure, DOM-free region geometry under `src/domain/`. It owns:

- polygon bounds and validation;
- even-odd point-in-polygon classification;
- segment/boundary intersection and covered-length accumulation;
- logical-stroke coverage aggregation and ID deduplication.

The domain API accepts logical points and strokes. It does not know CSS pixels, Stage Frames,
Pointer Events, Canvas contexts, repositories, or Obsidian.

For valid simple polygons, the coverage pipeline follows the established LineString/Polygon
structure also used by Turf `booleanWithin`: bounding-box rejection, point-in-polygon, segment
splitting at polygon intersections, and midpoint classification of every resulting interval.
Inkstone sums the classified interval lengths instead of requiring the standard 100% `within`
predicate, and extends that baseline with boundary-only acceptance and even-odd handling for
self-intersecting user loops. Pulling Turf or FlattenJS into the mobile runtime would not remove
those product-specific extensions, and their simple-valid-polygon contracts do not cover the
complete S21 behavior.

### Application

Extend `InkDocumentSession` with one batch region-erase entry point returning the removed logical
IDs. Refactor point erase and region erase through one private logical-ID removal command so linked
fragment cleanup, history, persistence, and failure behavior cannot diverge.

### UI

`InkCanvasController` owns CSS-space gesture qualification, transient rendering, lifecycle
cancellation, and routing between endpoint erase and region erase. It converts the accepted loop to
logical coordinates through the already-published Stage Frame before invoking the application
session.

UI code must not write sidecars or create a persisted eraser stroke.

### Storage

No codec, schema version, repository format, index format, or migration change is permitted for this
feature. Storage receives ordinary changed `InkSurfaceRecord.strokes` arrays through existing
application ports.

## Performance and Reliability Budgets

- Active eraser-path input-to-paint retains the Ink target of P95 below 16.7 ms at 60 Hz on the
  validated device.
- Pointer-move rendering is incremental and independent of the already-painted path prefix.
- Region hit-testing runs once after a qualifying pointer-up. Polygon and stroke bounding boxes
  reject impossible candidates before segment containment work.
- A deterministic profile with 10,000 logical strokes and a simplified loop of at most 128 points
  must complete classification plus in-memory deletion within the existing desktop interaction
  budget of 250 ms.
- Loop simplification must preserve closure and containment within the accepted visual-error
  tolerance. It must not convert an open gesture into a closed gesture.
- A spatial index is not required unless the bounded scan fails the performance gate. Any later
  cache remains disposable and cannot become placement or deletion truth.

## Acceptance Criteria

- Tapping a stroke still removes exactly that complete logical stroke.
- Drawing an open path still performs one endpoint point erase and does not batch-delete nearby
  strokes along the path.
- A qualifying loop around three strokes deletes those three together; a fourth outside the loop and
  a fifth with more than 30% of its centerline outside remain unchanged. A stroke with only a minor
  endpoint protrusion may be deleted.
- A qualifying empty loop changes no history, revision, canonical file, or save status.
- One loop can remove linked fragments across multiple chunks without leaving an orphan fragment.
- Undo once restores the complete batch; Redo once removes it again; save and reload reconstruct the
  same result.
- A simulated multi-chunk write failure retains the complete live deletion and exposes Retry without
  a half-written canonical result.
- Fit, 50%, 100%, 150%, and 200% use the same CSS-space closure feel and correct logical
  containment.
- Loops and targets in the pane margins retain negative X or X greater than 704 without clamping or
  drift.
- Mouse, Pointer pen, and WebKit stylus Touch execute the same batch semantics; direct finger input
  continues native scrolling and deletes nothing.
- Pointer cancellation and duplicate Pointer-plus-Touch delivery never commit a partial or duplicate
  deletion.
- The loop is absent from sidecars, thumbnails, SVG/PNG exports, summaries, and Raw/Preview Canvas.
- Targeted TDD, full `npm run check`, performance checks, development installation, native desktop
  walkthrough, and physical-iPad Pencil/finger HAT pass before S21 is complete.

## Non-Goals

- Lasso or marquee selection in Select/Move.
- Deleting only the portion of a stroke that lies inside the loop.
- Path/scribble erasing continuously along every sampled eraser point.
- Deleting a stroke merely because it touches or intersects the loop while failing the 70%
  centerline-coverage rule.
- Persistent groups, handwriting-object inference, shape recognition, or arbitrary point editing.
- Finger drawing/erasing, Pencil double-tap/squeeze/hover, or a new gesture settings panel.
- Text-annotation deletion, Markdown deletion, whole-surface deletion, or sidebar bulk deletion.
- A sidecar schema migration or persisted eraser gesture history.

## Execution Slice S21

### Contract and Domain TDD

- [x] Add failing geometry tests for convex, concave, boundary-inclusive, and self-intersecting
      polygons.
- [x] Add centerline-coverage tests for point strokes, minor protrusions, materially crossing
      strokes, sparse long segments, negative X, and X greater than 704.
- [x] Add linked logical-stroke tests proving coverage is aggregated across fragments while an
      outside stationary fragment fails closed.
- [x] Implement pure bounds, even-odd containment, boundary intersection, length accumulation, and
      ID deduplication.

### Application TDD

- [x] Add failing single- and multi-chunk batch-delete tests with one Undo/Redo command.
- [x] Add no-match/no-dirty/no-write and redo-stack preservation tests.
- [x] Add stale revision, atomic-writer failure, live-result retention, Retry, and reload
      regressions.
- [x] Refactor point and region erase through one logical-ID removal command.

### Controller and UI TDD

- [x] Add CSS-space threshold tests for short, clearly open, closed, moderately/large-gapped,
      retraced, and empty loops at multiple zooms.
- [x] Add pointer-up routing, pointer-cancel, tool switch, exit, root replacement, and unload tests.
- [x] Add mouse, Pointer pen, WebKit stylus Touch, direct-finger, and dual-delivery regressions.
- [x] Add destructive dashed preview, non-color closure cue, accessible label, and non-persistence
      tests.
- [x] Preserve current point-erase radius, toolbar order, and More-only secondary controls.

### Verification and HAT

- [x] Add the 10,000-stroke / 128-point region-erase performance profile and retain active-paint
      budgets.
- [x] Run focused tests, touched-file formatting, lint, typecheck, coverage, performance, production
      build/mobile check, and `npm run install:dev`.
- [x] Run the composite `npm run check` after the workspace formatting gate became clean.
- [ ] Record native Obsidian desktop evidence at Fit, 50%, 100%, 150%, and 200%.
- [ ] Record physical-iPad Pencil circle erase, finger scroll, cancellation, and dual-delivery
      evidence.
- [ ] Prepare S21 HAT artifacts, performance/reliability evidence, and a Slice Source Manifest
      before marking delivery complete.

## Source Manifest

### Sources

- User request in the 2026-07-16 Codex conversation: allow the Eraser to circle an area and delete
  the strokes inside; the follow-up explicitly requested a new specification.
- User request in the 2026-07-17 Codex conversation: make the gesture less strict so users need not
  draw a perfectly closed, regular circle; the follow-up reported that the first adaptive revision
  was still insufficiently tolerant.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`.
- `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`.
- `docs/specs/2026-07-16-ink-704-zoomable-workspace.md`.
- `docs/specs/2026-07-16-ink-stage-frame-and-native-navigation.md`.
- `docs/delivery/slices/S12-ink-tools/`.
- `docs/delivery/slices/S16-ink-fixed-width-manual-move/`.
- `src/application/ink-document-session.ts` and its tests.
- `src/ui/ink-canvas-controller.ts` and its tests.
- [W3C Pointer Events — coalesced events](https://www.w3.org/TR/pointerevents3/#coalesced-events)
  defines empty coalesced lists for non-move trusted events.
- [WebKit: Safari 18.2 Pointer Events](https://webkit.org/blog/16301/webkit-features-in-safari-18-2/)
  documents the iOS/WebKit introduction of `getCoalescedEvents()`.
- [Apple: high-fidelity coalesced touches](https://developer.apple.com/documentation/uikit/getting-high-fidelity-input-with-coalesced-touches)
  documents retaining the delivered final touch alongside high-frequency samples.
- [Apple: Introducing PencilKit](https://developer.apple.com/videos/play/wwdc2019/221/) documents
  `PKLassoTool` as selecting strokes intersected by the lasso.
- [Turf `booleanWithin`](https://turfjs.org/docs/api/booleanWithin) and its
  [reference implementation](https://github.com/Turfjs/turf/blob/master/packages/turf-boolean-within/index.ts).
- `/Users/ivan/.agents/docs/agents/workflows.md`.
- `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

### Produced artifacts

- `docs/specs/2026-07-16-ink-closed-loop-stroke-eraser.md`.
- Entries in `docs/specs/README.md` and `AGENTS.md` naming this specification as a source of truth.
- `src/domain/ink-closed-loop-erase.ts` and its geometry tests.
- Application, Controller, toolbar, integration, and performance changes listed in
  `docs/delivery/slices/S21-ink-closed-loop-stroke-eraser/source-manifest.md`.
- `docs/delivery/slices/S21-ink-closed-loop-stroke-eraser/` automated delivery evidence.

### Key decisions

- Extend the existing Stroke eraser with a dual gesture instead of adding a new toolbar mode.
- Preserve whole-logical-stroke deletion while tolerating up to 30% uncovered centerline.
- Use size-adaptive closure plus gap ratio and effective area instead of one fixed 20 CSS px gap.
- Keep point erase as the fallback for non-qualifying open paths.
- Make one closed loop one atomic Undo/Redo and persistence command.
- Keep gesture qualification in CSS space and canonical containment in Stage Frame logical space.
- Do not introduce a schema change, partial-stroke erasing, or Select/Move lasso selection.

### Verification evidence

- Focused S21 regression suite: 7 files / 145 tests passed.
- Full `npm run check`: formatting, lint, typecheck, 101 files / 695 coverage tests, 4 files / 9
  performance tests, production build, and mobile bundle check passed.
- The 10,000-stroke / 128-point loop profile completed in 35 ms against the 250 ms gate on the
  development machine.
- `npm run install:dev` and `git diff --check` passed.
- A standards-compliant WebKit regression reproduced the iPad failure by returning coalesced samples
  only for `pointermove`; retaining parent down/up events restored both Pencil circle and tap erase.
- Native desktop and physical-iPad verification remain pending, so S21 is not complete.

### Open questions / risks

- The adaptive CSS-space closure constants require native desktop and physical-iPad tuning before
  S21 can be considered complete.
- The 70% centerline coverage threshold balances natural endpoint overshoot against destructive
  false positives; native HAT must validate both minor protrusions and materially crossing strokes.
- The bounded scan passed the desktop gate without a spatial cache; native device measurement is
  still required.
- Physical-iPad Pencil/finger and dual Pointer-plus-Touch behavior remain hardware release gates.
- The WebKit endpoint fix is installed in the development Vault but still requires confirmation on
  the reporting physical iPad.
