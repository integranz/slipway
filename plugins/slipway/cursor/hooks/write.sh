#!/usr/bin/env bash
# Cursor preToolUse (matcher: write/edit tools) -> guard-secrets-and-state.sh. Input: {"tool_name","tool_input":{...},"cwd"}.
# Cursor does not document the edit tools' input keys, so the usual names for the path and the new content are tried.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
tool="$(cursor_json tool_name)"
case "$tool" in Write|Edit|StrReplace|MultiEdit|edit_file|search_replace|write_file|write|edit) ;; *) emit allow "";; esac
ti="$(cursor_json tool_input)"; cwd="$(cursor_json cwd)"; [ -n "$cwd" ] || cwd="$PWD"
input="$(python3 -c '
import json,sys
raw,cwd=sys.argv[1],sys.argv[2]
try: ti=json.loads(raw) if raw else {}
except Exception: ti={}
if not isinstance(ti,dict): ti={}
f=next((ti[k] for k in ("file_path","path","target_file","filePath","relative_workspace_path","file") if isinstance(ti.get(k),str)),"")
c=next((ti[k] for k in ("content","contents","code_edit","new_string","new_str","text","replacement") if isinstance(ti.get(k),str)),"")
print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":f,"content":c},"cwd":cwd,"permission_mode":"default","host":"cursor"}))' "$ti" "$cwd")"
run_guards "$input" guard-secrets-and-state.sh
