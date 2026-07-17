# Ink Stage Frame and Native Navigation

## Status

- Created: 2026-07-16
- Status: implemented and verified in the development Vault; physical iPad mini Pencil/finger
  acceptance remains a release gate
- Scope: root repair for Ink/Markdown alignment across zoom, vertical scroll, and pane resize, plus
  restoration of native wheel/finger navigation.

This focused specification supersedes the transient viewport-coordinate and Canvas input-routing
implementation described by `2026-07-16-ink-704-zoomable-workspace.md`. It does not change the 704
logical width, three-state lifecycle, manual Select/Move behavior, sidecar schema, or the rule that
Markdown edits do not automatically rebase Ink.

## Problem Evidence

The same visible defects returned after several local geometry corrections:

1. Existing Ink is aligned at 100% but moves above its Markdown landmark at 50%.
2. Changing the annotation sidebar width changes Fit scale and moves the Ink layer away from the
   Markdown layer.
3. Vertical scrolling has previously produced different deltas for Ink and Markdown.
4. In Ink edit, mouse-wheel scrolling no longer moves the note; only dragging the scrollbar works.
5. On iPad, switching from 100% to 60% can leave Ink at 100% size and move its origin far to the
   right while Markdown visibly scales and recenters.

Native Obsidian 1.12.7 measurements show why:

- At Fit `0.87358`, the 704 workspace rect was `(276, 140.390625, 615, 1440.453125)`, while the
  fixed Canvas rect was `(244, 70, 679, 891)` and the Reading View rect began at `y=108.390625`.
- The first persisted stroke rendered at client `y=232.5..241`, while its canonical first point is
  logical `y=153.4375`.
- At 50%, the Markdown paragraph and the same persisted stroke no longer shared one scaled landmark.
- A trusted Chromium wheel experiment reproduced the navigation failure only when an interactive
  fixed Canvas was the event target. The wheel event was not cancelled; it simply did not target
  content in the scroll container's scrolling box.

## Root Cause

Before S19, the controller reconstructed a logical viewport from pane width, pane top, padding,
scroll offsets, the toolbar's requested scale, and a fixed Canvas whose containing block was chosen
by browser layout. Rendering and pointer input then independently inverted that reconstructed
viewport. That created several competing sources of truth:

- Markdown uses Chromium's actual CSS-zoomed DOM geometry.
- Canvas placement uses assumed fixed-position containing-block geometry.
- Ink rendering uses mutable `viewportLeft/Top/Width/Height` fields.
- Pointer input uses the Canvas rect plus those fields.
- Resize, scroll, and scale update those values in separate imperative steps.

At 100%, old input and old rendering share the same structural fixed-layer offset, so existing
sidecars appear correct. At other scales, that offset remains in client pixels instead of scaling as
part of the logical stage. Repeated `top`, `scrollTop`, padding, and overflow corrections cannot
make the model stable because no single transform owns all conversions.

The wheel regression has a separate but related cause: the same Canvas is both renderer and input
surface. Making the fixed Canvas interactive removes the native Reading View content from hit
testing, so browser navigation no longer has the correct scroll target.

The iPad-only zoom regression is a WebKit CSS `zoom` geometry defect. WebKit can render the zoom
while `getBoundingClientRect()` retains the unzoomed width and height and reports viewport
coordinates divided by the zoom factor. Dividing that width by `offsetWidth` therefore returns `1`,
and publishing the raw `left`/`top` moves the Stage Frame origin in the opposite direction.

## Decisions

