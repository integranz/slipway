# slipway — Agentic Delivery Lifecycle plugin for Claude Code

**Version 1.0.0, contents frozen on 2026-09-22** for the Q3 review: what this version does is what the review packet, the clean-install test and the marketplace submission describe. Fixes may follow as 1.0.x; new capabilities (curated `node-ts-api`, the configuration scanner, database provisioning, Azure App Configuration) are planned for 1.1.

Takes a repository from "code in a repo" to "versioned image running in the cloud, verified, and tracked in a ticket", driven by skills, three role sub-agents and mechanical guardrail hooks.

Status: **day 5 of 16**. Guard hooks, role sub-agents, MCP servers, option registry, config schema, scaffold engine, `bootstrap`, `dockerize` and `plan` skills, Docker Hardened Images templates for `dotnet8-api` and `react-vite`, `compose.yaml`, the Terraform foundation and Container Apps layers (azurerm 5.x), the GitHub Actions CI and gated CD templates and all five command skills (`dockerize`, `plan`, `deploy`, `verify`, `ticket`) are in place and exercised on `integranz/slipway-demo` (0.1.16 deployed to `dev` after a human approval, verified 19/19, tracked to Done in Jira DEVOPS-5).

## Install
```
/plugin marketplace add integranz/slipway
/plugin install slipway@slipway-marketplace
```
Local development: `claude --plugin-dir ./plugins/slipway`.

## Uninstall / rollback
`/plugin uninstall slipway@slipway-marketplace`. To roll back, install a specific version from the marketplace commit history (`git checkout vX.Y.Z` in the marketplace repo and re-add it), or pin `ref` in your own marketplace entry.

## Skills (invoked as `/slipway:<name>`)
| Skill | Kind | Purpose |
|---|---|---|
| `launch` | command | The whole delivery in one command, resumable; stops only for human decisions and in-session approvals |
| `bootstrap` | user + model invoked | Intake interview → `.slipway/config.yaml` → classify apps → scaffold repo-side files → open ticket |
| `dockerize` | command | Write/refresh a hardened multi-stage Dockerfile for one app and prove it runs |
| `plan` | command | `terraform fmt/validate/plan` for one layer (`foundation` or `apps/<app>`); never applies |
| `deploy` | command | Trigger one app's CD for an immutable tag and monitor it (`deploy <app> <tag> <env>`) |
| `verify` | command | Falsifiable post-deploy checks; writes `.slipway/evidence/<app>/<tag>.md` |
| `ticket` | command | Epic → story → subtask tracking in the configured tracker, with read-backs and an offline queue; never blocks delivery |
| `delivery-knowledge` | model-invoked only | Reference knowledge per option (compute, versioning, base image, runner, secrets) |

## Data handling
The plugin reads `.slipway/config.yaml` and repository files. It sends nothing anywhere except through the MCP servers you enable (tracker, GitHub, Azure read-only) and the CLIs you already authenticate (`az`, `gh`, `terraform`, `docker`). Secrets are never written to the repo; hooks block it.

## Scripts
| Script | Purpose |
|---|---|
| `scripts/scaffold.cjs --repo <dir> [--dry-run] [--force]` | Render templates into a target repo from `.slipway/config.yaml`; refuses planned/later options; never writes a partial scaffold |
| `scripts/validate-config.cjs [config]` | Schema + option-status + cross-dimension validation |
| `scripts/options.cjs [dimension] [--json]` | Option registry for the intake interview |
| `scripts/app-info.cjs [<app>] [--json]` | Derived delivery facts per app: workflow names, tag prefix, build context, `infra/apps/<app>`, state key, inputs |
| `scripts/verify.cjs <app> <env> <tag>` | Deterministic post-deployment claims for one app; writes `.slipway/evidence/<app>/<tag>.md` |
| `scripts/approve-apply.sh <planfile>` | Human-only, one-shot, 10-minute approval for one `terraform apply` |
| `scripts/preflight.sh [--repo <dir>]` | Read-only preflight: tools, logins, repository secrets/variables, environment, ruleset, Azure prerequisites |
| `scripts/ruleset.cjs` | GitHub ruleset JSON for the default branch: pull requests only plus the per-app `<app> changes` / `<app> ci` checks |
| `scripts/tracking-queue.cjs add\|list\|pop\|clear` | Offline queue of tracker updates when Jira is unreachable; replayed by `/slipway:ticket sync` |

## Branches and releases
`main` holds the frozen 1.0 line: only `fix:`, `docs:`, `chore:` and `test:` commits land there and release as 1.0.x. New capabilities go to `next`, which semantic-release publishes as `1.1.0-next.N` pre-releases; marketplace users follow `main`. `next` is merged into `main` after the Q3 review.

## Updating
A repository that enables the plugin through its `.claude/settings.json` gets a **project-scope** install next to your user-scope one; `claude plugin list` shows both. After a release update both: `claude plugin update slipway@slipway-marketplace` and, inside the repository, `claude plugin update slipway@slipway-marketplace --scope project`. Sessions load the plugin at start: restart after updating.

## Any stack
`stack: custom` accepts any language: the agent writes the Dockerfile for the app (or keeps an existing one) and lands it through a confirmed pull request, slipway verifies the contract (VERSION/COMMIT build args, health endpoint reporting the version, non-root runtime) and does the rest unchanged. Curated hardened templates exist for .NET 8 APIs and React/Vite frontends. Apps may live at the repository root (`path: .`). Per-app `test_services` start service containers (for example PostgreSQL) next to the tests.

## Pipelines per app
Every app gets `<prefix>-<app>-ci` and `<prefix>-<app>-cd` (thin callers of the shared `_ci.yml`/`_cd.yml`), its own `version.json` with path filters, its own git tags `<app>/v<semver>` and its own Terraform module and state under `infra/apps/<app>`. A change triggers only the apps whose inputs it touches; shared inputs trigger every app that lists them. Options `cd_trigger` (manual or after a green CI) and `pr_checks` (pure path filter or an always-running gate for protected branches) shape the workflows. Design: `docs/PIPELINES-PER-APP.md` in the plugin repository.

## Option matrix
See `templates/common/slipway/options.yaml`: `implemented` options are selectable and exercised end to end; `planned` options are shown but not selectable; `later` is roadmap.

## License
MIT (see `LICENSE`).
