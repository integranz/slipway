#!/usr/bin/env bash
# Cursor beforeShellExecution -> slipway guards. Input: {"command","cwd","sandbox",...}.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
decide_shell "$(first_of command tool_input.command)" "$(effective_cwd)"