| ID          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| INK-V1.3-01 | One immutable **Stage Frame** is the only runtime authority for logical, client, Canvas-CSS, and Canvas-backing coordinates.                                                                                                                                                                                                                                                                                                         |
| INK-V1.3-02 | The Stage Frame is measured from actual DOM rectangles and actual rendered scale. It does not reconstruct centering, padding, scroll, or fixed containing-block behavior.                                                                                                                                                                                                                                                            |
| INK-V1.3-03 | Existing 100% placement is the compatibility baseline. Its structural document-origin inset is captured once per Reading View host attachment, normalized by the measured containing-block scale, and multiplied by the actual document scale thereafter. No sidecar is rewritten.                                                                                                                                                   |
| INK-V1.3-04 | Both committed and active Canvas contexts consume the same Stage Frame matrix. Pointer creation and hit testing consume its exact inverse.                                                                                                                                                                                                                                                                                           |
| INK-V1.3-05 | Canvas and its pane-wide surface are always pointer-transparent. Mouse and `pointerType: pen` input are captured at the stable Reading View scroll host. WebKit `Touch.touchType: stylus` is the Apple Pencil fallback when Pointer Events are missing or misclassified. Direct finger touch propagation is stopped without cancelling the event, so Reading View handlers stay isolated while the browser retains native scrolling. |
| INK-V1.3-06 | Wheel scrolling is never bridged or reimplemented by the plugin. The native scroll host remains the browser event target.                                                                                                                                                                                                                                                                                                            |
| INK-V1.3-07 | Zoom, scroll, and resize each replace the complete Stage Frame atomically before redraw. Partial viewport fields are removed.                                                                                                                                                                                                                                                                                                        |
| INK-V1.3-08 | One global lifecycle queue owns the active `(view, mounted session, file path)` transition. Async exit commits only if the same view and mounted-session identity still own the manager.                                                                                                                                                                                                                                             |
| INK-V1.3-09 | Preview is a persisted Reading transition, so re-entering Edit must reopen every retained bounded domain session before the UI accepts input.                                                                                                                                                                                                                                                                                        |
| INK-V1.3-10 | Retry belongs to the same manager lifecycle queue as exit. A toolbar Retry cannot locally deactivate a controller while the manager still owns it.                                                                                                                                                                                                                                                                                   |
| INK-V1.3-11 | A pending enter captures the active-leaf epoch and is cancelled after mounting if the leaf, view, or mounted identity changed.                                                                                                                                                                                                                                                                                                       |
| INK-V1.3-12 | Dirty bounded vectors receive a synchronous device-local recovery checkpoint. Canonical sidecars remain authoritative; revision divergence fails closed instead of overwriting either copy.                                                                                                                                                                                                                                          |
| INK-V1.3-13 | Native scroll is a read-only Stage Frame projection: it reuses the measured Canvas frame and scale, updates only the document client origin, and redraws without writing layout or measuring Canvas.                                                                                                                                                                                                                                 |
| INK-V1.3-14 | Manual zoom, Fit resize, and Reading View host replacement preserve the same logical viewport top across the layout transaction.                                                                                                                                                                                                                                                                                                     |
| INK-V1.3-15 | A newer wheel, touch, pointer, keyboard, or scroll intent cancels any deferred Reading Context restore so plugin restoration cannot overwrite native navigation.                                                                                                                                                                                                                                                                     |
| INK-V1.3-16 | Repository instances sharing one Vault text-file adapter share one canonical write coordinator; single, batch, and summary keys are collision-proof namespaces.                                                                                                                                                                                                                                                                      |
| INK-V1.3-17 | One document-level macrotask is the commit barrier for a multi-chunk logical Ink command, preventing sibling chunk persistence from exposing a partial command.                                                                                                                                                                                                                                                                      |
| INK-V1.3-18 | A successful owner write invalidates sibling preview mounts for the same file so a second visible leaf cannot keep rendering stale canonical Ink.                                                                                                                                                                                                                                                                                    |
| INK-V1.3-19 | Recovery v3 persists the confirmed base, pending attempt, and working record separately; it fences stale managers, quarantines corrupt bytes, and retains one reachable live owner after dual checkpoint/canonical failure.                                                                                                                                                                                                          |
| INK-V1.3-20 | Journal recovery preflights every canonical record before writing any record. It may replay only when all canonical bytes are exactly the journal's previous or next bytes; any third state fails closed without mutation.                                                                                                                                                                                                           |
| INK-V1.3-21 | Brush width uses one visible preview/value trigger backed by a full-size native `select`. iPad delegates choice to the system picker instead of exposing several compressed line targets; the control never autofocuses.                                                                                                                                                                                                             |
| INK-V1.3-22 | The DOM measurement adapter detects whether the layout rect ignored the presented CSS zoom by comparing its raw scale with the unzoomed containing scale and the expected presented scale. Only in that case it normalizes rect size, viewport origin, and Stage Frame scale together; detection is geometric rather than user-agent based.                                                                                          |
| INK-V1.3-23 | Every stable toolbar choice is device-local preference state: drawing tool, color, width, Draw/Select interaction, multiple selection, More expansion, edit zoom mode/scale, and dragged position. Undo/Redo availability, save state, and selected stroke identities remain session state.                                                                                                                                          |
| INK-V1.3-24 | Ink Preview always presents the Reading View at its native `100%` scale. Edit zoom is remembered separately and restored only when Edit is entered again; it never leaks into Preview.                                                                                                                                                                                                                                               |

