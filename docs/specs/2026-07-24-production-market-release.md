# Inkstone Annotations Production and Community Market Release

## Status

- Created: 2026-07-24
- Status: adopted; R0 and R1 implemented; product-owner HAT accepted outside this task; automated
  release qualification and external publication in progress
- Product name: `Inkstone Annotations`
- Immutable plugin ID: `inkstone-annotations`
- Public repository: `https://github.com/ivan-94/obsidian-plugin-ink-annotation`
- License: MIT
- Beta line: `0.1.x`
- First Community directory release: `1.0.0`

## Product promise

Inkstone Annotations lets readers highlight, underline, and comment on mutable Markdown while
keeping those annotations recoverable as the source changes. It also captures a stable, Vault-local
Snapshot of Reading View so users can add freehand Pen and Highlighter markup without turning
mutable DOM layout into persistent Ink coordinates.

The Community directory description is:

> Highlight and underline mutable Markdown, add notes, and draw on stable snapshots.

The name deliberately combines a distinctive brand, `Inkstone`, with the searchable product
category, `Annotations`. It differentiates the plugin from direct-between-paragraph handwriting and
standalone infinite-canvas products without encoding implementation details into the name.

## Goals

1. Publish a public, reviewable repository that a new contributor can clone, verify, and package.
2. Establish one repeatable release contract from committed source to GitHub Release assets.
3. Pass the current Obsidian plugin policies, manifest rules, and automated Community directory
   review.
4. Prove data safety across fresh install, upgrade, rollback, uninstall, persistence failure, note
   rename, source mutation, and external sidecar change.
5. Validate every declared platform on real Obsidian installations; do not declare mobile support
   before physical iPadOS and Android evidence exists.
6. Run a public `0.1.x` Beta before submitting `1.0.0` to the Community directory.
7. Make post-1.0 updates deliverable through versioned GitHub Releases without manual artifact
   assembly.

## Non-goals

- Pushing the repository, creating a GitHub Release, or submitting to the Community directory
  without an explicit external-publication checkpoint.
- Adding telemetry, accounts, hosted services, or a network dependency.
- Changing the canonical sidecar schemas solely for release packaging.
- Claiming iCloud or other sync-provider reliability beyond observed local and cross-device
  evidence.
- Renaming the plugin ID after a public Beta has been distributed.
- Treating disposable indexes, summaries, thumbnails, or IndexedDB caches as canonical data.

## Stable identity and metadata

The following values must agree wherever they appear:

| Surface                   | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| Display name              | `Inkstone Annotations`                                                               |
| Plugin ID                 | `inkstone-annotations`                                                               |
| Package name              | `inkstone-annotations`                                                               |
| Repository                | `ivan-94/obsidian-plugin-ink-annotation`                                             |
| Author                    | `Ivan`                                                                               |
| Author URL                | `https://github.com/ivan-94`                                                         |
| Description               | `Highlight and underline mutable Markdown, add notes, and draw on stable snapshots.` |
| Canonical sidecar root    | `.obsidian-annotations/`                                                             |
| Runtime release artifacts | `main.js`, `manifest.json`, `styles.css`                                             |

`manifest.json#id` is the durable installation and data-integration identity. The repository slug
and display name may be improved later, but changing the ID after public distribution is a migration
and is outside this release.

## Release stages

### R0 — Release foundation

Deliver:

- MIT `LICENSE`;
- user-facing README with product promise, feature boundaries, quick start, data location, privacy,
  portability, limitations, development, and release installation;
- contribution, security, support, and issue-reporting entry points;
- consistent manifest and package metadata;
- CI for every pull request and `main` update;
- a tag-aware release preflight that fails closed when the tag and manifest version differ.

Exit criteria:

- a clean clone passes `npm ci` and `npm run check`;
- the release package contains the three Obsidian runtime files plus optional checksum evidence;
- no generated `main.js`, `coverage/`, `dist/`, test Vault state, or private local artifact is
  tracked;
- the repository contains every file required by the Obsidian submission guide.

### R1 — Obsidian policy and production audit

Audit:

- lifecycle registration and cleanup;
- startup work and Deferred View compatibility;
- global `app`, hard-coded config-directory access, Adapter usage, direct DOM styling, console
  noise, default hotkeys, command naming, and sentence case;
- Node.js and Electron imports in the mobile bundle;
- dependency licenses, known vulnerabilities, unexpected network behavior, and telemetry;
- minimum supported Obsidian version against APIs actually used;
- minimized production bundle size and startup cost.

Exit criteria:

