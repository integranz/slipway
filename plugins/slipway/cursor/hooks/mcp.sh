#!/usr/bin/env bash
# Cursor beforeMCPExecution -> slipway guards. Input: {"tool_name","tool_input":"<json string>","mcp_server_name",...}.
# The guards match Claude Code MCP tool names (mcp__<server>__<tool>), so the name is rebuilt from server + tool.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
decide_mcp "$(cursor_json tool_name)" "$(cursor_json tool_input)" "$(cursor_json mcp_server_name)"
