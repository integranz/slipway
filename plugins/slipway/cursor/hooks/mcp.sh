#!/usr/bin/env bash
# Cursor beforeMCPExecution -> slipway guards. Input: {"tool_name","tool_input":"<json string>","mcp_server_name",...}.
# The guards match Claude Code MCP tool names (mcp__<server>__<tool>), so the name is rebuilt from server + tool.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
tool="$(cursor_json tool_name)"; server="$(cursor_json mcp_server_name)"; raw="$(cursor_json tool_input)"
[ -n "$tool" ] || emit deny "could not read the MCP tool name from the hook input (failing closed)"
input="$(python3 -c '
import json,sys
tool,server,raw=sys.argv[1],sys.argv[2],sys.argv[3]
try: ti=json.loads(raw) if raw else {}
except Exception: ti={"raw":raw}
if not isinstance(ti,dict): ti={"value":ti}
name=tool if tool.startswith("mcp__") else "mcp__%s__%s"%(server or "server",tool)
print(json.dumps({"hook_event_name":"PreToolUse","tool_name":name,"tool_input":ti,"permission_mode":"default","host":"cursor"}))' "$tool" "$server" "$raw")"
run_guards "$input" guard-immutable-tags.sh
