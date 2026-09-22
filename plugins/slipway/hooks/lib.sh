#!/usr/bin/env bash
# Shared helpers for slipway guard hooks. Sourced by every guard script.
# Contract (Claude Code PreToolUse): read JSON on stdin; exit 0 = no decision (or JSON decision on stdout);
# exit 2 = block, stderr is shown to Claude as the reason. Anything unexpected -> fail closed (exit 2).
set -u
HOOK_INPUT="$(cat || true)"

hook_json() { # $1 = dotted path, e.g. tool_input.command ; prints empty string when absent
  local path="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$HOOK_INPUT" | jq -r --arg p "$path" '
      ($p | split(".")) as $parts
      | reduce $parts[] as $k (.; if type=="object" then .[$k] else null end)
      | if . == null then "" elif type=="string" then . else tojson end' 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$HOOK_INPUT" | python3 -c '
import json,sys
p=sys.argv[1].split("."); d=json.load(sys.stdin)
for k in p:
    d=d.get(k) if isinstance(d,dict) else None
if d is None: print("")
elif isinstance(d,str): print(d)
else: print(json.dumps(d))' "$path" 2>/dev/null || true
  else
    echo "slipway hook: neither jq nor python3 available; failing closed" >&2; exit 2
  fi
}

deny() { # $1 = reason (multi-line ok)
  printf 'slipway guard: BLOCKED\n%s\n' "$1" >&2
  exit 2
}

allow_with_reason() { # $1 = reason ; explicit allow decision
  local r; r="$(printf '%s' "$1" | sed 's/"/\\"/g' | tr '\n' ' ')"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"%s"}}\n' "$r"
  exit 0
}

ask_with_reason() { # $1 = reason shown to the human in the permission prompt ; forces the prompt (also in auto mode)
  local r; r="$(printf '%s' "$1" | sed 's/"/\\"/g' | tr '\n' ' ')"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$r"
  exit 0
}

# A human can answer a permission prompt only in an attended session. Claude Code exports CLAUDE_CODE_SESSION_ATTENDED=1
# to hooks of a terminal session a person is watching (0 for `claude -p`, background jobs and child sessions; measured
# 2026-09-20, not documented, so absence fails safe). bypassPermissions and dontAsk never show a prompt: treat as unattended.
# The Cursor adapter (cursor/hooks/session-start.sh) sets SLIPWAY_SESSION_ATTENDED from Cursor's is_background_agent.
attended() {
  { [ "${CLAUDE_CODE_SESSION_ATTENDED:-0}" = "1" ] || [ "${SLIPWAY_SESSION_ATTENDED:-0}" = "1" ]; } || return 1
  case "$(hook_json permission_mode)" in bypassPermissions|dontAsk) return 1;; esac
  return 0
}

warn_and_continue() { # $1 = message shown to the user, no decision
  local m; m="$(printf '%s' "$1" | sed 's/"/\\"/g' | tr '\n' ' ')"
  printf '{"systemMessage":"slipway guard: %s"}\n' "$m"
  exit 0
}

sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

repo_root() { git -C "${1:-.}" rev-parse --show-toplevel 2>/dev/null || printf '%s' "${1:-.}"; }

# Strip leading VAR=value assignments and `sudo`, collapse whitespace.
normalize_cmd() { printf '%s' "$1" | sed -E 's/^([[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*//; s/^[[:space:]]*sudo[[:space:]]+//' | tr -s '[:space:]' ' '; }
