# Compute option `aca` — Azure Container Apps (`infra/foundation/cae.tf` + one root module per app in `infra/apps/<app>`)

Verified 2026-09-14/15 against learn.microsoft.com (connect-apps, ingress, secrets) and the azurerm 5.x resource docs.

## Facts the templates rely on
- **Service discovery**: apps in the same environment reach each other as `http://<APP_NAME>` (port 80) through the environment's Envoy proxy, which routes by the `Host` header. Therefore container apps are named exactly after `apps[*].name`, and the frontend's nginx proxies with `proxy_pass http://<upstream>;` and no `Host` override. Apps live in separate root modules with separate state, so there is no Terraform dependency between them; an upstream that is not deployed yet simply answers 5xx through the proxy until it is.
- **Ingress**: `external_enabled = true` gives a public HTTPS FQDN `<app>.<env-id>.<region>.azurecontainerapps.io` with TLS termination; `allow_insecure_connections = false` redirects HTTP. Workers (`kind: worker`) get no ingress block.
- **Registry pull**: `registry { server, identity }` with the user-assigned identity that holds `AcrPull` (foundation layer). No admin credentials.
- **Secrets**: `secret { name, identity, key_vault_secret_id = "<vault_uri>secrets/<name>" }` + `env { name, secret_name }`; Container Apps fetches the value with the identity (`Key Vault Secrets User`) and refreshes it. Values never enter Terraform state. Config: `apps[*].secrets: [{name, env}]`.
- **Probes**: HTTP liveness (10 s interval, 5 s initial delay) and readiness (5 s interval) on `health_path`; transport values `TCP|HTTP|HTTPS`; both need `port`.
- **Sizing**: Consumption plan requires valid cpu/memory pairs (0.25/0.5Gi, 0.5/1Gi, 0.75/1.5Gi, 1/2Gi, …); defaults 0.25 vCPU / 0.5Gi, replicas 1–2 (min 1 avoids cold starts during verification; set `scale.min: 0` for scale-to-zero). Config: `apps[*].resources`, `apps[*].scale`.
- **Environment**: `azurerm_container_app_environment` is created once in `infra/foundation` (`cae.tf`, shared by every app) with `logs_destination = "log-analytics"` and the foundation workspace; each app module reads it with `data "azurerm_container_app_environment"`; console logs in the `ContainerAppConsoleLogs_CL` table.
- **Revision mode `Single`**: every apply with a new `image_tag` creates a new revision and shifts 100 % traffic to it once its probes pass, typically 20–60 s **after** `terraform apply` has returned; until then the previous revision still answers with the old version. The CD smoke test therefore waits for `version == tag` (up to 240 s) instead of judging the first 200 (learned on the 0.2.1 api deploy, 2026-09-17). The previous revision is kept for rollback (`az containerapp revision list`).
- **Version stamping**: the image tag is injected as `APP_VERSION` and the images already report it (`/health`), so the smoke test compares `version == tag`.

## Verification (`/slipway:verify` recipes)
```
az containerapp show -n <app> -g <rg> --query properties.configuration.ingress.fqdn -o tsv
az containerapp revision list -n <app> -g <rg> --query "[?properties.active].{name:name,image:properties.template.containers[0].image,traffic:properties.trafficWeight}" -o table
az acr repository show -n <acr> --image <repo>:<tag> --query digest -o tsv           # registry digest for the tag (manifest show --query digest returns nothing in az 2.75)
curl -fsS https://<fqdn>/health | jq -r .version                                      # must equal <tag>
terraform -chdir=infra/apps/<app> plan -detailed-exitcode -var image_tag=<tag>       # exit 0 = no drift (per app)
```
Rollback: `/slipway:deploy <app> <previous tag> <env>` (or re-activate the previous revision with `az containerapp revision activate`).
