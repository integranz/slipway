# Option `platform_scope: shared` — one organisation platform, many repositories (added 2026-10-26)

## What changes for a repository
- `infra/foundation` and `.slipway/setup-azure.sh` are **not rendered** (the scaffold prints `omit`): the registry, key vault, Container Apps environment, Log Analytics, state storage and the CI/CD identity exist already and are applied once by the platform owner from the platform repository. `.slipway/config.yaml` only *names* them: `azure.acr_name` + `azure.acr_resource_group` (`registry_scope: existing` is required), `azure.key_vault_name`, `azure.container_app_environment`, `azure.resource_group`, `azure.state.*`.
- `infra/apps/<app>` is the whole Terraform of the repository: the container app, and with `identity_scope: per-app` (the default here) the app's own user-assigned identity `id-<project>-<app>` with AcrPull on the registry and Key Vault Secrets User on **that app's secrets only** (`for_each` over `apps[].secrets`, scope `<vault>/secrets/<project>-<name>`).
- Names are namespaced by project because the environment and the vault are shared: container app `<project>-<app>` (so an upstream is reached as `http://<project>-<api>`), Key Vault secret `<project>-<name>` (the app still sees it as `apps[].secrets[].env`).
- The `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` secrets are **organisation** secrets (the platform's CI/CD identity, one for every repository); `/slipway:launch` phases 2 and 5 print `skipped (shared platform)`; preflight checks that the platform's registry, vault and environment exist instead of dry-running `setup-azure.sh`.
- What stays per repository: the pull request, the `dev` environment with its reviewer (the onboarding poller creates it), the Key Vault secret **values** (human), the CD approval.

## What the platform must provide (platform repository; human-only, once)
- Resource group, Log Analytics, registry, key vault (RBAC), Container Apps environment, state storage (Entra-only auth).
- One **user-assigned managed identity** for CI/CD with Entra *flexible* federated credentials matching every repository of the organisation (`claims['sub'] matches 'repo:<org>@<org id>/*:ref:refs/heads/<default>' and claims['repository_owner_id'] eq '<org id>'`, and the `environment:<env>` form; both the immutable and the classic subject prefixes), with Contributor on the resource group, AcrPush on the registry, Storage Blob Data Contributor on the state container, and, for `identity_scope: per-app`, the two **conditioned** role-assignment rights granted by a subscription Owner: Role Based Access Control Administrator limited to `AcrPull` on the registry, Key Vault Data Access Administrator limited to `Key Vault Secrets User` on the vault.
- The organisation secrets `AZURE_*`, `DOCKERHUB_TOKEN` (+ variable `DOCKERHUB_USERNAME`), `JIRA_API_TOKEN` (+ `JIRA_EMAIL`).

## Facts (Microsoft Learn, read 2026-09-27)
- Flexible federated identity credentials (preview) support `matches` wildcards on `sub`; GitHub expressions must also match an immutable claim (`repository_id` or `repository_owner_id`); created through ARM `federatedIdentityCredentials` api-version `2025-01-31-preview` on a user-assigned managed identity.
- Key Vault RBAC roles can be assigned at the scope of a single secret (`…/vaults/<name>/secrets/<secret>`).
- Delegating role assignments with conditions: the Role Based Access Control Administrator role can be constrained to specific roles; Key Vault Data Access Administrator is the built-in role for delegating Key Vault data-plane roles.

## Trade-offs
- Any repository's CD identity is Contributor on the shared resource group: its plan can touch other repositories' resources; the plan shown at the environment approval is the control.
- The Container Apps environment is shared: one network, one domain suffix; names are prefixed by project to avoid collisions.