- no unresolved submission blocker;
- every accepted deviation has a written product or architecture reason;
- `minAppVersion` is either evidenced or raised before Beta;
- mobile support remains true only if the real-device gate passes.

Decision for 0.1.x: `manifest.json#isDesktopOnly` is `false`. `html-to-image@1.11.13` is embedded in
`main.js` and is the mobile default. Its production invocation disables font embedding, converts
already-loaded Vault images to data URLs, replaces remote images, suppresses URL-valued
background/mask styles, and neutralizes external SVG images before render. A focused test runs the
real embedded `toSvg()` pipeline with `fetch` intercepted and observes zero requests.
Backend-selection commands remain restricted to `build:web-hat`.

### R2 — Production HAT

Required product paths:

- fresh install into a Vault with no Inkstone data;
- upgrade from the most recent Beta with canonical bytes preserved;
- rollback of runtime files with canonical sidecars preserved;
- disable and uninstall without deleting canonical sidecars or exports;
- text highlight, underline, note, edit, delete, restore, export, and source reattachment;
- Snapshot capture, Pen, Highlighter, eraser, transform, undo/redo, Done, Preview, reopen, and
  export;
- read-only note opening creates no empty per-note sidecar;
- failed persistence retains unsaved Ink and exposes recovery;
- note rename, source mutation, external sidecar arrival, stale derived summary, and corrupt
  disposable cache;
- large note and large Vault demand bounds.

Device matrix:

| Platform        | Minimum gate                                                       |
| --------------- | ------------------------------------------------------------------ |
| macOS desktop   | Full P0 flow, upgrade, rollback, uninstall, and large-Vault smoke  |
| Windows desktop | Fresh install, text annotation, Snapshot, export, and upgrade      |
| iPadOS          | Pencil/Highlighter latency, touch controls, Done, reopen, recovery |
| Android         | Touch drawing, text selection, Snapshot, reopen, and export        |
| Linux desktop   | Fresh install and core workflow smoke                              |

The product owner reported completing human acceptance outside this task and directed the release
run not to repeat HAT. This statement is retained as supplied evidence but is not expanded into
unreported device, OS, Obsidian-version, latency, memory, or accessibility results.

Exit criteria:

- no open P0 data-loss, security, install, startup, or persistence defect;
- no open P1 core-workflow defect without an explicit release decision;
- automated, performance, reliability, and human evidence are linked from the release record.

### R3 — Public Beta

Release `0.1.x` from the public GitHub repository and distribute it through BRAT or manual
installation. A Beta manifest version remains strict `x.y.z`; GitHub tags must match it exactly
without a `v` prefix.

Exit criteria:

- the full supported-platform matrix has at least one completed real-device run;
- a Beta-to-Beta upgrade has preserved canonical data;
- no unresolved data-loss or startup blocker;
- known limitations and recovery instructions match observed behavior;
- feedback has been triaged into must-fix, post-1.0, or declined-with-reason.

### R4 — Community directory 1.0

Deliver:

- synchronized `1.0.0` in `manifest.json`, `package.json`, lockfile, and `versions.json`;
- tag `1.0.0`;
- GitHub Release assets named exactly `main.js`, `manifest.json`, and `styles.css`;
- release notes with compatibility, data-safety, upgrade, rollback, and known-limitations links;
- accurate `manifest.json` committed at the default branch HEAD;
- submission through `community.obsidian.md` after linking the repository owner's GitHub account.

If automated review requires a code or metadata change, publish a new patch version and matching
GitHub Release before resubmitting. Never replace an already distributed release asset in place.

Exit criteria:

- automated review passes;
- the plugin is installable from a clean Vault through the Community plugins UI;
- installed runtime hashes match the published GitHub Release assets;
- a post-install smoke test passes on one desktop and one mobile device.

### R5 — Maintained production

- publish changes through pull requests and repeatable GitHub Releases;
- keep `versions.json` compatible with the real API floor;
- use schema migrations that preserve or copy canonical data before destructive cleanup;
- publish security and data-loss fixes with priority over feature work;
- retain release evidence and update the Source Manifest for every major release decision.

## Automated release contract

CI must run on pull requests and updates to `main`:

```text
npm ci
npm run check
```

The release workflow may run only for a SemVer `x.y.z` tag. Before creating a GitHub Release it must
prove:

1. the tag equals `manifest.json#version`;
2. `package.json#version` equals the manifest version;
3. `versions.json` contains that exact version;
4. the production build and all automated gates pass;
5. the packaged runtime files match their SHA-256 evidence;
6. the three required runtime files are uploaded as individual release assets.

