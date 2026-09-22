#!/usr/bin/env bash
# Cursor preToolUse (matcher: write/edit tools) -> guard-secrets-and-state.sh. Input: {"tool_name","tool_input":{...},"cwd"}.
# Kept for hooks.json files that route only edit tools here; pretooluse.sh covers every tool.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
tool="$(cursor_json tool_name)"
case "$tool" in Write|Edit|StrReplace|MultiEdit|edit_file|search_replace|write_file|write|edit) ;; *) emit allow "";; esac
decide_write "$(cursor_json tool_input)" "$(effective_cwd)"
