# slipway — the Agentic Delivery Lifecycle plugin for Claude Code and Cursor

A slipway exists to launch a ship. **slipway** takes a repository from source to a verified, tracked deployment on Azure Container Apps with one command, and keeps every step honest: humans approve every cloud change, secrets never enter the conversation, nothing is claimed without evidence. Version **1.0** froze the review contents on 2026-09-22; **1.1** adds installation in Cursor without changing what 1.0 delivers.

This repository is the plugin source (`plugins/slipway`) and its marketplace for both hosts: Claude Code reads `.claude-plugin/marketplace.json`, Cursor reads `.cursor-plugin/marketplace.json`; both point at the same plugin directory. The reference consumer is [`integranz/slipway-demo`](https://github.com/integranz/slipway-demo).

- [Install in Claude Code](#install-in-claude-code) · [Install in Cursor](#install-in-cursor) · [Usage guide](#usage-guide) · [Commands](#commands) · [Approvals, secrets, tracking](#approvals-secrets-and-tracking) · [Troubleshooting](#troubleshooting) · [Develop](#develop-and-release)

## Install in Claude Code

In Claude Code, slipway is a plugin with skills (`/slipway:…` commands), guard hooks, sub-agents and MCP server declarations. Requirements on the machine: Claude Code, `git`, `gh`, `az`, `docker`, `terraform`, `node`, plus the app toolchains (`dotnet`, `npm`) and `nbgv` for repositories using Nerdbank.GitVersioning.

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

## Install in Cursor

slipway is also a Cursor plugin (Cursor Plugin format: `plugins/slipway/.cursor-plugin/plugin.json`). The same skills, the same guard hooks through adapters, read-only `explore`/`verify` and a writing `execute` subagent, the three MCP server declarations, and one always-on rule that maps Claude Code wording (`${CLAUDE_PLUGIN_ROOT}`, `AskUserQuestion`, `Agent`) onto Cursor. Requirements on the machine are the same as for Claude Code, plus `python3` (the hook adapters use it) and `rsync` for the local install script.

**Team marketplace (Cursor Teams)** — Dashboard → Plugins & MCPs → Team Marketplaces → Add Marketplace → *Import from Repo* with `https://github.com/integranz/slipway`; Cursor finds `.cursor-plugin/marketplace.json` and lists **slipway**. Turn on *Auto Refresh* so a merge to `main` updates the plugin (requires the Cursor GitHub App on the repository; at most one re-index every 10 minutes); otherwise click *Refresh*. Then install the plugin from the marketplace and confirm its components under Settings → Plugins.

**On your machine (required for the guards)** — from a checkout:
```
npm run install:cursor-local          # ~/.cursor/plugins/local/slipway + the guard hooks in ~/.cursor/hooks.json
```
Cursor 3.21 does not load hooks from an installed plugin (they sit behind a feature gate tied to third-party plugin import, which team admins can disable), so the script also registers the plugin's hook adapters in your user hooks file, merging with whatever is there. Reload Cursor (*Developer: Reload Window*) and check Settings → Plugins for slipway's skills, rules, subagents and MCP servers. Cursor Teams admins must allow *Local Plugin Imports* for the plugin folder; the hooks file works regardless. Re-run after every plugin update; `npm run install:cursor-local -- --uninstall` removes the folder and only slipway's hook entries. Repositories delivered by slipway also carry `.cursor/hooks.json` and `.slipway/cursor-hooks.sh`, which route to the installed plugin (and allow everything, with a warning at session start, on a machine without it).

**Commands** — Cursor has no plugin namespace, so the skills are `/launch`, `/bootstrap`, `/dockerize <app>`, `/plan <env> --layer …`, `/deploy <app> <tag> <env>`, `/verify <app> <env> <tag>` and `/ticket …` with the same arguments as the `/slipway:` commands below. A session-start hook tells the agent where the plugin lives; skill scripts run from that path.

**Check the guards are loaded**: in an Agent session ask *"run this in the terminal and show me the output: `echo approve-apply-probe && date`"*. The command must be **blocked** (the message starts with `slipway guard:`). The `&& date` part matters: a model that merely answers the text `approve-apply-probe` without running a terminal command has not exercised the hook at all (seen on 22 Sep). If the command really runs and prints, the hooks are not active: run `npm run install:cursor-local`, look at the *Hooks* output channel (`Loaded 5 user hook(s)` must appear), and do nothing sensitive in that session.

**What differs in Cursor**
| Topic | Claude Code | Cursor |
|---|---|---|
| Foundation `terraform apply` | attended session: forced permission prompt with the plan summary; unattended: approval token | always the approval token: you run `bash <plugin-root>/scripts/approve-apply.sh <planfile>` in your own terminal, then the agent applies (Cursor documents the hook `ask` decision as not enforced, so a prompt cannot be relied on) |
| Cloud/GitHub administration, secret writes | forced prompt naming the action | the hook returns `ask` with the reason; Cursor's own command approval is the gate. Do not run slipway with auto-run ("Run Everything") enabled |
| Read-only sub-agents | hook blocks mutating commands by `agent_type` | `readonly: true` in the subagent definition (Cursor sends no agent type to hooks) |
| Seed file `.slipway/.env` | Read tool denied, printing denied | `beforeReadFile` denies the read, shell guards deny printing |
| MCP servers | `.mcp.json`, authorised with `/mcp` | `cursor/mcp.json`, authorised in Settings → MCP (same Atlassian, GitHub and Azure servers) |
| Cursor Automations | — | a PR-review automation on `slipway-demo` reviews every pull request against `AGENTS.md`; see `docs/CURSOR-AUTOMATION.md` |

**About `.cursor/scripts/cloud-agent-install.sh`**: Cursor Cloud Agents work in a fresh VM built from an environment definition (`.cursor/environment.json` in the repository, or a personal or team saved environment in the Cloud Agents dashboard). Both let you name an *install script* that Cursor runs while building the VM so dependencies exist before the agent starts. This script is that install step for **this** repository: `npm ci` and the Claude Code CLI, which `npm run validate:plugin` needs. You never run it yourself, and it does nothing for local Cursor use.

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
- **Secrets never enter the transcript.** Identifiers are written by `setup-azure.sh`; real secrets come from your clipboard (`gh secret set NAME --body "$(pbpaste)"`) or the gitignored seed file `.slipway/.env` (copy of `.slipway/.env.example`), which is only ever sourced. The hooks refuse to print or read it and refuse to echo secret-named variables. Runtime secrets reach the apps as Container Apps secrets backed by Key Vault (`apps[].secrets`); non-secret settings are environment variables (`apps[].env`). Their **values** are yours to provide once the foundation exists: put `VAR=…` in `.slipway/.env` and the launch writes each one with `az keyvault secret set … --value "$VAR"` behind a prompt, or run that command in your own terminal; the guard refuses a literal value and refuses to read a value back, and no app can deploy until its secrets exist.
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
| Cursor: slipway lists fewer skills or subagents than expected | a frontmatter that is not strict YAML (Cursor drops the component silently; Claude Code accepts it) | `npm test` fails on it since 1.1.2 (strict-YAML frontmatter test); quote the `description` |
| Cursor: slipway missing from Settings → Plugins after `install:cursor-local` | window not reloaded, or local plugin imports disabled by the team admin | *Developer: Reload Window*; ask the admin to allow local plugin imports, or use the team marketplace import |
| Cursor: the probe prints `approve-apply-probe` | either the model answered the text without running a terminal command (no tool call, so no hook), or the hooks are not registered (Cursor 3.21 loads no plugin hooks) | ask for a real run (`echo approve-apply-probe && date`); check the *Hooks* output channel for `Loaded 5 user hook(s)`; otherwise `npm run install:cursor-local` |
| Cursor: "apply needs a human approval token" although you are watching | by design: Cursor cannot force a permission prompt from a hook | `bash <plugin-root>/scripts/approve-apply.sh <planfile>` in your terminal, then let the agent retry |
| Cursor: every shell command is blocked with "guard script missing" or "failed" | adapter cannot find or run the guards (moved folder, no `python3`) | reinstall with `npm run install:cursor-local`; install `python3` |

## Develop and release
```
npm ci
npm test                       # renderer, scaffold, verify, queue, ruleset tests + hook branch tests + Cursor format and adapter tests
npm run validate:plugin        # claude plugin validate --strict
npm run build:cursor           # regenerate cursor/agents/*.md and cursor/mcp.json from the Claude Code sources
npm run install:cursor-local   # copy the plugin to ~/.cursor/plugins/local/slipway for testing in Cursor
node plugins/slipway/scripts/options.cjs
node plugins/slipway/scripts/scaffold.cjs --repo <target> --dry-run
```
`main` is protected: changes arrive through pull requests with the `validate` check green; only the `slipway-release` GitHub App pushes directly, for the release commit. Releases: semantic-release from Conventional Commits on `main` (`fix:` → patch, `feat:` → minor); the `next` branch publishes pre-releases (`x.y.z-next.N`) for work that must not touch the review line yet. Both plugin manifests (`.claude-plugin`, `.cursor-plugin`) receive the version. Design and decisions: `docs/DECISIONS.md`, `docs/PIPELINES-PER-APP.md`, `docs/HOOKS.md`, `docs/MCP-INTEGRATION.md`, `docs/COMMAND-CATALOG.md`. License: MIT, © 2026 Abdelazim Ali.