## Stage Frame Contract

The pure frame takes three measured facts:

```ts
interface InkStageFrameInput {
  canvasClientRect: CssRect;
  documentClientOrigin: CssPoint;
  actualScale: number;
}
```

For logical point `L`, document client origin `O`, scale `S`, and Canvas client origin `C`:

```text
client(L)    = O + S × L
canvasCss(L) = client(L) - C
logical(P)   = (P - O) / S
```

The Canvas backing-store transform at device-pixel ratio `D` is:

```text
[ D×S   0    D×(O.x-C.x) ]
[  0   D×S   D×(O.y-C.y) ]
```

Required invariants:

- `clientToLogical(logicalToClient(point))` round-trips within floating-point tolerance.
- A Markdown landmark and its Ink logical point move by the same client-pixel delta after any zoom,
  scroll, or sidebar resize.
- Requested toolbar scale is not trusted when it differs from measured rendered scale.
- The Canvas backing size affects sharpness only; it never changes logical coordinates.
- The Stage Frame is runtime-only and never appears in a sidecar.

### 100% compatibility inset

Existing vectors were created with a fixed-layer structural inset at 100%. The controller captures
that inset before applying Ink zoom:

```text
compatibilityInset = oldFixedCanvasOrigin - readingPaneOrigin
documentOrigin     = measuredWorkspaceOrigin + compatibilityInset × actualScale
```

This preserves the accepted 100% placement while making the inset part of the logical stage at 50%,
150%, Fit, and after pane resize. It is a presentation compatibility adapter, not a new persisted
coordinate field.

## Rendering and Input Boundaries

- The pane-wide overlay is calibrated to the actual Reading View client rect; browser fixed-layer
  containing-block offsets must not leak into its final rect.
- Canvas layers remain viewport-sized and do not contribute to `scrollWidth` or `scrollHeight`.
- The pane-wide surface and both Canvas children remain pointer-transparent in Edit, Preview, and
  Raw. Reading View content remains the browser hit target so its real scroll container owns native
  touch navigation.
- Every Canvas transform is replaced with `setTransform`; transforms are not incrementally stacked.
- Strokes are rendered in canonical logical coordinates without subtracting ad-hoc viewport offsets.
- Canvas clearing temporarily uses backing-pixel identity space so translations cannot leave stale
  pixels.
- Pointer listeners live on `scrollContainer ?? root` in capture phase. Only primary mouse/pen input
  in Ink edit is prevented and interpreted as Ink.
- During Ink edit, touch pointer events are stopped at the scroll-host capture boundary but are
  never cancelled. They therefore cannot reach Markdown component listeners while the browser's
  default pan action still scrolls the native Reading View container.
- WebKit stylus Touch Events are a second Apple Pencil input adapter. `touchType: stylus` is
  cancelled and mapped into the same draw, erase, and Select/Move state machine; `touchType: direct`
  is never cancelled. When WebKit emits both Pointer and Touch Events for one Pencil sequence, the
  active Pointer sequence owns the stroke and the Touch fallback does not duplicate it.
- WebKit CSS-zoom rect normalization happens before Stage Frame publication. A rect that already
  includes the presented zoom remains untouched; a rect that ignores it has width, height, left, and
  top corrected as one measurement transaction.
