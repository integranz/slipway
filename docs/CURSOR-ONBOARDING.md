# Cursor Cloud onboarding runbook — one repository, one agent run, one pull request (goal 7 tier)

The cheapest automation of the onboarding: a human (or a `workflow_dispatch`) starts **one Cursor Cloud Agent** on a repository that slipway does not deliver yet. The agent installs the plugin at a pinned version, runs `/slipway:launch --yes --until bootstrap`, drafts a Dockerfile where a custom stack needs one, and commits on a branch; Cursor pushes the branch and opens the pull request. A human reviews the PR, and after the merge runs `/slipway:launch` once on a desktop to complete the human-only phases (Azure prerequisites, GitHub secrets and environment, foundation apply). Nothing here holds a cloud credential.

Sources, read 2026-09-27: cursor.com/docs/cloud-agent/api/endpoints (`POST https://api.cursor.com/v1/agents`: `prompt.text`, `repos[{url, startingRef}]`, `autoCreatePR`, `model.id`; Basic auth `-u KEY:` with a user or team service-account key; when `workOnCurrentBranch` is false, Cursor pushes the agent's commits to an auto-generated `cursor/…` branch); cursor.com/docs/agent/hooks (cloud agents run only the repository's command hooks; a repository without `.cursor/hooks.json` has no guards, which is why the agent gets no credential); the assessment in `docs/NON-INTERACTIVE-TIERS.md` (headless onboarding, parked).

