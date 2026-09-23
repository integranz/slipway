---
name: deploy
description: Trigger the CD workflow of one app for one immutable image tag and one environment, wait for the human approval on the GitHub environment, monitor the run to completion and report the deployed URL.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Read, Glob, Grep, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/app-info.cjs" *), Bash(gh run list *), Bash(gh run view *), Bash(gh run watch *), Bash(gh run download *), Bash(gh workflow run *), Bash(gh api repos/*), Bash(az acr repository show *), Bash(az acr repository show-tags *), Bash(az account show *), Bash(git rev-parse *), Bash(curl -fsS *)
---

# /slipway:deploy — deploy one tag of one app to one environment

Arguments: `$0` app name from `.slipway/config.yaml` (required). `$1` image tag (semver from that app's CI; default: the version of the latest successful `<prefix>-<app>-ci` run on the default branch). `$2` environment (default: `github.cd_environment`). Flags: `--no-wait` (trigger and return the run URL), `--no-ticket`.

Every app has its own CD workflow, state and version; deploying `api` never touches `web`. Resolve names with `node "${CLAUDE_PLUGIN_ROOT}/scripts/app-info.cjs" <app>` (workflow names, image, `infra/apps/<app>`, evidence directory) instead of guessing them.

## Preconditions
1. `.slipway/config.yaml` validates; `.github/workflows/<prefix>-<app>-cd.yml`, `.github/workflows/_cd.yml` and `infra/apps/<app>/` exist (otherwise: run the scaffold, commit, push).
2. GitHub access: the GitHub MCP server (`actions_run_trigger`, `actions_get`, `get_job_logs`) or an authenticated `gh` CLI. Azure read access for the tag check (`az account show`).
3. With `options.cd_trigger: on-ci-success` the CD of the latest release may already be running or waiting for approval: `gh run list --workflow <prefix>-<app>-cd --limit 3 --json databaseId,status,displayTitle` first; if a run for this tag exists, watch it (Step 3) instead of dispatching a duplicate.

4. Every `apps[].secrets` entry of the app exists in the key vault: `az keyvault secret show --vault-name <azure.key_vault_name> --name <name> --query id -o tsv` (never without `--query id`; the guard denies reading the value). A missing secret stops here with the `az keyvault secret set … --value "$<ENV>"` command for the human (or from the seed file behind a prompt, see the launch skill); the CD apply would fail on the Key Vault reference otherwise.

## Step 1 — Resolve the tag
- If `$1` is given: it must match `^[0-9]+\.[0-9]+\.[0-9]+` and must not be `latest` or a branch name (the guard hook enforces this too).
- Otherwise: `gh run list --workflow <prefix>-<app>-ci --branch <default_branch> --status success --limit 1 --json databaseId` → `gh api repos/<owner>/<repo>/actions/runs/<id>/artifacts --jq '.artifacts[].name'` → the `release-manifest-<app>-<version>` artifact gives the version. Tell the user which tag was chosen and from which run.
- Confirm the image exists: `az acr repository show -n <acr> --image <image_repository>:<tag> --query digest -o tsv` (a non-empty digest; `acr manifest show --query digest` prints nothing in az 2.75). Missing image → stop; the fix is a CI release of that app, not a deploy.

## Step 2 — Trigger CD
Preferred: GitHub MCP `actions_run_trigger` with `method: run_workflow`, `workflow_id: <prefix>-<app>-cd.yml`, `ref: <default_branch>`, `inputs: { tag, environment }`. Fallback: `gh workflow run <prefix>-<app>-cd.yml -R <owner>/<repo> -f tag=<tag> -f environment=<env>`. The guard hook rejects a dispatch without an immutable `tag` input. Find the run id: `gh run list --workflow <prefix>-<app>-cd --limit 1 --json databaseId,url`.

## Step 3 — Watch and hand over the approval
1. Poll (`gh run watch <id>` or `actions_get` every 15 s). The `plan` job publishes the plan summary; the `apply` job then **waits for a human** on the `<env>` environment.
2. As soon as the run reaches "waiting", tell the user: the plan summary URL, the exact resource changes (`Plan: x to add, y to change, z to destroy`; a healthy app deploy changes exactly one `azurerm_container_app`), and where to approve (`https://github.com/<owner>/<repo>/actions/runs/<id>`).
   - `options.cd_approval: github-ui` (default): the human approves on that page; never approve yourself.
   - `options.cd_approval: in-session`: ask with `AskUserQuestion` ("Approve <app> <tag> → <env>? plan: …") and, only on an explicit approve, run
     `gh api repos/<owner>/<repo>/actions/runs/<id>/pending_deployments` to read the waiting environment (`environment.id`, `current_user_can_approve`), then
     `gh api -X POST repos/<owner>/<repo>/actions/runs/<id>/pending_deployments --input -` with `{"environment_ids":[<id>],"state":"approved","comment":"approved via slipway by <gh user> after plan review: <Plan: line>"}`.
     The guard hook forces a permission prompt for this call (the reason names the run), so the human confirms twice: the question and the prompt. The approval is recorded under the human's own GitHub account (only required reviewers can call this endpoint). In an unattended session the hook denies the call: print the URL and wait. A "reject" answer posts `state: rejected` the same way.
3. After approval, keep polling until completion. On failure: `gh run view <id> --log-failed` (or `get_job_logs` with `failed_only`), quote the first failing lines, and stop; do not retry automatically.
4. On success: download `deploy-evidence-<app>-<env>-<tag>` and read `outputs.json` (`url`, `health_url`, `latest_revision`) and `smoke.txt`.

## Step 4 — Tracking (runs alongside Steps 2–3)
Unless `--no-ticket` or `options.tracker: none`: after the dispatch, `/slipway:ticket subtask start "Deploy <app> <tag> → <env>" --message "<run URL>"`; when the run waits for the approval, `/slipway:ticket subtask review "Deploy <app> <tag> → <env>" --message "<plan summary line>, waiting for approval on <env>"`; after a successful apply and smoke test, `/slipway:ticket subtask done "Deploy <app> <tag> → <env>" --message "<Apply complete line>; <smoke line>; <url>"`. On failure leave it in review with the failing lines as a comment. An unavailable tracker queues these; continue.

## Output
```
## slipway deploy: <project>/<app> <tag> → <env>
Run: <url> (plan: +a ~c -d | apply: <Apply complete line>)
Approval: <who, when> | Smoke: <CONFIRMED|REFUTED line>
URL: <url>
Next: /slipway:verify <app> <env> <tag>
```

## Do not
- Do not deploy `latest`, branch names or a tag whose image is missing; do not deploy one app's tag through another app's workflow.
- Do not run `terraform apply` locally for `infra/apps/<app>`; the hook blocks it and the state belongs to the CD identity.
- Do not approve, bypass or re-request the environment review; do not re-run a failed apply without a human decision.
- Do not deploy to an environment that is not listed in `.slipway/config.yaml`.
