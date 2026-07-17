# Ink Three-State View and Toolbar/Layout Correction

## Status

- Created: 2026-07-15
- Status: implementation complete; physical iPad verification remains a separate release gate
- Scope: Ink view lifecycle, fixed-width alignment, toolbar iconography, and preview preference.

This focused follow-up supersedes only the conflicting two-state Reading/Ink lifecycle and toolbar
presentation in `2026-07-15-ink-fixed-width-manual-repositioning.md`. Schema-v2 coordinates,
continuous chunks, manual movement, persistence, recovery, and all text-annotation behavior remain
unchanged.

## Problem Evidence

The user-provided native Obsidian screenshots show four release-blocking failures:

1. `Select/Move` is rendered as a long visible label inside an icon dock and is clipped by the dock.
2. Toolbar icons do not share one visual slot/size contract and the movement icon is not legible.
3. The fixture note stores a 513 logical-pixel Ink plane, but its Canvas is positioned from stale
   pre-transition geometry and from the outer Reading View box rather than the padded content box.
   The result is a left-shifted Canvas boundary and Markdown visibly crossing that boundary.
4. Opening a note with canonical Ink produces native Obsidian Reading View with no Ink. The product
   needs three explicit states rather than the current raw/edit toggle.

## Product Decisions

| ID          | Decision                                                                                                                                                                                                 | Status            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| INK-V1.1-01 | Ink has three explicit view states: `raw`, `ink-preview`, and `ink-edit`.                                                                                                                                | Confirmed by user |
| INK-V1.1-02 | A Reading View note with canonical Ink opens in `ink-preview` by default. A setting named `Show Ink preview by default` controls this behavior and defaults to enabled.                                  | Confirmed by user |
| INK-V1.1-03 | `raw` is untouched Obsidian Reading View: no fixed width, Canvas, Ink toolbar, or pointer interception.                                                                                                  | Confirmed by user |
| INK-V1.1-04 | `ink-preview` uses the same fixed logical coordinate plane as edit, shows committed Ink, hides edit chrome, and remains pointer-transparent so Reading interactions work.                                | Confirmed by user |
| INK-V1.1-05 | `ink-edit` adds the active Canvas and compact edit dock to the same coordinate plane. Finishing edit returns to preview when the preference is enabled, otherwise to raw.                                | Confirmed by user |
| INK-V1.1-06 | Ink toolbar actions are icon-only in the dock. Full names remain in `aria-label`, tooltip, and focus semantics.                                                                                          | Confirmed by user |
| INK-V1.1-07 | Pen, Highlighter, and Stroke eraser each own an independent device-local color and width slot. Switching tools restores that tool's most recent values, including after controller recreation or reload. | Confirmed by user |

## Width and Alignment Contract

- `layout.logicalWidth` is the width of the Markdown content coordinate plane, not the outer padded
  `.markdown-preview-sizer` box.
- The existing `Supported Markdown.md` fixture stores `logicalWidth: 513`; this implementation must
  render that exact width without silently rewriting or scaling canonical vectors.
- The content coordinate plane is horizontally centered inside the available Reading View.
- Overlay position is recomputed after every raw/preview/edit layout transition and root resize.
- Overlay origin includes the rendered content-box inset (`padding-inline-start` and block inset),
  so Markdown and Canvas use the same origin.
- Markdown wraps inside the logical plane; the Canvas boundary must not be used as a misleading
  decoration around a differently sized box.
- New notes retain the existing per-note width capture in this correction. Choosing one universal
  width or migrating existing widths requires a separate product/storage decision.

## State Contract

### Raw

- Obsidian controls width and layout.
- Committed and active Ink Canvas layers are absent or hidden.
- Links, selection, scrolling, editing/view switching, and native navigation are unchanged.

### Ink preview

- Entered automatically only when enabled and at least one non-deleted canonical Ink surface exists.
- Applies the stored logical width and continuous safe extent.
- Displays committed Ink only; no toolbar, hover, selection, drawing, or move input.
- Canvas layers use `pointer-events: none` and never block Reading View.
- Passive preview mounting must not migrate v1, change revision/status, or write sidecars.

### Ink edit

- Uses exactly the preview width/origin so entering edit does not shift content or Ink.
- Displays compact icon-only controls in this order:

  ```text
  Dock move | Finish edit | Pen | Highlighter | Stroke eraser | Select/Move | Multiple* | Color/Width* | Undo | Redo | More
  ```

  `Multiple` is conditional on Select/Move; Color/Width are conditional on More.

- `Select/Move` uses a recognizable move icon. `Multiple` uses a distinct multi-selection icon.
- The dock may scroll horizontally on narrow viewports but never clips half a label or control.
- Pen, Highlighter, and Stroke eraser each remember their own Color and Width values. Changing one
  tool never overwrites either value for another tool, and the visible controls update immediately
  when the active drawing tool changes.
- The three style slots are stored in the existing device-local Ink preference, never in the Vault
  sidecar or iCloud data. A legacy preference with one shared color initializes all three slots with
  that color; its width remains assigned to the formerly active tool while the other tools retain
  their established default widths.

## Settings and Commands