The workflow must not publish from a dirty local workspace, accept a `v1.0.0`/`1.0.0` mismatch, or
silently reuse an existing release.

## Public repository requirements

The repository root must contain:

- `README.md`;
- `LICENSE`;
- `manifest.json`;
- `versions.json`;
- `package.json` and `package-lock.json`;
- source, build configuration, and repeatable verification commands.

Recommended public governance:

- `CONTRIBUTING.md`;
- `SECURITY.md`;
- GitHub issue forms for bugs and feature requests;
- pull request template;
- CI and release workflows.

The README must not depend on a private or adjacent workspace for essential product behavior. It
must state that:

- canonical data stays in the Vault under `.obsidian-annotations/`;
- disabling or uninstalling the plugin does not delete canonical sidecars;
- the plugin has no telemetry or external service;
- Snapshot markup uses a stable captured image rather than live Markdown layout;
- exports are the portability boundary outside Inkstone;
- users should back up their Vault before Beta upgrades.

## Release stop conditions

Stop a release when any of these is true:

- canonical data can be lost or overwritten on a supported failure path;
- the Git tag, manifest, package, lockfile, or `versions.json` disagree;
- required GitHub Release assets are absent or checksums differ;
- a supported platform cannot load the plugin;
- the declared minimum Obsidian version is not compatible;
- an undisclosed network request, telemetry path, or external data transmission exists;
- the public README omits a material data-safety or platform limitation;
- the worktree contains secrets, private Vault contents, or generated artifacts intended to stay
  local.

## Acceptance criteria

- The product is published as `Inkstone Annotations` with ID `inkstone-annotations` and MIT License.
- The Community description is the approved one-sentence product promise.
- A public clean clone can reproduce the release files.
- CI blocks formatting, lint, type, test, performance, build, mobile, retired-runtime, version, and
  release-package failures.
- Beta and 1.0 releases use exact SemVer tags and immutable assets.
- All supported platforms have evidence proportional to the manifest claim. For 0.1.x the product
  owner supplied the human acceptance decision for `isDesktopOnly: false`; the release record must
  not invent device/version/performance detail that was not supplied.
- Read-only Markdown navigation creates no empty per-note Ink summary sidecar.
- Canonical sidecars survive install, upgrade, rollback, disable, and uninstall.
- The Community directory can read the repository HEAD and install the matching GitHub Release.

## Source Manifest

### Sources

- User instruction on 2026-07-24 to configure
  `git@github.com:ivan-94/obsidian-plugin-ink-annotation.git`, select a descriptive production name,
  plan the Community market release, adopt `Inkstone Annotations`, and use the MIT License.
- User instruction on 2026-07-24 to embed `html-to-image`, rely on the product owner's completed
  acceptance, and skip a duplicate HAT run in this task.
- `AGENTS.md`.
- `CONTEXT.md`.
- `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`.
- `README.md`, `docs/user-guide.md`, `docs/data-safety.md`, and `docs/known-limitations.md`.
- `docs/release/0.1.0-rc.md`.
- `scripts/package-release.mjs`, `scripts/verify-release-lifecycle.mjs`, and their tests.
- Obsidian Developer Documentation:
  `https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin`.
- Obsidian manifest reference: `https://docs.obsidian.md/Reference/Manifest`.
- Obsidian plugin self-critique checklist: `https://docs.obsidian.md/oo/plugin`.
- Obsidian Community plugin registry:
  `https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json`.
- `/Users/ivan/.agents/docs/agents/workflows.md`.
- `/Users/ivan/.agents/docs/agents/handoff-policy.md`.
- `/Users/ivan/.agents/skills/tdd/SKILL.md`.

### Produced artifacts

- `docs/specs/2026-07-24-production-market-release.md`.
- `docs/specs/README.md`.
- `docs/release/0.1.0-r1-policy-audit.md`.
- `LICENSE`.
- `README.md`.
- `CONTRIBUTING.md`.
- `SECURITY.md`.
- `.github/ISSUE_TEMPLATE/bug_report.yml`.
- `.github/ISSUE_TEMPLATE/feature_request.yml`.
- `.github/ISSUE_TEMPLATE/config.yml`.
- `.github/pull_request_template.md`.
- `.github/dependabot.yml`.
- `.github/workflows/ci.yml`.
- `.github/workflows/release.yml`.
- `.nvmrc`.
- `scripts/verify-release-tag.mjs`.
- `scripts/verify-release-tag.test.mts`.
- `scripts/check-production-bundle.mjs`.
- `scripts/check-production-bundle.test.mts`.
- `tsconfig.obsidian-1.7.2.json`.
- Updated public metadata in `manifest.json`, `package.json`, and `package-lock.json`.
- Corrected public behavior and safety documentation in `docs/user-guide.md`, `docs/data-safety.md`,
  and `docs/known-limitations.md`.

