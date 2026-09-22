#!/usr/bin/env bash
# Installs or refreshes the slipway plugin for Cursor on this machine:
#   1. copies plugins/slipway to ~/.cursor/plugins/local/slipway (cursor.com/docs/plugins, "Test plugins locally");
#   2. registers the guard hook adapters in the user hooks file ~/.cursor/hooks.json (merged; other entries are kept),
#      because Cursor 3.21.x loads hooks from the user/project/team/enterprise sources, not from an installed plugin.
# Cursor watches its hook configuration and reloads it; reload the window ("Developer: Reload Window") for the plugin
# components (skills, rules, subagents, MCP servers). Cursor Teams: the admin setting "Allow Local Plugin Imports" must
# be on for the plugin folder; the hooks file works regardless.
# Options: --no-hooks (folder only) | --uninstall (remove the folder and the hook entries)
# Overrides for tests: CURSOR_PLUGINS_LOCAL (folder), CURSOR_USER_HOOKS (hooks file)
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/plugins/slipway"
dest="${CURSOR_PLUGINS_LOCAL:-$HOME/.cursor/plugins/local}/slipway"
hooks_file="${CURSOR_USER_HOOKS:-$HOME/.cursor/hooks.json}"
mode=install; hooks=1
for a in "$@"; do case "$a" in --no-hooks) hooks=0;; --uninstall) mode=uninstall;; *) echo "unknown option: $a" >&2; exit 2;; esac; done

merge_hooks() { # $1 = install|uninstall ; rewrites $hooks_file keeping foreign entries
  node -e '
    const fs = require("fs"); const [, file, dest, mode] = process.argv;
    const marker = "/slipway/cursor/hooks/";
    let cfg = { version: 1, hooks: {} };
    if (fs.existsSync(file)) { try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`${file} is not valid JSON; fix or remove it first`); process.exit(1); } }
    cfg.version = cfg.version || 1; cfg.hooks = cfg.hooks || {};
    for (const ev of Object.keys(cfg.hooks)) {
      cfg.hooks[ev] = (cfg.hooks[ev] || []).filter((h) => !(h && typeof h.command === "string" && h.command.includes(marker)));
      if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
    }
    if (mode === "install") {
      const cmd = (name) => `bash "${dest}/cursor/hooks/${name}.sh"`;
      const ours = {
        sessionStart: [{ command: cmd("session-start"), timeout: 10 }],
        preToolUse: [{ command: cmd("pretooluse"), timeout: 30, failClosed: true }],
        beforeShellExecution: [{ command: cmd("shell"), timeout: 30, failClosed: true }],
        beforeMCPExecution: [{ command: cmd("mcp"), timeout: 15, failClosed: true }],
        beforeReadFile: [{ command: cmd("read"), timeout: 10, failClosed: true }],
      };
      for (const [ev, defs] of Object.entries(ours)) cfg.hooks[ev] = [...(cfg.hooks[ev] || []), ...defs];
    }
    fs.mkdirSync(require("path").dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    const n = Object.values(cfg.hooks).flat().filter((h) => h.command && h.command.includes(marker)).length;
    console.log(`${file}: ${n} slipway hook entr${n === 1 ? "y" : "ies"} (${mode})`);
  ' "$hooks_file" "$dest" "$1"
}

if [ "$mode" = uninstall ]; then
  rm -rf "$dest"; echo "removed $dest"
  [ -f "$hooks_file" ] && merge_hooks uninstall
  exit 0
fi
[ -f "$src/.cursor-plugin/plugin.json" ] || { echo "not a Cursor plugin: $src" >&2; exit 1; }
mkdir -p "$dest"
rsync -a --delete --exclude node_modules "$src/" "$dest/"
version="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$dest/.cursor-plugin/plugin.json")"
echo "slipway $version installed -> $dest"
if [ "$hooks" = 1 ]; then merge_hooks install; else echo "hooks: skipped (--no-hooks)"; fi
echo "Cursor reloads hooks.json by itself; reload the window for the plugin components. Then ask an Agent session to run in the terminal: echo approve-apply-probe && date  -> must be blocked (slipway guard: ...)"
