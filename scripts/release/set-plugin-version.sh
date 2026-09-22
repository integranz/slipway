#!/usr/bin/env bash
# Called by @semantic-release/exec (prepareCmd) with the next version. Writes it into plugin.json.
# PLUGIN_MANIFEST may override the manifest path (used by the CI self-test).
set -euo pipefail
version="${1:?usage: set-plugin-version.sh <semver>}"
manifest="${PLUGIN_MANIFEST:-$(cd "$(dirname "$0")/../.." && pwd)/plugins/slipway/.claude-plugin/plugin.json}"
[ -f "$manifest" ] || { echo "manifest not found: $manifest" >&2; exit 1; }
# node -e: extra arguments start at process.argv[1] (there is no script path)
node -e '
  const fs = require("fs"); const [, file, version] = process.argv;
  const j = JSON.parse(fs.readFileSync(file, "utf8")); j.version = version;
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
' "$manifest" "$version"
echo "plugin.json version -> $version ($manifest)"
