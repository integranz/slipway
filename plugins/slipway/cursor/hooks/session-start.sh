#!/usr/bin/env bash
# Cursor sessionStart: tells the agent where the plugin lives (skills say ${CLAUDE_PLUGIN_ROOT}) and marks the session
# attended or not for the other adapters. Input: {"session_id","is_background_agent","composer_mode"}.
# Output: {"env":{...},"additional_context":"..."}; env is available to later hook executions in this session.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
bg="$(cursor_json is_background_agent)"; attended=1; [ "$bg" = "true" ] && attended=0
ctx="slipway plugin root: $PLUGIN_ROOT
slipway (Agentic Delivery Lifecycle) is installed as a Cursor plugin. Its skills are invoked as /launch, /bootstrap, /dockerize, /plan, /deploy, /verify and /ticket (Claude Code names them /slipway:<name>). Wherever a slipway skill writes \${CLAUDE_PLUGIN_ROOT}, use the plugin root above. AskUserQuestion means: ask the user in chat and wait. Agent with subagent_type explore|execute|verify means the slipway subagent of that name.
Guardrails are enforced by the plugin's hooks: a local 'terraform apply' needs a saved plan in infra/foundation and the human's answer to the permission prompt the guard raises (with options.apply_gate: token, or in a background agent, the human first creates a one-shot token in their own terminal: bash \"$PLUGIN_ROOT/scripts/approve-apply.sh\" <planfile>). Never terraform destroy or -auto-approve; the app layer (infra/apps/*) is applied only by its CD workflow. Never commit .env*, *.tfvars, state or plan files; only immutable image tags; .slipway/.env is sourced, never printed."
python3 -c '
import json,sys
root,att,ctx=sys.argv[1],sys.argv[2],sys.argv[3]
print(json.dumps({"env":{"SLIPWAY_PLUGIN_ROOT":root,"CLAUDE_PLUGIN_ROOT":root,"SLIPWAY_SESSION_ATTENDED":att,"SLIPWAY_HOST":"cursor"},"additional_context":ctx}))' "$PLUGIN_ROOT" "$attended" "$ctx"
exit 0
