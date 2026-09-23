# Cloud option `azure` — foundation layer (`infra/foundation`)

Verified 2026-09-14 against the azurerm provider docs (5.x, `main` branch), the 5.0 upgrade guide and the azurerm backend docs.

## Ownership split
| Created by | Resources | Why |
|---|---|---|
| `.slipway/setup-azure.sh` (human, once) | resource group, state storage account + container, Entra app registration for CI/CD, RBAC for the CI/CD principal and the human | Chicken-and-egg (state before Terraform) and privileged operations that Terraform should not need |
| `infra/foundation` (human applies) | Log Analytics workspace, Container Registry (Basic, admin disabled), user-assigned identity for the apps, Key Vault (RBAC mode), role assignments: identity→`AcrPull`, identity→`Key Vault Secrets User`, CI/CD principal→`AcrPush`, applier→`Key Vault Secrets Officer` | Rarely changes; contains role assignments, which the CI/CD principal must not be able to create |
| `infra/apps/<app>` (that app's CD applies) | one container app, its image tag and secret references; own state | Changes on every release of that app |
| `infra/foundation` also owns the Container Apps environment (`cae.tf`, compute `aca`) since it is shared by every app | | |

## Provider and backend facts used
- azurerm **5.x** (5.5.0 on 2026-09-10): `rbac_authorization_enabled` is now **required** on `azurerm_key_vault`; `enable_rbac_authorization` was removed. `resource_provider_registrations` defaults to `none` in 5.0; the template sets it explicitly so the CI/CD principal never needs subscription-level registration rights (providers are registered once by an owner). `enhanced_validation` moved into `features`.
- `subscription_id` is required since 4.0 and is supplied by `ARM_SUBSCRIPTION_ID` (never committed).
- Backend `azurerm` with `use_azuread_auth = true`: Entra ID only, no storage keys (the account has shared-key access disabled). Requires `Storage Blob Data Contributor` on the container. In GitHub Actions `use_oidc`/`ARM_USE_OIDC=true` is enough; the backend reads `ACTIONS_ID_TOKEN_REQUEST_*` itself.
- `azurerm_role_assignment`: set `principal_type` explicitly (ABAC-conditioned assigners may filter on it) and `skip_service_principal_aad_check = true` for the CI/CD principal to avoid Entra replication-lag failures.
- azuread 3.x is used only for `data "azuread_service_principal"` (display name `sp-<project>-github`), which needs directory read permission for the person applying.
- Container Registry Basic SKU has no network rules, geo-replication or zone redundancy; fine for a demo, switch to Premium for private endpoints.
- Log Analytics `PerGB2018`, 30-day retention: the minimum the Container Apps environment needs for console logs.

## Naming rendered from `.slipway/config.yaml`
`azure.resource_group`, `azure.acr_name` (5–50 alphanumerics, globally unique), `azure.key_vault_name` (3–24, globally unique), `azure.identity_name`, `log-<project>-<env>`, `azure.state.*`, state key `<project>/foundation/<env>.tfstate`.

## Apply protocol
1. `/slipway:plan <env> --layer foundation` → `infra/foundation/tfplan.<env>` + summary.
2. Human: `bash <plugin>/scripts/approve-apply.sh infra/foundation/tfplan.<env>` (token, 10 min, single use).
3. Session: `terraform -chdir=infra/foundation apply tfplan.<env>` (the guard hook consumes the token; any other apply form is blocked).
4. Human sets secret values: `az keyvault secret set --vault-name <kv> --name <NAME> --value …` (needs the Secrets Officer role the layer grants).

## Registry scope (`options.registry_scope`, added 2026-09-23)
- `per-repository` (default): `infra/foundation` creates the registry (Basic, admin disabled) in the repository's resource group and assigns AcrPush to the CI/CD principal and AcrPull to the app identity. The resource group stays the security and cost boundary.
- `existing`: the registry is shared by several repositories. `azure.acr_name` names it and `azure.acr_resource_group` its group when that is not `azure.resource_group`. The foundation layer only references it (`data "azurerm_container_registry"`) and assigns three roles on it for this repository: AcrPush (CI/CD principal, pushes), Reader (CI/CD principal, so the app layer's data source can read the registry from another group) and AcrPull (app identity). Outputs and the app layer read the login server from the data source; CI logs in with `az acr login --name <acr_name>`, which resolves the registry by name.
- Who can apply: assigning roles on the shared registry needs Owner or User Access Administrator on that registry (or its group); `setup-azure.sh` grants nothing there. Ask a subscription owner once per shared registry.
- Changing scope on a delivered repository is a state operation, not a re-render: `terraform state rm azurerm_container_registry.this` (to keep the registry) before re-planning, or accept the destroy consciously. The plan skill shows the destroy; never apply it by reflex.
- Same pattern later for a shared Container Apps environment or Log Analytics workspace (not offered yet).
