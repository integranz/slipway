# slipway — the Agentic Delivery Lifecycle plugin for Claude Code

A slipway exists to launch a ship. **slipway** takes a repository from source to a verified, tracked deployment on Azure Container Apps with one command, and keeps every step honest: humans approve every cloud change, secrets never enter the conversation, nothing is claimed without evidence. Version **1.0.x** is the frozen review line; new capabilities land on the `next` channel.

This repository is both the plugin source (`plugins/slipway`) and its Claude Code marketplace (`.claude-plugin/marketplace.json`). The reference consumer is [`integranz/slipway-demo`](https://github.com/integranz/slipway-demo).

- [Install in Claude Code](#install-in-claude-code) · [Use with Cursor](#use-with-cursor) · [Usage guide](#usage-guide) · [Commands](#commands) · [Approvals, secrets, tracking](#approvals-secrets-and-tracking) · [Troubleshooting](#troubleshooting) · [Develop](#develop-and-release)

## Install in Claude Code

slipway is a Claude Code plugin: skills (`/slipway:…` commands), guard hooks, sub-agents and MCP server declarations. Requirements on the machine: Claude Code, `git`, `gh`, `az`, `docker`, `terraform`, `node`, plus the app toolchains (`dotnet`, `npm`) and `nbgv` for repositories using Nerdbank.GitVersioning.

**Per user (recommended, covers every session on the machine, background jobs included)**
```
claude plugin marketplace add integranz/slipway
claude plugin install slipway@slipway-marketplace
```

**Per repository** — a repository bootstrapped by slipway carries this in `.claude/settings.json`, so cloud sessions install the plugin automatically and local sessions get a project-scope install:
```json
{ "extraKnownMarketplaces": { "slipway-marketplace": { "source": { "source": "github", "repo": "integranz/slipway" } } },
  "enabledPlugins": { "slipway@slipway-marketplace": true } }
```

**Update** (both scopes exist when a repository enables the plugin too; sessions load the plugin at start, so restart afterwards):
```
claude plugin update slipway@slipway-marketplace                       # user scope
claude plugin update slipway@slipway-marketplace --scope project       # inside the repository
```

**Check the guards are loaded** before anything sensitive: in a session, `echo approve-apply-probe` must be **blocked** by `[plugin:slipway]`. If it prints, the plugin is not loaded in that session.

**Uninstall / rollback**: `claude plugin uninstall slipway@slipway-marketplace`; to pin an older version, install from a tagged checkout with `claude --plugin-dir <checkout>/plugins/slipway`.

**Develop against a checkout**: `claude --plugin-dir ./plugins/slipway` (restart the session after moving the checkout; the plugin is loaded at start).

## Use with Cursor

slipway is not a Cursor plugin, and Cursor does not load Claude Code plugins. What Cursor gets from a slipway repository today:

| Cursor feature | With slipway | Notes |
|---|---|---|
| `AGENTS.md` | generated and kept current by the scaffold | Cursor reads it natively as plain-markdown agent instructions (its documented alternative to `.cursor/rules`) |
| Rules | not generated | slipway's path-scoped rules live in `.claude/rules/*.md`, a Claude Code format; a `.cursor/rules/*.mdc` mirror is planned |
| Skills (`/slipway:…`) | not available in Cursor | Cursor loads Agent Skills from `.cursor/skills`, `.agents/skills` and, for compatibility, `.claude/skills` in the repository or your home folder, never from Claude Code's plugin cache. The `cursor_mirror` option in `.slipway/config.yaml` is reserved for a mirror and changes nothing yet |
| Guard hooks | not applicable | Cursor has its own `hooks.json` contract (`beforeShellExecution`, `beforeMCPExecution`, …); an adapter is planned. Until then, run slipway commands and applies in Claude Code |
| MCP servers | configurable by you | add the same servers to `.cursor/mcp.json` (Atlassian `https://mcp.atlassian.com/v2/mcp`, GitHub `https://api.githubcopilot.com/mcp/x/actions`, Azure `npx -y @azure/mcp@latest server start … --read-only`) |
| Cursor Automations | proven | a PR-review automation on `slipway-demo` reviews every pull request against `AGENTS.md`; see `docs/CURSOR-AUTOMATION.md` |
| Cloud Agents | environment ready on this repository | see below |

**The split that works today**: Cursor writes application code, Dockerfiles for `stack: custom`, docs and pull requests, and reviews them; Claude Code runs the delivery (`/slipway:launch`, approvals, verification, tracking).

**About `.cursor/scripts/cloud-agent-install.sh`**: Cursor Cloud Agents work in a fresh VM built from an environment definition (`.cursor/environment.json` in the repository, or a personal or team saved environment in the Cloud Agents dashboard). Both let you name an *install script* that Cursor runs while building the VM so dependencies exist before the agent starts. This script is that install step for **this** repository: `npm ci` and the Claude Code CLI, which `npm run validate:plugin` needs. You never run it yourself, and it does nothing for local Cursor use; the environment that references it was created from the Cloud Agents dashboard when the "set up my environment" agent opened its pull request.

## Usage guide

### 1. One command: `/slipway:launch`
In Claude Code, inside the repository to deliver:
```
/slipway:launch
```
The phases run in order and the command resumes from whatever exists, so you can run it again at any time:

| Phase | What happens | Where it stops for you |
|---|---|---|
| Preflight | tools, logins (`az`, `gh`, Docker Hub), repository secrets and variables, environment, ruleset, Azure prerequisites | prints the exact command for anything missing that only you can do (logins) |
| Bootstrap | inventory of the apps by the explore sub-agent, interview for the options that shape generated files, `.slipway/config.yaml`, scaffold, delivery story in the tracker | the interview; a pull request when the default branch is protected |
| Cloud prerequisites | `setup-azure.sh --apply --set-github-secrets`: Entra app registration with OIDC, state storage, resource group, least-privilege roles, identifier secrets | one permission prompt naming the action |
| GitHub | `DOCKERHUB_TOKEN` from your clipboard or the seed file, `DOCKERHUB_USERNAME`, the `dev` environment with you as reviewer, the branch ruleset | a prompt per write |
| Images | one hardened image per app, built and probed locally (health, version, non-root) | nothing, unless an app has no Dockerfile: the agent drafts one and asks |
| Foundation | `terraform plan` for registry, key vault, identity, logs and the Container Apps environment, then the apply | the prompt shows the plan summary; your answer is the approval |
| Release | push or merge; one CI per app builds only the apps whose inputs changed | your merge when the branch is protected |
| Deploy | one CD per app plans, waits at the `dev` environment, applies exactly the reviewed plan, smoke-tests | your approval, in the session or on GitHub |
| Verify and track | falsifiable claims per app written to `.slipway/evidence/<app>/<tag>.md`; the story's subtasks closed | nothing |

`--yes` runs without questions and stops with instructions at every step that needs a human; `--until <phase>` stops early; `--env <name>` targets another environment.

### 2. What gets generated
`.slipway/config.yaml` is the single source of truth. From it the scaffold renders: `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/rules/*`, `.slipway/SETUP.md`, `.slipway/setup-azure.sh`, `.slipway/.env.example`, `compose.yaml`, per app a Dockerfile (curated stacks) or the contract for yours (`stack: custom`), `<app path>/version.json` (NBGV, path-filtered), `.github/workflows/_ci.yml` and `_cd.yml` (shared stages), `<repo>-<app>-ci.yml` and `<repo>-<app>-cd.yml` (thin, path-filtered callers), `infra/foundation/` and `infra/apps/<app>/` (one Terraform root module and state per app). Re-render after a config change with `node <plugin>/scripts/scaffold.cjs --force`; generated files carry a header and must not be hand-edited.

### 3. Day-to-day
- A change to one app's inputs (its path, declared shared paths, its workflows, `infra/apps/<app>`) builds, versions and deploys that app only; a shared input rebuilds every app that lists it.
- Pull requests run every app's `changes` gate; untouched apps report skipped-and-passed, so the checks `<app> changes` and `<app> ci` can be required on the branch.
- A green CI on the default branch starts that app's CD (`cd_trigger: on-ci-success`), which waits for the environment approval; with `cd_approval: in-session`, `/slipway:deploy` asks you and approves through the GitHub API under your own account after a forced prompt.
- A new piece of work gets a new story: `/slipway:ticket story create --title "…" [--epic KEY]`; every skill then keeps one subtask per unit of work current, and the story closes itself when the last subtask is done.
- Verify after every deployment: `/slipway:verify <app> <env> <tag>`; commit the evidence through a pull request.

## Commands
| Command | Purpose | Example |
|---|---|---|
| `/slipway:launch` | everything end to end, resumable | `/slipway:launch --env dev` |
| `/slipway:bootstrap` | interview, config, scaffold, cloud prerequisites, story | `/slipway:bootstrap --cloud azure --compute aca` |
| `/slipway:dockerize <app>` | build and prove one app's image locally | `/slipway:dockerize api` |
| `/slipway:plan <env> --layer foundation\|apps/<app>` | Terraform plan, never apply | `/slipway:plan dev --layer foundation` |
| `/slipway:deploy <app> <tag> <env>` | dispatch or watch one app's CD to the approval and beyond | `/slipway:deploy api 0.2.6 dev` |
| `/slipway:verify <app> <env> <tag>` | falsifiable post-deployment claims, evidence file | `/slipway:verify web dev 0.2.6` |
| `/slipway:ticket …` | story, subtasks, comments, sync of queued updates | `/slipway:ticket show` |

Details, defaults and safety notes per command: `docs/COMMAND-CATALOG.md`.

## Approvals, secrets and tracking
- **Cloud changes need a human.** `terraform apply`, `setup-azure.sh --apply`, GitHub environment/ruleset/secret writes and deployment approvals are gated by hooks: in an attended session they force a permission prompt whose reason names the action and, for applies, shows the plan summary; in unattended sessions (`claude -p`, background jobs) they are denied, and a foundation apply needs a one-shot token created by a human with `scripts/approve-apply.sh <planfile>`. `terraform destroy`, `-auto-approve` and applies of `infra/apps/*` from a session are never allowed. `docs/HOOKS.md` lists every rule.
- **Secrets never enter the transcript.** Identifiers are written by `setup-azure.sh`; real secrets come from your clipboard (`gh secret set NAME --body "$(pbpaste)"`) or the gitignored seed file `.slipway/.env` (copy of `.slipway/.env.example`), which is only ever sourced. The hooks refuse to print or read it and refuse to echo secret-named variables. Runtime secrets reach the apps as Container Apps secrets backed by Key Vault (`apps[].secrets`); non-secret settings are environment variables (`apps[].env`).
- **Tracking never blocks.** Jira through the Atlassian Rovo MCP Server: one story per delivery, one subtask per unit of work, read-back after every write. `tracker: none` disables it; an unreachable Jira queues updates in `.slipway/tracking-queue.jsonl` for `/slipway:ticket sync`.
- **Immutable tags.** Images are `<repo>:<semver>` plus `sha-<short>`, never `latest`; git tags are `<app>/v<semver>`; a re-run of the same CI run reuses the image it already pushed.

## Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| `echo approve-apply-probe` prints instead of being blocked | plugin not loaded in this session | install at user scope, restart the session; check `--plugin-dir` paths |
| "No human approval found … unattended" on an apply | session is `-p` or a background job | run `scripts/approve-apply.sh <planfile>` in your terminal within 10 minutes, or use an attended session |
| `AADSTS50173` / `az` errors during verify | Azure CLI grant expired | `az login && az account set --subscription <id>` |
| "tracking: queued" | Atlassian MCP not authorised | `/mcp` → `atlassian`, then `/slipway:ticket sync` |
| Required check "Expected — Waiting for status" on a PR | per-app checks required with `pr_checks: path-filtered` | switch to `always-run-gate` and require `<app> changes` and `<app> ci` only |
| CI refuses "already exists in registry" on the first attempt | re-running a release build for an existing version | make a new commit; only a re-run of the same run may reuse a tag |
| Two plugin versions in `claude plugin list` | user and project scopes | update both (see Install) |

## Develop and release
```
npm ci
npm test                       # renderer, scaffold, verify, queue, ruleset tests + hook branch tests
npm run validate:plugin        # claude plugin validate --strict
node plugins/slipway/scripts/options.cjs
node plugins/slipway/scripts/scaffold.cjs --repo <target> --dry-run
```
`main` is protected: changes arrive through pull requests with the `validate` check green; only the `slipway-release` GitHub App pushes directly, for the release commit. Releases: semantic-release from Conventional Commits; `fix:` → 1.0.x on `main`, features on `next` → `1.1.0-next.N`. Design and decisions: `docs/DECISIONS.md`, `docs/PIPELINES-PER-APP.md`, `docs/HOOKS.md`, `docs/MCP-INTEGRATION.md`, `docs/COMMAND-CATALOG.md`. License: MIT, © 2026 Abdelazim Ali.
