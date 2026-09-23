# Stack option `custom` — an agent-written (or existing) Dockerfile for any language

Added 2026-09-21 so that slipway works on any stack: everything except the image template is already language-agnostic (CI runs `docker build`, Terraform deploys any image, verify probes the health URL, versioning counts commits per path, tracking is per unit of work).

## Who writes the Dockerfile
Not the end user. When the app has no Dockerfile, the dockerize phase drafts one (hardened base image when `base_image: dhi`, `ARG VERSION`/`ARG COMMIT`, non-root runtime, environment-only configuration), shows it, asks for confirmation and lands it through a pull request; an existing Dockerfile is kept and only checked. The difference from the curated stacks is determinism, not authorship: curated Dockerfiles are rendered templates, identical on every render; a `custom` Dockerfile is authored once per app and owned by the repository afterwards, so re-rendering never overwrites it.

## Contract the Dockerfile must meet (verified by `/slipway:dockerize` and `/slipway:verify`)
- Lives at `<app path>/Dockerfile` (`Dockerfile` for an app at the repository root); the scaffold renders nothing for the image and stops with an explicit message while it is missing, so the dockerize phase can write it first.
- Accepts `ARG VERSION` and `ARG COMMIT` (CI passes both) and stamps `VERSION` where the app can read it (label `org.opencontainers.image.version`; the health endpoint returns the same value, or the frontend bundle contains it).
- Serves the configured health path on the configured port; runs as a non-root user (`docker inspect -f '{{.Config.User}}'` not empty and not `root`/`0`).
- Reads all configuration from environment variables: secrets arrive as Container Apps secrets backed by Key Vault (`apps[].secrets`), non-secrets from `apps[].env` (`config_store: env`). No config files at runtime, no `--env-file`. The secret *values* are created by the human after the foundation apply (`.slipway/SETUP.md` lists the exact `az keyvault secret set` command per secret; the launch writes them from `.slipway/.env` behind a prompt); an app whose secret is missing cannot deploy.
- Base image: a hardened family is recommended (`dhi.io/<runtime>` when `base_image: dhi`), not enforced for `custom`; `verify` only checks the non-root runtime.
- Build context is the app path, or the repository root when `apps[].paths` lists shared inputs; then `.dockerignore` next to the Dockerfile (or `Dockerfile.dockerignore`) must carry the repository-level exclusions.

## What slipway detects for `custom`
- `package.json` at the app path → Node setup and `npm ci` before the test command; a `*.csproj` → .NET SDK setup. Other toolchains rely on what `ubuntu-latest` runners ship (Python, Go, Java) or on the test command installing them.
- `apps[].test_services` start service containers (for example PostgreSQL) next to the tests; `apps[].test_env` sets the test step's variables. Both render into the app's own CI workflow, not the shared one.

## Apps at the repository root (`path: .`)
- Must be the only app. Triggers are `**` minus `.slipway/**` and `**/*.md`; `pathFilters` are `.`, `:!/.slipway`, `:!**/*.md` (evidence and docs never bump the version). `version.json`, the Dockerfile and `.dockerignore` sit at the root; the stack's ignore file shadows the common one and carries the repository-level exclusions.
- Name the app after its role (`api`), giving `<repo>-api-ci` / `<repo>-api-cd`.

## Planned (1.1)
Curated `node-ts-api` template (hardened Node image, `tsx` or a build step), a configuration scanner classifying keys into `secrets` (Key Vault) and `env`, an optional PostgreSQL Flexible Server in the foundation layer (`database` dimension), Azure App Configuration as a `config_store`, and proposed code changes (remove file-based env loading, version in `/health`) made by the execute sub-agent through confirmed pull requests.
