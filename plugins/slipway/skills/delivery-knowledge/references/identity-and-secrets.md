# Identity, secrets and variables (cloud=azure · runner=github-actions · registry=acr · base_image=dhi)

Verified against primary sources on 2026-09-13: Azure/login README, GitHub "Configuring OpenID Connect in Azure", Microsoft Learn "workload-identity-federation-create-trust", Terraform azurerm provider OIDC guide and `azurerm` backend docs, docker/login-action README, Docker Hardened Images "Use a DHI" page.

## Who can run the setup script (`.slipway/setup-azure.sh`)
| Step | Permission the human needs | Source |
|---|---|---|
| Create the app registration and its service principal | Any member user if the tenant's authorization policy has `allowedToCreateApps = true`; otherwise the Entra role **Application Administrator** or **Cloud Application Administrator** (or Global Administrator) | Microsoft Learn, "Create a trust relationship…": creator becomes owner; policy `defaultUserRolePermissions.allowedToCreateApps` |
| Add federated credentials | Owner of the app (the creator) or Application Administrator / Cloud Application Administrator / Global Administrator / Hybrid Identity Administrator | same page, "Important considerations" |
| Create resource groups and the storage account | `Contributor` (or `Owner`) on the subscription | Azure RBAC |
| Create role assignments (step 5) | `Owner` or `User Access Administrator` at the subscription or on the target resource groups (`Microsoft.Authorization/roleAssignments/write`) | Azure RBAC |
| Create the state container with `--auth-mode login` on an account with shared keys disabled | `Storage Blob Data Contributor` on the storage account (data-plane role; the script assigns it to you first) | `azurerm` backend docs / Azure Storage RBAC |
The script runs a preflight that checks these and stops before changing anything if a required permission is missing. Tenants often attach an **ABAC condition** to delegated User Access Administrator rights (Azure "delegate role assignment management with conditions"): the holder may assign any role except Owner, User Access Administrator and Role Based Access Control Administrator. The script therefore never assigns privileged roles, counts inherited assignments as satisfied, and treats the human's own assignments as soft (warn and continue). The CI/CD principal only ever needs Contributor and Storage Blob Data Contributor, which such conditions allow. Dry run is the default; `--apply` executes; `--apply --set-github-secrets` also pushes the three `AZURE_*` secrets with `gh`.

## Principle
No long-lived cloud credential is stored anywhere. GitHub Actions obtains a short-lived token through OIDC federation with an Entra app registration; Terraform and `az` reuse it. The only stored secret is a registry token for Docker Hardened Images, because `dhi.io` requires a login even for Community images.

## GitHub repository: Settings → Secrets and variables → Actions
| Name | Kind | Value | Consumed by | Why this name |
|---|---|---|---|---|
| `AZURE_CLIENT_ID` | secret | Application (client) ID of the app registration | `azure/login` input `client-id`; exported as `ARM_CLIENT_ID` for Terraform | Name used in the Azure/login README, GitHub's OIDC guide and Microsoft Learn |
| `AZURE_TENANT_ID` | secret | Directory (tenant) ID | `azure/login` input `tenant-id`; `ARM_TENANT_ID` | same |
| `AZURE_SUBSCRIPTION_ID` | secret | Subscription ID | `azure/login` input `subscription-id`; `ARM_SUBSCRIPTION_ID` (required by azurerm ≥ 4.0) | same |
| `DOCKERHUB_TOKEN` | secret | Docker Hub personal access token, or an organization access token (Docker recommends OATs for CI) | `docker/login-action` input `password` with `registry: dhi.io` | docker/login-action README example |
| `DOCKERHUB_USERNAME` | **variable** | Docker Hub username (or the organization name when using an OAT) | `docker/login-action` input `username` | docker/login-action README uses `vars.DOCKERHUB_USERNAME` |

The three `AZURE_*` values are identifiers, not credentials. Azure/login says "it's better to create a GitHub Action secret" and also shows them as `vars.*`; slipway stores them as secrets so they never appear in logs of a public repo.

Jira is reached through the **Atlassian Rovo MCP Server** (`https://mcp.atlassian.com/v2/mcp`, OAuth 2.1 per user, Standard+ plan); the plugin's `.mcp.json` server key is `atlassian`. Nothing else is stored: `GITHUB_TOKEN` is automatic (workflows request `contents: write` for tags/releases, `id-token: write` for OIDC), Jira is reached through the Atlassian MCP with a per-user OAuth grant (never from CI), and Key Vault secret *values* are set by a human with `az keyvault secret set`, never committed or passed through GitHub.

## GitHub repository: Settings → Environments
| Environment | Protection | Purpose |
|---|---|---|
| `dev` (from `github.cd_environment`) | Required reviewers: at least one human; deployment branch policy: default branch only | The CD job runs with `environment: dev`; its OIDC token carries the subject `repo:<owner>/<repo>:environment:dev`, and the approval gate happens before `terraform apply` of `infra/app`. The branch policy stops a deployment job from a feature branch even if someone dispatches the workflow there |

