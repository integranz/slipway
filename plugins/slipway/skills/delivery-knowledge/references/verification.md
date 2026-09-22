# Verification recipes (used by the `verify` sub-agent and `/slipway:verify`)

Every claim gets one command and a literal comparison. CONFIRMED needs a positive observation; absence of errors is not evidence.

## Image (local, after `/slipway:dockerize`)
| Claim | Command | Compare |
|---|---|---|
| Runs as non-root | `docker inspect -f '{{.Config.User}}' IMG` | `65532` or `nginx` |
| Distroless | `docker run --rm --entrypoint /bin/sh IMG -c true` | exit ≠ 0 |
| Version label == tag | `docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' IMG` | equals `$VERSION` |
| Health with version | `curl -fsS localhost:PORT/health` | HTTP 200, `.version == $VERSION` |
| Frontend bundle carries the version | `curl -fsS localhost:PORT/ \| grep -o 'assets/index-[^"]*\.js'` then `curl … \| grep -c "$VERSION"` (bare string; bundlers may emit a template literal) | ≥ 1 |
| Frontend → API proxy | `curl -fsS localhost:LOCAL_PORT/api/health` (compose) | `.version` equals the API image tag |

## Registry (after CI) — filled in on the pipeline day
| Claim | Command |
|---|---|
| Tag exists | `az acr repository show-tags -n ACR --repository REPO -o tsv \| grep -x TAG` |
| Digest of tag | `az acr repository show -n ACR --image REPO:TAG --query digest -o tsv` (not `acr manifest show --query digest`: empty output in az 2.75) |

## Deployment (after CD) — filled in on the compute day
| Claim | Command |
|---|---|
| Running image digest == registry digest | `az containerapp revision list -n APP -g RG --query "[?properties.active].properties.template.containers[0].image" -o tsv` then `docker manifest inspect` / ACR digest |
| URL answers with the version | `curl -fsS https://FQDN/health` → `.version == TAG` |
| No drift | `terraform -chdir=infra/apps/<app> plan -detailed-exitcode -var image_tag=TAG` → exit 0 (per app) |
| Pipeline definition | CI `on.push.paths` == `version.json` `pathFilters` == inputs derived from `.slipway/config.yaml` (verify.cjs claim) |
