#!/usr/bin/env bash
# Preflight for /slipway:launch: which tools, logins, repository settings and cloud prerequisites are in place.
# Read-only. Prints one line per check: OK / MISSING / SKIP with the fix. Exit 0 when nothing is missing, 3 otherwise.
# usage: bash preflight.sh [--repo <dir>]
set -u
REPO="."; while [ $# -gt 0 ]; do case "$1" in --repo) REPO="$2"; shift 2;; *) shift;; esac; done
cd "$REPO" || exit 2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
missing=0
ok()   { printf '  OK       %-44s %s\n' "$1" "${2:-}"; }
miss() { printf '  MISSING  %-44s %s\n' "$1" "${2:-}"; missing=$((missing+1)); }
skip() { printf '  SKIP     %-44s %s\n' "$1" "${2:-}"; }
INFO="$(node "$HERE/app-info.cjs" --json 2>/dev/null)" || { echo "  MISSING  .slipway/config.yaml            run /slipway:bootstrap first"; exit 3; }
jget() { printf '%s' "$INFO" | python3 -c 'import json,sys; d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d=d.get(k) if isinstance(d,dict) else None
print("" if d is None else (d if isinstance(d,str) else json.dumps(d)))' "$1"; }
CFG=".slipway/config.yaml"
yget() { python3 - "$1" <<'PY'
import sys,re
key=sys.argv[1].split("."); cur=None
# minimal YAML path reader for the flat blocks we need (owner/repo/env/base image/tracker)
import json
try:
    import yaml  # not always available
except Exception:
    yaml=None
txt=open(".slipway/config.yaml").read()
if yaml:
    d=yaml.safe_load(txt)
    for k in key: d=d.get(k) if isinstance(d,dict) else None
    print("" if d is None else d); sys.exit(0)
# fallback: two-level indentation scan
block=None; out=""
for line in txt.splitlines():
    if re.match(r'^[a-z_]+:', line): block=line.split(":")[0]
    m=re.match(r'^\s+([a-z_]+):\s*(.*)$', line)
    if block==key[0] and m and len(key)==2 and m.group(1)==key[1]: out=m.group(2).strip().strip('"').strip("'")
print(out)
PY
}
OWNER="$(yget github.owner)"; REPO_NAME="$(yget github.repo)"; ENV="$(jget cd_environment)"; [ -n "$ENV" ] || ENV=dev
BASE_IMAGE="$(yget options.base_image)"; TRACKER="$(yget options.tracker)"; ACR="$(yget azure.acr_name)"

echo "Tools"
for t in az gh docker terraform node git; do command -v "$t" >/dev/null 2>&1 && ok "$t" "$(command -v "$t")" || miss "$t" "install $t"; done
printf '%s' "$INFO" | grep -q '"stack": "dotnet' && { command -v dotnet >/dev/null 2>&1 && ok "dotnet SDK" "$(dotnet --version 2>/dev/null)" || miss "dotnet SDK" "https://dot.net"; }
printf '%s' "$INFO" | grep -qE '"stack": "(react-vite|node-ts-api)' && { command -v npm >/dev/null 2>&1 && ok "npm" "$(npm --version 2>/dev/null)" || miss "npm" "install Node.js"; }
command -v nbgv >/dev/null 2>&1 && ok "nbgv" "$(nbgv --version 2>/dev/null | head -1)" || miss "nbgv" "dotnet tool install -g nbgv"

echo "Logins (never printed: only whether they exist)"
if az account show >/dev/null 2>&1; then ok "az login" "subscription $(az account show --query name -o tsv 2>/dev/null)"; else miss "az login" "az login && az account set --subscription <id>"; fi
if gh auth status >/dev/null 2>&1; then ok "gh auth" "$(gh api user --jq .login 2>/dev/null)"; else miss "gh auth" "gh auth login"; fi
if [ "$BASE_IMAGE" = "dhi" ]; then
  if python3 -c 'import json,os,sys; c=json.load(open(os.path.expanduser("~/.docker/config.json"))); sys.exit(0 if "dhi.io" in (c.get("auths") or {}) or c.get("credsStore") or c.get("credHelpers") else 1)' 2>/dev/null; then ok "docker login dhi.io" "credentials configured"; else miss "docker login dhi.io" "source the seed file, then: docker login dhi.io -u \"\$DOCKERHUB_USERNAME\" --password-stdin <<<\"\$DOCKERHUB_TOKEN\""; fi
fi
[ -f .slipway/.env ] && ok "seed file .slipway/.env" "present (sourced, never printed)" || skip "seed file .slipway/.env" "optional; copy .slipway/.env.example or use the clipboard method"

if [ -n "$OWNER" ] && [ -n "$REPO_NAME" ] && gh auth status >/dev/null 2>&1; then
  echo "GitHub repository $OWNER/$REPO_NAME"
  SECRETS="$(gh secret list -R "$OWNER/$REPO_NAME" --json name --jq '.[].name' 2>/dev/null)"; VARS="$(gh variable list -R "$OWNER/$REPO_NAME" --json name --jq '.[].name' 2>/dev/null)"
  for s in AZURE_CLIENT_ID AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID; do printf '%s\n' "$SECRETS" | grep -qx "$s" && ok "secret $s" || miss "secret $s" "bash .slipway/setup-azure.sh --apply --set-github-secrets"; done
  if [ "$BASE_IMAGE" = "dhi" ]; then
    printf '%s\n' "$SECRETS" | grep -qx DOCKERHUB_TOKEN && ok "secret DOCKERHUB_TOKEN" || miss "secret DOCKERHUB_TOKEN" "gh secret set DOCKERHUB_TOKEN -R $OWNER/$REPO_NAME --body \"\$(pbpaste)\"  (or from the seed file)"
    printf '%s\n' "$VARS" | grep -qx DOCKERHUB_USERNAME && ok "variable DOCKERHUB_USERNAME" || miss "variable DOCKERHUB_USERNAME" "gh variable set DOCKERHUB_USERNAME -R $OWNER/$REPO_NAME --body <username>"
  fi
  ENVJSON="$(gh api "repos/$OWNER/$REPO_NAME/environments/$ENV" 2>/dev/null)"
  if [ -n "$ENVJSON" ]; then
    REV="$(printf '%s' "$ENVJSON" | python3 -c 'import json,sys; e=json.load(sys.stdin); r=[x for x in e.get("protection_rules",[]) if x.get("type")=="required_reviewers"]; print(",".join(rv["reviewer"]["login"] for x in r for rv in x.get("reviewers",[])))' 2>/dev/null)"
    [ -n "$REV" ] && ok "environment $ENV with required reviewers" "$REV" || miss "environment $ENV required reviewers" "the launch skill adds the current gh user as reviewer"
  else miss "environment $ENV" "the launch skill creates it"; fi
  RULES="$(gh api "repos/$OWNER/$REPO_NAME/rules/branches/$(yget github.default_branch | sed 's/^$/main/')" 2>/dev/null)"
  printf '%s' "$RULES" | grep -q '"pull_request"' && ok "branch ruleset (pull requests + checks)" "$(printf '%s' "$RULES" | python3 -c 'import json,sys; r=json.load(sys.stdin); c=[x for x in r if x.get("type")=="required_status_checks"]; print(", ".join(s["context"] for x in c for s in x["parameters"]["required_status_checks"]))' 2>/dev/null)" || miss "branch ruleset" "node scripts/ruleset.cjs | gh api -X POST repos/$OWNER/$REPO_NAME/rulesets --input -"
fi

if az account show >/dev/null 2>&1 && [ -x .slipway/setup-azure.sh ]; then
  echo "Azure prerequisites (dry run of .slipway/setup-azure.sh)"
  DRY="$(bash .slipway/setup-azure.sh 2>/dev/null)"; N="$(printf '%s\n' "$DRY" | grep -cE '^\s+would ' || true)"
  [ "${N:-0}" = "0" ] && ok "setup-azure.sh" "nothing to change" || miss "setup-azure.sh" "$N change(s) pending: bash .slipway/setup-azure.sh --apply --set-github-secrets"
  [ -n "$ACR" ] && { az acr show -n "$ACR" >/dev/null 2>&1 && ok "foundation applied (registry $ACR exists)" || miss "foundation layer" "/slipway:plan <env> --layer foundation, then approve the apply"; }
fi
[ "$TRACKER" = "none" ] && skip "tracker" "disabled" || echo "Tracker $TRACKER: the skill checks the MCP grant itself (getAccessibleAtlassianResources)"
echo; [ "$missing" = 0 ] && { echo "preflight: nothing missing"; exit 0; } || { echo "preflight: $missing item(s) missing"; exit 3; }
