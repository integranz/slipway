#!/usr/bin/env bash
# Tests for the Cursor hook adapters: Cursor-shaped inputs in, {"permission":...} out. Exit non-zero on any failure.
set -u
H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; P="$(cd "$H/../.." && pwd -P)"
pass=0; fail=0
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git -C "$T" init -q -b main; mkdir -p "$T/infra/foundation" "$T/infra/apps/api" "$T/.slipway"
printf 'plan' > "$T/infra/foundation/tfplan.dev"; printf 'plan' > "$T/infra/apps/api/tfplan.dev"
printf '.slipway/approvals/\n*.tfvars\n!*.tfvars.example\ntfplan*\n.env\n' > "$T/.gitignore"; git -C "$T" add .gitignore; git -C "$T" -c user.email=t@t -c user.name=t commit -qm init
unset SLIPWAY_SESSION_ATTENDED CLAUDE_CODE_SESSION_ATTENDED

shell_in() { python3 -c 'import json,sys; print(json.dumps({"command":sys.argv[1],"cwd":sys.argv[2],"sandbox":False,"conversation_id":"c1","hook_event_name":"beforeShellExecution"}))' "$1" "$2"; }
mcp_in() { python3 -c 'import json,sys; print(json.dumps({"tool_name":sys.argv[1],"tool_input":sys.argv[2],"mcp_server_name":sys.argv[3],"url":"https://x","hook_event_name":"beforeMCPExecution"}))' "$1" "$2" "$3"; }
read_in() { python3 -c 'import json,sys; print(json.dumps({"file_path":sys.argv[1],"content":"x","attachments":[]}))' "$1"; }
write_in() { python3 -c 'import json,sys; print(json.dumps({"tool_name":sys.argv[1],"tool_input":json.loads(sys.argv[2]),"cwd":sys.argv[3],"tool_use_id":"t1"}))' "$1" "$2" "$3"; }

expect() { # name adapter want_permission input [env assignments...]
  local name="$1" adapter="$2" want="$3" input="$4"; shift 4
  out="$(printf '%s' "$input" | env "$@" bash "$H/$adapter" 2>"$T/err")"; rc=$?
  got="$(printf '%s' "$out" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("permission","<none>"))
except Exception: print("<invalid json>")')"
  if [ "$rc" = 0 ] && [ "$got" = "$want" ]; then pass=$((pass+1)); printf '  ok   %-60s %s\n' "$name" "$got"
  else fail=$((fail+1)); printf '  FAIL %-60s want %s got %s (exit %s)\n' "$name" "$want" "$got" "$rc"; printf '       stdout: %s\n' "$out" | head -2; sed 's/^/       stderr: /' "$T/err" | head -3; fi
}
expect_msg() { # name adapter regex input : the user_message must match
  local name="$1" adapter="$2" re="$3" input="$4"
  out="$(printf '%s' "$input" | bash "$H/$adapter" 2>/dev/null)"
  msg="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("user_message",""))' 2>/dev/null)"
  if printf '%s' "$msg" | grep -Eq "$re"; then pass=$((pass+1)); printf '  ok   %-60s message matches\n' "$name"
  else fail=$((fail+1)); printf '  FAIL %-60s message %s does not match /%s/\n' "$name" "$msg" "$re"; fi
}

echo "shell.sh (beforeShellExecution)"
expect "plain command allowed"                    shell.sh allow "$(shell_in 'echo hello' "$T")"
expect "terraform plan allowed"                   shell.sh allow "$(shell_in 'terraform plan -out=tfplan.dev' "$T/infra/foundation")"
expect "apply without token denied"               shell.sh deny  "$(shell_in 'terraform apply tfplan.dev' "$T/infra/foundation")"
expect "apply without token denied even attended" shell.sh deny  "$(shell_in 'terraform apply tfplan.dev' "$T/infra/foundation")" SLIPWAY_SESSION_ATTENDED=1
expect_msg "denial carries the token instructions" shell.sh 'approve-apply' "$(shell_in 'terraform apply tfplan.dev' "$T/infra/foundation")"
expect "destroy denied"                           shell.sh deny  "$(shell_in 'terraform destroy' "$T/infra/foundation")"
expect "apply -auto-approve denied"               shell.sh deny  "$(shell_in 'terraform apply -auto-approve tfplan.dev' "$T/infra/foundation")"
expect "apply in infra/apps/<app> denied"         shell.sh deny  "$(shell_in 'terraform apply tfplan.dev' "$T/infra/apps/api")"
expect "agent cannot self-approve"                shell.sh deny  "$(shell_in "bash $P/scripts/approve-apply.sh infra/foundation/tfplan.dev" "$T")"
expect "liveness probe is blocked"                shell.sh deny  "$(shell_in 'echo approve-apply-probe' "$T")"
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "apply with human token allowed"           shell.sh allow "$(shell_in 'terraform apply tfplan.dev' "$T/infra/foundation")"
expect "token is single-use"                      shell.sh deny  "$(shell_in 'terraform apply tfplan.dev' "$T/infra/foundation")"
expect "docker push :latest denied"               shell.sh deny  "$(shell_in 'docker push acr.azurecr.io/api:latest' "$T")"
expect "docker push semver allowed"               shell.sh allow "$(shell_in 'docker push acr.azurecr.io/api:1.2.3' "$T")"
expect "git add .env denied"                      shell.sh deny  "$(shell_in 'git add .env' "$T")"
expect "cat .slipway/.env denied"                 shell.sh deny  "$(shell_in 'cat .slipway/.env' "$T")"
expect "sourcing .slipway/.env allowed"           shell.sh allow "$(shell_in 'set -a; . .slipway/.env; set +a; node scripts/preflight.cjs' "$T")"
expect "bare env denied"                          shell.sh deny  "$(shell_in 'env' "$T")"
expect "admin write attended -> ask"              shell.sh ask   "$(shell_in 'gh api -X PUT repos/o/r/environments/dev --input -' "$T")" SLIPWAY_SESSION_ATTENDED=1
expect "admin write unattended -> deny"           shell.sh deny  "$(shell_in 'gh api -X PUT repos/o/r/environments/dev --input -' "$T")"
expect "setup-azure --apply attended -> ask"      shell.sh ask   "$(shell_in 'bash .slipway/setup-azure.sh --apply --set-github-secrets' "$T")" SLIPWAY_SESSION_ATTENDED=1
expect "missing command fails closed"             shell.sh deny  '{"cwd":"/tmp"}'
expect "invalid JSON fails closed"                shell.sh deny  'not json'
mkdir -p "$T/badguards"; printf '#!/usr/bin/env bash\nexit 1\n' > "$T/badguards/guard-terraform-apply.sh"
expect "crashing guard fails closed"              shell.sh deny  "$(shell_in 'echo hello' "$T")" SLIPWAY_GUARDS_DIR="$T/badguards"
expect "missing guard fails closed"               shell.sh deny  "$(shell_in 'echo hello' "$T")" SLIPWAY_GUARDS_DIR="$T/nowhere"

