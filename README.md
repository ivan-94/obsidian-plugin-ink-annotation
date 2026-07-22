# Inkstone Annotations

Inkstone Annotations is an Obsidian plugin for text annotations over mutable Markdown and freehand
markup over stable, Vault-local snapshots.

The project is under active development. The canonical product and execution specifications live in
the adjacent AI Wiki workspace.

## Development

Requirements: Node.js 20.19 or newer and npm.

```bash
npm install
npm run check
npm run install:dev
```

`npm run install:dev` installs the built plugin into `test-fixtures/vault` by default. Set
`INKSTONE_VAULT` to install into another development Vault.

## Privacy

The plugin has no telemetry or external service. Optional diagnostics retain only local timing
samples and never include annotation text, ink points, or file paths.

## Portability and removal

Canonical annotations are stored separately from Markdown under the Vault's hidden
`.obsidian-annotations/` directory. Disabling or uninstalling the plugin does not delete those
sidecars, but Obsidian cannot dynamically render them without the plugin.

Use Export from an annotation Inspector, the Current file sidebar, or Entire Vault results to create
independent Markdown or HTML files under `Inkstone Exports/`. Available text formats are a
standalone Markdown report, plain Markdown highlights, Markdown footnotes, and HTML marks. Plain
Markdown has no portable underline syntax, so underline exports retain the quote and explicit type
metadata instead of pretending the formatting is lossless. Existing exports are never overwritten; a
numeric suffix is chosen on collision.

See [User Guide](docs/user-guide.md), [Data Safety](docs/data-safety.md), and
[Known Limitations](docs/known-limitations.md) before using a release candidate with important
Vaults.
