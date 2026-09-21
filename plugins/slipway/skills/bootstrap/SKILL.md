---
name: bootstrap
description: Use when the user asks to onboard, containerise, "set up delivery", CI/CD, deployment or infrastructure for a repository, to run the ADLC intake, or to change delivery options (cloud, compute, registry, runner, versioning, branching, tracker, secret store, base image). Interviews the user for the options that shape generated files, classifies the apps with the explore sub-agent, writes .slipway/config.yaml, scaffolds the repo-side files deterministically and opens a tracking ticket.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Read, Glob, Grep, Write, Edit, Agent, AskUserQuestion, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/options.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.cjs" *), Bash(git status *), Bash(git rev-parse *), Bash(git remote *), Bash(git diff *)
---

# /slipway:bootstrap — intake, classification, scaffold, ticket

Turns a repository into a slipway-managed repository: `.slipway/config.yaml` (single source of truth), `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, path-scoped rules, and the per-option files: shared reusable workflows (`_ci.yml`, `_cd.yml`), **one CI and one CD workflow per app** (`<prefix>-<app>-ci.yml`, `<prefix>-<app>-cd.yml`), one Terraform root module per app (`infra/apps/<app>`), one `version.json` per app, Dockerfiles. Everything generated comes from templates rendered by a script; you never hand-write generated files.

Arguments: `$ARGUMENTS` may contain `--cloud`, `--compute`, `--registry`, `--runner`, `--versioning`, `--branching`, `--tracker`, `--secret-store`, `--base-image` (pre-answer an interview question), `--stack <app>=<stack>` (override a detected stack), `--yes` (accept detections and defaults without asking; requires that every needed value is present or defaulted), `--no-ticket`, `--force` (overwrite generated files).

## Preconditions (check, do not assume)
1. You are at a git repository root: `git rev-parse --show-toplevel` equals the working directory. If not, stop and say which directory to open.
2. Plugin scripts are reachable: `node "${CLAUDE_PLUGIN_ROOT}/scripts/options.cjs" --json` prints the option registry. If it fails, stop; the plugin install is broken, do not improvise a scaffold.
3. Decide the mode:
   - **New**: no `.slipway/config.yaml` → full interview.
   - **Update**: `.slipway/config.yaml` exists → validate it, show the current options table, ask only what the user wants to change (or nothing if `--yes`), then re-scaffold. Never re-ask questions whose answers are already in the file.
   - **Non-interactive** (`--yes`, or a session with no prompt UI such as a Routine or cloud run): use the existing config, or detections plus the *defaults defined below*; if any value without a default is missing, print the list of missing values and **stop before Step 3 with nothing written**. `templates/common/slipway/config.example.yaml` is a **shape reference only**; its values (names, owner, site, keys) are never defaults.

### What has a default and what does not
| Value | Default | Source |
|---|---|---|
| `project.name` | repository directory name, lower-cased, kebab-case | filesystem |
| `options.*` | first `implemented` option of each dimension, filtered by `depends_on` | `options.cjs --json` |
| `environments` | `[dev]` | fixed |
| `github.owner` / `github.repo` | parsed from `git remote get-url origin` **only if** the host is `github.com`; otherwise none | git |
| `github.default_branch` | current default branch | git |
| `apps[*]` | explore agent detections **only** where kind, stack, port and health path all have evidence | Step 1 |
| `azure.location`, `azure.resource_group`, `azure.acr_name`, `azure.key_vault_name`, `azure.identity_name`, `azure.state.*` | **none** | interview |
| `jira.site_url`, `jira.project_key` (or the equivalent block for another tracker) | **none** | interview |
| `azure.subscription_id`, `azure.tenant_id` | omitted (env vars at runtime) | — |
| `options.cd_trigger`, `options.pr_checks` | `manual`, `path-filtered` (both are questions in the interview; the recommended pair for a protected default branch is `on-ci-success` + `always-run-gate`) | `options.cjs --json` |
| `pipelines.name_prefix` | `github.repo` (workflow names `<prefix>-<app>-ci` / `-cd`) | git |
| `shared_paths` | `[]` (the shared workflow files are always inputs of every app) | interview |
| `apps[*].paths` | .NET `ProjectReference`s outside the app path are detected automatically; other shared inputs (a root `Directory.Build.props`, a shared config folder) come from the interview | detection + interview |
| `apps[*].version` | `0.1` (initial `version.json` version; never rewritten) | interview when migrating from an existing version |

## Step 1 — Discover the apps (explore sub-agent)
Delegate to the `explore` sub-agent with this brief, verbatim except for the repo path:

> Inventory the deployable applications in `<repo root>`. For each, report: path (directory containing the project/manifest), kind (`api` = serves HTTP for other systems, `frontend` = browser UI, `worker` = no ingress) with the evidence for the kind, stack (`dotnet8-api`, `react-vite`, `node-ts-api`, `python-api`, or "other: <what you see>"), exposed port and where it is declared, health path if any route like `/health`, `/healthz`, `/ready` exists, and the test command that actually works from the repo root. Also report: existing `Dockerfile*`, `.github/workflows/*`, `infra/**/*.tf`, `version.json`, `.releaserc*`, and the default branch. Return the App inventory table and the Unknowns list; do not guess ports or health paths.

Treat the result as a proposal. Anything under "Unknowns" becomes an interview question.

## Step 2 — Interview (only what changes generated files)
Load the registry with `node "${CLAUDE_PLUGIN_ROOT}/scripts/options.cjs" --json`. Rules:
- Offer **only options with `status: implemented`** as selectable. List `planned` and `later` options in the question text as "planned, not selectable yet" so the user knows the roadmap; if they insist on one, refuse politely and record the request in the ticket.
- Honour `depends_on`: filter compute/registry/secret_store options by the chosen cloud.
- Pre-fill from arguments, then from detections (e.g. a `version.json` → `nbgv`, a `.releaserc` → `semantic-release`, `*.csproj` → `dotnet8-api`, `package.json` with `vite` → `react-vite`), then from the defaults table above. Any other language or a Node API gets `stack: custom` (bring your own Dockerfile; see `delivery-knowledge/references/stack-custom.md`): if no Dockerfile exists, propose one and ask before writing it. `node-ts-api`, the configuration scanner and database provisioning are planned for 1.1: say so when they come up, never pretend they exist.
- An app that is the whole repository gets `path: .`, must be the only app, and is named after its role (`api` for a service) so workflows read `<repo>-api-ci`. Ask for `test_services` (for example a PostgreSQL) and `test_env` when the tests need a database; detected `process.env`/`IConfiguration` keys that look like secrets (`*TOKEN*`, `*PASSWORD*`, `*SECRET*`, `*CONNECTION*`, `DATABASE_URL`) go to `apps[].secrets` (Key Vault references), the rest to `apps[].env`; confirm the split with the user. Ask only where a real choice remains, the detection is uncertain, or the value has no default. Never invent cloud resource names, tracker sites or project keys.
- Ask with `AskUserQuestion`, at most four questions per call, grouping: (a) platform options, (b) cloud identifiers and resource names, (c) apps to confirm (kind, port, health path, test command per app), (d) tracker details and environments.
- Resource names must satisfy the schema patterns (see `templates/common/slipway/config.schema.json`): ACR 5–50 alphanumerics, Key Vault 3–24 chars starting with a letter, storage account 3–24 lowercase alphanumerics, project name lowercase kebab-case. Propose compliant names derived from the project name; the user can override.
- Cloud subscription and tenant ids are **optional** in the file; prefer leaving them out of a public repo and relying on `ARM_SUBSCRIPTION_ID`/`AZURE_*` variables. Say so when asking.
- Pipelines: ask `cd_trigger` (does an app deploy to `<cd_environment>` automatically after a green CI on the default branch? the human approval stays) and `pr_checks` (will the default branch require the per-app checks? then `always-run-gate`). Ask for **shared inputs**: paths outside an app that change its build (shared libraries, root build props). Detected .NET references are shown, not asked. Explain that a shared path triggers and versions every app that lists it, and that a repository-level `version.json` is replaced by one file per app.
- `versioning=semantic-release` is selectable only for a single-app repository; with several apps say that per-app semantic-release tags are planned and offer `nbgv`.
- Tracking (group d): `tracker` (`jira` or `none`); with `jira`: the site URL and **project key** (existing project), the **epic** to attach the delivery story to (optional; validate the key exists and is an Epic when given), and the **story**: attach to an existing story key or create `Onboard <project> to slipway delivery`. Explain the model in one sentence: one story per delivery, one subtask per unit of work, the story closes itself when every subtask is done; later change requests get a new story named in `jira.story_key`. Tracking is never a blocker: `none` disables it and an unreachable Jira queues updates.

## Step 3 — Write and validate the config
1. Write `.slipway/config.yaml` following `templates/common/slipway/config.example.yaml` exactly in shape (`schema_version: 1`, `project`, `options`, cloud block, `github`, tracker block, `environments`, `pipelines`, `shared_paths`, `apps`, `cursor_mirror`). Each app needs `name`, `path`, `kind`, `stack`, `image_repository` (`<project>/<app>`), and for `api`/`frontend` also `port` and `health_path`; add `upstreams` for a frontend that proxies to an API, `paths` for shared inputs outside the app, `version` for the initial per-app version. App paths must be disjoint (one pipeline pair per app).
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.cjs" .slipway/config.yaml`. On any error, fix the file and re-run; never proceed with an invalid file and never edit the schema or registry to make it pass.
3. Show the user the resulting options table and app table and ask for a one-word confirmation unless `--yes`.

