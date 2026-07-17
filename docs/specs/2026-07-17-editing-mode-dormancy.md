# Editing Mode Dormancy and Reading View Remount Correction

**Status:** Adopted product correction, 2026-07-17  
**Overrides:** The Editing View behavior in `2026-07-14-obsidian-annotation-plugin-design.md` and
the interactive Live Preview behavior delivered by S13. S13 remains historical evidence, not the
current product behavior.

## Decision

Inkstone document-attached interaction surfaces exist only while an Obsidian Markdown view is in
Reading View (`MarkdownView.getMode() === 'preview'`). Source mode and Live Preview are both editing
mode and must remain dormant.

The sidebar and canonical sidecar data remain available as management surfaces. Dormancy applies to
editor decorations, editor selection actions, Reading View delegates, Ink controls/overlays, and
annotation refresh work caused by typing or editor autosave.

## Required behavior

### Editing mode

- Do not install a CodeMirror view plugin, decorations, selection listeners, selection toolbar, or
  annotation creation path.
- Editor transactions and selection changes perform no annotation resolution or canonical writes.
- A Markdown `modify` event for the active editing view does not refresh Reading View, Live Preview,
  or sidebar annotation surfaces.
- Do not create an Ink action, query Ink surface summaries, or mount an Ink preview when a view is
  first observed in editing mode.
- If a view leaves Reading View with active Ink, flush safely and detach the Ink controller. If it
  leaves with passive Ink preview, detach it without remounting. Hide any already-created Ink
  action.
- Programmatic Ink entry while editing fails closed with the existing Reading View guidance.

### Returning to Reading View

- Re-register document-attached actions and discover Ink only after the current Reading View exists.
- A cleaned preview section must not leave a delegate holding its source context. During the remount
  gap, selection is ignored rather than mapped against an edited, stale Markdown source.
- Once the new section mounts, text selection uses the latest section/source context and the normal
  Reading View toolbar becomes available.

## Performance invariant

Editing mode has no per-transaction Inkstone CodeMirror plugin work and no annotation-surface
refresh caused by active-file autosave. Repository discovery and DOM mounting begin only after
Reading View is active.

## Acceptance criteria

- Editing text, selecting text, using IME, and autosaving in Source or Live Preview produce zero
  annotation resolve/commit calls and no Inkstone toolbar or decoration.
- Opening a note directly in editing mode produces zero Ink summary reads and no Ink action.
- Switching an Ink preview/edit session into editing mode leaves no Ink overlay/controller attached;
  unsaved Ink still follows the existing fail-safe persistence contract.
- Switching back to Reading View restores text selection and Ink entry from the current rendered
  source without the false `This selection is ambiguous in the Markdown source.` message.

## Source Manifest

### Sources

- User instruction on 2026-07-17 in the current Codex task: editing mode feels slower with the
  plugin enabled and text selection/Ink must be completely disabled there.
- User screenshot from the same task:
  `/tmp/codex-remote-attachments/019f6d92-4c95-73b2-847f-cba2f72e0480/79A6D7C3-F731-4749-B0D9-CF8386F71893/1-粘贴的图片-1.jpg`.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`, especially S02 and S13.
- `docs/delivery/slices/S13-live-preview/` and
  `docs/delivery/slices/S19-ink-stage-frame-native-navigation/`.
- `/Users/ivan/.agents/docs/agents/workflows.md` and
  `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

### Produced artifacts

- This correction specification.
- Editing-mode policy, Reading View lifecycle, Live Preview dormancy, Ink lifecycle, and regression
  tests under `src/`.

### Key decisions

- Reading View is the only document-attached annotation interaction mode.
- Historical S13 editor support remains in source for traceability but is registered as an inert
  extension; it is not active product behavior.
- Sidebar management remains available because it is not attached to editor input or selection.

### Verification evidence

- TDD regressions cover stale Reading View remounts, inert editor behavior, active-file modify
  policy, and Ink discovery/detachment across editing-mode transitions.
- `npm run check` passed on 2026-07-17: formatting, ESLint, TypeScript, 101 test files / 693 tests,
  4 performance-test files / 9 tests, production build, and mobile bundle check.
- The focused lifecycle suite passed 74 tests before the final full gate; the additional
  programmatic editing-mode Ink exit regression is included in the 693-test result.

### Open questions / risks

- Real-device input latency still requires human comparison in Obsidian; automated tests prove that
  the identified per-transaction and autosave-triggered work is absent, not an end-to-end frame-time
  measurement.
