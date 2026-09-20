---
name: plan
description: Run terraform fmt, validate and plan for one infrastructure layer of this repository (foundation, or one app's module) and summarise the changes. Never applies; tells the human exactly how to approve and apply.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Read, Glob, Grep, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/app-info.cjs" *), Bash(az account show *), Bash(terraform -chdir=* init *), Bash(terraform -chdir=* fmt *), Bash(terraform -chdir=* validate *), Bash(terraform -chdir=* plan *), Bash(terraform -chdir=* show *), Bash(terraform -chdir=* output *), Bash(terraform -chdir=* providers *), Bash(git status *), Bash(git rev-parse *)
---

# /slipway:plan — plan one Terraform layer

Arguments: `$0` environment (default `dev`); `--layer foundation|apps/<app>` (default `foundation`); `--image-tag <semver>` (app modules only; defaults to the tag currently deployed for that app, else refuses).

## Layers
| Layer | Directory | Owns | Who applies |
|---|---|---|---|
| `foundation` | `infra/foundation` | registry, key vault, app identity, log analytics, the Container Apps environment (compute `aca`), role assignments inside the resource group | a **human**, after this plan, with an approval token (`scripts/approve-apply.sh`) |
| `apps/<app>` | `infra/apps/<app>` | exactly one container app and its image tag; its own state (`<project>/apps/<app>/<env>.tfstate`) | only that app's CD workflow (`<prefix>-<app>-cd`) behind the GitHub environment approval; `/slipway:plan dev --layer apps/<app>` is read-only here |
The resource group and the state storage are created by `.slipway/setup-azure.sh`, not by Terraform. `node "${CLAUDE_PLUGIN_ROOT}/scripts/app-info.cjs"` lists the apps and their directories.

## Preconditions
1. `.slipway/config.yaml` validates (`validate-config.cjs`). If `infra/<layer>/` is missing, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.cjs" --repo .` first (it renders the layer from the cloud/compute templates) and say so.
2. Azure identity: `az account show` succeeds. Export `ARM_SUBSCRIPTION_ID` from it for the Terraform commands (the provider requires it and it is not committed). If `az account show` fails, stop: "run `az login && az account set --subscription <id>`".
3. Working tree: note uncommitted changes under `infra/` in the summary; do not commit.

## Tracking
For `--layer foundation` (a unit of work with a human apply), unless `options.tracker: none`: `/slipway:ticket subtask start "Foundation <env>: plan and apply"` before planning; after the human-approved apply completes in the session, `/slipway:ticket subtask done "Foundation <env>: plan and apply" --message "<Apply complete line>"`. App-module plans are read-only previews and need no subtask.

## Steps (run them yourself; all are read-only against the cloud)
```
export ARM_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
terraform -chdir=infra/<layer> init -input=false -reconfigure
terraform -chdir=infra/<layer> fmt -check -recursive        # report files that need formatting; do not rewrite them silently
terraform -chdir=infra/<layer> validate
terraform -chdir=infra/<layer> plan -input=false -out=tfplan.<env> [-var image_tag=<tag>]
terraform -chdir=infra/<layer> show -json tfplan.<env>
```
Summarise the JSON plan: count `create` / `update` / `delete` / `replace` from `resource_changes[].change.actions`, list each resource with its action, and flag any **delete or replace** in bold. `tfplan.*` is gitignored and blocked from commits by the guard hook; leave it in place, the apply needs it.

## Output
```
## slipway plan: <project> <layer> <env>
Backend: azurerm <storage account>/<container>/<key> (Entra ID auth)
Format: ok | <n> files need `terraform fmt`
Validate: ok
Plan: +<n> create, ~<n> update, -<n> destroy, ±<n> replace   (plan file infra/<layer>/tfplan.<env>)
  + azurerm_container_registry.this        acradlcdemo
  ~ …
Warnings: <destroy/replace lines, drift notes, or none>
```
Then, for `foundation`, print the exact human steps:
```
Approve (you, in your own terminal, not in this session):
  bash <plugin root>/scripts/approve-apply.sh infra/foundation/tfplan.<env>
Apply (in this session within 10 minutes, once):
  terraform -chdir=infra/foundation apply tfplan.<env>
```
For `apps/<app>`: "This module is applied by CD: `/slipway:deploy <app> <tag> <env>`."

## Do not
- Never run `terraform apply` or `destroy` from this skill, even if asked; the guard hook blocks it and the human owns the apply.
- Never run `terraform fmt` without `-check` unless the user asks to fix formatting; never edit `.tf` files here (change the templates via the plugin, or hand the change to `execute` with an acceptance command).
- Never write `*.tfvars`, `backend.hcl` with credentials, or subscription/tenant ids into the repository.
- Never approve your own plan: `approve-apply.sh` is human-only and the hook rejects it from an agent session.
