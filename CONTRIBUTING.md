# Contributing to Inkstone Annotations

Thanks for helping improve Inkstone Annotations. The project treats annotation sidecars as user
data, so behavior and persistence changes need stronger evidence than ordinary UI polish.

## Before you start

Read:

- [AGENTS.md](AGENTS.md) for repository rules and architecture boundaries;
- [CONTEXT.md](CONTEXT.md) for domain language;
- the relevant file under [`docs/specs/`](docs/specs/);
- the relevant delivery evidence under `docs/delivery/slices/` when it is available locally.

Open an issue before starting a large feature, schema migration, new network integration, telemetry,
or a change that can make existing sidecars unreadable.

## Development setup

Requirements:

- Node.js 20.19 or newer;
- npm;
- a disposable Obsidian Vault for manual testing.

```bash
npm ci
npm run check
npm run install:dev
```

Set `INKSTONE_VAULT` to install into a different development Vault. Never point automated tests at a
personal or production Vault.

## Development workflow

Use a vertical test-driven cycle for behavior changes:

1. Add one observable failing test.
2. Implement the smallest change that makes it pass.
3. Refactor only while the test suite is green.
4. Run focused tests, then `npm run check`.
5. Add manual acceptance evidence when DOM, mobile input, capture fidelity, accessibility, or
   Obsidian lifecycle behavior cannot be proven by unit tests.

Respect these boundaries:

- `src/domain/` has no Obsidian or DOM imports.
- `src/application/` coordinates domain ports and performs no direct file or DOM access.
- `src/storage/` owns sidecar codecs and repository implementations.
- `src/adapters/obsidian/` owns Obsidian integration.
- `src/ui/` never writes sidecars directly.
- Sidecars are canonical; indexes, summaries, thumbnails, and caches are disposable.

## Data-safety rules

- Never persist a DOM `Range`.
- Ambiguous targets fail closed and remain recoverable.
- Never discard unsaved Ink after persistence failure.
- Never claim sync completion from a successful local write.
- Do not add telemetry or an external service without a new explicit product decision.
- Do not include real note contents, personal Vault paths, credentials, or private sidecars in
  tests, screenshots, issues, or pull requests.

## Pull requests

A pull request should include:

- the user-visible motivation;
- the scope and explicit non-goals;
- tests and manual acceptance performed;
- data, schema, compatibility, and rollback impact;
- a Source Manifest linking the original issue/spec and verification evidence.

Do not commit generated `main.js`, `coverage/`, `dist/`, local Vault state, or release packages.

## Releases

Only maintainers publish releases. A release tag must be exact SemVer `x.y.z` and match
`manifest.json`, `package.json`, `package-lock.json`, and `versions.json`.

```bash
npm run package:rc
npm run verify:release-tag -- 0.1.0
```

See the [production release specification](docs/specs/2026-07-24-production-market-release.md) for
the complete release gate.