- Add `showInkPreviewByDefault: boolean` to settings with default `true`.
- Legacy settings without the field parse as `true`; malformed values fail to the safe default.
- Settings UI explains that preview is read-only and uses the saved fixed-width Ink layout.
- Existing Ink Mode commands continue to enter/exit `ink-edit`; naming may be clarified without
  breaking command IDs.

## Acceptance Criteria

- Opening a Reading View file with canonical v2 Ink and default settings mounts `ink-preview`.
- Disabling the preference leaves the same file in `raw`; no overlay or width class remains.
- Preview is pointer-transparent, icon-dock-free, and byte-for-byte passive.
- Entering edit from preview does not change the content/Canvas horizontal origin.
- Finishing edit returns to preview or raw according to the preference.
- The 513 px fixture plane is centered and Markdown does not cross its right edge.
- Toolbar has no visible `Select/Move`, `Multiple`, or retry prose in the normal dock; icons share
  an 18 px visual slot and accessible names remain complete.
- Toolbar is usable without clipped controls at desktop width and at 320/360/480 px.
- Assigning distinct Color/Width pairs to Pen, Highlighter, and Stroke eraser restores the correct
  pair after arbitrary tool switching and after recreating the Ink controller.
- Legacy device-local preferences without per-tool slots load without data loss and become per-tool
  preferences on the next toolbar change.
- Targeted tests, full `npm run check`, package gate, and a native Obsidian screenshot loop pass.

## Execution Plan

1. Add settings parsing/UI tests and implement the default-on preview preference.
2. Add controller state tests for raw/preview/edit and implement pointer/toolbar/workspace behavior.
3. Add manager lifecycle tests for passive v2 preview, v1 no-write behavior, and edit exit target.
4. Add alignment tests for content-box inset and post-transition repositioning.
5. Add toolbar DOM/CSS tests for icon-only controls, icon slots, and narrow overflow behavior.
6. Build/install into the fixture Vault and perform a real Obsidian visual walkthrough of all three
   states, default settings, and toolbar interactions.
7. Add a controller regression proving independent Pen/Highlighter/Eraser Color and Width
   restoration within one session and after controller recreation.
8. Extend the device-local preference additively with validated per-tool style slots and a legacy
   shared-style fallback.

## Non-Goals

- Universal-width migration or rescaling existing Ink vectors.
- Automatic semantic rebase after Markdown changes.
- Lasso selection, persistent grouping, pagination, or fixed typography.
- Treating preview as an editable or pointer-capturing mode.

## Source Manifest

### Sources

- User feedback and two native Obsidian screenshots supplied in the current Codex task on
  2026-07-15.
- User feedback and toolbar screenshot supplied on 2026-07-17 showing that Color and Width must be
  remembered independently for every drawing tool.
- `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`
- `docs/specs/2026_07_15_refactor_to_preact.md`
- `docs/delivery/slices/S16-ink-fixed-width-manual-move/`
- `src/adapters/obsidian/ink-mode-manager.ts`
- `src/ui/ink-canvas-controller.ts`
- `src/ui/ink/ink-toolbar-app.tsx`
- `styles.css`
- `/Users/ivan/.agents/skills/visual-fidelity-loop/SKILL.md`
- `/Users/ivan/.agents/skills/tdd/SKILL.md`
- `/Users/ivan/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000387/skills/computer-use/SKILL.md`
- `/Users/ivan/.agents/docs/agents/workflows.md`
- `/Users/ivan/.agents/docs/agents/handoff-policy.md`

### Produced artifacts

- `docs/specs/2026-07-15-ink-three-state-view-and-toolbar-correction.md`
- `docs/delivery/slices/S17-ink-three-state-view-toolbar-correction/`
- Three-state lifecycle, fixed-width alignment, preview setting, toolbar icon, and regression-test
  changes under `src/` and `styles.css`.
- Per-tool style-slot persistence under `src/storage/local-ink-tool-preference.ts` and tool-switch
  restoration under `src/ui/ink-canvas-controller.ts`.

### Key decisions

- Model preview as a real state rather than rendering Ink as an incidental inactive edit Canvas.
- Keep stored logical width authoritative; fix coordinate origins and box alignment without a silent
  vector migration.
- Preserve accessible prose while removing visible prose from the compact dock.
- Keep tool styles device-local and additive to the existing preference format; do not modify Ink
  sidecars or synchronize UI preferences through the Vault.

### Verification evidence

- Initial native Obsidian walkthrough reproduced raw view and the screenshot failures.
- Static inspection identified stale overlay positioning, content padding mismatch, visible toolbar
  labels, and the absence of passive preview mounting.
- `npm run package:rc` passed on 2026-07-15: 91 test files / 447 tests, 4 performance files / 8
  tests, formatting, ESLint, type checking, production build, mobile bundle check, and release
  lifecycle verification.
- Native Obsidian 1.12.7 walkthrough passed Preview, Edit, Select/Move, Raw, preference toggle, and
  reload-persistence scenarios. Screenshots and observations are in the S17 delivery evidence.

### Open questions / risks

- A universal default logical width remains deferred; the current fixture is 513 logical px.
- Real iPad Pencil/finger behavior remains a separate physical-device gate.
- Per-tool Color/Width switching still requires physical-iPad toolbar confirmation.
