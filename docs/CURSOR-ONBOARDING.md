# Cursor Cloud onboarding runbook — one repository, one agent run, one pull request (goal 7 tier)

The cheapest automation of the onboarding: a human (or a `workflow_dispatch`) starts **one Cursor Cloud Agent** on a repository that slipway does not deliver yet. The agent installs the plugin at a pinned version, runs `/slipway:launch --yes --until bootstrap`, drafts a Dockerfile where a custom stack needs one, and commits on a branch; Cursor pushes the branch and opens the pull request. A human reviews the PR, and after the merge runs `/slipway:launch` once on a desktop to complete the human-only phases (Azure prerequisites, GitHub secrets and environment, foundation apply). Nothing here holds a cloud credential.

Sources, read 2026-09-27: cursor.com/docs/cloud-agent/api/endpoints (`POST https://api.cursor.com/v1/agents`: `prompt.text`, `repos[{url, startingRef}]`, `autoCreatePR`, `model.id`; Basic auth `-u KEY:` with a user or team service-account key; when `workOnCurrentBranch` is false, Cursor pushes the agent's commits to an auto-generated `cursor/…` branch); cursor.com/docs/agent/hooks (cloud agents run only the repository's command hooks; a repository without `.cursor/hooks.json` has no guards, which is why the agent gets no credential); the assessment in `docs/NON-INTERACTIVE-TIERS.md` (headless onboarding, parked).

| Field | Value |
|---|---|
| **Trigger** | `gh workflow run onboard.yml -R integranz/slipway -f repository=<owner/name> [-f ref=main] [-f answers="$(cat answers.txt)"]`, or the same prompt pasted at cursor.com/agents |
| **Scope** | one repository per run; the agent starts from `ref` (its default branch) |
| **Identity** | the Cursor account behind `CURSOR_API_KEY` (team service account recommended: PRs by `cursor`, billed to the team pool) |
| **Secrets** | `CURSOR_API_KEY` on `integranz/slipway` only, used by the workflow to call the API. The agent receives **no** credential: no Azure, no GitHub token, no Jira |
| **Prompt** | `bash scripts/onboard-prompt.sh <owner/name> --ref <branch> --version <plugin version> [--answers <file>]` |
| **Output / review path** | one pull request titled `slipway: onboard <name>` with `.slipway/config.yaml`, `AGENTS.md`, `CLAUDE.md`, rules, per-app CI/CD workflows, Terraform modules, Dockerfiles; a report in the agent transcript. A human reviews and merges |
| **Guardrails** | the prompt limits the run to preflight + bootstrap; the agent is told to print human-only commands instead of running them. The first run has no repository hooks yet (the scaffold adds them), so the guarantee is the absence of credentials, not the hooks |
| **Monitoring** | the workflow step summary (prompt, agent id and URL), the agent transcript at cursor.com/agents, the PR |
| **Rollback** | close the PR and delete the branch; nothing was deployed or configured |

## Answers file
The interview values without a default must be given, one `key: value` per line; the agent treats them as answered. Example:
```
azure.location: westeurope
azure.resource_group: rg-<name>-dev
azure.acr_name: acr<name>dev
azure.key_vault_name: kv-<name>-dev
azure.identity_name: id-<name>-dev
azure.state.resource_group: rg-<name>-tfstate
azure.state.storage_account: st<name>tf
azure.state.container: tfstate
jira.site_url: https://integranz.atlassian.net
jira.project_key: DEVOPS
options.registry_scope: existing
azure.acr_resource_group: rg-shared-dev
```
Omit what detections cover (apps, ports, health paths, default branch) and what has a default (`options.*` other than the ones you want to change). No ids, no secrets: the file ends up in the workflow summary and the agent transcript.

## Choosing the target of the first real run
Pick a repository that slipway does **not** deliver yet: on a delivered one (`slipway-demo`, `taskflow`) the bootstrap finds `.slipway/config.yaml`, changes nothing and no onboarding PR appears. A small public test repository with one deployable app (a minimal .NET 8 API or an Express app with a Dockerfile, a `/health` route and a `PORT` variable) plus an answers file with the Azure and Jira identifiers is the right first target; it can be deleted afterwards.

## Steps
1. Once: create the Cursor API key (team admin → service account, or your own key) and store it: `gh secret set CURSOR_API_KEY -R integranz/slipway` in **your** terminal (the plugin guards deny secret writes from agent sessions).
2. Dispatch: `gh workflow run onboard.yml -R integranz/slipway -f repository=integranz/<name> -f answers="$(cat answers.txt)"`. Add `-f dry_run=true` to see the request without starting an agent.
3. Follow the run: `gh run watch -R integranz/slipway`; the step summary shows the prompt and the agent link.
4. Review the pull request the agent produced; merge it.
5. On a desktop, in the merged repository: `/slipway:launch` (resumable) completes the Azure prerequisites, GitHub secrets, environment and ruleset, the foundation apply, and the first CI/CD with your approval.

## First-run checks (record here)
- **Done 2026-09-27, dry run** (owner, https://github.com/integranz/slipway/actions/runs/36347722889, inputs `repository=integranz/slipway-demo`, `ref=main`, no answers, `dry_run=true`): the prompt was built from the checkout version (1.7.0, 2641 bytes), the request was `{"repos":[{"url":"https://github.com/integranz/slipway-demo","startingRef":"main"}],"autoCreatePR":true}` plus the prompt, the API step was skipped as designed. The pipeline up to the API call works; nothing was started.
- (pending) The agent installs the plugin from the tag and `node "${CLAUDE_PLUGIN_ROOT}/scripts/options.cjs" --json` works.
- (pending) `launch --yes --until bootstrap` writes `.slipway/config.yaml` from detections plus the answers, or stops with the list of missing values.
- (pending) Cursor pushes the agent's commit and opens the pull request without the agent pushing (`workOnCurrentBranch: false`, `autoCreatePR: true`). If the PR does not appear, the fallback is `envVars` with a one-hour installation token for `gh pr create`.
- (pending) Docker availability in the cloud VM (drives whether the image claims are verified or UNVERIFIABLE).

## Proof
- (pending the owner's first dispatch: date/time UTC, workflow run URL, agent URL, PR URL, the agent's report)
