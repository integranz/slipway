#!/usr/bin/env bash
# slipway <-> Cursor hook adapter: shared helpers, sourced by pretooluse.sh, shell.sh, mcp.sh, read.sh, write.sh and
# session-start.sh.
#
# Cursor contract (cursor.com/docs/hooks and /docs/reference/hooks, read 2026-09-22): the hook reads one JSON object on
# stdin and prints one JSON object on stdout: {"permission":"allow"|"deny"|"ask","user_message":..,"agent_message":..}.
# Exit code 2 also blocks. Any other failure (crash, timeout, bad JSON) is fail-OPEN unless the hook is declared with
# "failClosed": true, which every slipway hooks.json does for the blocking hooks. This adapter never relies on that:
# every error path prints an explicit deny.
#
# Live finding (Cursor 3.21.16, 2026-09-22, Hooks output channel): this Cursor loads hooks from the enterprise, team,
# project (.cursor/hooks.json), user (~/.cursor/hooks.json) and Claude settings sources only, not from an installed
# plugin, and the shell tool arrives as a generic preToolUse event: {"tool_name":"Shell","tool_input":{"command","cwd":"",
# "timeout"},"cwd":"","workspace_roots":[...],"conversation_id",...}. So the adapters accept both the event-specific
# inputs and the preToolUse shape (pretooluse.sh dispatches by tool_name), and the same decision is cached for a few
# seconds so that a command reaching two hooks (preToolUse and beforeShellExecution) is judged once: the apply guard
# consumes the approval token on allow, and a second run would otherwise deny an approved apply.
#
# The guard scripts in ../../hooks implement the Claude Code PreToolUse contract (stdin JSON with tool_name/tool_input/
# cwd; exit 2 = block with the reason on stderr; or a {"hookSpecificOutput":{"permissionDecision":..}} line on stdout).
# The adapter builds that input from the Cursor input, runs the guards unchanged and translates the decision back.
# Policy differences in Cursor (recorded in docs/HOOKS.md §6):
#   - "ask" is returned for administrative actions and, since 1.4.0, for the foundation apply too: observed live in
#     Cursor 3.21.16 (2026-09-24), Cursor prompts the user and proceeds on approval, exactly like Claude Code.
#     options.apply_gate: token keeps the human-made token mandatory (auto-run setups, shared machines).
#   - A Cursor IDE session is interactive, so the attended marker defaults to 1 unless the session-start hook reported
#     a background agent (SLIPWAY_SESSION_ATTENDED=0). The marker only affects whether admin actions ask or deny.
#   - Cursor subagents get no agent_type in hook input; explore and verify are read-only through `readonly: true`
#     in cursor/agents/*.md instead of guard-readonly-agents.sh.
set -u
CURSOR_INPUT="$(cat || true)"
ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ROOT="$(cd "$ADAPTER_DIR/../.." && pwd -P)"
GUARDS="${SLIPWAY_GUARDS_DIR:-$PLUGIN_ROOT/hooks}"
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}"
export SLIPWAY_HOST=cursor
[ -n "${SLIPWAY_SESSION_ATTENDED:-}" ] || export SLIPWAY_SESSION_ATTENDED=1
ASK_PERMISSION="${ASK_PERMISSION:-ask}" # read.sh sets deny: beforeReadFile has no "ask"
CACHE_DIR="${SLIPWAY_CURSOR_CACHE:-${TMPDIR:-/tmp}/slipway-cursor-hooks}"
CACHE_TTL="${SLIPWAY_CURSOR_CACHE_TTL:-3}" # seconds: long enough for two hooks of one tool call, too short for a retry
CACHE_KEY=""
ERR_FILE="$(mktemp 2>/dev/null || printf '/tmp/slipway-cursor-hook.%s' "$$")"
trap 'rm -f "$ERR_FILE"' EXIT

if ! command -v python3 >/dev/null 2>&1; then
  printf '{"permission":"deny","user_message":"slipway guard: python3 is required by the Cursor hook adapter (failing closed)","agent_message":"slipway guard: python3 is required by the Cursor hook adapter (failing closed)"}\n'
  exit 0
