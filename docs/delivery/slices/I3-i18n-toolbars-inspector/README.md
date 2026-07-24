# I3 — Quick toolbar and annotation inspector

## Outcome

- The Reading View and Live Preview quick annotation toolbar receives the startup i18n service
  through explicit constructor dependencies.
- Quick actions, style action labels, accessible toolbar names, and retry feedback support English
  and Simplified Chinese.
- The annotation inspector localizes editing, overlap selection, reattachment, deletion, copy,
  save, error, and accessibility copy.
- Inspector focus routing uses stable semantic selectors instead of matching English accessible
  names.
- Existing constructors retain an English default for isolated tests and reusable boundary use;
  the production composition root always injects the resolved locale.

## TDD evidence

- RED: a Simplified Chinese quick-toolbar test rendered all previous English labels.
- GREEN: the toolbar renders localized action/accessibility labels and the full toolbar suite
  remains green.
- RED: a Simplified Chinese inspector test rendered `Annotation inspector`.
- GREEN: the inspector renders localized dialog, mark, note, copy, delete, and save controls while
  preserving all existing interaction tests.

Focused verification:

```text
npx vitest run src/ui/annotation-inspector.test.ts \
  src/ui/quick-highlight-toolbar.test.ts \
  src/adapters/obsidian/reading-annotation-controller.test.ts \
  src/adapters/obsidian/reading-view-integration.test.ts \
  src/adapters/obsidian/live-preview-extension.test.ts \
  src/ui/i18n --coverage=false

Test Files  7 passed (7)
Tests       81 passed (81)
```

Full verification:

```text
npm run check
Coverage     130 files passed / 914 tests passed
Performance  9 files passed / 11 tests passed
Production bundle, mobile bundle, retired Ink, current types, and Obsidian 1.7.2 types passed
```

The first full build correctly rejected acceptance-only wording after it was placed in the
production locale catalog. Those development-only labels now remain inside the compile-time
acceptance branch, allowing the whole branch and its copy to be removed from production.

## Source Manifest

- `AGENTS.md`
- `CONTEXT.md`
- `docs/specs/2026-07-24-inkstone-internationalization.md`
- `src/main.ts`
- `src/ui/i18n/`
- `src/ui/annotation-inspector.ts`
- `src/ui/annotation-inspector.test.ts`
- `src/ui/inspector/annotation-inspector-app.tsx`
- `src/ui/quick-highlight-toolbar.ts`
- `src/ui/quick-highlight-toolbar.test.ts`
- `src/ui/floating/quick-highlight-toolbar-app.tsx`
- `src/adapters/obsidian/reading-annotation-controller.ts`
- `src/adapters/obsidian/reading-view-integration.ts`
- `src/adapters/obsidian/live-preview-extension.ts`
