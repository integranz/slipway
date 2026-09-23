---
name: delivery-knowledge
description: "Reference knowledge for delivery decisions: Azure Container Apps vs Container Instances constraints, Docker Hardened Images multi-stage patterns per stack, GitHub Actions with OIDC to Azure, NBGV and semantic-release versioning, Key Vault secret handling, and verification recipes. Loaded by the execute and verify sub-agents."
user-invocable: false
---

# /slipway:delivery-knowledge

Status: **stub (day 1)**. Ordered steps, constraints and the "do not" list are written on the day this skill is built (see docs/DECISIONS.md for the schedule).

## Arguments
None (model-invoked only).

## Outline
`references/<dimension>-<option>.md` files, one per implemented option. Written on the day each option is implemented.

## Do not
- Never run `terraform apply` yourself; the guard hook blocks it and the human applies.
- Never write secrets, tfvars or state into the repository.
- Never push or deploy a mutable tag (`latest`, branch names).
