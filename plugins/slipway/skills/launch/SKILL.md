---
name: launch
description: "One command that takes a repository from nothing to a verified, tracked deployment: preflight of tools and credentials, intake interview and scaffold, Azure and GitHub prerequisites, per-app images, foundation infrastructure, per-app CI/CD with in-session approvals, verification and tracking. Idempotent: re-run it any time and it continues from what it finds."
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/*), Read, Glob, Grep, Write, Edit, Agent, AskUserQuestion, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(bash "${CLAUDE_PLUGIN_ROOT}/scripts/*), Bash(bash .slipway/setup-azure.sh *), Bash(gh *), Bash(az *), Bash(git *), Bash(docker *), Bash(terraform -chdir=* *), Bash(dotnet *), Bash(npm *), Bash(nbgv *), Bash(curl -fsS *), Bash(set -a; . .slipway/.env; set +a; *), Bash(source .slipway/.env && *), Bash(pbpaste), Bash(xclip *), Bash(wl-paste)
---

# /slipway:launch — the whole delivery, end to end, in one command

A slipway exists to launch a ship. This skill runs every phase of the delivery lifecycle in order and stops only where a human must decide: the interview, approvals of cloud changes, and deployment approvals. Every phase is **idempotent** (it checks what exists and does only the missing part), so running `/slipway:launch` again resumes.

Arguments: `--yes` (non-interactive: accept detections and defaults; stop with exact instructions at every step that needs a human), `--until <phase>` (stop after `preflight|bootstrap|cloud|github|images|foundation|release|deploy|verify`), `--env <name>` (default `github.cd_environment`), `--no-ticket`.

The phases below **follow the corresponding skill's SKILL.md** (read it with `Read` from `${CLAUDE_PLUGIN_ROOT}/skills/<name>/SKILL.md` and execute its steps here; those skills are user-invoked only, so you cannot call them, you carry out their procedure). Never shortcut a phase's checks.

## Rules for the whole run
- **Approvals happen in this session.** Cloud and GitHub administrative commands are gated by the plugin hooks: in an attended session they force a permission prompt whose reason names the action; you never work around a prompt, never mint approval tokens (`approve-apply.sh` is human-only) and never approve on a human's behalf without an explicit `AskUserQuestion` answer first. In an unattended session (`--yes`, `-p`, background) those commands are denied: print the exact command for the human and stop the phase.
- **Secrets never enter the transcript.** Values come from the clipboard (`gh secret set NAME --body "$(pbpaste)"`; Linux: `xclip -o` / `wl-paste`), from the seed file (`set -a; . .slipway/.env; set +a; gh secret set NAME --body "$NAME"`) or from the human's own terminal. Never `cat`/`Read` the seed file, never echo a secret variable, never ask the user to paste a secret into the chat.
- **Status line after every phase**: `phase <name>: done | skipped (why) | waiting for <human action>`. Finish with the summary block.
- Tracking: with `options.tracker: jira` keep the subtasks current exactly as the phase skills do (`Bootstrap <project>`, `Dockerize <app>`, `Foundation <env>: plan and apply`, `Deploy <app> <tag> → <env>`); an unreachable tracker queues and never blocks.

## Phase 0 — Preflight
`bash "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.sh"` (read-only; exit 3 = something missing). Show the table. Fix only what the later phases own (secrets, environment, ruleset, cloud prerequisites); for logins and tools, print the exact command and wait: `az login && az account set --subscription <id>`, `gh auth login`, `docker login dhi.io …` (from the seed file or the human's terminal), `dotnet tool install -g nbgv`. Tracker: `getAccessibleAtlassianResources` must answer when `tracker: jira`; otherwise say `/mcp` → `atlassian` and continue (queue mode).

## Phase 1 — Bootstrap (config + scaffold)
Follow `skills/bootstrap/SKILL.md`: interview only when `.slipway/config.yaml` is missing or the user asked for changes; scaffold; verify with the `verify` sub-agent; story + `Bootstrap <project>` subtask. Then commit: with a protected default branch open a pull request (`git switch -c slipway/bootstrap`, `gh pr create`), otherwise commit to the default branch; wait for the user's merge when the branch is protected (the per-app CIs run on the PR).

## Phase 2 — Cloud prerequisites (Azure)
`bash .slipway/setup-azure.sh` (dry run) → show what would change → `AskUserQuestion`: run `--apply --set-github-secrets` now? On yes, run `bash .slipway/setup-azure.sh --apply --set-github-secrets` (the hook forces the permission prompt; the human approves the tool use). Read the dry run again: it must report nothing to change. Idempotent: skip when the dry run is already clean.

## Phase 3 — GitHub repository
1. Secrets and variables: `gh secret list` / `gh variable list`. Missing `DOCKERHUB_TOKEN`: ask the user to copy the token to the clipboard (or fill `.slipway/.env` from `.slipway/.env.example`), then run the clipboard or seed-file form of `gh secret set`. Missing `DOCKERHUB_USERNAME`: ask for the username (not a secret) and `gh variable set`. `AZURE_*` come from Phase 2.
2. Environment `<env>` with required reviewers: `gh api repos/O/R/environments/<env>`; when missing or without reviewers: `gh api -X PUT repos/O/R/environments/<env> --input -` with `{"reviewers":[{"type":"User","id":<id of gh api user>}],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}` then `POST …/deployment-branch-policies -f name=<default_branch> -f type=branch`. Reviewer = the current `gh` user unless the user names someone else.
3. Branch ruleset: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ruleset.cjs" | gh api -X POST repos/O/R/rulesets --input -` when no ruleset with `pull_request` applies to the default branch (`gh api repos/O/R/rules/branches/<default_branch>`). Requires `pr_checks: always-run-gate` (the script warns otherwise). Tell the user that from now on every change, including yours, goes through pull requests.

## Phase 4 — Images
For every app, follow `skills/dockerize/SKILL.md` (render, build, run, health, non-root, version) with its `Dockerize <app>` subtask. Skip an app whose image was proven for the current commit in this run.

## Phase 5 — Foundation infrastructure
Follow `skills/plan/SKILL.md` for `--layer foundation`. If the plan has changes: show the summary and run `terraform -chdir=infra/foundation apply tfplan.<env>`; the apply guard forces the permission prompt with the plan summary as the reason and the human approves it there (unattended: it denies and prints the token instructions; stop and wait). Then re-plan: no changes.

**Runtime secret values** (each `apps[].secrets` entry, once the key vault exists): check existence with `az keyvault secret show --vault-name <azure.key_vault_name> --name <name> --query id -o tsv` (metadata only; the guard denies any form that would print the value). When it is missing: if `.slipway/.env` exists, run `set -a; . .slipway/.env; set +a; az keyvault secret set --vault-name <kv> --name <name> --value "$<ENV>"` (the guard forces a permission prompt naming the secret; the value never appears; an empty variable means the human has not filled the seed file yet, so stop instead); otherwise stop with `phase foundation: waiting for the human to set Key Vault secret <name>` and print that exact command for the human's own terminal. Never accept a secret value in the chat and never pass a literal `--value`. The app layer cannot deploy until every referenced secret exists (Container Apps validates the Key Vault reference at apply time).

## Phase 6 — Release (CI)
Push or merge so the default branch carries the current code, then watch every app's CI (`<prefix>-<app>-ci`) to success: `gh run list --workflow <name> --branch <default_branch> --limit 1`, `gh run watch`. Record each app's released version from its `release-manifest-<app>-<version>` artifact.

## Phase 7 — Deploy
Follow `skills/deploy/SKILL.md` per app for the released version and `<env>`. With `cd_trigger: on-ci-success` the CD is already running: watch it instead of dispatching. Approval: with `cd_approval: in-session`, present the plan summary, ask the user with `AskUserQuestion`, and on "approve" call the pending-deployments API (the hook forces a permission prompt); with `github-ui`, print the run URL and wait for the human. Never approve without the explicit answer.

## Phase 8 — Verify and track
Follow `skills/verify/SKILL.md` per app (`verify.cjs <app> <env> <tag>`), record the deploy subtasks (`subtask done`/`review`), commit the evidence through a pull request when the branch is protected.

## Output (always end with this)
```
## slipway launch: <project> → <env>
preflight: <n ok / n missing (what)>
bootstrap: <new | update | unchanged>      cloud: <applied n | clean>      github: <secrets n/n, environment, ruleset>
images: <app:version …>                    foundation: <applied | no changes>
release: <app:version …>                   deploy: <app:tag → env: approved by <who> | waiting: <url>>
verify: <app: n/n …>                       tracking: <story KEY: n subtasks done | queued | disabled>
Waiting for you: <exact commands or approvals, or nothing>
```

## Do not
- Do not skip the dry run, the plan summary or the read-back before any approval; do not approve anything yourself.
- Do not print, read or paste secrets; do not write `*.tfvars`, tokens or subscription ids into the repository.
- Do not run `terraform apply` for `infra/apps/*`, `terraform destroy` or `-auto-approve`; do not push to a protected branch.
- Do not fabricate versions, run ids, ticket keys or verification verdicts; every claim needs the command output behind it.