fi

cursor_json() { # $1 = dotted path into the Cursor input; "" when absent; strings raw, booleans true/false, objects as JSON
  printf '%s' "$CURSOR_INPUT" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
for k in sys.argv[1].split("."):
    d=d.get(k) if isinstance(d,dict) else None
if d is None: print("")
elif isinstance(d,bool): print("true" if d else "false")
elif isinstance(d,str): print(d)
else: print(json.dumps(d))' "$1" 2>/dev/null || true
}

first_of() { # first non-empty value among dotted paths
  local p v; for p in "$@"; do v="$(cursor_json "$p")"; [ -n "$v" ] && { printf '%s' "$v"; return; }; done; printf ''
}

effective_cwd() { # Cursor sends cwd "" for the workspace root; fall back to workspace_roots[0], then to our own cwd
  local c; c="$(first_of cwd tool_input.cwd tool_input.working_directory)"
  [ -n "$c" ] || c="$(cursor_json workspace_roots | python3 -c 'import json,sys
try: a=json.load(sys.stdin); print(a[0] if isinstance(a,list) and a else "")
except Exception: print("")' 2>/dev/null)"
  [ -n "$c" ] || c="$PWD"; printf '%s' "$c"
}

cache_key() { printf '%s' "$1" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-40; }
replay_cached() { # $1 = key: print and exit when a fresh decision exists for the same tool call
  local f="$CACHE_DIR/$1" now mtime
  [ -f "$f" ] || return 0
  # GNU stat first (-c %Y); BSD/macOS stat second (-f %m). On Linux `stat -f` succeeds with file-system info, so the
  # order matters. A non-numeric result is treated as expired.
  now="$(date +%s)"; mtime="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)"
  case "$mtime" in ''|*[!0-9]*) mtime=0;; esac
  if [ $(( now - mtime )) -le "$CACHE_TTL" ]; then cat "$f"; exit 0; fi
  rm -f "$f"; return 0
}

emit() { # $1 = permission, $2 = message for the user and the agent ("" = none); prints the Cursor decision and exits 0
  local out; out="$(python3 -c '
import json,sys
p,m=sys.argv[1],sys.argv[2]
o={"permission":p}
if m: o["user_message"]="slipway guard: "+m; o["agent_message"]="slipway guard: "+m
print(json.dumps(o))' "$1" "$2")"
  if [ -n "$CACHE_KEY" ]; then mkdir -p "$CACHE_DIR" 2>/dev/null && printf '%s\n' "$out" > "$CACHE_DIR/$CACHE_KEY" 2>/dev/null; fi
  printf '%s\n' "$out"
  exit 0
}

# run_guards <claude-style input JSON> <guard>...
# Each guard may be prefixed "unattended:" to run without the attended-session markers (forces the token path).
# The first deny wins; an "ask" is remembered and returned after all guards passed; otherwise allow.
run_guards() {
  local input="$1"; shift
  local ask_reason="" g out rc decision perm reason tab=$'\t'
  for g in "$@"; do
    local -a runner=(bash)
    case "$g" in unattended:*) g="${g#unattended:}"; runner=(env -u SLIPWAY_SESSION_ATTENDED -u CLAUDE_CODE_SESSION_ATTENDED bash);; esac
    [ -f "$GUARDS/$g" ] || emit deny "guard script missing: $g (failing closed)"
    out="$(printf '%s' "$input" | "${runner[@]}" "$GUARDS/$g" 2>"$ERR_FILE")"; rc=$?
    if [ "$rc" -eq 2 ]; then emit deny "$(sed '1{/^slipway guard: BLOCKED$/d;}' "$ERR_FILE")"; fi
    if [ "$rc" -ne 0 ]; then emit deny "$g failed with exit $rc (failing closed): $(head -c 400 "$ERR_FILE")"; fi
    decision="$(printf '%s' "$out" | python3 -c '
