#!/usr/bin/env bash
# Branch tests for the slipway guard hooks. Exit non-zero on any failed expectation.
set -u
H="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; P="$(dirname "$H")"
pass=0; fail=0
export SLIPWAY_APPROVAL_REPLAY_SECONDS=0   # the replay window is tested in its own block
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git -C "$T" init -q -b main; mkdir -p "$T/infra/foundation" "$T/infra/app" "$T/infra/apps/api" "$T/.github/workflows"
printf 'plan' > "$T/infra/foundation/tfplan.dev"; printf 'plan' > "$T/infra/app/tfplan.dev"; printf 'plan' > "$T/infra/apps/api/tfplan.dev"
printf '.slipway/approvals/\n*.tfvars\n!*.tfvars.example\ntfplan*\n' > "$T/.gitignore"; git -C "$T" add .gitignore; git -C "$T" -c user.email=t@t -c user.name=t commit -qm init

json_bash() { # cmd cwd [agent_type] [permission_mode]
  python3 -c 'import json,sys; d={"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":sys.argv[1]},"cwd":sys.argv[2],"permission_mode":(sys.argv[4] if len(sys.argv)>4 and sys.argv[4] else "default")}
if len(sys.argv)>3 and sys.argv[3]: d["agent_type"]=sys.argv[3]
print(json.dumps(d))' "$1" "$2" "${3:-}" "${4:-}"; }
json_read() { python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":sys.argv[1]},"cwd":sys.argv[2],"permission_mode":"default"}))' "$1" "$2"; }
json_write() { python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":sys.argv[1],"tool_input":{"file_path":sys.argv[2],"content":sys.argv[3]},"cwd":sys.argv[4]}))' "$1" "$2" "$3" "$4"; }
json_mcp() { python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":"mcp__plugin_slipway_github__actions_run_trigger","tool_input":{"method":"run_workflow","workflow_id":sys.argv[1],"ref":"main","inputs":{"tag":sys.argv[2],"environment":"dev"}},"cwd":"/tmp"}))' "$1" "$2"; }

expect() { # name script expected_exit json [expect_stdout_regex]
  local name="$1" script="$2" want="$3" input="$4" outre="${5:-}"
  out="$(printf '%s' "$input" | bash "$H/$script" 2>/tmp/adlc_hook_err)"; got=$?
  if [ "$got" = "$want" ] && { [ -z "$outre" ] || printf '%s' "$out" | grep -Eq "$outre"; }; then pass=$((pass+1)); printf '  ok   %-58s exit %s\n' "$name" "$got"
  else fail=$((fail+1)); printf '  FAIL %-58s want %s got %s\n' "$name" "$want" "$got"; sed 's/^/       stderr: /' /tmp/adlc_hook_err | head -3; [ -n "$out" ] && printf '       stdout: %s\n' "$out" | head -2; fi
}

echo "guard-terraform-apply"
expect "plan is allowed"                      guard-terraform-apply.sh 0 "$(json_bash 'terraform plan -out=tfplan.dev' "$T/infra/foundation")"
expect "validate/fmt allowed"                 guard-terraform-apply.sh 0 "$(json_bash 'terraform fmt -check && terraform validate' "$T/infra/foundation")"
expect "apply without planfile denied"        guard-terraform-apply.sh 2 "$(json_bash 'terraform apply' "$T/infra/foundation")"
expect "apply -auto-approve denied"           guard-terraform-apply.sh 2 "$(json_bash 'terraform apply -auto-approve tfplan.dev' "$T/infra/foundation")"
expect "destroy denied"                       guard-terraform-apply.sh 2 "$(json_bash 'terraform destroy' "$T/infra/foundation")"
expect "apply -destroy denied"                guard-terraform-apply.sh 2 "$(json_bash 'terraform apply -destroy tfplan.dev' "$T/infra/foundation")"
expect "apply in infra/app denied (cwd)"      guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/app")"
expect "apply in infra/app denied (-chdir)"   guard-terraform-apply.sh 2 "$(json_bash "terraform -chdir=$T/infra/app apply tfplan.dev" "$T")"
expect "apply in infra/apps/<app> denied (cwd)" guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/apps/api")"
expect "apply in infra/apps/<app> denied (-chdir)" guard-terraform-apply.sh 2 "$(json_bash "terraform -chdir=$T/infra/apps/api apply tfplan.dev" "$T")"
expect "cd infra/apps/api && apply denied"      guard-terraform-apply.sh 2 "$(json_bash 'cd infra/apps/api && terraform apply tfplan.dev' "$T")"
expect "apply with planfile, no approval"     guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"
expect "agent cannot self-approve"            guard-terraform-apply.sh 2 "$(json_bash "bash $P/scripts/approve-apply.sh tfplan.dev && terraform apply tfplan.dev" "$T/infra/foundation")"
expect "agent cannot self-approve (alone)"    guard-terraform-apply.sh 2 "$(json_bash "bash $P/scripts/approve-apply.sh infra/foundation/tfplan.dev" "$T")"
expect "guard liveness probe is blocked"       guard-terraform-apply.sh 2 "$(json_bash 'echo approve-apply-probe' "$T")"
expect "plain echo allowed"                    guard-terraform-apply.sh 0 "$(json_bash 'echo hello' "$T")"
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "apply with valid human approval"      guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" '"permissionDecision":"allow"'
expect "approval is single-use"               guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"
SLIPWAY_APPROVAL_TTL=-5 bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "expired approval denied"              guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"
expect "chained cd && apply still caught"     guard-terraform-apply.sh 2 "$(json_bash 'cd infra/foundation && terraform apply -auto-approve' "$T")"
expect "cd infra/app && apply denied (layer)"  guard-terraform-apply.sh 2 "$(json_bash 'cd infra/app && terraform apply tfplan.dev' "$T")"
expect "cd foundation && apply, no approval"   guard-terraform-apply.sh 2 "$(json_bash 'cd infra/foundation && terraform apply tfplan.dev' "$T")"
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "cd foundation && apply, approved"      guard-terraform-apply.sh 0 "$(json_bash 'cd infra/foundation && terraform apply tfplan.dev' "$T")" '"permissionDecision":"allow"'
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "cd infra; cd foundation; apply ok"     guard-terraform-apply.sh 0 "$(json_bash 'cd infra; cd foundation; terraform apply tfplan.dev' "$T")" '"permissionDecision":"allow"'
expect "cd app quoted && apply denied"         guard-terraform-apply.sh 2 "$(json_bash "cd \"$T/infra/app\" && terraform apply tfplan.dev" "/tmp")"
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "apply | pager resolves planfile (approved)" guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev | less' "$T/infra/foundation")" '"permissionDecision":"allow"'
expect "apply > log without approval denied"   guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev > apply.log 2>&1' "$T/infra/foundation")"
expect "apply | tee, planfile missing denied"  guard-terraform-apply.sh 2 "$(json_bash 'terraform apply nope.plan | tee out.txt' "$T/infra/foundation")"
expect "apply -no-color planfile | cat"        guard-terraform-apply.sh 2 "$(json_bash 'terraform apply -no-color tfplan.dev | cat' "$T/infra/foundation")"
expect "env prefix stripped"                  guard-terraform-apply.sh 2 "$(json_bash 'TF_LOG=debug terraform apply' "$T/infra/foundation")"

echo "guard-secrets-and-state"

echo "guard-terraform-apply: attended in-session approval"
ASK='"permissionDecision":"ask"'
rm -rf "$T/.slipway/approvals"
export CLAUDE_CODE_SESSION_ATTENDED=0
expect "no token, unattended -> denied"          guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"
export CLAUDE_CODE_SESSION_ATTENDED=1
expect "no token, attended -> ask (prompt)"       guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" "$ASK"
expect "attended but bypassPermissions -> denied" guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation" "" bypassPermissions)"
expect "attended but dontAsk -> denied"           guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation" "" dontAsk)"
SLIPWAY_APPLY_GATE=token expect "attended, apply_gate=token (env) -> denied with token instructions" guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"
printf 'schema_version: 1\noptions:\n  apply_gate: token\n' > "$T/.slipway/config.yaml"
expect "attended, apply_gate=token (repo config) -> denied" guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"
printf 'schema_version: 1\noptions:\n  apply_gate: prompt\n' > "$T/.slipway/config.yaml"
expect "attended, apply_gate=prompt (repo config) -> ask"  guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" "$ASK"
rm -f "$T/.slipway/config.yaml"
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
SLIPWAY_APPLY_GATE=token expect "apply_gate=token with a valid token -> allow" guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" '"permissionDecision":"allow"'
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "valid token, attended -> allow, consumed" guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" '"permissionDecision":"allow"'
expect "destroy still denied when attended"       guard-terraform-apply.sh 2 "$(json_bash 'terraform destroy' "$T/infra/foundation")"
expect "app layer still denied when attended"     guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/apps/api")"
unset CLAUDE_CODE_SESSION_ATTENDED

echo "guard-admin-actions"
mkdir -p "$T/.slipway"; printf 'DOCKERHUB_TOKEN=x\n' > "$T/.slipway/.env"; printf 'DOCKERHUB_TOKEN=\n' > "$T/.slipway/.env.example"
expect "setup-azure dry run allowed"              guard-admin-actions.sh 0 "$(json_bash 'bash .slipway/setup-azure.sh' "$T")"
expect "setup-azure --apply unattended denied"    guard-admin-actions.sh 2 "$(json_bash 'bash .slipway/setup-azure.sh --apply --set-github-secrets' "$T")"
export CLAUDE_CODE_SESSION_ATTENDED=1
expect "setup-azure --apply attended -> ask"      guard-admin-actions.sh 0 "$(json_bash 'bash .slipway/setup-azure.sh --apply --set-github-secrets' "$T")" "$ASK"
expect "gh api GET allowed"                       guard-admin-actions.sh 0 "$(json_bash 'gh api repos/o/r/environments/dev --jq .id' "$T")"
expect "gh api PUT environment -> ask"            guard-admin-actions.sh 0 "$(json_bash 'gh api -X PUT repos/o/r/environments/dev --input -' "$T")" "$ASK"
expect "gh api POST pending_deployments -> ask"   guard-admin-actions.sh 0 "$(json_bash 'gh api -X POST repos/o/r/actions/runs/123/pending_deployments -f state=approved' "$T")" 'runs/123'
expect "gh api POST rulesets -> ask"              guard-admin-actions.sh 0 "$(json_bash 'gh api -X POST repos/o/r/rulesets --input rules.json' "$T")" "$ASK"
expect "gh secret set -> ask"                     guard-admin-actions.sh 0 "$(json_bash 'gh secret set DOCKERHUB_TOKEN -R o/r --body "$(pbpaste)"' "$T")" 'DOCKERHUB_TOKEN'
expect "gh variable set -> ask"                   guard-admin-actions.sh 0 "$(json_bash 'gh variable set DOCKERHUB_USERNAME -R o/r --body abdelazim' "$T")" "$ASK"
expect "source seed file then gh secret set -> ask" guard-admin-actions.sh 0 "$(json_bash 'set -a; . .slipway/.env; set +a; gh secret set DOCKERHUB_TOKEN -R o/r --body "$DOCKERHUB_TOKEN"' "$T")" "$ASK"
unset CLAUDE_CODE_SESSION_ATTENDED
expect "gh api POST pending_deployments unattended denied" guard-admin-actions.sh 2 "$(json_bash 'gh api -X POST repos/o/r/actions/runs/123/pending_deployments -f state=approved' "$T")"
expect "gh secret set unattended denied"          guard-admin-actions.sh 2 "$(json_bash 'gh secret set DOCKERHUB_TOKEN -R o/r --body x' "$T")"
expect "cat seed file denied"                     guard-admin-actions.sh 2 "$(json_bash 'cat .slipway/.env' "$T")"
expect "grep seed file denied"                    guard-admin-actions.sh 2 "$(json_bash 'grep TOKEN .slipway/.env' "$T")"
expect "sourcing seed file alone allowed"         guard-admin-actions.sh 0 "$(json_bash 'source .slipway/.env && docker login dhi.io -u "$DOCKERHUB_USERNAME" --password-stdin <<<"$DOCKERHUB_TOKEN"' "$T")"
expect "echo secret variable denied"              guard-admin-actions.sh 2 "$(json_bash 'echo $DOCKERHUB_TOKEN' "$T")"
expect "printf non-secret variable allowed"       guard-admin-actions.sh 0 "$(json_bash 'printf "%s" "$AZURE_CLIENT_ID"' "$T")"
expect "bare env denied"                          guard-admin-actions.sh 2 "$(json_bash 'env' "$T")"
expect "env piped denied"                         guard-admin-actions.sh 2 "$(json_bash 'env | grep -i claude' "$T")"
expect "env with command allowed"                 guard-admin-actions.sh 0 "$(json_bash 'env FOO=1 node scripts/x.cjs' "$T")"
expect "printenv HOME allowed"                    guard-admin-actions.sh 0 "$(json_bash 'printenv HOME' "$T")"
expect "Read seed file denied"                    guard-admin-actions.sh 2 "$(json_read "$T/.slipway/.env" "$T")"
expect "Read seed example allowed"                guard-admin-actions.sh 0 "$(json_read "$T/.slipway/.env.example" "$T")"
expect "Read README allowed"                      guard-admin-actions.sh 0 "$(json_read "$T/README.md" "$T")"
rm -f "$T/.slipway/.env" "$T/.slipway/.env.example"   # the seed files would (correctly) trip the secrets guard in later git add tests

printf 'x' > "$T/secrets.tfvars"; printf 'x' > "$T/dev.tfvars.example"; printf 'x' > "$T/main.tf"; printf 'x' > "$T/.env"; printf 'x' > "$T/terraform.tfstate"
expect "git add main.tf allowed"              guard-secrets-and-state.sh 0 "$(json_bash 'git add main.tf' "$T")"
expect "git add tfvars denied"                guard-secrets-and-state.sh 2 "$(json_bash 'git add secrets.tfvars' "$T")"
expect "git add tfvars.example allowed"       guard-secrets-and-state.sh 0 "$(json_bash 'git add dev.tfvars.example' "$T")"
expect "git add .env denied"                  guard-secrets-and-state.sh 2 "$(json_bash 'git add .env' "$T")"
expect "git add tfstate denied"               guard-secrets-and-state.sh 2 "$(json_bash 'git add terraform.tfstate' "$T")"
expect "git add -A with .env present denied"  guard-secrets-and-state.sh 2 "$(json_bash 'git add -A' "$T")"
expect "git commit -am with .env denied"      guard-secrets-and-state.sh 2 "$(json_bash 'git commit -am "x"' "$T")"
expect "git -C dir add tfstate denied"        guard-secrets-and-state.sh 2 "$(json_bash "git -C $T add terraform.tfstate" "/tmp")"
expect "git status allowed"                   guard-secrets-and-state.sh 0 "$(json_bash 'git status' "$T")"
rm -f "$T/.env" "$T/terraform.tfstate" "$T/secrets.tfvars"
expect "git add -A clean tree allowed"        guard-secrets-and-state.sh 0 "$(json_bash 'git add -A' "$T")"
expect "tf literal client_secret denied"      guard-secrets-and-state.sh 2 "$(json_write Write "$T/infra/foundation/main.tf" 'client_secret = "Q~8superSecretValue123456"' "$T")"
expect "tf var reference allowed"             guard-secrets-and-state.sh 0 "$(json_write Write "$T/infra/foundation/main.tf" 'client_secret = var.client_secret' "$T")"
expect "tf key vault ref allowed"             guard-secrets-and-state.sh 0 "$(json_write Edit "$T/infra/app/main.tf" 'key_vault_secret_id = azurerm_key_vault_secret.db.id' "$T")"
expect "workflow secrets ref allowed"         guard-secrets-and-state.sh 0 "$(json_write Write "$T/.github/workflows/ci.yml" 'password: ${{ secrets.ACR_PASSWORD }}' "$T")"
expect "workflow literal token denied"        guard-secrets-and-state.sh 2 "$(json_write Write "$T/.github/workflows/ci.yml" 'token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234"' "$T")"
expect "private key in tf denied"             guard-secrets-and-state.sh 2 "$(json_write Write "$T/infra/foundation/x.tf" '-----BEGIN RSA PRIVATE KEY-----' "$T")"
expect "app source file not inspected"        guard-secrets-and-state.sh 0 "$(json_write Write "$T/apps/api/Program.cs" 'var password = "not-infra-file-1234567";' "$T")"

echo "guard-immutable-tags"
expect "push semver allowed"                  guard-immutable-tags.sh 0 "$(json_bash 'docker push acradlc.azurecr.io/adlc-demo/api:1.2.3' /tmp)"
expect "push sha tag allowed"                 guard-immutable-tags.sh 0 "$(json_bash 'docker push acradlc.azurecr.io/adlc-demo/api:sha-9d1dc0e' /tmp)"
expect "push latest denied"                   guard-immutable-tags.sh 2 "$(json_bash 'docker push acradlc.azurecr.io/adlc-demo/api:latest' /tmp)"
expect "push untagged denied"                 guard-immutable-tags.sh 2 "$(json_bash 'docker push acradlc.azurecr.io/adlc-demo/api' /tmp)"
expect "push registry:port untagged denied"   guard-immutable-tags.sh 2 "$(json_bash 'docker push localhost:5000/api' /tmp)"
expect "push dev denied"                      guard-immutable-tags.sh 2 "$(json_bash 'docker build -t x:1.0 . && docker push acr.io/x:dev' /tmp)"
expect "build latest warns, allowed"          guard-immutable-tags.sh 0 "$(json_bash 'docker build -t api:latest .' /tmp)" 'systemMessage'
expect "az acr build latest denied"           guard-immutable-tags.sh 2 "$(json_bash 'az acr build -r acradlc --image adlc-demo/api:latest .' /tmp)"
expect "az acr build semver allowed"          guard-immutable-tags.sh 0 "$(json_bash 'az acr build -r acradlc --image adlc-demo/api:1.2.3 .' /tmp)"
expect "gh run cd without tag denied"         guard-immutable-tags.sh 2 "$(json_bash 'gh workflow run cd.yml -f environment=dev' /tmp)"
expect "gh run cd tag=latest denied"          guard-immutable-tags.sh 2 "$(json_bash 'gh workflow run cd.yml -f tag=latest -f environment=dev' /tmp)"
expect "gh run cd tag=semver allowed"         guard-immutable-tags.sh 0 "$(json_bash 'gh workflow run cd.yml -f tag=1.2.3 -f environment=dev' /tmp)"
expect "gh run ci without tag allowed"        guard-immutable-tags.sh 0 "$(json_bash 'gh workflow run ci.yml' /tmp)"
expect "terraform -var image_tag=latest deny" guard-immutable-tags.sh 2 "$(json_bash 'terraform plan -var image_tag=latest' /tmp)"
expect "TF_VAR_image_tag=main denied"         guard-immutable-tags.sh 2 "$(json_bash 'TF_VAR_image_tag=main terraform plan' /tmp)"
expect "mcp run_workflow cd tag=latest deny"  guard-immutable-tags.sh 2 "$(json_mcp cd.yml latest)"
expect "mcp run_workflow cd tag=semver allow" guard-immutable-tags.sh 0 "$(json_mcp cd.yml 1.2.3)"
expect "mcp run_workflow ci no tag allowed"   guard-immutable-tags.sh 0 "$(python3 -c 'import json;print(json.dumps({"tool_name":"mcp__plugin_slipway_github__actions_run_trigger","tool_input":{"method":"run_workflow","workflow_id":"ci.yml","ref":"main","inputs":{}}}))')"

echo "guard-readonly-agents"
expect "explore: git status allowed"          guard-readonly-agents.sh 0 "$(json_bash 'git status && grep -rn TODO .' "$T" explore)"
expect "explore: git commit denied"           guard-readonly-agents.sh 2 "$(json_bash 'git commit -m x' "$T" explore)"
expect "verify: terraform plan allowed"       guard-readonly-agents.sh 0 "$(json_bash 'terraform plan -detailed-exitcode' "$T" slipway:verify)"
expect "verify: docker push denied"           guard-readonly-agents.sh 2 "$(json_bash 'docker push x:1.0' "$T" verify)"
expect "verify: curl GET allowed"             guard-readonly-agents.sh 0 "$(json_bash 'curl -fsS https://example.com/health' "$T" verify)"
expect "verify: az show allowed"              guard-readonly-agents.sh 0 "$(json_bash 'az containerapp show -n api -g rg' "$T" verify)"
expect "verify: az create denied"             guard-readonly-agents.sh 2 "$(json_bash 'az group create -n rg -l westeurope' "$T" verify)"
expect "verify: redirect to file denied"      guard-readonly-agents.sh 2 "$(json_bash 'echo hi > notes.txt' "$T" verify)"
expect "verify: redirect to /dev/null allowed" guard-readonly-agents.sh 0 "$(json_bash 'ls > /dev/null 2>&1' "$T" verify)"
expect "execute: git commit allowed"          guard-readonly-agents.sh 0 "$(json_bash 'git commit -m x' "$T" execute)"
expect "verify: mcp createJiraIssue denied"    guard-readonly-agents.sh 2 "$(python3 -c 'import json;print(json.dumps({"tool_name":"mcp__plugin_slipway_atlassian__createJiraIssue","tool_input":{},"agent_type":"slipway:verify"}))')"
expect "verify: mcp getJiraIssue allowed"       guard-readonly-agents.sh 0 "$(python3 -c 'import json;print(json.dumps({"tool_name":"mcp__plugin_slipway_atlassian__getJiraIssue","tool_input":{},"agent_type":"verify"}))')"
expect "explore: mcp actions_run_trigger denied" guard-readonly-agents.sh 2 "$(python3 -c 'import json;print(json.dumps({"tool_name":"mcp__github__actions_run_trigger","tool_input":{"method":"run_workflow"},"agent_type":"explore"}))')"
expect "verify: mcp get_job_logs allowed"       guard-readonly-agents.sh 0 "$(python3 -c 'import json;print(json.dumps({"tool_name":"mcp__github__get_job_logs","tool_input":{},"agent_type":"verify"}))')"
expect "verify: heredoc allowed"                guard-readonly-agents.sh 0 "$(json_bash $'cat <<EOF\nhello\nEOF' "$T" verify)"
expect "verify: 2>&1 allowed"                   guard-readonly-agents.sh 0 "$(json_bash 'terraform plan 2>&1 | tail -5' "$T" verify)"
expect "no agent: unaffected"                 guard-readonly-agents.sh 0 "$(json_bash 'rm -rf build' "$T")"

echo "attended marker set by the Cursor adapter (SLIPWAY_SESSION_ATTENDED)"
unset CLAUDE_CODE_SESSION_ATTENDED SLIPWAY_SESSION_ATTENDED
expect "no marker -> admin write denied"          guard-admin-actions.sh 2 "$(json_bash 'gh api -X PUT repos/o/r/environments/dev --input -' "$T")"
export SLIPWAY_SESSION_ATTENDED=1
expect "SLIPWAY_SESSION_ATTENDED=1 -> ask"        guard-admin-actions.sh 0 "$(json_bash 'gh api -X PUT repos/o/r/environments/dev --input -' "$T")" "$ASK"
expect "marker but bypassPermissions -> denied"   guard-admin-actions.sh 2 "$(json_bash 'gh api -X PUT repos/o/r/environments/dev --input -' "$T" "" bypassPermissions)"
expect "marker: apply without token -> ask"       guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" "$ASK"
unset SLIPWAY_SESSION_ATTENDED

echo "guard-admin-actions: Key Vault secret values"
export CLAUDE_CODE_SESSION_ATTENDED=1
expect "kv set from seed variable, attended -> ask"  guard-admin-actions.sh 0 "$(json_bash 'set -a; . .slipway/.env; set +a; az keyvault secret set --vault-name kv-x --name database-url --value "$DATABASE_URL"' "$T")" 'database-url'
expect "kv set from clipboard -> ask"                guard-admin-actions.sh 0 "$(json_bash 'az keyvault secret set --vault-name kv-x --name database-url --value "$(pbpaste)"' "$T")" "$ASK"
expect "kv set from file -> ask"                     guard-admin-actions.sh 0 "$(json_bash 'az keyvault secret set --vault-name kv-x --name tls-cert --file ./cert.pem' "$T")" "$ASK"
expect "kv set with literal value denied"            guard-admin-actions.sh 2 "$(json_bash 'az keyvault secret set --vault-name kv-x --name database-url --value postgres://u:p@h:5432/db' "$T")"
unset CLAUDE_CODE_SESSION_ATTENDED
expect "kv set from variable, unattended denied"     guard-admin-actions.sh 2 "$(json_bash 'az keyvault secret set --vault-name kv-x --name database-url --value "$DATABASE_URL"' "$T")"
expect "kv show --query id allowed"                  guard-admin-actions.sh 0 "$(json_bash 'az keyvault secret show --vault-name kv-x --name database-url --query id -o tsv' "$T")"
expect "kv show bare denied"                         guard-admin-actions.sh 2 "$(json_bash 'az keyvault secret show --vault-name kv-x --name database-url' "$T")"
expect "kv show --query value denied"                guard-admin-actions.sh 2 "$(json_bash 'az keyvault secret show --vault-name kv-x --name database-url --query value -o tsv' "$T")"
expect "kv download denied"                          guard-admin-actions.sh 2 "$(json_bash 'az keyvault secret download --vault-name kv-x --name database-url --file x.txt' "$T")"
expect "kv list of names allowed"                    guard-admin-actions.sh 0 "$(json_bash 'az keyvault secret list --vault-name kv-x --query "[].name" -o tsv' "$T")"

echo "guard-terraform-apply: several hook deliveries of one tool call share one approval"
export SLIPWAY_APPROVAL_REPLAY_SECONDS=15
rm -rf "$T/.slipway/approvals"; bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
expect "first delivery consumes the token"          guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" '"permissionDecision":"allow"'
expect "second delivery within the window replays"  guard-terraform-apply.sh 0 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" 'delivered again'
touch -t 202001010000 "$T/.slipway/approvals/"*.used
expect "stale marker: denied again"                 guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"
if [ -z "$(ls -A "$T/.slipway/approvals" 2>/dev/null)" ]; then pass=$((pass+1)); echo "  ok   stale marker removed, approvals dir empty"; else fail=$((fail+1)); echo "  FAIL leftover in approvals: $(ls -A "$T/.slipway/approvals")"; fi
bash "$P/scripts/approve-apply.sh" "$T/infra/foundation/tfplan.dev" >/dev/null
for i in 1 2 3 4 5; do ( printf '%s' "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")" | bash "$H/guard-terraform-apply.sh" > "$T/conc$i.out" 2>/dev/null; echo $? > "$T/conc$i.rc" ) & done; wait
okc=0; for i in 1 2 3 4 5; do [ "$(cat "$T/conc$i.rc")" = 0 ] && grep -q '"permissionDecision":"allow"' "$T/conc$i.out" && okc=$((okc+1)); done
if [ "$okc" = 5 ]; then pass=$((pass+1)); echo "  ok   5 concurrent deliveries with one token: all allowed"; else fail=$((fail+1)); echo "  FAIL concurrent deliveries: $okc/5 allowed"; fi
rm -f "$T/.slipway/approvals/"*.used
export SLIPWAY_APPROVAL_REPLAY_SECONDS=0
expect "after the marker is gone: denied"           guard-terraform-apply.sh 2 "$(json_bash 'terraform apply tfplan.dev' "$T/infra/foundation")"

echo; echo "passed=$pass failed=$fail"; [ "$fail" -eq 0 ]
