#!/usr/bin/env bash
# Guardrail 4 (supporting): the explore and verify sub-agents are read-only. Their tools list already excludes
# Edit/Write; this hook also blocks mutating shell commands so "verify never fixes" is mechanical.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
agent="$(hook_json agent_type)"; [ -n "$agent" ] || exit 0
printf '%s' "$agent" | grep -Eqi '(^|[:_-])(explore|verify)$|^(explore|verify)([:_-]|$)' || exit 0
tool="$(hook_json tool_name)"
case "$tool" in
  mcp__*)
    printf '%s' "$tool" | grep -Eqi '(actions_run_trigger|run_workflow|rerun|cancel|create|edit|update|delete|transition|add|write|push|merge|dispatch|upsert|set_)' \
      && deny "Agent '$agent' is read-only: MCP tool '$tool' mutates an external system. Report the need and let the parent act."
    exit 0;;
  Bash) ;;
  *) exit 0;;
esac
raw="$(hook_json tool_input.command)"; cmd="$(normalize_cmd "$raw")"
MUTATING_RE='(^|[;&|(`][[:space:]]*)(rm|mv|cp|chmod|chown|tee|truncate|mkdir|touch|ln|sed[[:space:]]+-i|git[[:space:]]+(add|commit|push|checkout|switch|reset|rebase|merge|stash|tag|rm|mv|clean|cherry-pick|am)|terraform[[:space:]]+(apply|destroy|import|taint|untaint|state[[:space:]]+(rm|mv|push|replace-provider)|workspace[[:space:]]+(new|delete))|docker[[:space:]]+(push|rm|rmi|build|buildx|tag|login|system[[:space:]]+prune)|kubectl[[:space:]]+(apply|delete|create|patch|edit|scale|rollout|label|annotate|drain|cordon)|helm[[:space:]]+(install|upgrade|uninstall|rollback)|az[[:space:]]+[a-z-]+([[:space:]]+[a-z-]+)*[[:space:]]+(create|delete|update|set|import|start|stop|restart|deploy|purge|assign|add|remove)|gh[[:space:]]+(workflow[[:space:]]+run|run[[:space:]]+(rerun|cancel|delete)|pr[[:space:]]+(create|merge|close|edit|ready)|issue[[:space:]]+(create|close|edit|delete)|release[[:space:]]+(create|delete|edit)|repo[[:space:]]+(create|delete|edit))|npm[[:space:]]+(install|i|ci|publish|uninstall)|dotnet[[:space:]]+(tool[[:space:]]+install|nuget[[:space:]]+push|new)|pip[[:space:]]+install|curl[[:space:]]+.*-X[[:space:]]*(POST|PUT|PATCH|DELETE))([[:space:]]|$)'
printf '%s' "$cmd" | grep -Eq "$MUTATING_RE" && deny "Agent '$agent' is read-only. Report the finding and let the parent delegate the change to the execute agent."
# redirection into a file (fd duplications and /dev/null are fine; heredocs are not redirections)
stripped="$(printf '%s' "$cmd" | sed -E 's/[0-9]*>&[0-9]+//g; s/&?>{1,2}[[:space:]]*\/dev\/null//g; s/<<-?[[:space:]]*['"'"'"]?[A-Za-z_]+['"'"'"]?//g')"
printf '%s' "$stripped" | grep -Eq '>{1,2}' && deny "Agent '$agent' is read-only: output redirection into files is not allowed. Return the content in your report instead."
exit 0
