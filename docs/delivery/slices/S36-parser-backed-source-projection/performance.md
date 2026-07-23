# Performance and Bundle Evidence

## Parser and Binder

Focused local performance observations:

- 200,000-character note: one parse plus 100 cached lookups completed in `311 ms` for the test
  process; cache reuse performed no second parse.
- Ten-block projection fixture: `2 ms`.
- 100 visible DOM blocks bound in `39 ms`, below the 50 ms long-task gate.
- Repeated navigation across 100 notes retained at most eight projections and stayed under the
  configured 16 MiB estimate.

These are deterministic local regression gates, not physical-iPad latency evidence.

## Cache Policy

- Maximum entries: `8`.
- Maximum estimated retained bytes: `16 MiB`.
- Key: `{filePath, sourceRevision, dialectVersion}`.
- DOM bindings additionally expire by Reading View render epoch and are released with the view.

## Production Bundle

| Artifact     | Baseline `9569874` |       S36 build |                    Delta |
| ------------ | -----------------: | --------------: | -----------------------: |
| `main.js`    |    1,257,706 bytes | 1,522,008 bytes | +264,302 bytes (+21.01%) |
| `styles.css` |       74,403 bytes |    74,486 bytes |                +83 bytes |

The JavaScript increase is the reviewed cost of the CommonMark/GFM/frontmatter/math parser stack and
named-entity decoding. The mobile bundle scan passes and finds no Node.js/Electron runtime leak.
Physical-iPad heap and interaction latency remain release qualification work.