echo "mcp.sh (beforeMCPExecution)"
expect "run_workflow cd with mutable tag denied"  mcp.sh deny  "$(mcp_in actions_run_trigger '{"method":"run_workflow","workflow_id":"slipway-demo-api-cd.yml","ref":"main","inputs":{"tag":"latest","environment":"dev"}}' github)"
expect "run_workflow cd without tag denied"       mcp.sh deny  "$(mcp_in actions_run_trigger '{"method":"run_workflow","workflow_id":"slipway-demo-api-cd.yml","ref":"main","inputs":{"environment":"dev"}}' github)"
expect "run_workflow cd with semver allowed"      mcp.sh allow "$(mcp_in actions_run_trigger '{"method":"run_workflow","workflow_id":"slipway-demo-api-cd.yml","ref":"main","inputs":{"tag":"0.2.6","environment":"dev"}}' github)"
expect "run_workflow ci with no tag allowed"      mcp.sh allow "$(mcp_in actions_run_trigger '{"method":"run_workflow","workflow_id":"slipway-demo-api-ci.yml","ref":"main"}' github)"
expect "jira read allowed"                        mcp.sh allow "$(mcp_in getJiraIssue '{"issueIdOrKey":"DEVOPS-6"}' atlassian)"
expect "non-JSON tool_input string tolerated"     mcp.sh allow "$(mcp_in getJiraIssue 'DEVOPS-6' atlassian)"
expect "missing tool name fails closed"           mcp.sh deny  '{"mcp_server_name":"github"}'

echo "read.sh (beforeReadFile)"
expect "seed file read denied"                    read.sh deny  "$(read_in "$T/.slipway/.env")"
expect "ordinary file read allowed"               read.sh allow "$(read_in "$T/.slipway/config.yaml")"
expect "example seed file allowed"                read.sh allow "$(read_in "$T/.slipway/.env.example")"
expect "missing path fails closed"                read.sh deny  '{"content":"x"}'

echo "write.sh (preToolUse on edit tools)"
expect "secret literal into main.tf denied"       write.sh deny  "$(write_in Write '{"file_path":"infra/foundation/main.tf","content":"client_secret = \"S3cr3tValue1234567890\""}' "$T")"
expect "reference into main.tf allowed"           write.sh allow "$(write_in Write '{"file_path":"infra/foundation/main.tf","content":"client_secret = var.client_secret"}' "$T")"
expect "alternative keys (target_file/code_edit)" write.sh deny  "$(write_in edit_file '{"target_file":".github/workflows/ci.yml","code_edit":"password: \"Hunter2Hunter2Hunter2\""}' "$T")"
expect "app source is not inspected"              write.sh allow "$(write_in Write '{"file_path":"src/index.ts","content":"const password = \"Hunter2Hunter2Hunter2\""}' "$T")"
expect "non-edit tool passes through"             write.sh allow "$(write_in Shell '{"command":"ls"}' "$T")"

echo "session-start.sh"
out="$(printf '{"session_id":"s1","is_background_agent":false,"composer_mode":"agent"}' | bash "$H/session-start.sh")"
if printf '%s' "$out" | python3 -c 'import json,sys,os; o=json.load(sys.stdin); e=o["env"]; assert e["SLIPWAY_SESSION_ATTENDED"]=="1"; assert os.path.isdir(e["SLIPWAY_PLUGIN_ROOT"]); assert e["CLAUDE_PLUGIN_ROOT"]==e["SLIPWAY_PLUGIN_ROOT"]; assert "slipway plugin root: "+e["SLIPWAY_PLUGIN_ROOT"] in o["additional_context"]; assert "approve-apply.sh" in o["additional_context"]'; then pass=$((pass+1)); echo "  ok   interactive session: attended=1, root and token instructions in context"; else fail=$((fail+1)); echo "  FAIL interactive session output: $out"; fi
out="$(printf '{"session_id":"s2","is_background_agent":true}' | bash "$H/session-start.sh")"
if printf '%s' "$out" | python3 -c 'import json,sys; o=json.load(sys.stdin); assert o["env"]["SLIPWAY_SESSION_ATTENDED"]=="0"'; then pass=$((pass+1)); echo "  ok   background agent: attended=0"; else fail=$((fail+1)); echo "  FAIL background agent output: $out"; fi

echo; echo "passed=$pass failed=$fail"; [ "$fail" -eq 0 ]
