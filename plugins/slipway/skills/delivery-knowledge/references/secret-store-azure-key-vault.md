# Secret store option `azure-key-vault`

- Vault is created by `infra/foundation` in RBAC authorization mode (`rbac_authorization_enabled = true`): no access policies; data-plane rights are Azure roles. Soft delete 7 days; purge protection off for the demo (turn on for real secrets: it cannot be turned off again).
- **Who can do what**: the apps' user-assigned identity holds `Key Vault Secrets User` (read values); the human who applied the foundation holds `Key Vault Secrets Officer` (create/update values); the CI/CD principal holds nothing on the vault.
- **Secret values never touch the repo, Terraform state or GitHub**: a human sets them (`az keyvault secret set --vault-name <% kv %> --name <NAME> --value <value>`). Terraform references secrets by id only (`data "azurerm_key_vault_secret"` is avoided too, because its value would land in state).
- **How apps receive secrets on Container Apps** (`infra/apps/<app>`, day 7; formerly `infra/app`): `secret { name = "db-password" key_vault_secret_id = "<vault uri>/secrets/db-password" identity = <identity id> }` plus `env { name = "DB_PASSWORD" secret_name = "db-password" }`. Container Apps fetches the value with the identity and refreshes it periodically; nothing is stored in Terraform state.
- **Naming**: secret names are lowercase kebab-case (`[a-z0-9-]`), mapped to `UPPER_SNAKE` environment variables by convention in the app layer.
- Guard hooks block secret literals in `.tf`, `.tfvars`, workflow and Dockerfile content (`guard-secrets-and-state.sh`).
