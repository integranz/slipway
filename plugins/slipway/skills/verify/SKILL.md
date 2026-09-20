---
name: verify
description: Verify one app's deployment independently: run the deterministic verification script for an app, environment and tag, have the verify sub-agent re-check anything refuted or unverifiable, and record the evidence file under .slipway/evidence/<app>/<tag>.md.
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Edit, Agent, Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(az account *), Bash(az containerapp show *), Bash(az containerapp revision list *), Bash(az acr repository show *), Bash(az acr repository show-tags *), Bash(gh auth status *), Bash(gh run list *), Bash(gh run view *), Bash(gh run download *), Bash(gh api repos/*), Bash(terraform -chdir=infra/apps/* init *), Bash(terraform -chdir=infra/apps/* plan *), Bash(terraform -chdir=infra/apps/* output *), Bash(git status *), Bash(git ls-files *), Bash(curl *)
---

# /slipway:verify — prove one app's deployment, never fix it

Arguments: `$0` app name (required), `$1` environment (default `github.cd_environment`), `$2` image tag (default: the `image_tag` output of the latest CD run of that app for that environment, found via the `deploy-evidence-<app>-<env>-<tag>` artifacts). Flags: `--no-write` (do not touch `.slipway/evidence/`), `--json`.

Every app has its own version, workflow, module and evidence directory; verify one app per run and repeat for the others when a shared change deployed several apps.

## Preconditions
`.slipway/config.yaml` validates; `az account show` works and points at the configured subscription (`az account set --subscription $ARM_SUBSCRIPTION_ID` if not); `gh auth status` succeeds (otherwise the CD-run claims are UNVERIFIABLE, say so).

## Step 1 — Deterministic checks
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/verify.cjs" <app> <env> <tag> --repo .` (add `--no-write` if asked). It prints a Markdown table with one row per claim and writes `.slipway/evidence/<app>/<tag>.md`. Claims it checks (option-aware):
- the app's CD run (`<prefix>-<app>-cd`) for the tag succeeded, a human approved the environment, the evidence artifact exists, `image_tag` output equals the tag, the git tag `<app>/v<tag>` exists;
- the health URL answers 200 with `version == tag` (APIs) or the bundle carries the tag (frontends); a proxied upstream answers 200 with the **upstream's** running version (each app has its own version, so it is compared with the upstream's active revision, not with this tag); HTTP → HTTPS redirect;
- on Container Apps: the active revision runs `<registry>/<repo>:<tag>`, Healthy/Running at 100 % traffic, the registry holds the tag;
- pipeline definition: the CI trigger paths, the `version.json` pathFilters and `.slipway/config.yaml` list the same inputs (a mismatch means "re-scaffold");
- `infra/apps/<app>` has no drift (`terraform plan -detailed-exitcode`, lock-free, read-only);
- working tree clean, no state/plan/tfvars/key files tracked.
Exit codes: 0 all confirmed, 2 something refuted, 3 only unverifiable items.

## Step 2 — Second opinion on anything not CONFIRMED
For every REFUTED or UNVERIFIABLE row, delegate to the `verify` sub-agent with the exact claim and the evidence line, asking it to re-check with a different method (for example `az containerapp show … --query properties.configuration.ingress.fqdn` when the artifact was missing, or `docker manifest inspect` for a digest). It may only upgrade a verdict with a positive observation; it never repairs anything. Merge its findings into the table (keep both evidences).

## Step 3 — Record
Confirm `.slipway/evidence/<app>/<tag>.md` exists and matches the final table (edit it only to add the sub-agent's second-opinion lines). Do not commit; tell the user the file is ready to commit (through a pull request when `main` is protected). Unless `options.tracker: none`: record the result on the deploy subtask, which may not exist yet when the deploy started automatically (`cd_trigger: on-ci-success`): all claims confirmed → `/slipway:ticket subtask done "Deploy <app> <tag> → <env>" --evidence .slipway/evidence/<app>/<tag>.md` (finds or creates the subtask, comments, closes it, and closes the story when it was the last open subtask); anything refuted or unverifiable → `/slipway:ticket subtask review "Deploy <app> <tag> → <env>" --evidence …` so the subtask stays open with the findings. The parent session does this, never the verify sub-agent. If any claim stays REFUTED, say what is broken in one sentence and which skill fixes it (`/slipway:deploy <app>` for a wrong tag, that app's CI for a missing image, `/slipway:plan` for drift, the scaffold for a pipeline-definition mismatch); do not run them.

## Output
```
## slipway verify: <project>/<app> <env> <tag>
Result: <n> confirmed / <n> refuted / <n> unverifiable   (evidence: .slipway/evidence/<app>/<tag>.md)
Refuted: <claim → evidence> | none
URL: <url>
Tracking: subtask "Deploy <app> <tag> → <env>" done | review (findings) | queued | disabled
Next: <the fix skill named above, or nothing>
```

## Do not
- Do not deploy, re-run workflows, apply Terraform, restart revisions or edit application code to make a check pass.
- Do not report CONFIRMED without a positive observation; absence of an error is not evidence.
- Do not soften a REFUTED verdict; the human decides what to do with it.