| Field | Value |
|---|---|
| **Trigger** | `gh workflow run onboard.yml -R integranz/slipway -f repository=<owner/name> [-f ref=main] [-f answers="$(cat answers.txt)"]`, or the same prompt pasted at cursor.com/agents |
| **Scope** | one repository per run; the agent starts from `ref` (its default branch) |
| **Identity** | the Cursor account behind `CURSOR_API_KEY` (team service account recommended: PRs by `cursor`, billed to the team pool) |
| **Secrets** | On `integranz/slipway` only: `CURSOR_API_KEY` (calls the Cloud Agents API) and `ONBOARD_GITHUB_TOKEN` (fine-grained token with Pull requests: write, Issues: write, Contents: read, Metadata: read on the organisation's repositories; used by the `annotate` job to comment and label the PR). The agent receives **no** credential: no Azure, no GitHub token, no Jira |
| **Prompt** | `bash scripts/onboard-prompt.sh <owner/name> --ref <branch> --version <plugin version> [--answers <file>]` |
| **Output / review path** | one pull request titled `slipway: onboard <name>` with `.slipway/config.yaml`, `AGENTS.md`, `CLAUDE.md`, rules, per-app CI/CD workflows, Terraform modules, Dockerfiles; a report in the agent transcript. The workflow's `annotate` job waits for the run, finds the PR (`git.branches[].prUrl` of the run) and posts **the human steps as a PR comment**: merge, `bash .slipway/setup-azure.sh --apply --set-github-secrets` in your terminal, then `/slipway:launch` on a desktop for the remaining phases, with the branch's `.slipway/SETUP.md` folded in; label `slipway-onboarding`. A human reviews and merges |
| **Guardrails** | the prompt limits the run to preflight + bootstrap; the agent is told to print human-only commands instead of running them. The first run has no repository hooks yet (the scaffold adds them), so the guarantee is the absence of credentials, not the hooks |
| **Monitoring** | the workflow step summary (prompt, agent id and URL), the agent transcript at cursor.com/agents, the PR |
| **Rollback** | close the PR and delete the branch; nothing was deployed or configured |

## Creating `ONBOARD_GITHUB_TOKEN` (owner, once)
A **fine-grained personal access token owned by the organisation**, used only by the workflows (`onboard.yml` annotation job, `onboard-poller.yml`). It is not the `GITHUB_MCP_TOKEN` that cloud agents receive for the GitHub MCP server: that one stays read-only (Actions: read) and lives in the Cloud Agent Secrets tab; this one can write issues and pull-request comments across the organisation and lives only as a GitHub Actions secret. `<org>` below is your GitHub organisation.

1. **Generate** (browser): profile picture → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Token name `slipway-onboarding`; description "slipway poller and PR annotation: issues and PR comments across the organisation".
   - Expiration: a date you put in your calendar. The poller stops silently when the token expires.
   - **Resource owner: `<org>`** (the organisation, not your personal account). Organisation owners need no approval; GitHub's default policy requires an owner's approval only for tokens of other members.
   - Repository access: **All repositories**, so repositories created later are covered.
   - Repository permissions, nothing else: Contents **Read-only**; Issues **Read and write**; Pull requests **Read and write**; Metadata Read-only (added automatically). Organization permissions: none.
   - Generate and copy the token once; it is shown only now.
2. **Store** (your terminal, token in the clipboard; agent sessions are denied secret writes by the plugin guards):
   ```
   gh secret set ONBOARD_GITHUB_TOKEN -R <org>/slipway --body "$(pbpaste)"
   ```
3. **If `<org>` is missing from the resource-owner list**: organisation → Settings → Third-party Access → Personal access tokens → fine-grained tokens must be "Allow access via fine-grained personal access tokens" (GitHub's default is enabled).
4. **Verify** before the first tick (token still in the clipboard; then clear the clipboard):
   ```
   GH_TOKEN="$(pbpaste)" gh api orgs/<org>/repos --jq '.[].full_name'                       # lists every repository
   GH_TOKEN="$(pbpaste)" gh api 'repos/<org>/<repo>/issues?per_page=1' --jq 'length'          # a number: issues readable
   GH_TOKEN="$(pbpaste)" gh api repos/<org>/<repo>/contents/.slipway/config.yaml --jq '.path'  # on an onboarded repo: .slipway/config.yaml
   ```
5. **Never**: a classic token (too broad), the `GITHUB_MCP_TOKEN` value, or a token with Administration or Secrets permissions (nothing here needs them). Rotate by generating a new token and repeating step 2; the old one can be revoked immediately.

## Automatic onboarding: the scheduled poller (1.9.0)
`.github/workflows/onboard-poller.yml` runs `scripts/onboard-poller.cjs` every 15 minutes (cron `7,22,37,52 * * * *`, off the top of the hour where GitHub delays schedules) and on demand (`gh workflow run onboard-poller.yml -R integranz/slipway -f dry_run=true [-f repository=owner/name]`). It replaces the human who typed the dispatch; nothing else changes: `onboard.yml` still starts the one Cursor Cloud Agent and annotates the pull request.

What one tick does, deterministically and without an LLM, for every repository of the organisation:

| State | Detected by | Action |
|---|---|---|
| excluded (the poller's own repository, `ONBOARD_EXCLUDE`), archived, fork, empty default branch | repository metadata, `branches/<default>` | nothing |
| private | repository metadata | opens the issue `slipway onboarding` once, label `slipway-not-onboarded` (no environment protection on GitHub Free); closes it when the repository becomes public |
| onboarded | `.slipway/config.yaml` on the default branch | closes the onboarding issue if open; never touches the repository again |
| onboarding in progress | open issue labelled `slipway-onboarding` | nothing while a PR from `cursor/*` or `slipway/*` is open; otherwise waits 2 hours after the dispatch, re-dispatches once, then labels `needs-human` and stops |
| not deployable | open issue labelled `slipway-not-deployable` | re-runs the detector only when the default branch head changed; deployable now → relabels and dispatches |
| new | none of the above | detector on the recursive tree (`*.csproj`, `package.json`, `Dockerfile`, `pyproject.toml`, `requirements.txt`, `go.mod`, `pom.xml`, outside node_modules/vendor/dist/build/bin/obj) → deployable: opens the issue with the rendered answers, dispatches `onboard.yml`, comments the run link; not deployable: opens the issue with the reasons |

Limits and rules: at most `ONBOARD_MAX_DISPATCHES` (default 2) dispatches per tick; one tick at a time; a human who closes the onboarding issue stops the poller for that repository; every write to a target repository is an issue, a comment or a label. The step summary of each tick is the audit trail (repository, action, detail).

Setup (owner, once): the secret `ONBOARD_GITHUB_TOKEN` (already used by the annotation job) and the repository variable `ONBOARD_ANSWERS_TEMPLATE` on `integranz/slipway` with the organisation defaults, `<name>` standing for the repository name (`gh variable set ONBOARD_ANSWERS_TEMPLATE -R integranz/slipway --body "$(cat template.txt)"`). Example:
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
options.tracker_transport: both
```
`<name>` renders as a hyphen slug (`my_app` → `my-app`) except for `azure.acr_name` and `azure.state.storage_account`, where Azure allows letters and digits only (`myapp`). The rendered answers are posted in the onboarding issue. Optional variables: `ONBOARD_MAX_DISPATCHES`, `ONBOARD_EXCLUDE` (comma-separated `owner/name`).

Caveats: latency up to 15 minutes plus GitHub's schedule delays; GitHub disables scheduled workflows in a public repository after 60 days without repository activity (Actions → onboard-poller → Enable workflow); the token must stay valid (fine-grained tokens expire). Dry run read-only against the real organisation on 2026-10-06: `slipway` excluded, `slipway-demo` and `taskflow` onboarded, nothing dispatched.

## After the merge: Jira without a session
With `options.tracker_transport: rest` or `both` in the answers, the rendered repository carries `.github/workflows/slipway-tracker.yml`: when the onboarding pull request merges, it finds or creates the delivery story (`Onboard <name> to slipway delivery`) and closes the `Bootstrap <name>` and `Dockerize <app>` subtasks through the plugin's `jira-rest.cjs` (Jira Cloud REST v3, Basic auth). `_cd.yml` then keeps `Deploy <app> <tag> → <env>` current (In Progress at plan time, Done or In Review after apply and smoke), and the story auto-closes when no subtask is open. Credentials: organisation secret `JIRA_API_TOKEN` and variable `JIRA_EMAIL` (`gh secret set JIRA_API_TOKEN --org integranz --visibility all --body "$(pbpaste)"`, `gh variable set JIRA_EMAIL --org integranz --body <email>`, in your terminal). With `both`, the repository also declares the token-based `jira` MCP server (`uvx mcp-atlassian`) in `.cursor/mcp.json` for Cursor sessions; set `JIRA_EMAIL` and `JIRA_API_TOKEN` in the Cloud Agent **Secrets** tab so cloud sessions get Jira tools without a browser login. The onboarding run itself stays `--no-ticket`: the agent holds no Jira credential.

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
options.tracker_transport: both
```
Omit what detections cover (apps, ports, health paths, default branch) and what has a default (`options.*` other than the ones you want to change). No ids, no secrets: the file ends up in the workflow summary and the agent transcript.

## Model
The request omits `model` by default, so Cursor resolves the account's default model (user, then team, then system). **Seen 2026-09-27** (run https://github.com/integranz/slipway/actions/runs/36347863337): that default resolved to `claude-opus-4-5`, which the API refused with `invalid_model` ("not available or invalid"). The workflow therefore defaults `model` to `claude-opus-5-5` (a strong model for a long, rule-heavy skill run; `claude-sonnet-5` is the cheaper choice, `claude-fable-5-1` the other frontier option); `-f model=<id>` overrides it, and an empty value falls back to the account default. Ids available to the owner's key on 2026-09-27 included `default` (an alias for the account default, the one that failed), `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `composer-2.5`, `gpt-5.6-*`, `gpt-5.5`, `gemini-3.x`, `grok-4.x`. A dry run with the key set lists the ids the key may use (`GET /v1/models`, read-only), and a failed real run with `invalid_model` prints the same list; from a terminal: `curl -sS -u "$CURSOR_API_KEY:" https://api.cursor.com/v1/models | jq -r '.items[].id'`.

## Choosing the target of the first real run
Pick a repository that slipway does **not** deliver yet: on a delivered one (`slipway-demo`, `taskflow`) the bootstrap finds `.slipway/config.yaml`, changes nothing and no onboarding PR appears. A small public test repository with one deployable app (a minimal .NET 8 API or an Express app with a Dockerfile, a `/health` route and a `PORT` variable) plus an answers file with the Azure and Jira identifiers is the right first target; it can be deleted afterwards.

## Steps
1. Once: create the Cursor API key (team admin → service account, or your own key) and store it: `gh secret set CURSOR_API_KEY -R integranz/slipway` in **your** terminal (the plugin guards deny secret writes from agent sessions). Also once: `ONBOARD_GITHUB_TOKEN` (section "Creating `ONBOARD_GITHUB_TOKEN`" above), and for Jira the organisation secret `JIRA_API_TOKEN` + variable `JIRA_EMAIL` (see above).
2. Dispatch: `gh workflow run onboard.yml -R integranz/slipway -f repository=integranz/<name> -f answers="$(cat answers.txt)"`. Add `-f dry_run=true` to see the request without starting an agent.
3. Follow the run: `gh run watch -R integranz/slipway`; the step summary shows the prompt and the agent link.
4. Review the pull request the agent produced; merge it.
5. On a desktop, in the merged repository: `/slipway:launch` (resumable) completes the Azure prerequisites, GitHub secrets, environment and ruleset, the foundation apply, and the first CI/CD with your approval.

## First-run checks (record here)
- **Done 2026-09-27, first real dispatch (failed at the API, as designed to fail loudly)**: run https://github.com/integranz/slipway/actions/runs/36347863337 on `integranz/slipway-demo` without `model` → HTTP 400 `invalid_model` for the account's default `claude-opus-4-5`; no agent started. Fix: models listed by the dry run and by the failure path; retry with the workflow default `claude-opus-5-5` (or `-f model=<id>`) on a repository slipway does not deliver yet.
- **Done 2026-09-27, dry run** (owner, https://github.com/integranz/slipway/actions/runs/36347722889, inputs `repository=integranz/slipway-demo`, `ref=main`, no answers, `dry_run=true`): the prompt was built from the checkout version (1.7.0, 2641 bytes), the request was `{"repos":[{"url":"https://github.com/integranz/slipway-demo","startingRef":"main"}],"autoCreatePR":true}` plus the prompt, the API step was skipped as designed. The pipeline up to the API call works; nothing was started.
- (pending) The agent installs the plugin from the tag and `node "${CLAUDE_PLUGIN_ROOT}/scripts/options.cjs" --json` works.
- (pending) `launch --yes --until bootstrap` writes `.slipway/config.yaml` from detections plus the answers, or stops with the list of missing values.
- (pending) Cursor pushes the agent's commit and opens the pull request without the agent pushing (`workOnCurrentBranch: false`, `autoCreatePR: true`). If the PR does not appear, the fallback is `envVars` with a one-hour installation token for `gh pr create`.
- (pending) Docker availability in the cloud VM (drives whether the image claims are verified or UNVERIFIABLE).
- (pending) The `annotate` job finds the PR URL in the run's `git.branches[].prUrl`, posts the human-steps comment and adds the label (needs `ONBOARD_GITHUB_TOKEN`).
- (pending) After the merge, `slipway-tracker.yml` creates the story and closes the Bootstrap/Dockerize subtasks (needs the organisation `JIRA_*` credentials and `tracker_transport: rest|both` in the answers).
- (pending) The poller: a new public repository with a `package.json` or `Dockerfile` gets its `slipway onboarding` issue and a dispatch within one tick; a docs-only repository gets the not-deployable issue; a second tick changes nothing.

## Proof
- (pending the owner's first dispatch: date/time UTC, workflow run URL, agent URL, PR URL, the agent's report)
