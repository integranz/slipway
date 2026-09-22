#!/usr/bin/env bash
# Called by @semantic-release/exec (prepareCmd) with the next version. Writes it into both plugin manifests
# (Claude Code: .claude-plugin/plugin.json, Cursor: .cursor-plugin/plugin.json).
# PLUGIN_MANIFEST may override the manifest path with a single file (used by the CI self-test).
set -euo pipefail
version="${1:?usage: set-plugin-version.sh <semver>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "${PLUGIN_MANIFEST:-}" ]; then manifests=("$PLUGIN_MANIFEST")
else manifests=("$root/plugins/slipway/.claude-plugin/plugin.json" "$root/plugins/slipway/.cursor-plugin/plugin.json"); fi
for manifest in "${manifests[@]}"; do
  [ -f "$manifest" ] || { echo "manifest not found: $manifest" >&2; exit 1; }
  # node -e: extra arguments start at process.argv[1] (there is no script path)
  node -e '
    const fs = require("fs"); const [, file, version] = process.argv;
    const j = JSON.parse(fs.readFileSync(file, "utf8")); j.version = version;
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  ' "$manifest" "$version"
  echo "plugin.json version -> $version ($manifest)"
done
