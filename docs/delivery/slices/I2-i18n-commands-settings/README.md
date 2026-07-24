# I2 — Commands, notices, settings, and host actions

## Outcome

- Inkstone creates one immutable i18n service from the Obsidian startup locale.
- Command names, notices, diagnostics feedback, settings copy, cache-cleanup progress, and the
  Reading View Snapshot action support English and Simplified Chinese.
- User-facing failure notices use stable localized copy; internal exception details remain in the
  console.
- Locale selection remains startup-only and does not add a persisted plugin preference.

## TDD evidence

- RED: the settings test rendered the previous mixed English/Chinese surface and could not find an
  English cleanup action.
- GREEN: English and Simplified Chinese settings tests pass, including parameterized cleanup
  results and safe failure copy.
- RED: the host Snapshot action ignored the supplied Chinese label.
- GREEN: host action tests verify both Obsidian's action label and the accessible name.

Focused verification:

```text
npx vitest run src/adapters/obsidian/snapshot-capture-action.test.ts \
  src/settings-tab.test.ts src/ui/i18n --coverage=false

Test Files  4 passed (4)
Tests       9 passed (9)
```

Type verification:

```text
npm run typecheck
tsc --noEmit
```

## Source Manifest

- `AGENTS.md`
- `CONTEXT.md`
- `docs/specs/2026-07-24-inkstone-internationalization.md`
- `src/main.ts`
- `src/settings-tab.ts`
- `src/settings-tab.test.ts`
- `src/adapters/obsidian/snapshot-capture-action.ts`
- `src/adapters/obsidian/snapshot-capture-action.test.ts`
- `src/ui/i18n/`
