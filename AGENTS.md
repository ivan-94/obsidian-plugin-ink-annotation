# Inkstone Annotations Agent Guide

Inkstone Annotations is a mobile-first Obsidian plugin for text and ink annotations over mutable
Markdown.

## Sources of truth

- Product and UI/UX specification: `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`
- Execution plan: `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`
- Current Ink v1 follow-up specification:
  `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`
- Current Ink three-state view and toolbar/layout correction:
  `docs/specs/2026-07-15-ink-three-state-view-and-toolbar-correction.md`
- Current Ink 704 zoomable workspace and pane-wide drawing specification:
  `docs/specs/2026-07-16-ink-704-zoomable-workspace.md`
- Current Ink Stage Frame and native navigation correction:
  `docs/specs/2026-07-16-ink-stage-frame-and-native-navigation.md`
- UI architecture refactor specification: `docs/specs/2026_07_15_refactor_to_preact.md`
- Slice evidence: `docs/delivery/slices/`

Read the relevant specification and Slice before changing behavior. Code is not allowed to become a
conflicting implicit specification.

## Architecture boundaries

- `src/domain/`: pure annotation, anchor, Ink, schema, and invariant logic. No Obsidian or DOM
  imports.
- `src/application/`: use cases coordinating domain ports. No direct file or DOM access.
- `src/storage/`: sidecar codecs and repository implementations behind application ports.
- `src/adapters/obsidian/`: Obsidian lifecycle, Vault, Reading View, and Editor adapters.
- `src/ui/`: transient toolbars, inspectors, sidebars, and Ink controls.
- `src/runtime/`: lifecycle, diagnostics, and performance plumbing only.

## Hard boundaries

- Sidecars are canonical; caches and indexes are disposable.
- Never persist a DOM `Range` as an anchor.
- Ambiguous targets fail closed and become recoverable `unanchored` records.
- Never discard unsaved Ink after persistence failure.
- Never claim iCloud sync based on a local write.
- Runtime code must not import Node.js or Electron modules at the top level.
- UI code never writes sidecars directly.
- No telemetry or external service is allowed without a new explicit product decision.

## Development workflow

Use vertical TDD cycles: one observable failing test, the minimum implementation, green
verification, then refactor. Mock only system boundaries.

```bash
npm run format
npm run check
npm run install:dev
```

Do not mark a Slice complete without its automated tests, HAT evidence, performance/reliability
evidence, and Source Manifest.
