# Inkstone Annotations Agent Guide

Inkstone Annotations is a mobile-first Obsidian plugin for text and ink annotations over mutable
Markdown.

## Operating context

- Use `CONTEXT.md` for domain language.
- Use `docs/specs/README.md` to find product specifications and execution plans.
- Treat `docs/delivery/slices/` as implementation evidence, not a competing specification.
- Before changing behavior, read the latest relevant approved specification and Slice evidence.
- When code and specification disagree, reconcile the specification explicitly; do not let code
  become an implicit product decision.

## Architecture boundaries

- `src/domain/` is pure domain logic: no Obsidian, DOM, storage, or UI imports.
- `src/application/` coordinates use cases through ports: no direct file or DOM access.
- `src/storage/` implements persistence and codecs behind application ports.
- `src/adapters/obsidian/` owns Obsidian, Vault, Reading View, and Editor integration.
- `src/ui/` owns presentation and transient interaction; it invokes use cases instead of writing
  persistence.
- `src/runtime/` is limited to lifecycle, diagnostics, and performance plumbing.

## Product invariants

- Sidecars are canonical; caches and indexes are disposable.
- Persist source-based anchors, never DOM `Range` objects.
- Ambiguous targets fail closed as recoverable `unanchored` records.
- Persistence failure must not discard unsaved Ink.
- Never claim iCloud sync based on a local write.
- Runtime code has no top-level Node.js or Electron imports.
- UI code does not write Sidecars directly.
- Telemetry and external services require an explicit product decision.

## Development and completion

- Use vertical TDD: one observable failing test, minimum implementation, green verification, then
  refactor. Mock only system boundaries.
- Update the relevant specification when behavior, architecture, persistence, or user-facing
  contracts change.
- Run the focused tests while iterating, then the full project gate before completion.

```bash
npm run format
npm run check
```

- Run `npm run install:dev` only when the task includes manual Obsidian verification.
- Persistent plans, Slice evidence, reports, and handoffs must include a Source Manifest.
- Do not mark work complete without its required automated tests and any acceptance, performance, or
  reliability evidence defined by the relevant specification.