## Entra ID: one app registration for CI/CD
Create one app registration (for example `sp-<project>-github`) with **two federated credentials** (issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`; wildcards are not supported):
| Name | Subject | Used by |
|---|---|---|
| `github-main` | `repo:<owner>/<repo>:ref:refs/heads/main` | CI on `main`: `az acr login` + image push |
| `github-env-dev` | `repo:<owner>/<repo>:environment:dev` | CD job with `environment: dev`: Terraform plan/apply of `infra/apps/<app>` (one module and state per app) |
**Subject prefix**: repositories with GitHub's *immutable subject claims* enabled (observed as the default on `integranz/slipway-demo`, created 2026-09-09: `GET /repos/{owner}/{repo}/actions/oidc/customization/sub` → `use_immutable_subject: true`, `sub_claim_prefix: repo:<owner>@<owner-id>/<repo>@<repo-id>`) present `repo:integranz@326982263/adlc-demo@1362809496:ref:refs/heads/main`, not `repo:integranz/slipway-demo:…`. Entra matches literally, so the setup script reads the prefix from that endpoint (or derives it from the repository ids) and creates the credentials with the exact value. First CI run failed with `AADSTS700213 No matching federated identity record` until this was done. A job that references an environment presents the environment subject, not the branch subject (Microsoft Learn: "For Jobs tied to an environment: `repo:<Organization/Repository>:environment:<Name>`"). Pull-request builds do not touch Azure, so no `pull_request` credential is needed.

## Azure RBAC for the app registration's service principal (least privilege)
| Scope | Role | Why |
|---|---|---|
| Container registry | `AcrPush` | CI pushes `<acr>.azurecr.io/<project>/<app>:<semver>` |
| Resource group of the environment | `Contributor` | CD applies `infra/apps/<app>` (container apps, revisions); the Container Apps environment is in `infra/foundation` |
| State container `tfstate` (or the storage account) | `Storage Blob Data Contributor` | Terraform backend with `use_azuread_auth = true` (no storage keys) |
The service principal does **not** get `User Access Administrator`/`Owner`: role assignments (UAMI → `AcrPull`, UAMI → `Key Vault Secrets User`) live in `infra/foundation`, which a human applies.

## Azure RBAC for the human who applies `infra/foundation`
`Contributor` + `User Access Administrator` (or `Owner`) on the environment resource group, `Storage Blob Data Contributor` on the state container, `Key Vault Secrets Officer` on the vault to set secret values.

## Terraform state (bootstrap, once, by a human)
Storage account and container created outside Terraform (chicken-and-egg), with shared-key access disabled so only Entra ID identities can read state:
```
az group create -n <state_rg> -l <location>
az storage account create -n <state_sa> -g <state_rg> -l <location> --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false --allow-shared-key-access false
az storage container create -n tfstate --account-name <state_sa> --auth-mode login
```
Backend arguments rendered by slipway: `resource_group_name`, `storage_account_name`, `container_name`, `key = "<project>/<layer>/<env>.tfstate"`, `use_azuread_auth = true`, and in CI `use_oidc = true`.

## Environment variables Terraform and the CLIs read
| Where | Variable | Value / source |
|---|---|---|
| Local shell (human) | `ARM_SUBSCRIPTION_ID` | the subscription; azurerm ≥ 4.0 requires it and slipway keeps it out of the repo. Auth comes from `az login`; `az account set --subscription <id>` selects the subscription for the CLI |
| CI/CD jobs | `ARM_CLIENT_ID`, `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID` | from the three `AZURE_*` secrets |
| CI/CD jobs | `ARM_USE_OIDC=true`, `ARM_USE_AZUREAD=true` | provider and backend authenticate with the GitHub OIDC token; the provider and backend read `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN` automatically when the job has `permissions: id-token: write` |
| CI build | `VERSION` (build-arg) | from the versioning step (`nbgv` `SemVer2` or semantic-release), stamped into images |

## Verification commands (used by `/slipway:verify` and the setup checklist)
```
gh secret list -R <owner>/<repo>            # AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, DOCKERHUB_TOKEN
gh variable list -R <owner>/<repo>          # DOCKERHUB_USERNAME
gh api repos/<owner>/<repo>/environments/dev --jq '.protection_rules[].type'    # required_reviewers
az ad app federated-credential list --id <app-object-id> --query "[].subject" -o tsv
az role assignment list --assignee <client-id> --all --query "[].{role:roleDefinitionName,scope:scope}" -o table
az storage account show -n <state_sa> --query allowSharedKeyAccess     # false
```

## End-user credential flow (plugin ≥ 0.15.0, decided with the owner 2026-09-20)
- Logins stay human: `az login`, `gh auth login`, `docker login dhi.io`, `/mcp` for the Atlassian and GitHub servers. Headless runs reuse the MCP grants (measured 2026-09-20).
- Identifiers (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) are written by `setup-azure.sh --apply --set-github-secrets`, which the agent runs in the session behind a forced permission prompt.
- The one real secret, `DOCKERHUB_TOKEN`, reaches GitHub without entering the transcript: clipboard (`gh secret set NAME --body "$(pbpaste)"`; Linux `xclip -o`/`wl-paste`) or the seed file `.slipway/.env` (gitignored copy of `.slipway/.env.example`; only ever sourced: `set -a; . .slipway/.env; set +a; gh secret set NAME --body "$NAME"`). The guard hook denies reading or printing the seed file and echoing secret-named variables. Claude Code offers no secure input; the `!` prefix has no hidden stdin.
- Deployment approvals: GitHub's `POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments` with `environment_ids`, `state` (`approved`/`rejected`) and `comment` (all required); usable by a required reviewer with read access; recorded under that account. `cd_approval: in-session` uses it after an explicit answer, behind a forced permission prompt.
- Session attendance: hooks see `CLAUDE_CODE_SESSION_ATTENDED=1` in a watched terminal session (owner measured 2026-09-20), `0` in `claude -p`, background jobs and child sessions; `CLAUDE_CODE_ENTRYPOINT` is `cli` vs `sdk-cli`. Undocumented, so hooks fail safe when the variable is absent.
