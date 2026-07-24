# I0 Internationalization Source-Language Baseline

## Status

- Captured: 2026-07-24
- Source commit: `1d38f1b`
- Source locale: English (`en`)
- Result: green automated baseline; implementation authorized by the user

## Baseline surface

The existing English behavior is represented by the current integration-style Vitest suite and its
literal visible-copy/accessibility assertions.

Covered states include:

- command registration, Notices, settings, and cache cleanup;
- Quick Toolbar actions and feedback;
- annotation Inspector create/edit/delete/repair flows;
- Current File Sidebar empty, loading, error, populated, search, selection, bulk, restore, Snapshot,
  and Legacy Ink states;
- Entire Vault restoring/building/unavailable, search, filter, sort, group, selection, and bulk
  states;
- Snapshot preview/edit, unsaved exit, retry, capture placeholder, and Ink controls;
- owner-document behavior for mounted Preact islands; and
- production, mobile, Obsidian 1.7.2, performance, and release lifecycle gates.

Known visual-risk areas are the 300 px and 380 px Sidebar container modes, bottom mobile Ink toolbar,
compact action labels, filters, dialogs, and intentionally ellipsized user content.

No pre-implementation screenshots were captured because no live Obsidian UI session or accepted
visual runner was attached to this task. English DOM behavior and accessibility labels are frozen by
the automated suite; final visual acceptance must explicitly record this screenshot gap.

## Automated evidence

Command:

```bash
npm run package:rc
```

Result:

- 127 test files passed;
- 903 functional/regression tests passed;
- 9 performance test files and 11 performance tests passed;
- Obsidian current and 1.7.2 typechecks passed;
- production bundle: 776,417 bytes across 96 non-empty lines;
- mobile and retired-document-Ink checks passed; and
- release lifecycle passed with canonical SHA-256
  `77c3c8502222e47cbbcfb37ae08c4a4787e7c4a78e740c08620c8861c9ba69cc`.

## Regression contract

- English remains the fallback and must preserve the current observable behavior.
- Tests may stop selecting controls by English text where a stable behavior selector is more
  appropriate, but accessibility assertions must continue to verify English and Simplified Chinese.
- Intentional truncation applies only to user content and paths; translated controls and status
  messages must remain understandable.
- Sidecars, settings, drafts, indexes, caches, IDs, and user-authored copy must not change merely
  because i18n is introduced.

## Source Manifest

### Sources

- User authorization on 2026-07-24 to commit the specification and begin implementation.
- `AGENTS.md`
- `CONTEXT.md`
- `docs/specs/2026-07-24-inkstone-internationalization.md`
- Existing tests under `src/`, `scripts/`, and `test-support/`.
- `package.json`

### Produced artifacts

- `docs/delivery/slices/I0-i18n-source-baseline/README.md`

### Key decisions

- Existing English integration tests are the executable source-language baseline.
- Visual screenshot evidence is deferred and recorded as an explicit acceptance gap.
- Implementation proceeds sequentially from I1 using vertical TDD.

### Verification evidence

- `npm run package:rc` passed at source commit `1d38f1b`.
- Bundle and release lifecycle evidence are recorded above.

### Open questions / risks

- Simplified Chinese terminology still requires final human copy review.
- English and Chinese layout need live Obsidian visual acceptance before production release.
