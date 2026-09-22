#!/usr/bin/env bash
# Cursor preToolUse (all tools) -> slipway guards, dispatched by tool_name. This is the event Cursor 3.21.16 fires for
# the shell tool ({"tool_name":"Shell","tool_input":{"command","cwd","timeout"},...}); the other tool shapes are not
# documented, so paths and contents are looked up under their usual names and unknown tools are allowed.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
tool="$(cursor_json tool_name)"
case "$tool" in
  Shell|Bash|shell|run_terminal_cmd|terminal|RunCommand)
    decide_shell "$(first_of tool_input.command command)" "$(effective_cwd)";;
  Read|read_file|ReadFile|read)
    decide_read "$(first_of tool_input.file_path tool_input.path tool_input.target_file tool_input.relative_workspace_path file_path)" 0;;
  Write|Edit|StrReplace|MultiEdit|edit_file|search_replace|write_file|write|edit)
    decide_write "$(cursor_json tool_input)" "$(effective_cwd)";;
  *actions_run_trigger*|*run_workflow*)
    decide_mcp "$tool" "$(cursor_json tool_input)" "$(cursor_json mcp_server_name)";;
  *) emit allow "";;
esac
