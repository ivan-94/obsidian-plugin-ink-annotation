# Ink iCloud-Resilient Persistence

**Status:** Implemented and automated-gate verified; physical Mac/iPad iCloud HAT pending,
2026-07-17  
**Scope:** Ink canonical save/retry/recovery when a newer visible revision arrives after an edit
session read its base.

This specification supersedes only the historical requirement that every changed canonical payload
for one Ink surface must become an immediate manual conflict. Exact compare-and-swap, conflict
artifact preservation, tombstones, batch journals, and fail-closed recovery remain mandatory.

It does not authorize automatic Markdown/layout rebase, Last Write Wins, deletion of iCloud conflict
artifacts, or any claim that a successful local write has synced to iCloud.

## Problem

An active Ink session retains a confirmed canonical base `B`. The user produces local working state
`L`, while iCloud or another local owner can advance the visible canonical surface to `R`. The
repository correctly refuses `L` when `R != B`, but the current Retry action resubmits the same
`B + L`. A real successor therefore fails forever even when both sides only appended independent
strokes and no information is ambiguous.

The whole-record rejection protects data but is not a complete recovery algorithm. Common safe
divergence must be reconciled without user intervention, while semantic conflicts must continue to
preserve every version and fail closed.

## Save Classification

Every update is classified from the exact tuple `base B`, `local L`, and latest visible canonical
`remote R` while the repository's note write lock is held:

1. `R == L`, or `R` already contains every exact local append: the earlier write/reconciliation
   already landed; complete idempotently without creating another revision.
2. `R == B`: perform the ordinary one-revision CAS update.
3. `B -> L` and `B -> R` are both safe append-only Ink changes: deterministically merge and commit
   from `R` at `R.revision + 1`.
4. Anything else: do not mutate canonical bytes; retain local recovery state and surface a semantic
   conflict rather than a generic disk failure.

Retry must run this classification again against the newest visible canonical state. It must never
blindly overwrite `R` or repeatedly replay a known-stale base.

## Safe Automatic Merge Boundary

An automatic merge is permitted only when all of the following are true:

- `B`, `L`, and `R` are valid records for the same note, file, surface, schema version, status,
  creation identity, binding, and non-height layout metadata.
- The surface is active and none of the three records is tombstoned.
- `L` and `R` each preserve the complete base stroke set byte-for-byte by stable stroke ID and only
  add new IDs. Array position is not treated as a destructive edit because Inkstone exposes no
  stroke-reordering command.
- Every appended stroke ID is globally unique across the two branches, or both branches appended
  byte-identical content for the same ID.
- Neither branch moved, restyled, erased, reordered, or deleted an existing stroke.
- `logicalHeight` is unchanged or increases monotonically; the merged height is the maximum of all
  three records. Logical width, chunk origin, and every other layout field must remain exact.
- The repository still performs a fresh visible-candidate scan. Same-revision divergent siblings,
  corrupt records, unknown schema, missing surfaces, or a changed surface set remain conflicts.

The merged stroke sequence preserves the latest visible canonical order and appends local-only
additions in stable stroke-ID order. Future stale descendants compare stable stroke identity rather
than requiring either branch's array to remain a literal prefix, so an earlier safe merge cannot
make the next append-only descendant permanently stale.

This first safe boundary intentionally covers the high-frequency case of two devices drawing new
pen/highlighter strokes on the same bounded surface. It does not infer user intent from destructive
or spatial edits.

## Session and Recovery Contract

- A save API may return the actual canonical record committed by reconciliation. The live session
  must adopt that record as its new confirmed base instead of assuming its original candidate was
  written byte-for-byte.
- Remote additions from the returned canonical record become visible in the active session without
  discarding local strokes produced while I/O was in flight.
- If more local drawing arrived during the save, it is persisted in the next normal revision from
  the returned canonical base.
- Version-3 device-local checkpoints remain valid: after a merged commit, the session publishes the
  merged confirmed base before an older checkpoint generation can be cleared.
- A failed or ambiguous merge never clears the checkpoint or destroys the active owner.
- Automatic reconciliation is bounded to the current locked save attempt. Repeated external
  advancement still fails visibly rather than spinning indefinitely.

## Atomic Multi-Chunk Contract

- A logical command touching several bounded surfaces is classified completely before the first
  canonical surface write.
- Every changed target must be either an exact-base advance or a safe append merge. One unsafe
  target rejects the entire batch.
- The existing prepared/committed journal still exposes all-old or all-new canonical bytes.
- The writer returns reconciled records aligned by surface ID so each bounded session advances to
  the exact canonical base it owns.

## User Experience

- Safe append reconciliation is silent during normal drawing; it must not show the current
  `Couldn't save Ink locally` error or require Retry.
- A true semantic conflict says that another Ink version arrived and that the user's local strokes
  are retained. It must not mislabel revision divergence as a disk/permission failure.
