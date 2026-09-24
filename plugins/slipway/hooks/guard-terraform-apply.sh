#!/usr/bin/env bash
# Guardrail 1: no `terraform apply` without explicit human approval; never destroy; never -auto-approve;
# never apply the app layer (infra/apps/<app>, formerly infra/app) from a session (CD only).
# Approval = the human answering the permission prompt in an attended session (the hook forces it with the plan
# summary as the reason), or a one-shot token written by a human with scripts/approve-apply.sh <planfile> (10 min TTL)
# for unattended sessions. Measured 2026-09-20: in `claude -p` a hook "ask" refuses the call (nobody can answer), so the
# token is the only way to approve there; earlier notes claiming "ask becomes allow" were wrong.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tool="$(hook_json tool_name)"; [ "$tool" = "Bash" ] || exit 0
raw="$(hook_json tool_input.command)"; cmd="$(normalize_cmd "$raw")"
cwd="$(hook_json cwd)"; [ -n "$cwd" ] || cwd="$PWD"

# The agent must never mint its own approval: checked before the terraform fast path, so a lone
# `bash scripts/approve-apply.sh <plan>` is denied too (found 2026-09-17; before, only a combined command was).
# This also makes `echo approve-apply-probe` a valid liveness probe for the guard: it must be blocked.
printf '%s' "$cmd" | grep -Eq 'approve-apply' && deny "Approval tokens are created by a human in a separate terminal, never from an agent session."
# Fast path: nothing terraform-ish
printf '%s' "$cmd" | grep -Eq '(^|[;&|(`[:space:]])terraform([[:space:]]|$)' || exit 0

# Only apply/destroy are gated; plan/validate/fmt/init/show/output are fine
printf '%s' "$cmd" | grep -Eq 'terraform([[:space:]]+-[^[:space:]]+)*[[:space:]]+(apply|destroy)([[:space:]]|$)' || exit 0

printf '%s' "$cmd" | grep -Eq 'terraform([[:space:]]+-[^[:space:]]+)*[[:space:]]+destroy' && deny "terraform destroy is never run from an agent session. A human runs it deliberately, outside Claude, after review."
printf '%s' "$cmd" | grep -Eq '(-auto-approve|-refresh-only[[:space:]]+-auto-approve)' && deny "terraform apply -auto-approve is forbidden. Create a plan file (/slipway:plan), have a human approve it (scripts/approve-apply.sh), then apply that exact plan file."
printf '%s' "$cmd" | grep -Eq -- '-destroy([[:space:]]|$)' && deny "terraform apply -destroy is forbidden from an agent session."

# Effective working directory: follow leading `cd <dir> &&` / `cd <dir>;` / `pushd <dir> &&` chains, then -chdir=<dir> wins
dir="$cwd"; rest="$cmd"
while printf '%s' "$rest" | grep -Eq '^(cd|pushd)[[:space:]]+[^;&|]+[[:space:]]*(&&|;)'; do
  target="$(printf '%s' "$rest" | sed -E 's/^(cd|pushd)[[:space:]]+([^;&|]+)[[:space:]]*(&&|;).*/\2/' | sed -E 's/^["'"'"']//; s/["'"'"'][[:space:]]*$//; s/[[:space:]]+$//')"
  # shellcheck disable=SC2088  # these are case patterns matching a literal leading tilde, not expansions
  case "$target" in /*) dir="$target";; "~"|"~/"*) dir="$HOME${target#\~}";; *) dir="$dir/$target";; esac
  rest="$(printf '%s' "$rest" | sed -E 's/^(cd|pushd)[[:space:]]+[^;&|]+[[:space:]]*(&&|;)[[:space:]]*//')"
