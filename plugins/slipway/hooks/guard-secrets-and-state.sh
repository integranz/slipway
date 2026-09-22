#!/usr/bin/env bash
# Guardrail 2: keep secrets, tfvars, state, env files and plan files out of git, and secret literals out of
# Terraform and workflow files. Runs on Bash (git add/commit) and on Edit|Write.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FORBIDDEN_FILE_RE='(^|/)(\.env(\..*)?|.*\.tfstate(\..*)?|.*\.tfvars|tfplan.*|.*\.tfplan|backend\.hcl|.*\.pem|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*\.key)$'
ALLOWED_EXAMPLE_RE='\.example$|\.sample$|\.template$'
# Secret-looking literals. Exclusions handled separately (var./local./data./secrets./random_/keyVaultUrl).
SECRET_LITERAL_RE='(client[_-]?secret|password|passwd|secret|token|api[_-]?key|access[_-]?key|connection[_-]?string)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'$\{][^"'"'"']{7,}["'"'"']'
KNOWN_TOKEN_RE='(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{32,})'
SAFE_REF_RE='(var\.|local\.|data\.|module\.|\$\{\{[[:space:]]*secrets\.|secretref:|random_password|random_string|keyVaultUrl|key_vault_secret_id|azurerm_key_vault_secret\.)'

check_paths() { # stdin: newline-separated paths ; prints offenders
  grep -E "$FORBIDDEN_FILE_RE" | grep -Ev "$ALLOWED_EXAMPLE_RE" || true
}

tool="$(hook_json tool_name)"
case "$tool" in
  Bash)
    raw="$(hook_json tool_input.command)"; cmd="$(normalize_cmd "$raw")"; cwd="$(hook_json cwd)"; [ -n "$cwd" ] || cwd="$PWD"
    printf '%s' "$cmd" | grep -Eq '(^|[;&|(`[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(add|commit|stage)([[:space:]]|$)' || exit 0
    gitdir="$(printf '%s' "$cmd" | grep -Eo -- 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+' | head -1 | awk '{print $3}' || true)"
    [ -n "$gitdir" ] && { case "$gitdir" in /*) cwd="$gitdir";; *) cwd="$cwd/$gitdir";; esac; }
    offenders=""
    if printf '%s' "$cmd" | grep -Eq 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+add[[:space:]]+.*(-A|--all|-a|[[:space:]]\.([[:space:]]|$)|\*)' || printf '%s' "$cmd" | grep -Eq 'git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit[[:space:]]+.*(-a|--all|-am)([[:space:]]|$)'; then
      # bulk staging: inspect what would be staged (untracked + modified, honouring .gitignore)
      offenders="$( (git -C "$cwd" status --porcelain --untracked-files=all 2>/dev/null | cut -c4- ; git -C "$cwd" diff --cached --name-only 2>/dev/null) | sed 's/^"//; s/"$//' | check_paths)"
    else
      args="$(printf '%s' "$cmd" | sed -E 's/.*git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(add|stage|commit)[[:space:]]*//' | tr ' ' '\n' | grep -Ev '^-|^$|^&&$|^;$' || true)"
      offenders="$(printf '%s\n' "$args" | check_paths)"
      staged="$(git -C "$cwd" diff --cached --name-only 2>/dev/null | check_paths || true)"
      [ -n "$staged" ] && offenders="$(printf '%s\n%s' "$offenders" "$staged" | sed '/^$/d')"
    fi
    [ -z "$offenders" ] && exit 0
    deny "These files must never be committed (secrets, variables, state or plan files):
$(printf '%s\n' "$offenders" | sed 's/^/  - /')
Keep them local (they are gitignored by the slipway template) or use a *.example variant with placeholder values."
    ;;
  Edit|Write)
    file="$(hook_json tool_input.file_path)"
    content="$(hook_json tool_input.content)"; [ -n "$content" ] || content="$(hook_json tool_input.new_string)"
    # Only inspect infrastructure and pipeline files where a literal secret would be committed
    printf '%s' "$file" | grep -Eq '(\.tf|\.tfvars|\.hcl|\.bicep|\.ya?ml|\.json|Dockerfile[^/]*|\.env[^/]*)$' || exit 0
    printf '%s' "$file" | grep -Eq '(^|/)(infra|terraform|\.github/workflows|deploy|k8s|helm|charts)(/|$)|\.tf$|\.tfvars$|Dockerfile' || exit 0
    hits="$(printf '%s\n' "$content" | grep -En "$SECRET_LITERAL_RE|$KNOWN_TOKEN_RE" | grep -Ev "$SAFE_REF_RE" || true)"
    [ -z "$hits" ] && exit 0
    deny "Secret-looking literal in $file:
$(printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/  /')
Reference the secret instead: Terraform var.* fed from the environment (TF_VAR_*), a Key Vault reference (key_vault_secret_id / secretref:), or \${{ secrets.NAME }} in workflows."
    ;;
  *) exit 0;;
esac