## Step 4 — Scaffold (execute sub-agent optional)
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.cjs" --repo . --dry-run`, show the file list, then run it without `--dry-run` (add `--force` only if the user asked for it). The script is two-phase: if it prints a template error, nothing was written; report the error verbatim and stop. If it reports "no repo-side templates for" some options, that is expected while those option templates are still being built; say which files will appear later (workflows, infra, Dockerfiles).

Do not edit generated files by hand afterwards. If something is wrong in a generated file, the fix belongs in the plugin's templates.

**Update mode from the combined layout** (plugin < 0.13.0: `ci.yml`, `cd.yml`, `infra/app`, root `version.json`): the scaffold prints a `legacy` line and never deletes. Hand the removal and the state cutover to the human/`execute` agent as described in the plugin's `docs/PIPELINES-PER-APP.md` (import blocks for the environment and each container app, human-gated applies, then `terraform state rm` in the old module). `version.json` files that already exist keep their `version`; only `pathFilters` and `release.tagName` are refreshed.

## Step 4b — Cloud prerequisites (attended sessions)
After the scaffold, run the dry run `bash .slipway/setup-azure.sh` and show what it would create. Ask with `AskUserQuestion` whether to apply now; on yes run `bash .slipway/setup-azure.sh --apply --set-github-secrets`. The guard hook forces a permission prompt naming the action; the human's answer to that prompt is the approval, and nothing else is needed (no separate terminal). In an unattended session (`--yes`, `-p`) the hook denies it: print the command for the human and continue. Re-run the dry run afterwards; it must report nothing to change. Everything beyond Azure (Docker Hub secret, GitHub environment, branch ruleset) belongs to `/slipway:launch`, which calls this skill as its first phase.