- Until the visual conflict-repair workflow is complete, Retry remains useful for transient I/O and
  newly resolvable canonical states, but the UI must not imply repeated Retry can force an unsafe
  overwrite.
- Local save success remains `Saved locally`; cloud completion remains unknown.

## Required TDD and Acceptance

- Two real `InkSurfaceSession` instances starting at revision 1 append different strokes; the second
  save commits revision 3 containing both strokes without an error, then saves another local stroke
  from revision 3.
- A monotonic transient canvas-height expansion plus independent remote/local additions merges using
  the maximum height.
- A moved/restyled/deleted base stroke on either branch rejects automatic merge and leaves canonical
  bytes unchanged.
- A tombstone versus an appended stroke rejects automatic merge and never resurrects the surface.
- Same-revision divergent iCloud siblings remain visible repair candidates.
- A multi-chunk append merge commits atomically; any unsafe sibling prevents all writes.
- A local stroke added while the merged write is in flight survives and is saved in the following
  revision.
- Full automated checks and a physical Mac/iPad iCloud offline/reconnect HAT are required before the
  real-iCloud release gate can pass.

## Non-Goals and Follow-Ups

- Automatically merging movement, deletion, erasing, Undo/Redo, repartition, or layout rebase.
- Recovering inaccessible Apple `NSFileVersion` history.
- Solving simultaneous same-revision whole-file forks without a visible common ancestor.
- Replacing bounded snapshots with an immutable mutation log in this correction. A future schema may
  add parent hashes or per-device immutable operations if physical iCloud evidence shows that common
  ancestry is not reliably visible.

## Source Manifest

### Sources

- User screenshot and instruction on 2026-07-17 reporting repeated
  `Ink surface changed since the expected base was read.` failures under iCloud.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-design.md`.
- `docs/specs/2026-07-14-obsidian-annotation-plugin-execution-plan.md`.
- `docs/specs/2026-07-15-ink-fixed-width-manual-repositioning.md`.
- `docs/specs/2026-07-16-ink-stage-frame-and-native-navigation.md`.
- `docs/delivery/slices/S06-icloud-safety/`.
- `docs/delivery/slices/S19-ink-stage-frame-native-navigation/`.
- `src/application/ink-surface-session.ts`.
- `src/application/ink-document-session.ts`.
- `src/storage/ink-surface-repository.ts`.
- `src/storage/local-ink-recovery.ts`.
- `/Users/ivan/.agents/docs/agents/workflows.md` and
  `/Users/ivan/.agents/docs/agents/handoff-policy.md`.

### Produced artifacts

- This incremental specification.
- `src/domain/ink-concurrent-append-merge.ts` and its correctness/performance tests.
- Repository/session reconciliation in `src/storage/ink-surface-repository.ts`,
  `src/application/ink-surface-session.ts`, and `src/application/ink-document-session.ts`.
- Restart-safe checkpoint reconciliation in `src/storage/local-ink-recovery.ts`.
- Deterministic two-owner integration coverage in
  `src/application/ink-icloud-persistence.integration.test.ts`.

### Key decisions

- Keep exact CAS and fail-closed semantics; never solve the bug with overwrite-on-conflict.
- Automatically reconcile only exact-common-base append-only branches.
- Make the committed canonical record an explicit save result so live and recovery state cannot
  retain a stale base after a merge.
- Defer destructive/spatial semantic merging and common-ancestor schema changes.

### Verification evidence

- Before implementation, the existing deterministic regression
  `fails closed instead of leapfrogging a concurrent successor on Retry` reproduced the permanent
  stale-base behavior.
- The deterministic integration suite covers independent stale sessions, multi-chunk atomic merge,
  unsafe mutation rejection, drawing during in-flight reconciliation, a stale descendant after an
  earlier merge, and idempotent Retry after a post-commit callback failure.
- `npm run check` passed on 2026-07-17: formatting, lint, typecheck, 103 test files with 717 tests,
  coverage thresholds, 5 performance files with 10 tests, production build, and mobile bundle.
- The 10,000-stroke append-merge performance regression completed in approximately 32 ms against a
  250 ms budget on the development machine.
- `npm run install:dev` installed the verified development bundle into
  `test-fixtures/vault/.obsidian/plugins/inkstone-annotations`.
- Physical Mac/iPad iCloud offline/reconnect HAT remains pending; the real-iCloud release gate has
  not passed yet.

### Open questions / risks

- Obsidian may not emit every hidden-sidecar iCloud event promptly; save-time re-read remains the
  authoritative detection boundary.
- Real Mac/iPad iCloud conflict artifacts and hydration timing remain an unpassed physical gate.
- Cross-device perceived draw order has no reliable global clock. Reconciliation preserves the
  latest visible canonical order and deterministically appends local-only strokes; data preservation
  and convergence take precedence.