- Reading View `selectstart` is cancelled during Ink edit so touch/Pencil gestures cannot select
  Markdown text. Preview and Raw restore native selection.
- Ink edit consumes Reading View `dblclick` and the second `click` in a multi-click sequence outside
  the Ink toolbar. The first click remains available to WKWebView's Pencil input pipeline; Raw and
  Preview retain ordinary Reading View activation.
- Canvas layers and the surface stay `pointer-events: none` in every mode. Passive navigation-intent
  listeners may cancel a pending plugin restore, but never prevent, bridge, or synthesize native
  wheel or touch scrolling.

## Atomic Update Sequence

Enter, zoom, window/sidebar resize, and virtualized-root replacement are layout transactions:

1. Capture the current logical viewport top when a previous Stage Frame exists.
2. Apply the requested Markdown presentation scale only when it changed.
3. Measure the pane, workspace, Canvas, actual document scale, and fixed containing-block scale.
4. Calibrate the overlay to the pane rect and publish one complete Stage Frame.
5. Resize backing stores if needed, install the frame matrix on both contexts, and redraw.
6. Restore the captured logical viewport top using the replacement frame.

Native scroll follows a deliberately smaller read-only path:

1. Cancel any pending Reading Context restore.
2. Read only the current layout-root client rect.
3. Reuse the published Canvas rect and actual scale while replacing the document client origin.
4. Redraw from that new Stage Frame.

The scroll path does not write CSS zoom, restore `scrollTop`, measure Canvas, recalibrate the
overlay, or resize backing stores. An unchanged resize similarly avoids a redundant scale write.

No consumer may read a mixture of the old and new frame.

## Active Session Ownership

Stage geometry can remain correct and still be corrupted by lifecycle races if two independent
Obsidian events exit the same session concurrently. Layout refresh, active-leaf change, toolbar
toggle, file mutation, preview-policy change, and background persistence therefore follow one global
lifecycle queue whenever they can change or persist the active owner.

The ownership invariants are:

- `activeView` implies that the same view has a mounted session.
- A mounted session for the active view is never replaced or disposed by an async remount path.
- After any awaited exit or mutation, state changes commit only when both the view and mounted
  object still match the operation's captured owner.
- A file or mode change during font/layout readiness is revalidated after the wait; the old active
  session exits through persistence before its mount is released.
- A pending automatic preview rechecks the current preference after mounting and disposes only the
  exact mount it created.
- A second view's toolbar intent waits for the current transition instead of being swallowed. If
  persistence fails, the current owner remains active and the queued view fails closed.
- A retained Preview mount re-enters its domain session before the controller becomes editable;
  partially successful multi-chunk exits reopen only the chunks that reached Reading.
- Retry of a failed exit repeats and commits the captured Raw/Preview transition inside the global
  queue. Retry of a background save keeps the active owner.
- Active-leaf changes synchronously invalidate pending enter epochs even while layout/font/storage
  work is occupying the lifecycle queue.

## Device-local recovery checkpoint

Obsidian plugin unload is synchronous, while Vault writes are asynchronous. Dirty vectors therefore
cannot rely on a final `onunload` Promise. During each logical mutation, the mounted document
session serializes its bounded records to a vault/device/file-scoped `localStorage` checkpoint. The
checkpoint is a write-ahead recovery cache, not a canonical annotation store.

Recovery rules:

- A version-3 checkpoint carries the full expected base, pending attempt, and working record for
  every bounded surface. Recovery never reconstructs ancestry from a revision number alone.
- A file-scoped owner lease prevents a disposed or pre-reload manager from writing a newer
  checkpoint after the replacement manager claims the file.
- A successful canonical save clears only the exact checkpoint generation it covered; a newer
  generation cannot be deleted by an older in-flight save.
- On mount, matching base revisions are restored through the normal single-record or atomic
  multi-record repository write, producing a new canonical revision.
- If canonical bytes already contain the checkpoint content, the checkpoint is cleared without a
  duplicate write.
- If recovery landed but the process stopped before checkpoint clearing, the same recovered content
  at exactly `base + 1` or `pending + 1` is recognized as already recovered rather than becoming a
  permanent false conflict.
