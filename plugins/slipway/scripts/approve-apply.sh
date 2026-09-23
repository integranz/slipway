#!/usr/bin/env bash
# HUMAN-ONLY: approve one terraform plan file for a single `terraform apply <planfile>` within 10 minutes.
# Run this in your own terminal, never from an agent session (the guard hook refuses to run it from Claude).
set -euo pipefail
plan="${1:?usage: approve-apply.sh <planfile>}"
[ -f "$plan" ] || { echo "plan file not found: $plan" >&2; exit 1; }
dir="$(cd "$(dirname "$plan")" && pwd -P)"
root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || echo "$dir")"
if command -v sha256sum >/dev/null 2>&1; then sha="$(sha256sum "$plan" | cut -d' ' -f1)"; else sha="$(shasum -a 256 "$plan" | cut -d' ' -f1)"; fi
ttl="${SLIPWAY_APPROVAL_TTL:-600}"; exp=$(( $(date +%s) + ttl ))
mkdir -p "$root/.slipway/approvals"
find "$root/.slipway/approvals" -maxdepth 1 -name '*.used' -type f -delete 2>/dev/null || true  # stale replay markers of earlier applies
printf '%s\n%s\n%s\n' "$sha" "$exp" "$(basename "$plan") approved by $(id -un) at $(date -u +%FT%TZ)" > "$root/.slipway/approvals/$sha"
echo "Approved $(basename "$plan") (sha256 ${sha:0:12}) for one apply within ${ttl}s."
echo "In the agent session, run exactly: terraform -chdir=$dir apply $(basename "$plan")"
case "$(git -C "$root" check-ignore -q .slipway/approvals/x 2>/dev/null; echo $?)" in 0) ;; *) echo "note: add '.slipway/approvals/' to .gitignore (approval tokens must not be committed)";; esac