import json,sys
for line in sys.stdin.read().splitlines():
    try: o=json.loads(line)
    except Exception: continue
    h=o.get("hookSpecificOutput",{}) if isinstance(o,dict) else {}
    if h.get("permissionDecision"):
        print(h["permissionDecision"]+"\t"+h.get("permissionDecisionReason","")); break' 2>/dev/null)"
    perm="${decision%%"$tab"*}"; reason="${decision#*"$tab"}"
    case "$perm" in
      deny) emit deny "$reason";;
      ask) [ -n "$ask_reason" ] || ask_reason="$reason";;
    esac
  done
  [ -z "$ask_reason" ] || emit "$ASK_PERMISSION" "$ask_reason"
  emit allow ""
}

claude_input() { # $1 tool_name, $2 tool_input JSON, $3 cwd -> Claude Code PreToolUse input
  python3 -c '
import json,sys
tool,raw,cwd=sys.argv[1],sys.argv[2],sys.argv[3]
try: ti=json.loads(raw) if raw else {}
except Exception: ti={"raw":raw}
if not isinstance(ti,dict): ti={"value":ti}
print(json.dumps({"hook_event_name":"PreToolUse","tool_name":tool,"tool_input":ti,"cwd":cwd,"permission_mode":"default","host":"cursor"}))' "$1" "$2" "$3"
}

# ---- decisions (shared by the event-specific adapters and the preToolUse dispatcher) ----
decide_shell() { # $1 command, $2 cwd
  [ -n "$1" ] || emit deny "could not read the shell command from the hook input (failing closed)"
  CACHE_KEY="$(cache_key "shell|$(cursor_json conversation_id)|$2|$1")"; replay_cached "$CACHE_KEY"
  run_guards "$(claude_input Bash "$(python3 -c 'import json,sys; print(json.dumps({"command":sys.argv[1]}))' "$1")" "$2")" \
    guard-terraform-apply.sh guard-secrets-and-state.sh guard-immutable-tags.sh guard-admin-actions.sh
}
decide_read() { # $1 file path, $2 strict (1 = deny when the path is unknown; 0 = allow, the input shape is undocumented)
  if [ -z "$1" ]; then [ "$2" = 1 ] && emit deny "could not read the file path from the hook input (failing closed)"; emit allow ""; fi
  CACHE_KEY="$(cache_key "read|$(cursor_json conversation_id)|$1")"; replay_cached "$CACHE_KEY"
  ASK_PERMISSION=deny run_guards "$(claude_input Read "$(python3 -c 'import json,sys; print(json.dumps({"file_path":sys.argv[1]}))' "$1")" "$PWD")" guard-admin-actions.sh
}
decide_write() { # $1 tool_input JSON (Cursor does not document the edit tools' keys; the usual names are tried), $2 cwd
  local norm; norm="$(python3 -c '
import json,sys
raw=sys.argv[1]
try: ti=json.loads(raw) if raw else {}
except Exception: ti={}
if not isinstance(ti,dict): ti={}
f=next((ti[k] for k in ("file_path","path","target_file","filePath","relative_workspace_path","file") if isinstance(ti.get(k),str)),"")
c=next((ti[k] for k in ("content","contents","code_edit","new_string","new_str","text","replacement") if isinstance(ti.get(k),str)),"")
print(json.dumps({"file_path":f,"content":c}))' "$1")"
  CACHE_KEY="$(cache_key "write|$(cursor_json conversation_id)|$norm")"; replay_cached "$CACHE_KEY"
  run_guards "$(claude_input Write "$norm" "$2")" guard-secrets-and-state.sh
}
decide_mcp() { # $1 tool name, $2 tool_input (JSON string or object), $3 server name
  [ -n "$1" ] || emit deny "could not read the MCP tool name from the hook input (failing closed)"
  local name="$1"; case "$name" in mcp__*) ;; *) name="mcp__${3:-server}__$1";; esac
  CACHE_KEY="$(cache_key "mcp|$(cursor_json conversation_id)|$name|$2")"; replay_cached "$CACHE_KEY"
  run_guards "$(claude_input "$name" "$2" "$PWD")" guard-immutable-tags.sh
}