## Step 5 — Verify (verify sub-agent)
Delegate to the `verify` sub-agent these claims: `.slipway/config.yaml` validates (`validate-config.cjs` exit 0); `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/rules/precedence.md` exist and contain no `<%`; for every app `.github/workflows/<prefix>-<app>-ci.yml` and `-cd.yml`, `infra/apps/<app>/main.tf` and (nbgv) `<app path>/version.json` exist, and the CI `on.push.paths` equal the `version.json` `pathFilters`; `.claude/settings.json` is valid JSON naming the marketplace and plugin; every `.claude/rules/*.md` other than `precedence.md` has a `paths:` list in its frontmatter; `.gitignore` contains `.slipway/approvals/`, `*.tfvars` and `tfplan*`. Report the verdict table to the user.

## Step 6 — Ticket
Unless `--no-ticket` or `options.tracker: none`: `/slipway:ticket story create --title "Onboard <project> to slipway delivery"` (or `story set <KEY>` when the user named an existing story), then `/slipway:ticket subtask start "Bootstrap <project>"` and, once Step 5 is green, `/slipway:ticket subtask done "Bootstrap <project>" --message "<options table, app table, generated file count>"`. Record the story and subtask keys in the summary. If the tracker MCP is not connected, the ticket skill queues the updates and tells you; report `tracking: queued`, never a fake key, and continue.

## Output (always end with this)
```
## slipway bootstrap: <project> (<new|update>)
Options: <dimension=option, …>
Apps: <name (kind, stack, port, health)>, …
Generated: <n> files written, <n> skipped, <n> merged  |  Pending option templates: <list or none>
Verification: <n> confirmed / <n> refuted / <n> unverifiable
Tracking: story <KEY-123> (epic <KEY-1> | none), subtask <KEY-124> done | queued (n) | disabled
Next: /slipway:launch (everything else, end to end) or /slipway:dockerize <first app path>
```

## Do not
- Do not select a `planned` or `later` option, and do not silently substitute another option; explain and stop.
- Do not guess a port, health path, app kind, resource name, tracker site or project key that the explore agent or the user did not confirm; the example config is not a source of values.
- Do not hand-write or patch generated files; do not edit `options.yaml`, the schema or templates from a target repo.
- Do not commit, push, apply infrastructure, build or push images here; those are separate skills with their own guards.
- Do not put subscription ids, tenant ids, tokens or secrets into `.slipway/config.yaml` when the repo is public unless the user explicitly asks.
