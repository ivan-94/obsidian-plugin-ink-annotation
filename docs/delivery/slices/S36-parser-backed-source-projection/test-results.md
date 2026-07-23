# Test Results

## Final Automated Gate

- PASS: `npm run check`.
- PASS: formatting, lint, TypeScript, coverage, performance, production build, mobile-bundle policy,
  and retired-document-Ink policy.
- PASS: 122 test files and 878 tests in the coverage run.
- PASS: the durable HAT `prepare.sh prepare` workflow completed twice consecutively.
- NOTE: the first full run hit one transient 10-second timeout in the pre-existing raster
  highlighter test. Its immediate focused rerun passed 2/2 in 1.74 seconds, and the second unchanged
  full `npm run check` passed.

## Focused TDD Evidence

- PASS: parser-backed projection fixtures.
- PASS: semantic DOM binding fixtures.
- PASS: Obsidian wrapper-whitespace cross-block selection.
- PASS: MathJax element-endpoint rejection.
- PASS: postprocessor-root replacement and view-level highlight restoration.
- PASS: Reading View integration suite, 24 tests.
- PASS: mobile Note Inspector moves and reclamps when the iPad visual viewport shrinks from the
  software keyboard.

## Desktop HAT Evidence

- PASS: second tight-list item created a canonical sidecar at UTF-16 source offsets `241..275`.
- PASS: inline-code selection created a canonical sidecar at `535..542`.
- PASS: heading-to-paragraph cross-block selection created one source interval at `106..139`.
- PASS: paragraph-to-list cross-kind selection created one source interval at `1390..1446`.
- PASS: reload restored accepted highlights after Obsidian replaced postprocessor roots.
- PASS: partial MathJax selection returned unsupported copy and an `Annotate a snapshot instead`
  action.
- PASS: the rejected MathJax selection created no fifth sidecar; four accepted records remained.
- BLOCKED: physical-iPad P0 because no physical device is connected.

## Compatibility

- No text sidecar schema migration.
- Existing `TextPosition + TextQuote + scope` resolver path retained.
- Editing mode remains dormant.
- No runtime Node.js or Electron top-level import added.
- No telemetry or external service added.
