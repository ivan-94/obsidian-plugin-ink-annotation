#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
vault_root="$repo_root/test-fixtures/vault"
plugin_root="$vault_root/.obsidian/plugins/inkstone-annotations"
fixture_source="$script_dir/fixtures/source-projection-hat.md"
fixture_target="$vault_root/Source Projection HAT.md"
command="${1:-info}"

print_summary() {
  local status="$1"
  cat <<EOF
HAT_PREPARE_SUMMARY
mode=attach
status=$status
app_url=obsidian://open?path=$vault_root/Source%20Projection%20HAT.md
database=not-applicable
schema_version=text-sidecar-v1
seed_records=source-projection-note:1
cleanup=$script_dir/prepare.sh cleanup
guide=$script_dir/hat-guide.md
END_HAT_PREPARE_SUMMARY
EOF
}

case "$command" in
  info)
    printf 'repo_root=%s\nvault_root=%s\nplugin_root=%s\n' \
      "$repo_root" "$vault_root" "$plugin_root"
    print_summary "not-run"
    ;;
  prepare)
    mkdir -p "$vault_root"
    if [[ ! -f "$fixture_target" ]]; then
      cp "$fixture_source" "$fixture_target"
    fi
    cd "$repo_root"
    npm run build
    INKSTONE_VAULT="$vault_root" npm run install:dev
    test -f "$fixture_target"
    test -f "$plugin_root/main.js"
    print_summary "prepared"
    ;;
  cleanup)
    rm -f \
      "$plugin_root/main.js" \
      "$plugin_root/manifest.json" \
      "$plugin_root/styles.css"
    print_summary "cleaned"
    ;;
  *)
    printf 'Usage: %s {info|prepare|cleanup}\n' "$0" >&2
    exit 2
    ;;
esac
