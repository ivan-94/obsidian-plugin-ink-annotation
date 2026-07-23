# S36 Parser-backed Source Projection

Status: **IMPLEMENTATION PASS; RELEASE GATE OPEN**.

S36 replaces the legacy line-oriented rendered/source scanner with one parser-backed, bidirectional
Source Projection shared by Reading View selection creation, highlight restoration, and Snapshot
source binding.

Desktop Obsidian 1.12.7 acceptance passed for the reported tight-list regression, inline code,
cross-kind selection, reload restoration, and MathJax fail-closed Snapshot fallback. Automated
correctness, performance, mobile-bundle, and bounded-cache gates pass.

The remaining release qualification is physical-iPad P0. Whole rendered-math selection is also
intentionally disabled until a stable atomic MathJax DOM adapter is proven.

## Delivered

- CommonMark/GFM parser integration with frontmatter, math, and explicit Obsidian dialect adapters.
- Immutable UTF-16 Source Projection with forward and reverse mapping.
- Eight-entry, 16 MiB bounded LRU parser-artifact cache.
- Semantic Reading View DOM binder with typed failures and render-epoch invalidation.
- Tight, nested, task, and loose lists; formatting; links and wikilinks; inline/fenced code; quotes;
  callouts; tables; entities; Unicode; comments; and block IDs.
- Cross-kind, monotonic multi-block selection.
- View-level restoration after Obsidian replaces postprocessor roots.
- Snapshot capture, jump-to-source, and refind migrated to the same projection.
- Explicit Snapshot fallback for generated and unsupported surfaces.
- Legacy `rendered-source-map` production and test files removed.

## Evidence Index

- [HAT guide](hat-guide.md)
- [Test results](test-results.md)
- [Performance and bundle evidence](performance.md)
- [Risk register](risk-register.md)
- [Source Manifest](source-manifest.md)
- [Desktop restored-highlight screenshot](desktop-restored-highlights.jpeg)
- [Desktop MathJax fallback screenshot](desktop-math-fallback.jpeg)