- Missing surfaces, a changed surface set, or a different newer canonical payload fail closed and
  retain the checkpoint for manual recovery.
- Corrupt checkpoint bytes are moved to a unique quarantine key and removed from the active key so
  they cannot permanently block the note.
- If synchronous checkpoint storage fails, the error is surfaced and an immediate canonical
  background flush is scheduled; the failure is never silently treated as saved. If both paths fail,
  the live owner remains mounted so Retry can recover it before release.

## Acceptance Criteria

- The two persisted fixture strokes stay on the same Markdown landmarks at 50%, 100%, 150%, and Fit;
  their sidecar bytes and revisions do not change merely from viewing or resizing.
- After dragging the annotation sidebar narrower and wider, Fit recomputes and Ink remains aligned
  within one animation frame.
- Scrolling at the top, middle, and bottom changes the client position of Markdown and Ink by the
  same amount.
- Native scroll does not rewrite `--inkstone-ink-scale`, measure Canvas, recalibrate the overlay, or
  restore `scrollTop`; an unchanged resize does not repeat the CSS scale write.
- Manual zoom, Fit resize, and Reading View host replacement preserve the same logical viewport top,
  and a deferred restore never overwrites newer native navigation.
- Mouse wheel and trackpad scrolling work when the pointer is over text, Ink, and pane whitespace.
- Apple Pencil/mouse can still draw outside the 704 boundary, while a finger scroll is not captured
  as a stroke.
- Finger or Apple Pencil double-tap in Ink edit cannot switch the note into Markdown editing.
  Toolbar controls remain operable, and the first Pencil click is not canceled.
- Pencil input targets Reading View content and is intercepted by the scroll-host capture listener
  to create Ink without reaching Markdown handlers. Finger input is stopped at the same boundary
  without cancellation, retaining native Reading View scrolling.
- A Pencil sequence remains drawable when WKWebView reports its Pointer Event as touch, because the
  subsequent `Touch.touchType: stylus` sequence supplies the fallback. A normal `touchType: direct`
  sequence never creates a stroke and remains uncancelled.
- Markdown text cannot be selected during Ink edit because `selectstart` is cancelled at the capture
  boundary. Preview and Raw restore normal Reading View selection.
- Ink edit does not apply `user-select: none` or disable native touch actions; Pencil remains on the
  drawing path while finger input retains native scrolling.
- The brush-width control exposes `1`, `2`, `4`, `8`, `12`, and `16` px through the native platform
  picker, preserves a current non-standard width as an option, and applies the selected width to the
  next stroke without moving focus on toolbar mount.
- Stable toolbar choices, including the More expansion state, survive controller disposal and
  recreation through the device-local preference store. Existing v1 preference bytes without the new
  optional fields continue to load with safe defaults.
- Leaving Edit for Preview restores native Reading View scale to `100%`; re-entering Edit restores
  the last editing zoom mode and scale without changing canonical Ink coordinates.
- At 100%, 90%, 80%, 70%, 60%, and 50% on iPad, persisted Ink and newly drawn Ink use the same
  visual scale and document origin as Markdown; switching zoom cannot retain a 100% Canvas transform
  or publish the zoom-divided WebKit coordinates.
- Pointer-down at a visible landmark round-trips through persistence and reload at every supported
  scale.
- Fit content with no real horizontal overflow has no horizontal scrollbar.
- Raw mode restores native Obsidian layout and input behavior.
- Switching files, leaves, preview policy, or Raw mode during an in-flight layout/persistence wait
  cannot produce two exits, discard the previous owner, or clear a newly entered owner.
- Exit to Preview followed by re-entry accepts and persists another stroke on both single- and
  multi-chunk documents.
- Failed exit Retry clears ownership only after the captured transition succeeds; background Retry
  keeps ownership.
- Plugin disposal checkpoints dirty vectors before destroying the Canvas, and restart recovery never
  overwrites a diverged canonical revision.
- Overlapping single-record and batch canonical writes sharing one Vault adapter serialize without a
  lost update, and a multi-chunk logical command becomes visible only after its document commit
  barrier.
