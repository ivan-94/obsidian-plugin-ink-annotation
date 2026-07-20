# Inkstone specifications and plans

This directory is the canonical home for all product specifications and execution plans for the
Inkstone Annotations plugin.

## Authoritative documents

- [Product, architecture, and UI/UX specification](2026-07-14-obsidian-annotation-plugin-design.md)
- [Master execution plan](2026-07-14-obsidian-annotation-plugin-execution-plan.md)
- [Ink v1 fixed-width workspace and manual repositioning](2026-07-15-ink-fixed-width-manual-repositioning.md)
- [Ink three-state view and toolbar/layout correction](2026-07-15-ink-three-state-view-and-toolbar-correction.md)
- [Ink 704 zoomable workspace and pane-wide drawing](2026-07-16-ink-704-zoomable-workspace.md)
- [Ink Stage Frame and native navigation](2026-07-16-ink-stage-frame-and-native-navigation.md)
- [Ink context-sensitive next-action button](2026-07-16-ink-next-action-button.md)
- [Ink closed-loop stroke eraser](2026-07-16-ink-closed-loop-stroke-eraser.md)
- [Sidecar lifecycle, Trash, and garbage collection](2026-07-16-sidecar-lifecycle-trash-and-garbage-collection.md)
- [Editing mode dormancy and Reading View remount correction](2026-07-17-editing-mode-dormancy.md)
- [Ink iCloud-resilient persistence](2026-07-17-ink-icloud-resilient-persistence.md)
- [Ink explicit-commit and Canvas presentation foundation](2026-07-20-ink-explicit-commit-session.md)
- [Entire Vault demand-bounded local index and automated Gate](2026-07-19-entire-vault-demand-bounded-index.md)
- [Preact UI architecture refactor specification](2026_07_15_refactor_to_preact.md)

Historical plan updates that have already been reconciled into the master plan are retained here for
traceability:

- [R0–R9 Preact execution-plan update](2026-07-15-preact-execution-plan-update.md)

The master plan references supporting UI v2 feedback and target images under
`assets/obsidian-annotation-plugin-ui-v2/`. That asset directory must be restored before the earlier
image relocation can be considered complete.

Slice implementation and acceptance evidence remains under `docs/delivery/slices/`; it is evidence,
not a competing product specification. Future plugin plans and specifications must be created in
this directory and linked from this index.

## Relocation note

On 2026-07-15, the product/UI specification, master execution plan, and their UI v2 source images
were moved from `/Users/ivan/workspace/ai/ai_llm_wiki` into this repository. The old AI Wiki paths
are no longer valid sources of truth.

## Source Manifest

### Sources

- User instruction in the current Codex task on 2026-07-15: place every plan and specification for
  this plugin under `/Users/ivan/workspace/ai/obsidian-annotation-plugin/docs/specs`.
- `AGENTS.md` source-of-truth policy.
- All authoritative documents indexed above.
- `/Users/ivan/.agents/docs/agents/workflows.md` and
  `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

### Produced artifacts

- `docs/specs/README.md`
- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`
- `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`
- `docs/specs/2026-07-15-ink-three-state-view-and-toolbar-correction.md`
- `docs/specs/2026-07-16-ink-704-zoomable-workspace.md`
- `docs/specs/2026-07-16-ink-stage-frame-and-native-navigation.md`
- `docs/specs/2026-07-16-ink-next-action-button.md`
- `docs/specs/2026-07-16-ink-closed-loop-stroke-eraser.md`
- `docs/specs/2026-07-16-sidecar-lifecycle-trash-and-garbage-collection.md`
- `docs/specs/2026-07-17-editing-mode-dormancy.md`
- `docs/specs/2026-07-17-ink-icloud-resilient-persistence.md`
- `docs/specs/2026-07-20-ink-explicit-commit-session.md`
- `docs/specs/2026-07-19-entire-vault-demand-bounded-index.md`
- `docs/specs/2026_07_15_refactor_to_preact.md`
- `docs/specs/2026-07-15-preact-execution-plan-update.md`
- `docs/specs/assets/obsidian-annotation-plugin-ui-v2/`

### Key decisions

- `docs/specs/` is the only canonical directory for plugin plans and specifications.
- New product changes are recorded in focused incremental specifications instead of accumulating in
  the historical design and master execution documents.
- Historical Slice evidence remains in `docs/delivery/slices/` and links back to the local master
  execution plan.
- The 2026-07-19 Entire Vault specification supersedes the earlier full-memory index assumptions
  while preserving canonical sidecars and deferring UI cutover to separately authorized work.
- The 2026-07-20 explicit-commit specification supersedes automatic foreground Draft and short-idle
  canonical persistence: foreground Ink Mode is memory-only until Done or sustained inactivity,
  while background/inactivity save is explicitly best-effort. The same specification narrows Canvas
  invalidation, prohibits full-viewport rebuilds during Pencil contact, accepts temporary compositor
  scaling during viewport gestures, and bounds committed raster tiles.
- Supporting design images moved with the plan so all relative references remain repository-local.

### Verification evidence

- `git diff --check` passed in the plugin repository.
- All indexed specification Markdown files have balanced fenced blocks. Cross-specification links
  resolve locally.
- The two former AI Wiki documents no longer exist at their previous paths; live specification
  references use `docs/specs/`.

### Open questions / risks

- The 12 UI v2 image files referenced by the master plan are currently absent from
  `docs/specs/assets/obsidian-annotation-plugin-ui-v2/`; restore the original binaries before
  relying on those image links or claiming the asset relocation is complete.
- Future plans must update this index.
