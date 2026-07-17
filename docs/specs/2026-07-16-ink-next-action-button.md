# Ink Next-Action Button

## Status

- Created: 2026-07-16
- Status: implementation and automated full gate complete; physical iPad verification pending
- Scope: the Markdown view-header Ink action, its save/error feedback, and the low-frequency Preview
  exit in Obsidian's pane `…` menu.

This specification refines the entry control for the existing `raw`, `ink-preview`, and `ink-edit`
states. It does not change the Stage Frame, 704 logical width, sidecar schema, preview-default
setting, or edit-session persistence rules.

## Interaction Model

The header button is not a three-state toggle. It always communicates the most likely next action.
The current state remains visible through iconography, color, the edit toolbar, and accessible text.

| Current state           | Icon                                     | Primary action         | Tooltip and `aria-label` |
| ----------------------- | ---------------------------------------- | ---------------------- | ------------------------ |
| Raw without visible Ink | `paintbrush`                             | Enter Ink Edit         | `开始涂鸦`               |
| Raw with hidden Ink     | `eye`, with a purple status dot          | Enter Ink Preview      | `涂鸦已隐藏 · 显示预览`  |
| Ink Preview             | `paintbrush`, subtle purple background   | Enter Ink Edit         | `正在预览涂鸦 · 编辑`    |
| Ink Edit                | `check`, strong purple active background | Save and enter Preview | `完成涂鸦并预览`         |

The primary flow is:

```text
Raw without Ink -> Edit -> Preview
Raw with hidden Ink -> Preview -> Edit
Preview --Close preview in …--> Raw with hidden Ink
```

When the user removes the final visible stroke and completes Edit, the view returns to Raw without
visible Ink. Pressing `开始涂鸦` again must create or reuse an empty canonical Ink surface and enter
Edit in that same action. An older asynchronous sidecar-summary read must never overwrite this newer
locally confirmed empty state or redirect the action into a no-op Preview attempt.

Ink presence is a file-level projection of canonical surfaces, not a durable property of one
Markdown view and not a fact supplied by `ink-summaries.json`. The summary index and view-local
presence sets are disposable accelerators only. Opening a view, completing a canonical save,
deleting/restoring a whole surface, and receiving an external canonical sidecar event must reconcile
all registered views for that file from canonical surface records. Every reconciliation advances the
affected view generations so an older asynchronous discovery cannot overwrite the result.

The hidden-Ink action also revalidates canonical presence before opening Preview. If the cached
state says Ink exists but canonical records contain no visible strokes, that same click corrects the
state and enters Edit with `createIfMissing` behavior. It must never silently return from a failed
empty Preview mount.

## Save and Error States

- Completing Edit first persists the active document session. The button is disabled while that
  transition is pending, uses a progress icon, exposes `aria-busy="true"`, and reports
  `正在保存涂鸦…`.
- A failed save leaves the user in Ink Edit. The same header action becomes `rotate-ccw` with
  `保存失败 · 重试`; retry must not create a second concurrent canonical write.
- A successful save enters Preview when visible Ink exists. It must not silently enter Preview
  before persistence succeeds.

## Pane Menu

- `关闭涂鸦预览` appears only in the Markdown pane's native `more-options` menu while that view is
  in Ink Preview.
- Closing Preview hides and detaches the overlay for that view without changing the global
  `Show Ink preview by default` preference.
- The resulting Raw button uses `eye` plus the hidden-Ink status dot. Clicking it manually restores
  Preview even when default preview is disabled.
- A manually hidden Preview is not automatically reopened by a layout refresh for the same view/file
  pair. Navigating that view to a different file clears the local override.

## Accessibility and Visual Discipline

- The header action never uses `aria-pressed`; the control is not a binary toggle.
- Icon, tooltip, and `aria-label` are updated atomically for each state.
- `paintbrush` deliberately distinguishes the Ink action from Obsidian's adjacent Markdown edit
  action, which already uses a pen-shaped icon.
