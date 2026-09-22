#!/usr/bin/env bash
# Installs or refreshes the slipway plugin for local testing in Cursor: ~/.cursor/plugins/local/slipway
# (cursor.com/docs/plugins, "Test plugins locally", read 2026-09-22). Cursor discovers plugins in that folder after
# "Developer: Reload Window" when local plugin imports are allowed (Teams: admin setting "Allow Local Plugin Imports").
# Re-run after every change to plugins/slipway. Remove with: rm -rf ~/.cursor/plugins/local/slipway
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/plugins/slipway"
dest="${CURSOR_PLUGINS_LOCAL:-$HOME/.cursor/plugins/local}/slipway"
[ -f "$src/.cursor-plugin/plugin.json" ] || { echo "not a Cursor plugin: $src" >&2; exit 1; }
mkdir -p "$dest"
rsync -a --delete --exclude node_modules "$src/" "$dest/"
version="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$dest/.cursor-plugin/plugin.json")"
echo "slipway $version installed -> $dest"
echo "Cursor: run 'Developer: Reload Window', then open Settings -> Plugins (or Customize) and confirm slipway's skills, rules, subagents, hooks and MCP servers."
