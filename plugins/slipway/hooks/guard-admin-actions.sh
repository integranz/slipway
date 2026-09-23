#!/usr/bin/env bash
# Guardrail 5: cloud/GitHub administration and secret handling from a session.
#  - `setup-azure.sh --apply`, `cloud-setup.sh --apply`, GitHub admin API writes (environments, rulesets, branch
#    protection, pending deployment approvals, secrets, variables) and `gh secret|variable set` run only in an attended
#    session, behind a forced permission prompt whose reason names the action; unattended sessions are denied.
#  - The seed file .slipway/.env (local secrets the plugin consumes as environment variables) may be sourced, never
#    printed or read: cat/less/grep/... on it, the Read tool on it, bare `env`/`printenv`/`export -p`/`set`, and
#    echo/printf of *TOKEN*/*SECRET*/*PASSWORD*/*KEY variables are denied.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tool="$(hook_json tool_name)"
case "$tool" in
  Read)
    f="$(hook_json tool_input.file_path)"
    printf '%s' "$f" | grep -Eq '(^|/)\.slipway/\.env$' && deny "The seed file .slipway/.env holds local secrets: source it in a shell command (\`set -a; . .slipway/.env; set +a\`) so the values become environment variables; never read or print it."
    exit 0;;
  Bash) ;;
  *) exit 0;;
esac

raw="$(hook_json tool_input.command)"; cmd="$(normalize_cmd "$raw")"

# ---- seed file and secret variables must not enter the transcript ----
if printf '%s' "$cmd" | grep -Eq '\.slipway/\.env([[:space:]]|$|["'"'"'])' && ! printf '%s' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)(\.|source)[[:space:]]+[^;&|]*\.slipway/\.env' ; then
  deny "The seed file .slipway/.env may only be sourced (\`. .slipway/.env\`), never printed, copied or searched; its values are secrets."
fi
printf '%s' "$cmd" | grep -Eq '(^|[;&|][[:space:]]*)(env|printenv|export -p|set)[[:space:]]*($|[;&|])' && deny "Dumping the environment would print secret values (the seed file is sourced into it). Print a single, non-secret variable instead."
printf '%s' "$cmd" | grep -Eqi '(echo|printf)[^;&|]*\$\{?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY)[A-Za-z_]*\}?' && deny "Printing a secret variable would put its value in the transcript. Pass it to the consumer directly (for example \`gh secret set NAME --body \"\$NAME\"\`)."

# ---- Key Vault secret values: written from a variable, the clipboard or a file behind a prompt; never read back ----
KV_SET_RE='(^|[;&|(`[:space:]])az[[:space:]]+keyvault[[:space:]]+secret[[:space:]]+set[[:space:]]'
KV_SHOW_RE='(^|[;&|(`[:space:]])az[[:space:]]+keyvault[[:space:]]+secret[[:space:]]+show[[:space:]]'
KV_DL_RE='(^|[;&|(`[:space:]])az[[:space:]]+keyvault[[:space:]]+secret[[:space:]]+(download|backup)[[:space:]]'
printf '%s' "$cmd" | grep -Eq "$KV_DL_RE" && deny "Downloading a Key Vault secret would put its value in the transcript. Check existence with: az keyvault secret show … --query id -o tsv"
if printf '%s' "$cmd" | grep -Eq "$KV_SHOW_RE"; then
  printf '%s' "$cmd" | grep -Eq -- '--query[[:space:]=]+["'"'"']?(id|name|attributes[^[:space:]"'"'"']*|tags)["'"'"']?([[:space:]]|$)' \
    || deny "az keyvault secret show prints the secret value. Check existence only: az keyvault secret show --vault-name <kv> --name <name> --query id -o tsv"
fi
# ---- administrative actions: attended → forced prompt with a reason; unattended → denied ----
gate() { # $1 = reason for the human
  if attended; then ask_with_reason "$1"; fi
  deny "$1
This needs a human to answer a permission prompt, and this session is unattended. Run it in an attended session, or yourself in a terminal."
}
if printf '%s' "$cmd" | grep -Eq "$KV_SET_RE"; then
  if printf '%s' "$cmd" | grep -Eq -- '--value[[:space:]=]+["'"'"']?\$' || printf '%s' "$cmd" | grep -Eq -- '(^|[[:space:]])(-f|--file)[[:space:]=]'; then
    gate "Write Key Vault secret $(printf '%s' "$cmd" | grep -Eo -- '(--name|-n)[[:space:]=]+[A-Za-z0-9-]+' | head -1 | sed -E 's/^(--name|-n)[[:space:]=]+//'): the value comes from an environment variable, the clipboard or a file and is not shown."
  fi
  deny "az keyvault secret set with a literal --value would put the secret in the transcript. Source the seed file and pass a variable: set -a; . .slipway/.env; set +a; az keyvault secret set --vault-name <kv> --name <name> --value \"\$VAR\""
fi
if printf '%s' "$cmd" | grep -Eq '(setup-azure|cloud-setup)\.sh[^;&|]*--apply'; then
  extra=""; printf '%s' "$cmd" | grep -Eq -- '--set-github-secrets' && extra=" and writes the AZURE_* repository secrets with gh"
  gate "Cloud prerequisites --apply: creates or assigns the Entra app registration, federated credentials, Terraform state storage, resource group and role assignments in the current Azure subscription$extra. Run without --apply first to see the dry run."
fi
if printf '%s' "$cmd" | grep -Eq '(^|[;&|(`[:space:]])gh[[:space:]]+api[[:space:]]'; then
  method="$(printf '%s' "$cmd" | grep -Eo -- '(-X|--method)[[:space:]]+[A-Za-z]+' | head -1 | awk '{print toupper($2)}' || true)"
  if printf '%s' "$method" | grep -Eq '^(POST|PUT|PATCH|DELETE)$' || printf '%s' "$cmd" | grep -Eq -- '(^|[[:space:]])(-f|-F|--field|--raw-field|--input)[[:space:]=]'; then
    case "$cmd" in
      *pending_deployments*) gate "Approve or reject a pending GitHub deployment through the API, recorded under your GitHub account: $(printf '%s' "$cmd" | grep -Eo 'runs/[0-9]+' | head -1). Approve only the run whose plan you reviewed.";;
      *rulesets*|*/protection*) gate "Change branch protection / rulesets of the repository (who may push to the default branch and which checks are required).";;
      *environments*) gate "Create or change a GitHub deployment environment (required reviewers, deployment branch policy).";;
      *actions/secrets*|*actions/variables*) gate "Write a repository secret or variable through the API (the value is not shown).";;
    esac
  fi
fi
printf '%s' "$cmd" | grep -Eq '(^|[;&|(`[:space:]])gh[[:space:]]+(secret|variable)[[:space:]]+set[[:space:]]' && gate "Write a GitHub repository secret or variable: $(printf '%s' "$cmd" | grep -Eo 'gh (secret|variable) set [A-Za-z0-9_]+' | head -1). The value comes from the clipboard, the seed file or a file and is never printed."
exit 0
