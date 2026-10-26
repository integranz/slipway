# The shared platform — one cloud foundation for every repository of the organisation

With `options.platform_scope: shared` a repository brings only its app module: the registry, key vault, Container Apps environment, logs, state storage and the CI/CD identity exist once per organisation and environment, set up by a platform owner. This runbook sets that platform up. Repositories join it automatically through the onboarding poller once the organisation template names it. `<org>` is your GitHub organisation.

## What you get, and who does what
| Step | Who | Tool |
|---|---|---|
| Render the platform repository from `platform.yaml` | platform owner | `node <plugin>/scripts/platform.cjs render` |
| Resource groups, state storage, CI/CD managed identity with flexible federated credentials, its roles, `AZURE_*` organisation secrets | platform owner, own terminal | `setup-platform.sh --apply --set-github-secrets` |
| Registry, key vault, Container Apps environment, logs | platform owner, own terminal | `terraform` plan, read, apply |
| Two conditioned role-assignment grants (per-app identities) | a subscription **Owner** | `setup-platform.sh --grant-per-app-roles` |
| Publish the organisation template | platform owner | `gh variable set ONBOARD_ANSWERS_TEMPLATE` |
| Per repository, forever | nobody for the foundation; a human merges the PR, sets secret values, approves the CD | — |

## 1. Render
```
git clone https://github.com/<org>/slipway && cd slipway && npm ci
mkdir ../slipway-platform && cd ../slipway-platform && git init -b main
node ../slipway/plugins/slipway/scripts/platform.cjs example > platform.yaml
# edit platform.yaml: name, environment, location, github.org, github.org_id (gh api orgs/<org> --jq .id), the Azure names,
# registry.existing: true to adopt a registry you already have, jira block or delete it
node ../slipway/plugins/slipway/scripts/platform.cjs render --config platform.yaml --out .
```
Output: `README.md`, `setup-platform.sh`, `org-defaults.yaml`, `infra/foundation/*.tf`, `.gitignore`, and a copy of `platform.yaml`. Commit and push it to `<org>/slipway-platform` (create the repository first; no id or secret is in these files).

## 2. Azure prerequisites (owner, idempotent)
```
az login && az account set --subscription "<name>"
gh auth login            # an organisation owner account
bash setup-platform.sh                                   # dry run: read what would change
bash setup-platform.sh --apply --set-github-secrets
```
Creates: the two resource groups; the state storage account (shared-key access disabled, Entra-only); the user-assigned managed identity `azure.cicd_identity_name`; its **four flexible federated credentials** (`repo:<org>@<org id>/*:ref:refs/heads/<default branch>`, `repo:<org>@<org id>/*:environment:<env>`, and the classic-prefix pair, each pinned to `repository_owner_id = <org id>`), so GitHub Actions of every present and future repository of the organisation can log in; Contributor on the resource group and Storage Blob Data Contributor on the state container for that identity; the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` organisation secrets (visibility all; on GitHub Free, private repositories cannot read them).

## 3. Foundation (owner, own terminal)
```
export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
terraform -chdir=infra/foundation init
terraform -chdir=infra/foundation plan -out=tfplan.<env>      # read it: adds only, never destroys
terraform -chdir=infra/foundation apply tfplan.<env>
```
Creates the registry (or references the existing one and grants AcrPush and Reader to the CI/CD identity), the key vault (RBAC), the Container Apps environment with Log Analytics, and makes you Key Vault Secrets Officer so you can set secret values. Running this inside a slipway session is possible too: the guard asks before the apply.

## 4. Per-app identities (a subscription Owner, once)
Repositories on the platform give each app its own identity with AcrPull on the registry and Key Vault Secrets User on that app's secrets. Their CD, running as the CI/CD identity, must therefore create role assignments, but only those two roles. A subscription Owner grants it:
```
bash setup-platform.sh --grant-per-app-roles
```
which assigns Role Based Access Control Administrator on the registry with an ABAC condition limited to `AcrPull`, and Key Vault Data Access Administrator on the vault limited to `Key Vault Secrets User` (conditions on both `roleAssignments/write` and `/delete`). A User Access Administrator whose own role carries an ABAC condition usually cannot make these grants; the script prints the commands for the Owner when it is not one. Without this step, repositories must use `options.identity_scope: shared` and `azure.shared_apps_identity: true` in `platform.yaml`.

## 5. Organisation template and secrets (owner)
```
gh variable set ONBOARD_ANSWERS_TEMPLATE -R <org>/slipway --body "$(grep -v '^#' org-defaults.yaml)"
gh secret set DOCKERHUB_TOKEN --org <org> --visibility all --body "$(pbpaste)"
gh variable set DOCKERHUB_USERNAME --org <org> --visibility all --body <username>
gh secret set JIRA_API_TOKEN --org <org> --visibility all --body "$(pbpaste)"        # with a jira block
gh variable set JIRA_EMAIL --org <org> --visibility all --body <email>
```
`org-defaults.yaml` sets `options.platform_scope: shared`, `options.registry_scope: existing`, the platform's names and `github.cd_environment`; `<name>` is not needed any more because nothing is per repository except the app module (a repository may still override a value with an `answers` block on its onboarding issue).

## What a new repository looks like afterwards
`.slipway/config.yaml` names the platform; `infra/apps/<app>` holds the container app `<project>-<app>`, its identity `id-<project>-<app>` and the two role assignments; no `infra/foundation`, no `setup-azure.sh`; the CI pushes to the shared registry and the CD applies the app module behind the `dev` approval. Human steps left: merge the onboarding pull request, set the Key Vault secret values named `<project>-<name>` (listed in `.slipway/SETUP.md`), approve the deployment.

## Changing the platform
Edit `platform.yaml`, re-render with `--force`, review the diff, plan and apply. Never `destroy`: every repository of the organisation depends on these resources. Rotating the CI/CD identity's trust is editing the federated credentials, which `setup-platform.sh --apply` does idempotently.

## Facts this design rests on (read 2026-09-27 to 2026-10-27)
- Microsoft Entra flexible federated identity credentials (preview): `claimsMatchingExpression` with `matches` wildcards on `sub`, required pin on an immutable claim (`repository_owner_id`), ARM api-version `2025-01-31-preview` on user-assigned managed identities.
- Key Vault RBAC roles can be scoped to a single secret; Key Vault Data Access Administrator is the built-in role for delegating Key Vault data-plane role assignments; Role Based Access Control Administrator is the built-in role for delegating role assignments and accepts ABAC conditions constraining the assignable roles.
- GitHub organisation secrets are readable by public repositories on the free plan and by all repositories on paid plans; `gh secret set --org <org> --visibility all`.
- The `integranz` organisation's repositories use GitHub's immutable OIDC subjects (`repo:integranz@326982263/<repo>@<id>:…`), which is why both credential forms are created.
