#!/usr/bin/env bash
# slipway <-> Cursor hook adapter: shared helpers, sourced by shell.sh, mcp.sh, read.sh, write.sh and session-start.sh.
#
# Cursor contract (cursor.com/docs/hooks and /docs/reference/hooks, read 2026-09-22): the hook reads one JSON object on
# stdin and prints one JSON object on stdout: {"permission":"allow"|"deny"|"ask","user_message":..,"agent_message":..}.
# Exit code 2 also blocks. Any other failure (crash, timeout, bad JSON) is fail-OPEN unless the hook is declared with
# "failClosed": true, which ../hooks.json does for every blocking hook. This adapter never relies on that: every error
# path prints an explicit deny.
#
# The guard scripts in ../../hooks implement the Claude Code PreToolUse contract (stdin JSON with tool_name/tool_input/
# cwd; exit 2 = block with the reason on stderr; or a {"hookSpecificOutput":{"permissionDecision":..}} line on stdout).
# The adapter builds that input from the Cursor input, runs the guards unchanged and translates the decision back.
# Policy differences in Cursor (recorded in docs/HOOKS.md):
#   - "ask" cannot be relied on: Cursor documents it as accepted but not enforced for preToolUse and says nothing about
#     enforcement for the other events. Administrative actions still return "ask" (a non-enforcing Cursor falls back to
#     its own command approval). `terraform apply` never does: the guard is run in unattended mode so a local apply
#     always needs the human approval token (scripts/approve-apply.sh), whatever the user's auto-run setting.
#   - Cursor subagents get no agent_type in hook input; explore and verify are read-only through `readonly: true`
#     in cursor/agents/*.md instead of guard-readonly-agents.sh.
set -u
CURSOR_INPUT="$(cat || true)"
ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_ROOT="$(cd "$ADAPTER_DIR/../.." && pwd -P)"
GUARDS="${SLIPWAY_GUARDS_DIR:-$PLUGIN_ROOT/hooks}"
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}"
export SLIPWAY_HOST=cursor
ASK_PERMISSION="${ASK_PERMISSION:-ask}" # read.sh sets deny: beforeReadFile has no "ask"
ERR_FILE="$(mktemp 2>/dev/null || printf '/tmp/slipway-cursor-hook.%s' "$$")"
trap 'rm -f "$ERR_FILE"' EXIT

if ! command -v python3 >/dev/null 2>&1; then
  printf '{"permission":"deny","user_message":"slipway guard adapter: python3 is required (failing closed)","agent_message":"slipway guard adapter: python3 is required (failing closed)"}\n'
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

emit() { # $1 = permission, $2 = message for the user and the agent ("" = none); prints the Cursor decision and exits 0
  python3 -c '
import json,sys
p,m=sys.argv[1],sys.argv[2]
o={"permission":p}
if m: o["user_message"]="slipway guard: "+m; o["agent_message"]="slipway guard: "+m
print(json.dumps(o))' "$1" "$2"
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