- Pending state uses `aria-disabled="true"` and cannot start another transition.
- Preview uses a restrained accent tint; Edit uses the product's strong accent fill; the hidden-Ink
  dot is supplementary and never the sole state signal.

## Acceptance Criteria

- The four stable states render the exact icon and accessible label in the table.
- Raw with hidden Ink opens Preview instead of entering Edit.
- Preview enters Edit; Edit waits for persistence and then enters Preview.
- Save failure remains in Edit and exposes Retry; pending completion is busy and disabled.
- No Ink header action contains `aria-pressed`.
- `关闭涂鸦预览` is present only in the native `…` menu during Preview.
- Default-on opening still previews notes with Ink; notes without Ink remain Raw.
- After deleting the final stroke, `开始涂鸦` immediately recreates an editable empty surface even
  if an older non-empty sidecar-summary request finishes after the deletion.
- Deleting the final whole Ink surface through the sidebar immediately changes every same-file tab
  to `开始涂鸦`; restoring a visible surface changes them back to the appropriate Ink-present state.
- A valid-but-stale derived summary cannot override empty canonical surfaces during view
  initialization.
- If a canonical deletion arrives after the button rendered, the first formerly-hidden-Ink click
  self-corrects and enters Edit rather than becoming a no-op.
- External iCloud canonical surface events rebuild derived summaries and reconcile the Ink action
  for the owning Markdown file.
- Targeted tests, full `npm run check`, development installation, and native Obsidian state
  walkthrough pass.

## Non-Goals

- Replacing the edit toolbar's tool-selection `aria-pressed` semantics.
- Changing sidebar annotation menus or adding another visible ellipsis action.
- Changing Preview preference persistence or Ink coordinate/persistence formats.

## Source Manifest

### Sources

- User report and iPad screenshot from the 2026-07-17 Codex task showing the no-op action after the
  final stroke was deleted.
- User report and iPad screenshot on 2026-07-17 showing two same-file tabs, a stale hidden-Ink eye
  after whole-Ink deletion, and an action that could not create new Ink.
- User-confirmed next-action table and state-flow instruction in the 2026-07-16 Codex task.
- `docs/specs/2026-07-15-ink-three-state-view-and-toolbar-correction.md`.
- `docs/specs/2026-07-16-ink-stage-frame-and-native-navigation.md`.
- `src/adapters/obsidian/ink-mode-manager.ts` and its tests.
- `styles.css`.
- `/Users/ivan/.agents/skills/tdd/SKILL.md`.
- `/Users/ivan/.agents/skills/visual-fidelity-loop/SKILL.md`.
- `/Users/ivan/.agents/docs/agents/workflows.md`.
- `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

### Produced artifacts

- This focused specification.
- Header action, pane-menu, CSS, file-level canonical presence reconciliation, external sidecar
  refresh wiring, and regression-test changes named above.

### Key decisions

- Model the header action as a context-sensitive command, not a state toggle.
- Keep low-frequency Preview dismissal inside the existing native pane menu.
- Treat persistence progress and failure as first-class button states.
- Treat canonical surfaces as the only Ink-presence authority; view sets and summary indexes remain
  disposable projections.

### Verification evidence

- The reported same-file sibling-tab state and whole-surface deletion paths were reproduced as
  deterministic manager integration failures before the correction.
- `src/adapters/obsidian/ink-mode-manager.test.ts`: 49 tests passed on 2026-07-17, including
  canonical deletion refresh, stale derived-summary rejection, click-time self-healing, and
  same-file sibling propagation.
- `npm run typecheck` and `npm run lint` passed on 2026-07-17.
- `npm run check` passed on 2026-07-17: formatting, lint, typecheck, 103 test files with 722 tests,
  coverage thresholds, 5 performance files with 10 tests, production build, and mobile bundle.
- `npm run install:dev` installed the verified bundle into
  `test-fixtures/vault/.obsidian/plugins/inkstone-annotations`.
- The physical iPad deletion/recreation walkthrough remains pending.

### Open questions / risks

- Physical iPad mini Pencil/finger verification remains a separate hardware release gate.