done
chdir="$(printf '%s' "$cmd" | grep -Eo -- '-chdir=[^[:space:]]+' | head -1 | cut -d= -f2- || true)"
if [ -n "$chdir" ]; then case "$chdir" in /*) dir="$chdir";; *) dir="$dir/$chdir";; esac; fi
dir="$(cd "$dir" 2>/dev/null && pwd -P || printf '%s' "$dir")"

case "$dir" in *"/infra/app"|*"/infra/app/"*|*"/infra/apps"|*"/infra/apps/"*) deny "The app layer (infra/apps/<app>, formerly infra/app) is applied only by the CD workflow behind the environment approval gate. Use /slipway:deploy <app> <tag> <env> instead of applying it here.";; esac

# Plan file = last non-flag token of the apply command itself, i.e. before any pipe, redirect or command separator
# (so `terraform apply tfplan.dev | less` resolves tfplan.dev, not `less`).
applyargs="$(printf '%s' "$cmd" | sed -E 's/.*terraform([[:space:]]+-[^[:space:]]+)*[[:space:]]+apply([[:space:]]|$)//' | sed -E 's/[[:space:]]*(\||;|&&|\|\||>|<|2>).*$//')"
planfile="$(printf '%s' "$applyargs" | tr ' ' '\n' | grep -Ev '^-|^$' | tail -1 || true)"
[ -n "$planfile" ] || deny "terraform apply needs a saved plan file. Run /slipway:plan <env> --layer foundation, review the plan, then a human approves it with: bash \"\${CLAUDE_PLUGIN_ROOT}/scripts/approve-apply.sh\" <planfile>"
case "$planfile" in /*) planpath="$planfile";; *) planpath="$dir/$planfile";; esac
[ -f "$planpath" ] || deny "Plan file '$planfile' does not exist in $dir. Re-run /slipway:plan and apply the exact plan file it produced."

root="$(repo_root "$dir")"; sha="$(sha256_file "$planpath")"; token="$root/.slipway/approvals/$sha"; used="$token.used"
# One tool call can reach this guard several times at once (Cursor runs the plugin, user and project hook copies in
# parallel; Claude Code runs it once). The token is consumed by an atomic rename, so exactly one delivery consumes it;
# the others find the .used marker and, within SLIPWAY_APPROVAL_REPLAY_SECONDS (default 15, far shorter than a model
# turn), receive the same allow. A stale marker is removed and the apply is denied again.
REPLAY="${SLIPWAY_APPROVAL_REPLAY_SECONDS:-15}"
if [ -f "$token" ]; then
  expiry="$(sed -n '2p' "$token" 2>/dev/null | tr -dc '0-9')"; now="$(date +%s)"
  if [ -n "$expiry" ]; then
    [ "$now" -gt "$expiry" ] && { rm -f "$token"; deny "Approval for '$planfile' has expired (10 min TTL). Ask the human to approve again."; }
    if mv "$token" "$used" 2>/dev/null; then   # single use: the rename is atomic, the first delivery wins
      allow_with_reason "Human-approved plan $planfile (sha256 ${sha:0:12}) applied once; approval consumed."
    fi
  elif [ -f "$token" ]; then
    rm -f "$token"; deny "Approval file for '$planfile' is malformed. Ask the human to approve again."
  fi
  # otherwise a concurrent delivery consumed the token between our two looks; the .used check below decides
fi
if [ -f "$used" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$used" 2>/dev/null || stat -f %m "$used" 2>/dev/null || echo 0) ))
  if [ "$REPLAY" -gt 0 ] && [ "$age" -le "$REPLAY" ]; then
    allow_with_reason "Human-approved plan $planfile (sha256 ${sha:0:12}): same tool call delivered again ${age}s after the approval was consumed."
  fi
  rm -f "$used"
fi
# options.apply_gate: prompt (default) asks in an attended session; token always requires the human-made token.
# SLIPWAY_APPLY_GATE overrides the repository setting (tests, stricter personal policy).
apply_gate() {
  case "${SLIPWAY_APPLY_GATE:-}" in token|prompt) printf '%s' "$SLIPWAY_APPLY_GATE"; return;; esac
  if [ -f "$1/.slipway/config.yaml" ] && grep -Eq '^[[:space:]]*apply_gate:[[:space:]]*token([[:space:]]|$|#)' "$1/.slipway/config.yaml"; then printf 'token'; else printf 'prompt'; fi
}
if [ "$(apply_gate "$root")" = token ]; then
  deny "options.apply_gate is 'token': every foundation apply needs a one-shot approval created by a human in their own terminal:
  bash <plugin-root>/scripts/approve-apply.sh $planpath
Then re-run this exact apply command within 10 minutes."
fi
if attended; then
  # In-session approval: force the permission prompt and put the plan summary in front of the human.
  summary="$(cd "$dir" 2>/dev/null && terraform show -no-color "$planfile" 2>/dev/null | grep -E '^(Plan:|No changes)' | head -1 || true)"
  [ -n "$summary" ] || summary="plan summary unavailable here; read the output of /slipway:plan before approving"
  ask_with_reason "terraform apply of $planfile in ${dir#"$root"/} (sha256 ${sha:0:12}). $summary. Approve only if this is the plan you reviewed; it is applied exactly once."
fi
deny "No human approval found for plan '$planfile' and this session is unattended (no one can answer a prompt).
A human must run, in their own terminal:
  bash <plugin-root>/scripts/approve-apply.sh $planpath
The approval is single-use and expires after 10 minutes. Then re-run this exact apply command."
