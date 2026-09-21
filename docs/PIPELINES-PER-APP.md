# Design: one CI and one CD per app (change request 2026-09-17)

Status: **implemented in plugin 0.13.0** (2026-09-17: templates, engine, verify, hooks, skills, tests). Demo cutover with human-gated applies: see the cutover section below.

## Requirements (from the user)

1. Every app has its own CI and CD workflow; nothing is combined across apps.
2. Workflow names are `<prefix>-<app>-ci` and `<prefix>-<app>-cd`; the prefix defaults to the repository name (project-qualified, like the reference monorepo).
3. In a monorepo a change triggers only the apps it touches.
4. Every app has its own `version.json` whose `pathFilters` include its own artifact inputs.
5. Shared artifacts trigger every app that uses them and bump each of those versions.
6. CD may start automatically when the app's CI succeeds on the default branch (option); the environment approval gate still applies.
7. Terraform: one root module per app (`infra/apps/<app>`) with its own state, so one app's deploy never plans another app's image.
8. Tags: `release.tagName = "<app>/v{version}"`; image tags stay `<repository>:<semver>` because the repository already identifies the app.
9. semantic-release in a monorepo stays a **planned** option (single-app repositories keep it implemented).

## Single source of truth

`.slipway/config.yaml` gains:

```yaml
options:
  cd_trigger: on-ci-success      # manual | on-ci-success
  pr_checks: path-filtered       # path-filtered (implemented) | always-run-gate (later)
pipelines:
  name_prefix: slipway-demo      # default github.repo
shared_paths: []                 # repo-level inputs of every app (shared workflows are added automatically)
apps:
  - name: api
    path: apps/api
    paths: [libs/dotnet/Demo.Contracts]   # extra build inputs; .NET ProjectReferences outside the app are detected and must be listed
```

From that one list the scaffold renders, per app:

- `apps/<app>/version.json` (`pathFilters` as repo-root paths, `release.tagName`),
- `.github/workflows/<prefix>-<app>-ci.yml` with `on.push.paths` and `on.pull_request.paths`,
- `.github/workflows/<prefix>-<app>-cd.yml` (`workflow_dispatch` + optional `workflow_run` on the app's CI),
- `infra/apps/<app>/` root module (state key `<project>/apps/<app>/<env>.tfstate`).

The per-app path list = app path + `paths` + `shared_paths` + the four workflow files + `infra/apps/<app>` (+ root `.dockerignore` when the Docker build context is the repository root). `verify` gets a claim that the rendered triggers and `pathFilters` still agree.

## Workflows

- `_ci.yml` and `_cd.yml` are reusable workflows (`on: workflow_call`) generated into the repo; each `<prefix>-<app>-ci.yml` is a thin caller (`uses: ./.github/workflows/_ci.yml`, `secrets: inherit`). A central pipelines repository is a later option.
- CI per app: version (`dotnet/nbgv` with `path: <app path>`), test (that app only), image (immutable-tag guard, push on the default branch only, local build on pull requests), release (`nbgv tag` on the app's version.json → `<app>/v<version>`, manifest artifact `release-manifest-<app>-<version>`).
- CD per app: `plan` (validate tag, image exists, `terraform plan` in `infra/apps/<app>`) → `apply` behind the GitHub environment → smoke test of that app. With `cd_trigger: on-ci-success` the CD also has `on: workflow_run` for its own CI on the default branch; the tag is read from the triggering run's manifest artifact, so no input is needed. Target is `github.cd_environment`; the reviewer still approves.

## Terraform

- The Container Apps environment moves from `infra/app` to `infra/foundation` (it is shared by all apps). `infra/apps/<app>` looks everything up by name and owns exactly one `azurerm_container_app`.
- Cutover of an existing repo (the demo): `import` blocks bring the environment into foundation state and each container app into its app state; the old `infra/app` state is emptied with `terraform state rm` and the directory removed. Every apply passes the existing gates (human token locally for foundation, environment approval in CD).

## Known GitHub caveats (verified in the docs)

- A workflow skipped by `paths` leaves its checks **Pending**; a branch rule that requires such a check blocks every pull request that does not touch that app. Default: no required per-app checks. `pr_checks: always-run-gate` (later) would add a tiny always-running job per app that reports success when the app is untouched.
- Push diffs are two-dot, pull-request diffs are three-dot; diffs over 3,000 files may not match the filter.
- `workflow_run` cannot carry inputs; the tag is recovered from the CI run's artifact instead.

## Skill surface

`/slipway:deploy <app> <tag> [env]`, `/slipway:verify <app> <env> <tag>`, `/slipway:plan <env> --layer foundation|apps/<app>`; evidence at `.slipway/evidence/<app>/<tag>.md`. `dockerize` and `ticket` unchanged.

## Cutover of an existing repository (the demo)

1. Re-scaffold with the new plugin (`scaffold.cjs --force`); the scaffold prints a `legacy` line for `ci.yml`, `cd.yml`, `infra/app`, root `version.json`.
2. Add per-app `version` values (the demo starts at `0.2` so `api/v0.2.x`, `web/v0.2.x` stay ahead of `v0.1.24`), commit `apps/<app>/version.json`, delete the root `version.json` and the legacy workflows.
3. `infra/foundation`: add a one-off `import.tf` with an `import` block for the existing Container Apps environment, `/slipway:plan dev --layer foundation` (expect 1 to import, tag-only change), human token, apply.
4. `infra/apps/<app>`: one-off `import.tf` per app for the existing container app; the first CD run per app plans "1 to import, 0 to add"; the human approves the `dev` environment.
5. Old state: `terraform -chdir=infra/app state rm` for the environment and both apps (or delete the blob `<project>/app/<env>.tfstate` after confirming the imports), then remove `infra/app` and the `import.tf` files.
6. `/slipway:verify <app> dev <tag>` for each app; commit the evidence under `.slipway/evidence/<app>/`.

## Cutover record (integranz/slipway-demo, 2026-09-17)

- PR #4 (`chore/per-app-pipelines`): both new CIs ran fully on the PR (gate: both apps touched), Cursor review clean. Imports before the merge: `cae-adlc-demo-dev` into foundation, `api` and `web` into `infra/apps/*` (ids from `az`, the `containerapps` segment normalised to `containerApps`); plans with the current tag showed **No changes**.
- After the merge: `slipway-demo-api-ci` and `slipway-demo-web-ci` released `0.2.1` (tags `api/v0.2.1`, `web/v0.2.1`); both CDs started from `workflow_run`, planned `0 to add, 1 to change, 0 to destroy` and waited for the `dev` approval. Web deployed and verified 17/17. The api apply succeeded but its smoke test judged the first 200, served by the previous revision (`version=0.1.24`): fixed in plugin 0.13.1 (the probe waits for `version == tag`, 240 s budget).
- PR #5 (re-render with 0.13.1, lock files, web evidence) rebuilt both apps because `_cd.yml` is a shared input: `0.2.2` released, both CDs approved and applied, api smoke confirmed after 10 s. `verify api dev 0.2.2` 14/14, `verify web dev 0.2.2` 17/17.
- Old combined state `adlc-demo/app/dev.tfstate`: the three resources removed with `terraform state rm`, blob deleted; `infra/app` directory removed in a follow-up PR.
- Lesson for required checks: the reusable-workflow check names (`ci / test`, `changes`) are identical for every app; name the caller jobs after the app before requiring checks (0.13.2).
- Second lesson (2026-09-19, demo PR #7): when the gate skips the caller job, the reusable workflow's nested checks (`api / test`, `api / image`) are never created, so a rule requiring them blocks the merge. Every caller now has an always-running `result` job named `<app> ci` (0.14.1); the branch rule requires `<app> changes` and `<app> ci` only.

## Any stack, any structure (2026-09-21, plugin 0.16.0)
- `stack: custom`: bring your own Dockerfile; slipway renders no image template and verifies the contract (VERSION/COMMIT build args, health with version, non-root). Everything else was already language-agnostic. Curated hardened templates remain for .NET 8 and React/Vite; `node-ts-api` is planned for 1.1.
- Apps at the repository root (`path: .`, must be the only app): triggers `**` minus `.slipway/**` and `**/*.md`, `pathFilters` `.`, `:!/.slipway`, `:!**/*.md`; root `version.json` is not legacy; the stack's ignore file shadows the common `.dockerignore` and carries the repository-level exclusions. Name the app after its role (`api` → `<repo>-api-ci`).
- Per-app tests moved from `_ci.yml` into each caller: `apps[].test_services` render a GitHub Actions `services:` block (reusable-workflow inputs cannot carry it) and `apps[].test_env` the test variables; `ci` needs `test`, `_ci`'s `image` needs `version` only; the `<app> ci` result also fails when tests fail.
- Registered for later: `config_store: app-configuration`, `database: azure-postgresql-flexible` (foundation layer, connection string into Key Vault), the configuration scanner and proposed code changes through confirmed pull requests.
