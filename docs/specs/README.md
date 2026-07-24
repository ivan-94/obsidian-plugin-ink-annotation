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
- [Ink responsive commands, save, and Preview](2026-07-20-ink-responsive-commands-save-and-preview.md)
- [Ink retained tile scene and Worker rasterization](2026-07-20-ink-retained-tile-scene-and-worker-rasterization.md)
- [Ink simple snapshot persistence](2026-07-21-ink-simple-snapshot-persistence.md)
- [Ink semantic layers and transform-only interactions](2026-07-21-ink-semantic-layers-and-transform-only-interactions.md)
- [Ink shared scene, deterministic layout, and atomic camera](2026-07-21-ink-shared-scene-layout-and-atomic-camera.md)
- [Ink iPad immediate usability patch](2026-07-22-ink-ipad-immediate-usability-patch.md)
- [Snapshot Annotation capture and markup](2026-07-22-snapshot-annotation-capture-and-markup.md)
- [Parser-backed Text Source Projection and powerful Reading selection](2026-07-23-parser-backed-text-source-projection.md)
- [Entire Vault demand-bounded local Catalog and automated Gate — reassessed 2026-07-23](2026-07-19-entire-vault-demand-bounded-index.md)
- [Preact UI architecture refactor specification](2026_07_15_refactor_to_preact.md)
- [Production and Community market release](2026-07-24-production-market-release.md)
- [Inkstone Annotations internationalization](2026-07-24-inkstone-internationalization.md)

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
- User approval on 2026-07-23 of the Entire Vault reassessment recommendations: recent-20 default,
  Markdown-dependent Snapshot freshness, page-local Select all, and bounded stream export-all.
- User instruction on 2026-07-23 to specify the recommended systematic replacement for the
  restrictive Reading View selection mapper.
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
- `docs/specs/2026-07-20-ink-responsive-commands-save-and-preview.md`
- `docs/specs/2026-07-20-ink-retained-tile-scene-and-worker-rasterization.md`
- `docs/specs/2026-07-21-ink-simple-snapshot-persistence.md`
- `docs/specs/2026-07-21-ink-semantic-layers-and-transform-only-interactions.md`
- `docs/specs/2026-07-21-ink-shared-scene-layout-and-atomic-camera.md`
- `docs/specs/2026-07-22-ink-ipad-immediate-usability-patch.md`
- `docs/specs/2026-07-22-snapshot-annotation-capture-and-markup.md`
- `docs/specs/2026-07-23-parser-backed-text-source-projection.md`
- `docs/specs/2026-07-19-entire-vault-demand-bounded-index.md`
- `docs/specs/2026_07_15_refactor_to_preact.md`
- `docs/specs/2026-07-24-production-market-release.md`
- `docs/specs/2026-07-24-inkstone-internationalization.md`
- `docs/specs/2026-07-15-preact-execution-plan-update.md`
- `docs/specs/assets/obsidian-annotation-plugin-ui-v2/`

### Key decisions

- `docs/specs/` is the only canonical directory for plugin plans and specifications.
- New product changes are recorded in focused incremental specifications instead of accumulating in
  the historical design and master execution documents.
- Historical Slice evidence remains in `docs/delivery/slices/` and links back to the local master
  execution plan.
- The Entire Vault specification, reassessed on 2026-07-23, supersedes the earlier full-memory index
  assumptions while preserving canonical sidecars and deferring UI cutover to separately authorized
  work. It treats Snapshot `record.json` as canonical, Snapshot `summary.json` as a hint, current
  Markdown as a link-projection dependency, and Snapshot Capture Assets as outside Catalog reads.
- The 2026-07-20 explicit-commit specification supersedes automatic foreground Draft and short-idle
  canonical persistence: foreground Ink Mode is memory-only until Done or sustained inactivity,
  while background/inactivity save is explicitly best-effort. The same specification narrows Canvas
  invalidation, prohibits full-viewport rebuilds during Pencil contact, accepts temporary compositor
  scaling during viewport gestures, and bounds committed raster tiles.
- The 2026-07-20 responsive-command specification separates Pencil, toolbar-command, Done, and
  Preview budgets; requires one command-to-presentation transaction, feedback-first Done, exact
  read-only Preview projection, disposable device-local raster caching, and interactive/visible/cold
  scheduling lanes.
- The 2026-07-21 simple-snapshot specification replaces concurrent multi-surface persistence with
  memory-first editing, one Last-Done-Wins `ink.json`, and an optional one-record idle draft. Legacy
  bounded surfaces become read-only migration input.
- The 2026-07-21 semantic-layer specification rejects a broad GPU cutover for current interaction
  defects. It keeps accepted Canvas/tile/Active paths, makes selection drag transform-only, and
  requires complete staged tile replacement for undo, redo, and destructive eraser commands.
- The 2026-07-21 shared-scene specification keeps Canvas2D, reuses one retained History Scene across
  Preview/Edit, batches bounded work inside a frame budget, freezes macOS/iPadOS Ink layout metrics,
  strictly contains pane overlays, and atomically publishes visual/input camera transforms.
- The 2026-07-22 iPad immediate-usability specification pauses that architectural expansion for the
  current release. It limits work to four independently reversible patches: bounded first
  presentation, layout-neutral Preview containment, one shared Preview/Edit origin calibration, and
  a post-zoom camera-ready input fence. It changes no canonical schema or Logical Stroke
  coordinates.
- The 2026-07-22 Snapshot Annotation specification replaces new persistent freehand creation over
  live Markdown with immutable viewport capture plus semantic source anchors. Capture is a
  replaceable backend: the core desktop vertical slice starts with Electron, later Slices add
  open-source and self-developed DOM backends, and physical-iPad acceptance selects platform
  defaults before cutover. Legacy document-world Ink remains readable and exportable.
- The 2026-07-23 Text Source Projection specification replaces hand-scanned Markdown block
  candidates with one parser-backed bidirectional projection shared by selection creation, highlight
  restoration, and Snapshot source binding. It keeps compound source anchors, typed fail-closed
  behavior, bounded revision caches, and explicit Snapshot fallback for generated content.
- The 2026-07-24 production release specification adopts `Inkstone Annotations`,
  `inkstone-annotations`, and the MIT License; separates local release foundations from external
  publication; and defines Beta, policy audit, real-device HAT, Community submission, and maintained
  production gates.
- The 2026-07-24 internationalization specification keeps English as the source language, adds
  Simplified Chinese first, follows Obsidian locale with a 1.7.2-compatible fallback, and keeps
  localization out of canonical annotation data.
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