- Version-3 recovery passes the real save → load → plan path, preserves exact ancestry, recognizes a
  landed recovery after a crash-before-clear, fences stale owners, and quarantines corrupt active
  bytes.
- A stale batch journal cannot overwrite a newer canonical successor: recovery validates every
  target before performing its first write and fails closed on any third-state bytes.
- Focused tests, full `npm run check`, development installation, native Obsidian walkthrough, and
  dual-track cross-review pass before this specification is marked implemented.

## Non-Goals

- Changing or migrating sidecar coordinate data.
- Automatic Ink rebase after Markdown edits.
- Fixed typography, pagination, pinch zoom, or a rasterized Markdown document.
- Reimplementing browser wheel, trackpad momentum, touch scrolling, or scrollbar behavior.

## Source Manifest

### Sources

- User request and toolbar screenshot supplied in the 2026-07-17 Codex task requiring complete
  toolbar-choice memory, a `1 px` brush option, and `100%` Preview independent of Edit zoom.
- User report and three screenshots supplied in the 2026-07-16 Codex task: 100% accepted state, 50%
  alignment failure, sidebar-resize alignment failure, and loss of mouse-wheel scrolling.
- User follow-up in the same task reporting that finger or Apple Pencil double-tap during Ink edit
  entered Markdown editing and could hand Pencil input to iPadOS Scribble.
- Physical iPad follow-up showing that suppressing Reading View selection regressed Apple Pencil
  from drawing to native window scrolling.
- User-directed experiment in the same task: place a transparent interaction shield over the
  original Obsidian Markdown view during Ink edit instead of relying on Markdown event suppression.
- Physical iPad follow-up in the same task showing that the fixed interaction shield prevented
  native finger scrolling even with native pan actions declared; the shield was rejected in favor of
  a non-cancelling scroll-host capture barrier.
- Physical iPad follow-up in the same task showing that the pointer-only capture barrier restored
  finger scrolling but again stopped Apple Pencil drawing, requiring WebKit's stylus Touch fallback.
- Physical iPad follow-up and screenshot in the same task showing that the compressed inline brush
  width samples were not discoverable or reliably selectable, with the requested replacement being a
  dropdown control.
- Physical iPad follow-up and two screenshots in the same task showing the returned 100% to 60%
  regression: Markdown scaled and recentered while persisted Ink retained its former size and moved
  right.
- Earlier user reports and screenshots in the same task covering zoom drift, vertical scroll drift,
  horizontal overflow, pane resize, and Canvas/input behavior.
- Native Obsidian 1.12.7 DOM/Canvas measurements collected in the same task.
- Trusted Chromium fixed-overlay wheel reproduction collected in the same task.
- Apple WebKitJS `Touch` documentation exposing `touchType`:
  https://developer.apple.com/documentation/webkitjs/touch
- WebKit Safari 18.2 Pointer Events notes documenting Apple Pencil angle data and recent Pointer
  Events changes: https://webkit.org/blog/16301/webkit-features-in-safari-18-2/
- WebKit bug 77998 documenting that `getBoundingClientRect()` can return unzoomed size and
  zoom-divided coordinates for elements using CSS `zoom`:
  https://bugs.webkit.org/show_bug.cgi?id=77998
- `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`
- `docs/specs/2026-07-16-ink-704-zoomable-workspace.md`
- `docs/delivery/slices/S16-ink-fixed-width-manual-move/`
- `docs/delivery/slices/S18-ink-704-zoomable-workspace/`
- `src/adapters/obsidian/ink-mode-manager.ts`
- `src/adapters/obsidian/vault-text-file-store.ts`
- `src/application/ink-document-session.ts`
- `src/storage/ink-surface-repository.ts`
- `src/storage/local-ink-recovery.ts`
- `src/ui/ink-canvas-controller.ts`
- `src/domain/ink-workspace.ts`
- `styles.css`
- `/Users/ivan/.agents/docs/agents/workflows.md`
- `/Users/ivan/.agents/docs/agents/handoff-policy.md`
- `/Users/ivan/.agents/skills/diagnose/SKILL.md`
- `/Users/ivan/.agents/skills/tdd/SKILL.md`
- `/Users/ivan/.agents/skills/zoom-out/SKILL.md`
- `/Users/ivan/.agents/skills/improve-codebase-architecture/SKILL.md`
- `/Users/ivan/.agents/skills/cross-review/SKILL.md`
- `/Users/ivan/.agents/skills/visual-fidelity-loop/SKILL.md`
- `/Users/ivan/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000387/skills/computer-use/SKILL.md`

