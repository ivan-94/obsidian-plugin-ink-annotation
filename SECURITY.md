# Security Policy

## Supported versions

Inkstone Annotations is preparing its first public Beta. Until a GitHub Release is published, no
commit on `main` should be treated as a supported production build.

After publication, security and data-loss fixes will target the latest released version. Older
versions may require upgrading before a fix can be applied.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** flow to submit a private report.

If private vulnerability reporting is unavailable, open a minimal GitHub issue asking the maintainer
to establish a private contact channel. Do not include exploit details, private note content,
sidecars, screenshots, credentials, or Vault paths in that public issue.

Include when possible:

- the affected Inkstone and Obsidian versions;
- platform and device class;
- whether the issue affects confidentiality, integrity, availability, or canonical annotation data;
- minimal reproduction steps using synthetic data;
- whether a workaround exists.

The maintainer will acknowledge a valid private report, assess severity and supported versions, and
coordinate disclosure after a fix or mitigation is available.

## Security and privacy boundaries

- Canonical annotation data and Snapshot images stay inside the user's Vault.
- The plugin has no account, telemetry, ads, or external service.
- Snapshot images can contain sensitive note content.
- User-selected sync and backup providers remain outside Inkstone's trust boundary.
- A successful local write is not evidence that another device has received the data.

See [Data Safety](docs/data-safety.md) for the persistence and recovery model.
