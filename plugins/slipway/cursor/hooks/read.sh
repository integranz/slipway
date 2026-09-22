#!/usr/bin/env bash
# Cursor beforeReadFile -> slipway guards. Input: {"file_path","content","attachments"}. Output allow|deny only.
export ASK_PERMISSION=deny # read by common.sh (beforeReadFile has no "ask")
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
decide_read "$(cursor_json file_path)" 1