### Open questions / risks

- A physical iPad mini pass remains required to verify simultaneous Apple Pencil drawing and
  one-finger native scrolling. Automated pointer tests establish the event contract but cannot
  replace hardware acceptance.

### Produced artifacts

- `docs/specs/2026-07-16-ink-stage-frame-and-native-navigation.md`
- Stage Frame implementation and regression tests under `src/ui/`.
- Canvas/input-routing updates in `src/ui/ink-canvas-controller.ts` and `styles.css`.
- Device-local write-ahead recovery in `src/storage/local-ink-recovery.ts`.
- `docs/delivery/slices/S19-ink-stage-frame-native-navigation/`

### Key decisions

- Preserve accepted 100% vector placement without sidecar migration.
- Replace reconstructed viewport math with measured DOM geometry and one immutable transform.
- Separate pointer-transparent rendering from stable scroll-host input capture.
- Preserve native browser navigation instead of synthesizing wheel or touch scroll.
- Serialize active-owner changes globally and commit awaited lifecycle work only when its captured
  mount identity is still current.
- Treat Preview scale as Reading View presentation rather than a remembered editing preference.
- Persist stable toolbar choices device-locally while keeping undo history, save status, and live
  selection session-local.

### Verification evidence

- Focused Stage Frame/Canvas/pointer/lifecycle/recovery suite: 10 files / 132 tests passed.
- Full `npm run check`: 95 files / 531 tests and 4 performance files / 8 tests passed; production
  and mobile builds passed.
- Native Obsidian 1.12.7: manual 50%, Fit after automated sidebar-divider drag, mouse-wheel
  navigation, Raw scroll restoration, and active-file switching passed after a fresh plugin reload.
- Native geometry: 704 logical px rendered to 352 CSS px at scale 0.5; Canvas and overlay client
  rects matched, and both were pointer-transparent.
- Ink input-isolation regressions verify that touch `pointerdown` and the first Pencil click remain
  uncanceled while a second click/`dblclick` is consumed during Ink edit; CSS verification prevents
  the workspace from disabling selection or native touch actions.
- Input-barrier regressions verify the surface stays pointer-transparent; Pencil events captured
  from Reading View persist a stroke; finger events do not reach Markdown handlers and remain
  uncanceled for native scrolling; Edit-only `selectstart` suppression restores in Preview.
- WebKit input-adapter regressions verify misclassified Pointer touch followed by
  `Touch.touchType: stylus` draws, erases, and Select/Moves; direct finger Touch remains
  uncancelled; dual Pointer plus stylus Touch delivery persists exactly one stroke.
- Toolbar regressions verify the visible width trigger is backed by one full-size native `select`,
  exposes all supported widths, and applies the chosen width to the next stroke.
- The iPad CSS-zoom regression fixture reproduces WebKit's unzoomed layout rect at 60%, then
  verifies the committed Canvas transform, document origin, and pointer-to-logical round trip all
  use 0.6.
- Latest focused Stage Frame/Canvas suite: 4 files / 89 tests passed. Remaining executable suite: 98
  files / 640 tests passed; performance tests, production bundle, mobile bundle, focused lint,
  formatting, and full typecheck passed, followed by a fresh development Vault installation.
- Latest full `npm run check`: 98 files / 637 tests and 4 performance files / 8 tests passed;
  production and mobile builds passed, followed by a fresh development Vault installation.
- 2026-07-17 toolbar-preference/Preview-scale correction: focused preference and Canvas suites
  passed 81 tests; the full executable suite passed 101 files / 698 tests and 4 performance files /
  9 tests. Formatting, ESLint, TypeScript, production build, mobile bundle validation, and a fresh
  development Vault installation passed.
