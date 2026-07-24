# I1 Internationalization Foundation

## Status

- Implemented: 2026-07-24
- Result: complete

## Delivered behavior

- `en` and `zh` are the supported locale identifiers.
- Only exact Simplified Chinese (`zh`, case-insensitive) selects the Chinese catalog.
- `zh-TW`, `zh-HK`, and unsupported locales fall back to English.
- The Obsidian Adapter prefers public `getLanguage()` and falls back to `moment.locale()` for
  Obsidian 1.7.2.
- Message parameters are statically associated with catalog keys.
- Number and date formatters are created once per immutable I18n service.
- Preact islands can receive one I18n service through an island-local Context.
- `npm run check:i18n` is part of the project gate.

## TDD evidence

RED states were observed for:

- missing locale normalizer;
- missing locale-aware translation service;
- missing Obsidian locale Adapter;
- missing Preact locale Context; and
- a Preact island that did not provide the injected locale.

Each behavior was implemented through its public interface before the next behavior was added.

## Verification

`npm run check` passed:

- 3 i18n test files and 5 focused tests;
- 130 coverage test files and 909 tests;
- 9 performance test files and 11 tests;
- current and Obsidian 1.7.2 typechecks;
- production bundle: 777,107 bytes across 96 non-empty lines;
- mobile and retired-document-Ink checks.

An extra `npm test` run placed performance tests in the ordinary parallel pool and produced one
timing-only failure (`reading-source-projection` measured 182.9 ms against a 50 ms gate). The
project's authoritative split gate (`test:coverage` followed by single-worker `test:performance`)
passed. No i18n behavior failed.

## Source Manifest

### Sources

- `docs/specs/2026-07-24-inkstone-internationalization.md`
- `docs/delivery/slices/I0-i18n-source-baseline/README.md`
- `AGENTS.md`
- `node_modules/obsidian/obsidian.d.ts`
- `node_modules/obsidian-1-7-2/obsidian.d.ts`
- `/Users/ivan/.agents/skills/tdd/SKILL.md`
- `/Users/ivan/.agents/skills/migrate-frontend-i18n/SKILL.md`

### Produced artifacts

- `src/ui/i18n/`
- `src/adapters/obsidian/obsidian-locale.ts`
- `src/adapters/obsidian/obsidian-locale.test.ts`
- Updated `src/ui/runtime/mount-preact-island.tsx`
- Updated `package.json`
- `docs/delivery/slices/I1-i18n-foundation/README.md`

### Key decisions

- The I18n service is immutable and injected; there is no mutable global locale.
- Message catalogs use typed functions rather than runtime placeholder parsing.
- Obsidian version compatibility is isolated to one Adapter.

### Verification evidence

- `npm run check` passed with the results above.

### Open questions / risks

- Catalog coverage is intentionally minimal until UI Slices add their own observable behavior.
- The final hard-coded-copy scanner remains I7 work.
