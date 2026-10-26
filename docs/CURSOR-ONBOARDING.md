# Cursor Cloud onboarding runbook — one repository, one agent run, one pull request (goal 7 tier)

The cheapest automation of the onboarding: a human (or a `workflow_dispatch`) starts **one Cursor Cloud Agent** on a repository that slipway does not deliver yet. The agent installs the plugin at a pinned version, runs `/slipway:launch --yes --until bootstrap`, drafts a Dockerfile where a custom stack needs one, commits on its branch, pushes it and opens the pull request with the human steps in the body (the workflow opens it from the pushed branch if the agent cannot). A human reviews the PR, and after the merge runs `/slipway:launch` once on a desktop to complete the human-only phases (Azure prerequisites, GitHub secrets and environment, foundation apply). Nothing here holds a cloud credential.

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
   - Repository permissions, nothing else: Contents **Read-only**; Issues **Read and write**; Pull requests **Read and write**; **Administration: Read and write** (the poller creates the deployment environment with its required reviewers and the pull-request ruleset at dispatch; since 1.11.0); Metadata Read-only (added automatically). Organization permissions: none.
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
5. **Never**: a classic token (too broad), the `GITHUB_MCP_TOKEN` value, or a token with Secrets or Actions-write permissions on the organisation's repositories (nothing here needs them; Administration is needed only for environments and rulesets). Rotate by generating a new token and repeating step 2; the old one can be revoked immediately.

## Automatic onboarding: the scheduled poller (1.9.0)
`.github/workflows/onboard-poller.yml` runs `scripts/onboard-poller.cjs` every 15 minutes (cron `7,22,37,52 * * * *`, off the top of the hour where GitHub delays schedules) and on demand (`gh workflow run onboard-poller.yml -R integranz/slipway -f dry_run=true [-f repository=owner/name]`). It replaces the human who typed the dispatch; nothing else changes: `onboard.yml` still starts the one Cursor Cloud Agent and annotates the pull request.

What one tick does, deterministically and without an LLM, for every repository of the organisation:

| State | Detected by | Action |
|---|---|---|
| excluded (the poller's own repository, `ONBOARD_EXCLUDE`), archived, fork, empty default branch | repository metadata, `branches/<default>` | nothing |
| private | repository metadata | opens the issue `slipway onboarding` once, label `slipway-not-onboarded` (no environment protection on GitHub Free); closes it when the repository becomes public |
| onboarded | `.slipway/config.yaml` on the default branch | closes the onboarding issue if open; never touches the repository again |
| onboarding in progress | open issue labelled `slipway-onboarding` | nothing while a PR from `cursor/*` or `slipway/*` is open; otherwise waits 2 hours after the dispatch, re-dispatches once, then labels `needs-human` and stops |
| new `answers` block on the issue | fenced block tagged `answers` newer than the last dispatch | dispatches again with template + block as soon as the previous run has ended; removes `needs-human`; on a not-deployable issue the block overrides the detector |
| not deployable | open issue labelled `slipway-not-deployable` | re-runs the detector only when the default branch head changed; deployable now → relabels and dispatches |
| new | none of the above | detector on the recursive tree (`*.csproj`, `package.json`, `Dockerfile`, `pyproject.toml`, `requirements.txt`, `go.mod`, `pom.xml`, outside node_modules/vendor/dist/build/bin/obj) → deployable: opens the issue with the rendered answers, dispatches `onboard.yml`, comments the run link; not deployable: opens the issue with the reasons |

Retry after `needs-human`: add the missing or corrected values as an `answers` block on the issue (above); the next tick retries. A manual dispatch (`gh workflow run onboard.yml -R <org>/slipway -f repository=<owner>/<name> -f answers="$(cat answers.txt)"`) still works; the poller resumes when a pull request or `.slipway/config.yaml` exists. Closing the issue stops onboarding for that repository. **GitHub gates at dispatch (1.11.0).** Before it dispatches, the poller makes sure the repository is gated: the deployment environment (`github.cd_environment` from the answers, default `dev`) exists with required reviewers (`ONBOARD_REVIEWERS`, comma-separated logins; default: the token's owner) and deployments from the default branch only, and a pull-request-only ruleset `<default>: pull requests (slipway)` applies to the default branch (no required checks yet: the app names are unknown until the agent decides, and with the default `pr_checks: path-filtered` they must not be required; `/slipway:launch` adds them for `always-run-gate`). Both are created only when missing and reported in the dispatch comment. Without `Administration: write` on the token the comment says so and `/slipway:launch` creates them later. This closes the gap where GitHub auto-creates an unprotected environment on the first CD run. Limits and rules: at most `ONBOARD_MAX_DISPATCHES` (default 2) dispatches per tick; one tick at a time; a human who closes the onboarding issue stops the poller for that repository; every write to a target repository is an issue, a comment or a label. The step summary of each tick is the audit trail (repository, action, detail).

Setup (owner, once): the secret `ONBOARD_GITHUB_TOKEN` (already used by the annotation job) and the repository variable `ONBOARD_ANSWERS_TEMPLATE` on `<org>/slipway` with the organisation defaults, `<name>` standing for the repository name (`gh variable set ONBOARD_ANSWERS_TEMPLATE -R <org>/slipway --body "$(cat template.txt)"`). The template is where the organisation's sharing policy lives: the interview's registry discovery (`az acr list` + role checks) cannot run unattended, so **name the shared registry explicitly** once one exists, and create a registry per repository only while the subscription has none. Example for an organisation that already has one:
```
azure.location: westeurope
options.registry_scope: existing
azure.acr_name: <shared registry name>
azure.acr_resource_group: <its resource group>
azure.resource_group: rg-<name>-dev
azure.key_vault_name: kv-<name>-dev
azure.identity_name: id-<name>-dev
azure.state.resource_group: <shared state resource group>
azure.state.storage_account: <shared state storage account>
azure.state.container: tfstate
jira.site_url: https://<site>.atlassian.net
jira.project_key: <KEY>
options.tracker_transport: both
```
State storage can be shared too: every state key is prefixed with the project name. `<name>` renders as a hyphen slug (`my_app` → `my-app`) except for `azure.acr_name` and `azure.state.storage_account`, where Azure allows letters and digits only (`myapp`). The rendered answers are posted in the onboarding issue. Optional variables: `ONBOARD_MAX_DISPATCHES`, `ONBOARD_EXCLUDE` (comma-separated `owner/name`).

**Per-repository answers on the issue.** Anything the template cannot know for one repository goes into a comment on its `slipway onboarding` issue, as a fenced block tagged `answers`:
````
```answers
azure.resource_group: rg-taskflow-dev
apps[0].name: web
apps[0].health_path: /health
apps[0].env.TASKFLOW_API_URL: https://<backend host>
```
````
Blocks are merged over the template in chronological order (later keys win) and the final answers are posted with the dispatch. Rules: a block newer than the last dispatch makes the poller dispatch again as soon as the previous run has ended (the annotation job reports the end on the issue) and removes `needs-human`; the two-attempts limit restarts after each new block; on a `slipway-not-deployable` issue a block overrides the detector (give `apps[0].path`, kind, stack, port and health path). A frontend that joins its backend's resource group, as above, gets its own Key Vault, identity, logs and Container Apps environment in that group; only the group, the registry and the state storage are shared.

Caveats: the cron is every 15 minutes, but GitHub runs schedules on a best-effort basis and this repository has seen gaps of several hours between ticks (measured 2026-10-12); the poller therefore also ticks after every `onboard.yml` run (`workflow_run`), and a manual tick (`gh workflow run onboard-poller.yml`) is always available; GitHub disables scheduled workflows in a public repository after 60 days without repository activity (Actions → onboard-poller → Enable workflow); the token must stay valid (fine-grained tokens expire). Dry run read-only against the real organisation on 2026-10-06: `slipway` excluded, `slipway-demo` and `taskflow` onboarded, nothing dispatched.

## After the merge: Jira without a session
With `options.tracker_transport: rest` or `both` in the answers, the rendered repository carries `.github/workflows/slipway-tracker.yml`: when the onboarding pull request merges, it finds or creates the delivery story (`Onboard <name> to slipway delivery`) and closes the `Bootstrap <name>` and `Dockerize <app>` subtasks through the plugin's `jira-rest.cjs` (Jira Cloud REST v3, Basic auth). `_cd.yml` then keeps `Deploy <app> <tag> → <env>` current (In Progress at plan time, Done or In Review after apply and smoke), and the story auto-closes when no subtask is open. Credentials: organisation secret `JIRA_API_TOKEN` and variable `JIRA_EMAIL` (`gh secret set JIRA_API_TOKEN --org integranz --visibility all --body "$(pbpaste)"`, `gh variable set JIRA_EMAIL --org integranz --body <email>`, in your terminal). With `both`, the repository also declares the token-based `jira` MCP server (`uvx mcp-atlassian`) in `.cursor/mcp.json` for Cursor sessions; set `JIRA_EMAIL` and `JIRA_API_TOKEN` in the Cloud Agent **Secrets** tab so cloud sessions get Jira tools without a browser login. The onboarding run itself stays `--no-ticket`: the agent holds no Jira credential.

## Values the organisation template cannot know
The template covers organisation-wide names. Some repositories need per-repository values the code does not reveal: a health path when the app has no health route (frontends in particular), environment variables pointing at other systems (`apps[0].env.<NAME>`), a non-default app name. When the agent stops on such a value, its report lands on the onboarding issue; answer with a fenced `answers` block in a comment and the poller retries on its next tick (section "Automatic onboarding"). Product-level sharing is the same kind of value: a frontend that should live in its backend's resource group overrides `azure.resource_group` there, while the organisation template carries the shared registry and state storage for everyone. Give the app a health route that reports its version before onboarding it, because the deployed image must answer it anyway.

## Answers file
The interview values without a default must be given, one `key: value` per line; the agent treats them as answered. Example:
```
azure.location: westeurope
azure.resource_group: rg-<name>-dev
options.registry_scope: existing
azure.acr_name: <shared registry name>
azure.acr_resource_group: <its resource group>
azure.key_vault_name: kv-<name>-dev
azure.identity_name: id-<name>-dev
azure.state.resource_group: <shared state resource group>
azure.state.storage_account: <shared state storage account>
azure.state.container: tfstate
jira.site_url: https://<site>.atlassian.net
jira.project_key: <KEY>
options.tracker_transport: both
```
Omit what detections cover (apps, ports, health paths, default branch) and what has a default (`options.*` other than the ones you want to change). No ids, no secrets: the file ends up in the workflow summary and the agent transcript.

## Model
The request omits `model` by default, so Cursor resolves the account's default model (user, then team, then system). **Seen 2026-09-27** (run https://github.com/integranz/slipway/actions/runs/36347863337): that default resolved to `claude-opus-4-5`, which the API refused with `invalid_model` ("not available or invalid"). The workflow therefore defaults `model` to `claude-opus-5-5` (a strong model for a long, rule-heavy skill run; `claude-sonnet-5` is the cheaper choice, `claude-fable-5-1` the other frontier option); `-f model=<id>` overrides it, and an empty value falls back to the account default. Ids available to the owner's key on 2026-09-27 included `default` (an alias for the account default, the one that failed), `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `composer-2.5`, `gpt-5.6-*`, `gpt-5.5`, `gemini-3.x`, `grok-4.x`. A dry run with the key set lists the ids the key may use (`GET /v1/models`, read-only), and a failed real run with `invalid_model` prints the same list; from a terminal: `curl -sS -u "$CURSOR_API_KEY:" https://api.cursor.com/v1/models | jq -r '.items[].id'`.

## Choosing the target of the first real run
Pick a repository that slipway does **not** deliver yet: on a delivered one (`slipway-demo`, `taskflow`) the bootstrap finds `.slipway/config.yaml`, changes nothing and no onboarding PR appears. A small public test repository with one deployable app (a minimal .NET 8 API or an Express app with a Dockerfile, a `/health` route and a `PORT` variable) plus an answers file with the Azure and Jira identifiers is the right first target; it can be deleted afterwards.

## Steps
1. Once: create the Cursor API key (team admin → service account, or your own key) and store it: `gh secret set CURSOR_API_KEY -R <org>/slipway` in **your** terminal (the plugin guards deny secret writes from agent sessions). Also once: `ONBOARD_GITHUB_TOKEN` (section "Creating `ONBOARD_GITHUB_TOKEN`" above); for Jira the organisation secret `JIRA_API_TOKEN` + variable `JIRA_EMAIL` (see above); and for the hardened base images the organisation secret `DOCKERHUB_TOKEN` + variable `DOCKERHUB_USERNAME` (`gh secret set DOCKERHUB_TOKEN --org <org> --visibility all --body "$(pbpaste)"`, `gh variable set DOCKERHUB_USERNAME --org <org> --visibility all --body <username>`), so no repository needs its own copy and the first CI image build is green.
2. Dispatch: `gh workflow run onboard.yml -R integranz/slipway -f repository=integranz/<name> -f answers="$(cat answers.txt)"`. Add `-f dry_run=true` to see the request without starting an agent.
3. Follow the run: `gh run watch -R integranz/slipway`; the step summary shows the prompt and the agent link.
4. Review the pull request the agent produced; merge it.
5. On a desktop, in the merged repository: `/slipway:launch` (resumable) completes the Azure prerequisites, GitHub secrets, environment and ruleset, the foundation apply, and the first CI/CD with your approval.

## First-run checks (record here)
- **Done 2026-09-27, first real dispatch (failed at the API, as designed to fail loudly)**: run https://github.com/integranz/slipway/actions/runs/36347863337 on `integranz/slipway-demo` without `model` → HTTP 400 `invalid_model` for the account's default `claude-opus-4-5`; no agent started. Fix: models listed by the dry run and by the failure path; retry with the workflow default `claude-opus-5-5` (or `-f model=<id>`) on a repository slipway does not deliver yet.
- **Done 2026-09-27, dry run** (owner, https://github.com/integranz/slipway/actions/runs/36347722889, inputs `repository=integranz/slipway-demo`, `ref=main`, no answers, `dry_run=true`): the prompt was built from the checkout version (1.7.0, 2641 bytes), the request was `{"repos":[{"url":"https://github.com/integranz/slipway-demo","startingRef":"main"}],"autoCreatePR":true}` plus the prompt, the API step was skipped as designed. The pipeline up to the API call works; nothing was started.
- (pending) The agent installs the plugin from the tag and `node "${CLAUDE_PLUGIN_ROOT}/scripts/options.cjs" --json` works.
- (pending) `launch --yes --until bootstrap` writes `.slipway/config.yaml` from detections plus the answers, or stops with the list of missing values.
- **Answered 2026-10-11: Cursor does not publish on its own.** With the agent told not to push, the run finished with the commit left in the VM and `autoCreatePR` did nothing. The agent now pushes and opens the PR itself (`gh` is authenticated in the cloud VM); the workflow opens it from the branch as a fallback.
- (pending) Docker availability in the cloud VM (drives whether the image claims are verified or UNVERIFIABLE).
- (pending) The `annotate` job finds the PR URL in the run's `git.branches[].prUrl`, posts the human-steps comment and adds the label (needs `ONBOARD_GITHUB_TOKEN`).
- **Done 2026-10-12, Jira from the workflow**: on the merge of `taskflow-app#4` (09:38Z), `slipway-tracker.yml` (run 38231204979) authenticated with the organisation `JIRA_API_TOKEN` + `JIRA_EMAIL` and, through `jira-rest.cjs`, created the story **DEVOPS-18** `Onboard taskflow-app to slipway delivery`, created and closed **DEVOPS-19** `Bootstrap taskflow-app` and **DEVOPS-21** `Dockerize web`, all read back as Done. **Finding**: closing the first subtask auto-closed the story, and the next call's lookup by title ignores closed stories, so it created a second story **DEVOPS-20** for the Dockerize subtask. Fix (1.10.2): the generated workflow resolves the story key once (`story ensure --json`) and passes `--story` to every call, closes subtasks with `--no-autoclose`, and ends with `story autoclose`. DEVOPS-20/21 can be re-parented or deleted by hand.
- **Done 2026-10-07, poller dry run on GitHub Actions** (owner, https://github.com/integranz/slipway/actions/runs/37651632401, after setting `ONBOARD_ANSWERS_TEMPLATE`): token and template accepted, `3 repositories, 0 dispatched`; `integranz/slipway` → skip (excluded), `slipway-demo` and `taskflow` → skip (onboarded). The tick before it (run 37650892481) failed loudly on the missing template variable, as designed, and wrote nothing.
- **Done 2026-10-07/08, poller on a new repository** (`integranz/taskflow-app`, imported 17:33Z, content on `main` after its first PR merged): the first tick after that (21:22Z) detected `package.json`, opened issue #2 with the rendered answers and dispatched (run 37688999166, agent `bc-0a826fbf…`); the agent **finished in 8 minutes without a pull request and without pushing a branch**; the poller re-dispatched after 2 h (run 37712071596, agent `bc-8344da1a…`, same outcome) and labelled `needs-human` at 07:31Z. Two gaps found and fixed in 1.9.1: the prompt told the agent to create `slipway/onboard`, while Cursor pushes only the branch it created (now: commit on the current branch, never switch); and the agent's final report stayed in the Cursor transcript (now: the annotation job posts the run's `result` on the onboarding issue, with the PR link when there is one). Root cause, read from the first transcript (`bc-0a826fbf…`): the agent **stopped before writing anything, as the unattended rule requires**, because two values were neither detectable nor in the answers: `apps[0].health_path` (a Next.js 16 frontend with no health route of its own; every `/health` in the code calls the backend) and `apps[0].env.TASKFLOW_API_URL` (the backend's address lives in another repository). It had found the app correctly (kind frontend, stack custom, port 3001 from `next start -p 3001`, `npm test` 34/34). So the branch rule was not the trigger this time; nothing was written, hence no branch. Observation: only one scheduled tick ran between 17:30Z and 21:22Z; GitHub may delay or drop scheduled runs.
- **Done 2026-10-11, answers block → retry** (`taskflow-app` issue #2): the owner commented an `answers` block at 14:50Z; the 14:52Z tick dispatched with template + block (run 38148965267, agent `bc-2f2f269a…`) and removed `needs-human`; the agent wrote `.slipway/config.yaml` and 41 generated files, drafted a hardened Node 22 Dockerfile (non-root, `VERSION`/`COMMIT` build args, `next start` on 3001), ran the tests (37/37) and committed on Cursor's branch `cursor/slipway-onboarding-taskflow-app-293c`. **Finding: nothing was pushed and no pull request appeared.** The prompt forbade pushing and Cursor did not publish the commit on its own (`autoCreatePR` did not act); the run's report reached the issue through the annotation job. Fix (1.10.1): the agent pushes its branch and opens the pull request itself (`gh pr create`, which is authenticated in the cloud VM) with the human steps in the body; the workflow opens the PR from the pushed branch when the agent cannot. Recovery for this run (done 2026-10-11): a follow-up message to the agent in the Cursor dashboard ("push the current branch and open the pull request") published the existing commit as `integranz/taskflow-app#4` (`slipway: onboard taskflow-app`, 42 files, body = the onboarding report) without a new run. The agent's PR tool opened it as a **draft** by default; the prompt now asks for a ready-for-review pull request.
- **Done 2026-10-12, the onboarding pull request is real and green**: `integranz/taskflow-app#4` (`slipway: onboard taskflow-app`, 42 files, body = the agent's report) marked ready for review by the owner; after the Docker Hub credentials were set (`DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, the first human row of `SETUP.md`) the CI on the PR passed: `web test`, `web / version`, **`web / image` built the agent's Next.js Dockerfile in 2 minutes** (the image claims the cloud agent had to leave UNVERIFIABLE are now verified by CI), `web ci` gate green; mergeable. Reviewed by the plugin maintainer: config matches the answers, Dockerfile hardened and non-root, no secrets or ids, `.slipway/.env.example` placeholders only.
- (pending) A new repository onboarded end to end with the 1.10.1 prompt (the agent opens the PR itself, ready for review) and no follow-up message; a docs-only repository gets the not-deployable issue; a second tick changes nothing.

## Proof
- (pending the owner's first dispatch: date/time UTC, workflow run URL, agent URL, PR URL, the agent's report)
