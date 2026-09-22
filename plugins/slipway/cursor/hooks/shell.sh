#!/usr/bin/env bash
# Cursor beforeShellExecution -> slipway guards. Input: {"command","cwd","sandbox",...}.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cmd="$(cursor_json command)"; cwd="$(cursor_json cwd)"; [ -n "$cwd" ] || cwd="$PWD"
[ -n "$cmd" ] || emit deny "could not read the shell command from the hook input (failing closed)"
input="$(python3 -c '
import json,sys
print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":sys.argv[1]},"cwd":sys.argv[2],
                  "permission_mode":"default","session_id":sys.argv[3],"host":"cursor"}))' "$cmd" "$cwd" "$(cursor_json conversation_id)")"
run_guards "$input" unattended:guard-terraform-apply.sh guard-secrets-and-state.sh guard-immutable-tags.sh guard-admin-actions.sh
