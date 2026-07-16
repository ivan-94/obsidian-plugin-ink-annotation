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

## Decisions

| ID          | Decision                                                                                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INK-V1.3-01 | One immutable **Stage Frame** is the only runtime authority for logical, client, Canvas-CSS, and Canvas-backing coordinates.                                                                                                                                                       |
| INK-V1.3-02 | The Stage Frame is measured from actual DOM rectangles and actual rendered scale. It does not reconstruct centering, padding, scroll, or fixed containing-block behavior.                                                                                                          |
| INK-V1.3-03 | Existing 100% placement is the compatibility baseline. Its structural document-origin inset is captured once per Reading View host attachment, normalized by the measured containing-block scale, and multiplied by the actual document scale thereafter. No sidecar is rewritten. |
| INK-V1.3-04 | Both committed and active Canvas contexts consume the same Stage Frame matrix. Pointer creation and hit testing consume its exact inverse.                                                                                                                                         |
| INK-V1.3-05 | Canvas is always pointer-transparent. Mouse and pen input are captured at the stable Reading View scroll host; touch remains unhandled so native finger scrolling survives.                                                                                                        |
| INK-V1.3-06 | Wheel scrolling is never bridged or reimplemented by the plugin. The native scroll host remains the browser event target.                                                                                                                                                          |
| INK-V1.3-07 | Zoom, scroll, and resize each replace the complete Stage Frame atomically before redraw. Partial viewport fields are removed.                                                                                                                                                      |
| INK-V1.3-08 | One global lifecycle queue owns the active `(view, mounted session, file path)` transition. Async exit commits only if the same view and mounted-session identity still own the manager.                                                                                           |
| INK-V1.3-09 | Preview is a persisted Reading transition, so re-entering Edit must reopen every retained bounded domain session before the UI accepts input.                                                                                                                                      |
| INK-V1.3-10 | Retry belongs to the same manager lifecycle queue as exit. A toolbar Retry cannot locally deactivate a controller while the manager still owns it.                                                                                                                                 |
| INK-V1.3-11 | A pending enter captures the active-leaf epoch and is cancelled after mounting if the leaf, view, or mounted identity changed.                                                                                                                                                     |
| INK-V1.3-12 | Dirty bounded vectors receive a synchronous device-local recovery checkpoint. Canonical sidecars remain authoritative; revision divergence fails closed instead of overwriting either copy.                                                                                        |
| INK-V1.3-13 | Native scroll is a read-only Stage Frame projection: it reuses the measured Canvas frame and scale, updates only the document client origin, and redraws without writing layout or measuring Canvas.                                                                               |
| INK-V1.3-14 | Manual zoom, Fit resize, and Reading View host replacement preserve the same logical viewport top across the layout transaction.                                                                                                                                                   |
| INK-V1.3-15 | A newer wheel, touch, pointer, keyboard, or scroll intent cancels any deferred Reading Context restore so plugin restoration cannot overwrite native navigation.                                                                                                                   |
| INK-V1.3-16 | Repository instances sharing one Vault text-file adapter share one canonical write coordinator; single, batch, and summary keys are collision-proof namespaces.                                                                                                                    |
| INK-V1.3-17 | One document-level macrotask is the commit barrier for a multi-chunk logical Ink command, preventing sibling chunk persistence from exposing a partial command.                                                                                                                    |
| INK-V1.3-18 | A successful owner write invalidates sibling preview mounts for the same file so a second visible leaf cannot keep rendering stale canonical Ink.                                                                                                                                  |
| INK-V1.3-19 | Recovery v3 persists the confirmed base, pending attempt, and working record separately; it fences stale managers, quarantines corrupt bytes, and retains one reachable live owner after dual checkpoint/canonical failure.                                                        |
| INK-V1.3-20 | Journal recovery preflights every canonical record before writing any record. It may replay only when all canonical bytes are exactly the journal's previous or next bytes; any third state fails closed without mutation.                                                         |

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
- Every Canvas transform is replaced with `setTransform`; transforms are not incrementally stacked.
- Strokes are rendered in canonical logical coordinates without subtracting ad-hoc viewport offsets.
- Canvas clearing temporarily uses backing-pixel identity space so translations cannot leave stale
  pixels.
- Pointer listeners live on `scrollContainer ?? root` in capture phase. Only primary mouse/pen input
  in Ink edit is prevented and interpreted as Ink.
- Touch input is ignored by Ink capture and continues through Obsidian's native scrolling path.
- Canvas and overlay stay `pointer-events: none` in preview and edit. Passive navigation-intent
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

- User report and three screenshots supplied in the 2026-07-16 Codex task: 100% accepted state, 50%
  alignment failure, sidebar-resize alignment failure, and loss of mouse-wheel scrolling.
- Earlier user reports and screenshots in the same task covering zoom drift, vertical scroll drift,
  horizontal overflow, pane resize, and Canvas/input behavior.
- Native Obsidian 1.12.7 DOM/Canvas measurements collected in the same task.
- Trusted Chromium fixed-overlay wheel reproduction collected in the same task.
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

### Verification evidence

- Focused Stage Frame/Canvas/pointer/lifecycle/recovery suite: 10 files / 132 tests passed.
- Full `npm run check`: 95 files / 531 tests and 4 performance files / 8 tests passed; production
  and mobile builds passed.
- Native Obsidian 1.12.7: manual 50%, Fit after automated sidebar-divider drag, mouse-wheel
  navigation, Raw scroll restoration, and active-file switching passed after a fresh plugin reload.
- Native geometry: 704 logical px rendered to 352 CSS px at scale 0.5; Canvas and overlay client
  rects matched, and both were pointer-transparent.
