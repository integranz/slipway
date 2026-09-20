---
name: dockerize
description: Build the hardened multi-stage container image for one app from the slipway templates, run it locally, and prove it answers its health endpoint with the expected version as a non-root user.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Read, Glob, Grep, Agent, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.cjs" *), Bash(nbgv get-version *), Bash(git rev-parse *), Bash(docker build *), Bash(docker run *), Bash(docker rm *), Bash(docker stop *), Bash(docker image inspect *), Bash(docker inspect *), Bash(docker top *), Bash(docker logs *), Bash(docker images *), Bash(docker compose *), Bash(curl *), Bash(sleep *)
---

# /slipway:dockerize — image for one app

Arguments: `$0` = app path or app name from `.slipway/config.yaml` (e.g. `apps/api` or `api`). Flags: `--no-run` (build only), `--compose` (after the single-app check, run every app with `compose.yaml` and test the frontend → API proxy), `--force` (re-render the Dockerfile even if it was edited).

## Preconditions
1. `.slipway/config.yaml` exists and validates: `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.cjs" .slipway/config.yaml`. Otherwise stop and point to `/slipway:bootstrap`.
2. Resolve the app: match `$0` against `apps[*].path` or `apps[*].name`. Unknown → list the apps and stop.
3. Docker daemon reachable (`docker version`) and, for `base_image: dhi`, the user is logged in to `dhi.io` (a failed pull with `unauthorized` means `docker login dhi.io`; never store credentials yourself).

## Step 0 — Tracking
Unless `--no-ticket` or `options.tracker: none`: `/slipway:ticket subtask start "Dockerize <app>"`. Unavailable tracker → it queues; continue.

## Step 1 — Render the Dockerfile from the stack template
`node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.cjs" --repo . --app <name>` (add `--force` only if asked). This writes `<app path>/Dockerfile`, `.dockerignore` (and `Dockerfile.dockerignore` for .NET apps), for frontends `nginx.conf` + `nginx.local.conf`, plus the app's own workflows, `infra/apps/<app>` module and `version.json` when they are missing. Read the build context with `node "${CLAUDE_PLUGIN_ROOT}/scripts/app-info.cjs" <name>`: it is the app path, or the repository root when the app builds inputs outside its path (declared `paths` or detected .NET `ProjectReference`s). If the scaffold reports a config error (for example no `.csproj` detected), stop and tell the user which `build.*` key to set in `.slipway/config.yaml`. Never hand-edit the Dockerfile: fix the template or the config.

## Step 2 — Build (execute sub-agent)
Delegate to `execute` with this acceptance command, substituting the values:
```
VERSION=$(nbgv get-version -p <app path> -v SemVer2 2>/dev/null || echo 0.0.0-local); COMMIT=$(git rev-parse --short HEAD)
docker build --build-arg VERSION=$VERSION --build-arg COMMIT=$COMMIT -t <project>/<app>:$VERSION -f <app path>/Dockerfile <context>
```
The local tag is the real version (never `latest`; the guard hook warns on mutable tags). Nothing is pushed here: pushing is CI's job with the registry credentials the runner has.

## Step 3 — Run and verify (verify sub-agent)
Unless `--no-run`, run the image and hand these claims to `verify`:
| Claim | Check |
|---|---|
| Container starts and stays up | `docker run -d --rm -p <port>:<port> --name slipway-<app> <image>` then `docker inspect -f '{{.State.Running}}'` after 3 s |
| Health endpoint answers | `curl -fsS localhost:<port><health_path>` returns HTTP 200 (APIs: JSON with `version`) |
| Reported version equals the tag | API body `.version == $VERSION`; frontend: the entry bundle (`assets/index-*.js` referenced by `/`) contains `$VERSION` (the bundler may emit it as a template literal, so match the bare string) |
| Runs as non-root | `docker inspect -f '{{.Config.User}}'` is `65532` or `nginx`, and `docker top` shows a non-root user |
| OCI labels present | `org.opencontainers.image.version == $VERSION`, `org.opencontainers.image.revision == $COMMIT` |
| Image is distroless | `docker run --rm --entrypoint /bin/sh <image> -c true` fails (no shell) |
| Size is reasonable | `docker image inspect -f '{{.Size}}'`; report in MB, flag > 300 MB for APIs, > 100 MB for static frontends |
Always stop the container afterwards (`docker stop slipway-<app>`). Frontends with upstreams cannot reach the API standalone; mark the proxy claim UNVERIFIABLE unless `--compose` is used.

## Step 4 — `--compose` (all apps together)
`VERSION=$VERSION docker compose up -d --build`, wait, then for each frontend: `curl -fsS localhost:<local_port>/` is 200 and `curl -fsS localhost:<local_port><upstream path_prefix>health` returns the upstream's version. `docker compose down` at the end, even on failure.

## Output
```
## slipway dockerize: <project>/<app> <version>
Image: <project>/<app>:<version> (<size> MB, user <uid>, distroless: yes|no)
Health: <method> <url> → <status> version=<v> (matches tag: yes|no)
Labels: version=<v> revision=<sha>
Compose: <n>/<n> checks confirmed | skipped
Next: commit the generated files; CI will push <registry>/<repo>:<version> on the next merge to <default branch>.
```

## Step 4 — Tracking
`/slipway:ticket subtask done "Dockerize <app>" --message "image <project>/<app>:<version>, <n>/<n> claims confirmed"` (or `subtask review` with the refuted claims when something failed).

## Do not
- Do not push images, log in to registries with stored credentials, or use `latest`/branch tags.
- Do not edit the generated Dockerfile, nginx config, `.dockerignore` or `Dockerfile.dockerignore` by hand; change the template in the plugin or `build.*` / `paths` in the config.
- Do not add a shell, package manager or debugging tools to the runtime stage to make a check pass.
- Do not leave test containers running.
