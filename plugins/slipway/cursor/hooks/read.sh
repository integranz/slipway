#!/usr/bin/env bash
# Cursor beforeReadFile -> slipway guards. Input: {"file_path","content","attachments"}. Output allow|deny only.
ASK_PERMISSION=deny
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
f="$(cursor_json file_path)"
[ -n "$f" ] || emit deny "could not read the file path from the hook input (failing closed)"
input="$(python3 -c '
import json,sys
print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":sys.argv[1]},"permission_mode":"default","host":"cursor"}))' "$f")"
run_guards "$input" guard-admin-actions.sh
