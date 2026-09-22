#!/usr/bin/env bash
# Guardrail 3: only immutable image tags leave the machine or reach CD.
# Blocks: docker push / az acr build|import with no tag or a mutable tag; gh workflow run of a CD workflow
# without an immutable tag input; terraform -var image_tag=<mutable>; MCP actions_run_trigger with mutable tag.
# Warns (does not block): local `docker build -t x:latest`.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MUTABLE_RE='^(latest|main|master|dev|develop|development|staging|stage|prod|production|test|qa|edge|nightly|stable|release)$'
tag_is_mutable() { printf '%s' "$1" | grep -Eqi "$MUTABLE_RE"; }
ref_tag() { # image ref -> tag ('' if none). Handles registry:port/repo:tag and @digest.
  local ref="$1"; ref="${ref%%@*}"; local last="${ref##*/}"
  case "$last" in *:*) printf '%s' "${last##*:}";; *) printf '';; esac
}

tool="$(hook_json tool_name)"
case "$tool" in
  Bash)
    raw="$(hook_json tool_input.command)"; cmd="$(normalize_cmd "$raw")"
    # docker push
    for ref in $(printf '%s' "$cmd" | grep -Eo 'docker[[:space:]]+push[[:space:]]+[^[:space:];&|]+' | awk '{print $3}'); do
      t="$(ref_tag "$ref")"
      [ -z "$t" ] && deny "docker push $ref has no tag (would push :latest). Push an immutable tag: <registry>/<repo>:<semver> from the configured versioning tool."
      tag_is_mutable "$t" && deny "docker push $ref uses mutable tag ':$t'. Only immutable tags (semver or sha-<short>) may be pushed."
    done
    # az acr build/import --image|-t
    if printf '%s' "$cmd" | grep -Eq 'az[[:space:]]+acr[[:space:]]+(build|import)'; then
      for ref in $(printf '%s' "$cmd" | grep -Eo -- '(--image|-t)[[:space:]=]+[^[:space:]]+' | sed -E 's/^(--image|-t)[[:space:]=]+//'); do
        t="$(ref_tag "$ref")"; { [ -z "$t" ] || tag_is_mutable "$t"; } && deny "az acr build/import target '$ref' must carry an immutable tag."
      done
    fi
    # gh workflow run <cd workflow> needs -f tag=<immutable>
    if printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+workflow[[:space:]]+run[[:space:]]+[^[:space:]]*(cd|deploy|release)[^[:space:]]*'; then
      t="$(printf '%s' "$cmd" | grep -Eo -- '(-f|-F|--field|--raw-field)[[:space:]]+tag=[^[:space:]]+' | head -1 | sed -E 's/.*tag=//' | tr -d '"'"'"'' || true)"
      [ -z "$t" ] && deny "CD workflow dispatch requires an explicit immutable tag: gh workflow run cd.yml -f tag=<semver> -f environment=<env>"
      tag_is_mutable "$t" && deny "CD workflow dispatch with mutable tag '$t' is not allowed. Use the semver tag produced by CI."
    fi
    # terraform -var image_tag=... or TF_VAR_image_tag=...
    for t in $(printf '%s' "$raw" | grep -Eo -- '(-var[[:space:]=]+["'"'"']?image_tag=|TF_VAR_image_tag=)["'"'"']?[^[:space:]"'"'"']+' | sed -E 's/.*image_tag=["'"'"']?//'); do
      tag_is_mutable "$t" && deny "image_tag='$t' is mutable. Deploy an immutable semver tag."
    done
    # docker build -t x:latest -> warn only (local)
    if printf '%s' "$cmd" | grep -Eq 'docker[[:space:]]+build' ; then
      for ref in $(printf '%s' "$cmd" | grep -Eo -- '(-t|--tag)[[:space:]=]+[^[:space:]]+' | sed -E 's/^(-t|--tag)[[:space:]=]+//'); do
        t="$(ref_tag "$ref")"; { [ -z "$t" ] || tag_is_mutable "$t"; } && warn_and_continue "local build tagged '$ref' is fine for testing but cannot be pushed; CI tags images with the versioning tool."
      done
    fi
    exit 0
    ;;
  mcp__*actions_run_trigger*)
    method="$(hook_json tool_input.method)"; [ "$method" = "run_workflow" ] || exit 0
    wf="$(hook_json tool_input.workflow_id)"
    printf '%s' "$wf" | grep -Eqi '(cd|deploy|release)' || exit 0
    t="$(hook_json tool_input.inputs.tag)"
    [ -z "$t" ] && deny "run_workflow for '$wf' requires inputs.tag set to an immutable semver tag."
    tag_is_mutable "$t" && deny "run_workflow for '$wf' with mutable tag '$t' is not allowed."
    exit 0
    ;;
  *) exit 0;;
esac
