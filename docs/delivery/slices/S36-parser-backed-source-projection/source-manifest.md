# Source Manifest

## Original Sources

- User report in the current Codex task on 2026-07-23 that many Reading View selections could not be
  annotated.
- User-provided screenshot:
  `/var/folders/2q/6mht0dc90jxfygb7pxx6w5yh0000gn/T/codex-clipboard-2763fe00-9b33-441c-b2ff-773624d090f4.png`.
- User-provided physical-iPad screenshot showing the Note Inspector behind the software keyboard:
  `/var/folders/2q/6mht0dc90jxfygb7pxx6w5yh0000gn/T/codex-clipboard-8faee1d9-3750-4afc-a1b7-1bc348bef560.png`.
- User instruction to create a systematic Source Projection specification and then implement it on a
  new branch.
- `/Users/ivan/Downloads/Inkstone-UAT-Vault/UAT - Start Here.md`, inspected as the reported
  regression source.
- `AGENTS.md` and `CONTEXT.md`.
- `docs/specs/2026-07-23-parser-backed-text-source-projection.md`.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`.
- `docs/specs/2026-07-17-editing-mode-dormancy.md`.
- `docs/specs/2026-07-22-snapshot-annotation-capture-and-markup.md`.
- `docs/delivery/slices/S02-reading-highlight/source-manifest.md`.
- `docs/delivery/slices/S03-anchor-resolver/source-manifest.md`.
- `/Users/ivan/.agents/docs/agents/workflows.md`.
- `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

## Implementation Sources

- `package.json` and `package-lock.json`.
- `src/domain/source-projection.ts`.
- `src/adapters/obsidian/reading-source-projection.ts`.
- `src/adapters/obsidian/reading-selection.ts`.
- `src/adapters/obsidian/reading-annotation-controller.ts`.
- `src/adapters/obsidian/reading-view-integration.ts`.
- `src/adapters/obsidian/snapshot-annotation-manager.ts`.
- `src/ui/reading-highlight-renderer.ts`.
- `src/ui/quick-highlight-toolbar.ts`.
- `src/ui/floating/quick-highlight-toolbar-app.tsx`.
- `src/ui/annotation-inspector.ts`.
- `src/ui/inspector/annotation-inspector-app.tsx`.
- `src/ui/runtime/anchored-layer-position.ts`.
- `src/main.ts`.
- Obsidian 1.12.7 Reading View and MathJax DOM inspected locally through the installed test Vault.

## Produced Artifacts

- `docs/delivery/slices/S36-parser-backed-source-projection/`.
- `docs/delivery/slices/S36-parser-backed-source-projection/fixtures/source-projection-hat.md`.
- `docs/delivery/slices/S36-parser-backed-source-projection/ipad-keyboard-overlap-before.png`.
- `src/domain/source-projection.ts` and its correctness/performance tests.
- `src/adapters/obsidian/reading-source-projection.ts` and its correctness/performance tests.
- Reading View, controller, renderer, Snapshot manager, toolbar, and main wiring changes.
- Deletion of `src/domain/rendered-source-map.ts` and its test.

## Key Decisions

- One disposable Source Projection serves creation, restoration, and Snapshot binding.
- Sidecars and the existing compound anchor remain canonical; no schema migration is introduced.
- Source and display coordinates remain UTF-16 half-open intervals.
- DOM bindings are transient and fail closed.
- A single unsupported/postprocessed DOM block does not poison independently traceable siblings.
- Obsidian wrapper whitespace is ignored only when it has no owned visible source text.
- MathJax element endpoints are rejected as `unsupported-syntax` and offer Snapshot Annotation.
- View-level restoration repairs highlights after Obsidian replaces postprocessor roots.
- No legacy-mapper fallback remains in production.
- The mobile Note Inspector is positioned from `visualViewport`, not the layout viewport or `dvh`
  alone; keyboard resize/scroll events remeasure its bottom-sheet bounds.

## Verification Evidence

- `test-results.md`.
- `performance.md`.
- `hat-guide.md`.
- `desktop-restored-highlights.jpeg`.
- `desktop-math-fallback.jpeg`.
- `ipad-keyboard-overlap-before.png`.

## Open External Evidence

- Physical-iPad P0 is in progress; the keyboard-overlap correction requires user-operated device
  retest.
- Whole rendered-math selection remains disabled pending a proven atomic DOM adapter.