### Key decisions

- Keep `inkstone-annotations` as the immutable plugin ID and `Inkstone Annotations` as the display
  name.
- Use a clear functional description instead of adding more generic Ink/Drawing words to the name.
- Use the MIT License.
- Treat `0.1.x` as public Beta and `1.0.0` as the first Community directory release.
- Require exact version/tag agreement and individual Obsidian runtime assets.
- Complete local release foundations before any external push, Release, or Community submission.
- Publish 0.1.0 as a mobile-capable GitHub prerelease after automated qualification. Keep
  acceptance-only backend commands out of the production graph.
- Embed `html-to-image`; do not download library code at runtime. Constrain its renderer input so
  fonts and URL-backed resources are not refetched during Snapshot capture.

### Verification evidence

- On 2026-07-24 the official Community registry contained no exact `Inkstone Annotations`,
  `Inkstone Markup`, `Anchored Ink`, or `inkstone-annotations` entry.
- `git ls-remote origin` reached the configured SSH remote and returned no refs before the first
  push.
- The release-tag verifier was developed red-green across exact SemVer acceptance, `v`-prefix
  rejection, stale lockfile rejection, and public-identity mismatch rejection; all four focused
  tests pass.
- `npm run verify:release-tag -- 0.1.0` passed against the repository metadata.
- `npm run format:check` and `git diff --check` passed.
- All GitHub Actions and issue-form YAML files parsed successfully.
- `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org` reported zero
  vulnerabilities. The configured npm mirror does not implement the audit API, so the read-only
  audit used the official registry without changing repository configuration.
- `npm run package:rc` passed on macOS:
  - 126 automated test files and 894 tests passed;
  - 9 performance test files and 11 performance tests passed;
  - type checking, production build, mobile bundle, retired document-Ink, version, and release
    package gates passed;
  - install, upgrade, rollback, and uninstall lifecycle verification passed;
  - packaged runtime files are `main.js`, `manifest.json`, and `styles.css`, with `checksums.json`
    evidence;
  - canonical lifecycle SHA-256: `77c3c8502222e47cbbcfb37ae08c4a4787e7c4a78e740c08620c8861c9ba69cc`.
- An independent SHA-256 check matched all three packaged runtime files against `checksums.json`.
- `npm run install:dev` installed the built plugin successfully into the repository's disposable
  test Vault.
- R1 changed the production build from an unminified 1,544,109-byte bundle to a minified
  776,417-byte bundle with embedded Web capture and added a 1,000,000-byte release budget.
- The complete source type-checks against both the current declarations and the declared
  `obsidian@1.7.2` API surface.
- Focused R1 tests prove network-free local-image inlining, the production bundle contract, and
  action-menu compatibility.
- Production acceptance-only backend commands were removed, and optional Electron module IDs are
  transparent literal probes behind the desktop backend.
- The final post-R1 `npm run package:rc` passed with 127 automated test files / 903 tests, 9
  performance test files / 11 performance tests, both type-check targets, the production bundle
  gate, checksum packaging, and install/upgrade/rollback/uninstall lifecycle verification.
- Generated `main.js`, `dist/`, `coverage/`, and test Vault state are not tracked by Git.

### Open questions / risks

- The repository owner must make the GitHub repository publicly readable before Beta review.
- `minAppVersion: 1.7.2` passes the exact declaration-level API audit but still requires a real
  Obsidian 1.7.2 runtime smoke.
- Real Windows, iPadOS, Android, and Linux evidence cannot be replaced by local macOS automation.
- `isDesktopOnly: false` is enforced for the 0.1.x release line following the product owner's
  existing human acceptance decision.
- `html-to-image` is a pinned production dependency embedded by esbuild. Inkstone skips its
  font/resource embedding stages; the bundle gate permits only the remaining unreachable clone-video
  poster helper and rejects any additional `fetch()` path. Focused runtime testing proves the
  sanitized capture path does not invoke it.
- The GitHub Actions workflows have been syntax-checked locally but cannot be proven in the GitHub
  runner environment until the repository is pushed.
- GitHub push, Release creation, BRAT distribution, and Community submission remain explicit
  external-publication checkpoints.
