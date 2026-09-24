#!/usr/bin/env bash
# Installs or refreshes the slipway plugin for Cursor on this machine:
#   1. copies plugins/slipway to ~/.cursor/plugins/local/slipway (cursor.com/docs/plugins, "Test plugins locally");
#   2. registers the guard hooks in the user hooks file ~/.cursor/hooks.json (merged; other entries are kept) through a
#      small shim at ~/.cursor/slipway/cursor-hooks.sh that finds the plugin wherever Cursor keeps it (local folder,
#      marketplace cache, Claude Code cache). The entries therefore survive a plugin refresh or the removal of the local
#      folder from Cursor's UI; without any plugin copy the shim allows and warns at session start instead of failing
#      closed. Cursor 3.21 loads plugin hooks only when third-party plugin import is enabled, so this is the fallback.
# Cursor watches its hook configuration and reloads it; reload the window ("Developer: Reload Window") for the plugin
# components (skills, rules, subagents, MCP servers). Cursor Teams: the admin setting "Allow Local Plugin Imports" must
# be on for the plugin folder; the hooks file works regardless.
# Options: --no-hooks (folder only) | --uninstall (remove the folder and the hook entries)
# Overrides for tests: CURSOR_PLUGINS_LOCAL (folder), CURSOR_USER_HOOKS (hooks file), CURSOR_USER_SHIM_DIR (shim folder)
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/plugins/slipway"
dest="${CURSOR_PLUGINS_LOCAL:-$HOME/.cursor/plugins/local}/slipway"
hooks_file="${CURSOR_USER_HOOKS:-$HOME/.cursor/hooks.json}"
shim_dir="${CURSOR_USER_SHIM_DIR:-$HOME/.cursor/slipway}"
mode=install; hooks=1
for a in "$@"; do case "$a" in --no-hooks) hooks=0;; --uninstall) mode=uninstall;; *) echo "unknown option: $a" >&2; exit 2;; esac; done

merge_hooks() { # $1 = install|uninstall ; rewrites $hooks_file keeping foreign entries
  node -e '
    const fs = require("fs"); const [, file, shim, mode] = process.argv;
    const markers = ["/slipway/cursor/hooks/", "/cursor-hooks.sh\" "]; // old direct entries and the shim entries
    const ours = (h) => h && typeof h.command === "string" && markers.some((m) => h.command.includes(m));
    let cfg = { version: 1, hooks: {} };
    if (fs.existsSync(file)) { try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`${file} is not valid JSON; fix or remove it first`); process.exit(1); } }
    cfg.version = cfg.version || 1; cfg.hooks = cfg.hooks || {};
    for (const ev of Object.keys(cfg.hooks)) {
      cfg.hooks[ev] = (cfg.hooks[ev] || []).filter((h) => !ours(h));
      if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
    }
    if (mode === "install") {
      const cmd = (name) => `bash "${shim}/cursor-hooks.sh" ${name}`;
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
    const n = Object.values(cfg.hooks).flat().filter(ours).length;
    console.log(`${file}: ${n} slipway hook entr${n === 1 ? "y" : "ies"} (${mode})`);
  ' "$hooks_file" "$shim_dir" "$1"
}

if [ "$mode" = uninstall ]; then
  rm -rf "$dest"; echo "removed $dest"
  [ -f "$hooks_file" ] && merge_hooks uninstall
  rm -rf "$shim_dir"; echo "removed $shim_dir"
  exit 0
fi
[ -f "$src/.cursor-plugin/plugin.json" ] || { echo "not a Cursor plugin: $src" >&2; exit 1; }
mkdir -p "$dest"
rsync -a --delete --exclude node_modules "$src/" "$dest/"
version="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$dest/.cursor-plugin/plugin.json")"
echo "slipway $version installed -> $dest"
if [ "$hooks" = 1 ]; then
  mkdir -p "$shim_dir"
  cp "$src/templates/common/files/.slipway/cursor-hooks.sh.tmpl" "$shim_dir/cursor-hooks.sh" && chmod +x "$shim_dir/cursor-hooks.sh"
  echo "shim: $shim_dir/cursor-hooks.sh (finds the plugin in the local folder, the marketplace cache or the Claude Code cache)"
  merge_hooks install
else echo "hooks: skipped (--no-hooks)"; fi
echo "Cursor reloads hooks.json by itself; reload the window for the plugin components. Then ask an Agent session to run in the terminal: echo approve-apply-probe && date  -> must be blocked (slipway guard: ...)"
