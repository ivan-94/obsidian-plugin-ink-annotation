# S36 Source Projection HAT

- Date: 2026-07-23
- Repository mode: attach to `test-fixtures/vault`
- Desktop host: Obsidian 1.12.7 on macOS
- Prepare: `docs/delivery/slices/S36-parser-backed-source-projection/prepare.sh prepare`
- Fixture: `Source Projection HAT.md`, Reading View
- Desktop result: **PASS**
- Physical-iPad result: **IN PROGRESS — keyboard correction awaiting device retest**

## P0 Results

| Scenario                                           | Result                              | Evidence                                                            |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| Tight-list item two and later                      | PASS                                | Sidecar `241..275`; `desktop-restored-highlights.jpeg`              |
| Nested/task/loose-list binding                     | PASS automated; desktop smoke PASS  | Parser, binder, and Reading View suites                             |
| Inline code                                        | PASS                                | Sidecar `535..542`                                                  |
| Heading → paragraph cross-block                    | PASS                                | Sidecar `106..139`; restored screenshot                             |
| Paragraph → list cross-kind                        | PASS                                | Sidecar `1390..1446`                                                |
| Reload restoration after postprocessor replacement | PASS                                | `desktop-restored-highlights.jpeg`                                  |
| Partial MathJax selection                          | PASS fail-closed                    | `desktop-math-fallback.jpeg`; unsupported copy plus Snapshot action |
| Rejected-selection sidecar absence                 | PASS                                | Four accepted records before and after MathJax rejection            |
| Repeated target structural binding                 | PASS automated                      | Snapshot and DOM binder regression suites                           |
| Stale context                                      | PASS automated                      | Reading View integration stale-epoch regression                     |
| Snapshot capture/jump/refind migration             | PASS automated                      | Snapshot manager integration tests                                  |
| Note Inspector above the iPad software keyboard    | Initial FAIL; corrected, retest due | `ipad-keyboard-overlap-before.png`; visual-viewport regression test |
| Physical iPad native handles and latency           | IN PROGRESS                         | User-operated physical iPad                                         |

## Desktop Execution Record

| Time (Asia/Shanghai) | Scenario                    | Result                                      | Notes                                                                                                 |
| -------------------- | --------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 15:29–15:36          | Tight second list item      | Initial FAIL, fixed, then PASS              | Real DOM exposed one unmatched block poisoning global alignment.                                      |
| 15:37–15:40          | Inline code and cross-block | Initial cross-block FAIL, fixed, then PASS  | Obsidian wrapper whitespace was incorrectly treated as unsupported visible content.                   |
| 15:42–15:44          | MathJax selection           | Initial wrong `not-found`, fixed, then PASS | MathJax uses element endpoints without text nodes; endpoint inspection now rejects it explicitly.     |
| 15:49–15:53          | Reload restoration          | Initial partial restore, fixed, then PASS   | Obsidian replaced/unloaded postprocessor roots; view-level rebinding now restores all accepted spans. |

## Physical-iPad Execution Record

| Time (Asia/Shanghai) | Scenario               | Result                           | Notes                                                                                                             |
| -------------------- | ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 16:33                | Add-note soft keyboard | FAIL; correction awaiting retest | The mobile Inspector skipped viewport observation and CSS fixed it to the layout-viewport bottom behind keyboard. |

## Manual Physical-iPad Checklist

1. Install the prepared build into the same dedicated Vault on a physical iPad.
2. Repeat tight-list, inline-code, wikilink, and paragraph/list selections with native handles.
3. Verify preparation does not collapse selection or block scrolling.
4. Record cached endpoint P95 ≤16 ms, ten-block P95 ≤32 ms, and toolbar ≤150 ms.
5. Open Add note, keep the keyboard visible, rotate once, and verify the complete Inspector remains
   reachable above the keyboard.
6. Verify error announcements and the Snapshot fallback action.
7. Attach device identity, screen recording, and timing output to this Slice.

## Source Manifest

See `source-manifest.md`. Evidence contains no external service, credential, or telemetry
dependency.
