# Runner option `github-actions`

Verified 2026-09-15: action versions from each repository's latest release; runner image `ubuntu-latest` (Ubuntu 24.04) ships .NET SDK 8.0.4xx and the `nbgv` tool, but the workflow still pins them with setup actions.

## Workflow shape (one CI and one CD per app, since plugin 0.13.0)
Rendered from `templates/runner/github-actions/files/.github/workflows/_ci.yml.tmpl` / `_cd.yml.tmpl` (shared reusable workflows, `on: workflow_call`) and `templates/runner/github-actions/per-app/.github/workflows/__app__-ci.yml.tmpl` / `__app__-cd.yml.tmpl` (one thin caller per app, named `<prefix>-<app>-ci` / `<prefix>-<app>-cd`; prefix = `pipelines.name_prefix`, default the repository name).

| Workflow | Job | Runs on | Does | Notes |
|---|---|---|---|---|
| `<prefix>-<app>-ci` | `changes` (only with `pr_checks=always-run-gate`) | every PR | lists the PR's changed files (`gh api .../pulls/N/files`) and compares them with the app's inputs | untouched app → `ci` skipped; a conditionally skipped job counts as passed, so the checks may be required on the branch |
| `<prefix>-<app>-ci` | `ci` | PR (when touched) + default branch (path-filtered `on.push.paths`) | `uses: ./.github/workflows/_ci.yml` with the app's facts, `secrets: inherit` | the `paths` list is rendered from `.slipway/config.yaml` and equals the app's `version.json` pathFilters |
| `<prefix>-<app>-ci` | `result` (check `<app> ci`) | always (`if: always()`) | mirrors the `ci` job: success when built or skipped, failure otherwise | the only per-app check safe to require on the branch besides `<app> changes`; nested reusable-workflow checks vanish when the caller is skipped (found 2026-09-19) |
| `_ci` | `version` | | `dotnet/nbgv` with `path: <app path>` (or semantic-release, single-app repos) | `fetch-depth: 0` is mandatory |
| `<prefix>-<app>-ci` | `test` (check `<app> test`) | after the gate | the app's `test_command` with its `test_services` (GitHub Actions `services:` block rendered statically, since reusable-workflow inputs cannot carry it) and `test_env`; setup steps from `is_dotnet` / `is_node` (detected for `custom` from `package.json` / `*.csproj`) | moved out of `_ci.yml` on 2026-09-21; `ci` needs it, `_ci`'s `image` needs `version` only |
| `_ci` | `image` | PR: build + load; default branch: build + push | `docker/build-push-action` with `context` and `file` inputs (root context when the app has inputs outside its path), `VERSION`/`COMMIT` build-args, tags `<registry>/<repo>:<semver>` and `:sha-<short>`, `provenance: false`, GHA cache per app | immutable-tag guard refuses an existing tag |
| `_ci` | `release` | default branch only | `release-manifest-<app>-<version>` artifact, git tag `<app>/v<version>` (`nbgv tag -p <app path>`, name from `release.tagName`) | `contents: write` required |
| `<prefix>-<app>-cd` | `resolve` | `workflow_dispatch` (tag, environment); with `cd_trigger=on-ci-success` also `workflow_run` of the app's CI on the default branch | reads the tag from inputs, or from the triggering run's `release-manifest-<app>-*` artifact (`actions/download-artifact` with `run-id`) | `workflow_run` cannot carry inputs; the manifest replaces them |
| `_cd` | `plan` → `apply` | | image exists for this app, `terraform plan` in `infra/apps/<app>`, plan artifact; `apply` behind `environment: <env>` applies exactly that plan, collects `url`/`health_url`, smoke-tests this app, uploads `deploy-evidence-<app>-<env>-<tag>` | one app's CD never plans another app's module |

## Pinned actions (latest majors on 2026-09-15)
`actions/checkout@v7`, `actions/setup-dotnet@v6`, `actions/setup-node@v7`, `actions/upload-artifact@v7`, `actions/download-artifact@v7`, `dotnet/nbgv@v0.5.2`, `azure/login@v3`, `docker/login-action@v4`, `docker/setup-buildx-action@v4`, `docker/build-push-action@v7`.

## Decisions baked in
- **`workflow_run` carries no inputs**, so the automatic CD (`cd_trigger=on-ci-success`) recovers the tag from the CI run's release-manifest artifact instead; manual deploys stay `workflow_dispatch` with an explicit tag (`/slipway:deploy <app> <tag> <env>`).
- **Path filters and required checks**: a workflow skipped by `paths` leaves its checks Pending, which blocks a PR that requires them. `pr_checks=always-run-gate` adds the always-running `changes` job; `pr_checks=path-filtered` must not be combined with required per-app checks. Pushes use two-dot diffs, PRs three-dot; diffs over 3,000 files may not match.
- **Immutable tags only**: semver + `sha-<short>`; never `latest` or branch names (the guard hook rejects them locally; the template never emits them). A **re-run** of the same workflow run (`github.run_attempt > 1`) whose earlier attempt already pushed the tag reuses that image and digest instead of failing: seen on 2026-09-21 when GitHub's artifact service answered 403 on finalize after the push had succeeded (transient, GitHub-side); a first attempt meeting an existing tag still fails.
- **`provenance: false`, `sbom: false`**: with attestations, buildx pushes an OCI image index and the registry digest differs from the digest of the running image. A single manifest keeps `/slipway:verify`'s "registry digest == running digest" check literal. Supply-chain attestations can be re-enabled once verification compares platform manifests.
- **OIDC only**: `permissions: id-token: write`; the CI job on the default branch presents subject `repo:<owner>/<repo>:ref:refs/heads/<default>` (federated credential `github-main`); PR builds never touch Azure.
- **Concurrency**: one CI run per app and ref; PR runs cancel superseded ones, release runs never cancel. CD is serialised per app and environment.
- **Registry login**: `az acr login` after `azure/login` uses the OIDC identity's `AcrPush`; no admin credentials exist (`admin_enabled = false`).

## Secrets and variables consumed
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (secrets), `DOCKERHUB_TOKEN` (secret), `DOCKERHUB_USERNAME` (variable), `GITHUB_TOKEN` (automatic). See `identity-and-secrets.md`.

## Verifying a run (`/slipway:verify`, `explore`)
`gh run list --workflow <prefix>-<app>-ci --branch main`, `gh run view <id>`; job summary lists the pushed tag and digest; artifact `release-manifest-<app>-<version>` is the source of truth for the deploy step (`node scripts/app-info.cjs <app>` prints the workflow names). Registry side: `az acr repository show-tags -n <acr> --repository <repo>`, `az acr manifest list-metadata -r <acr> -n <repo>` for digests.
