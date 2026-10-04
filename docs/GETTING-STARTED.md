# Getting started with slipway — step by step

This guide takes a new user from nothing to a verified deployment, then to day-to-day use, then to the Cursor automations. Follow it top to bottom the first time. Every command you type yourself is in a code block; everything else the plugin does for you, and it tells you when it needs you.

**What slipway is, in one paragraph.** slipway is a plugin for Claude Code and Cursor. You open a repository, run one command, answer a short interview, and it generates the delivery setup (Dockerfiles, CI/CD pipelines, Terraform, agent guidance), prepares Azure and GitHub, builds and deploys your apps to Azure Container Apps, verifies the result and keeps a Jira story current. Guard hooks make sure nothing dangerous happens without a human: no `terraform apply`, no secret write, no cloud administration without your approval.

---

## Part 1 — What you need (15 minutes)

### Accounts and access
| You need | Why | How to check |
|---|---|---|
| A GitHub account with admin on the repository (or organisation owner) | secrets, environment, branch ruleset | you can open *Settings* on the repository |
| An Azure subscription where you can create resources and assign roles in a resource group | registry, key vault, container apps | `az account show` prints it after login |
| Docker Hub account with access to Docker Hardened Images (`dhi.io`) | hardened base images (default `base_image: dhi`) | `docker login dhi.io` succeeds |
| A Jira Cloud site and project (optional; `tracker: none` works too) | the delivery story and its subtasks | you can open the project in the browser |
| Claude Code and/or Cursor | the hosts the plugin runs in | `claude --version`, Cursor → About |

### Tools on your machine
```
git --version && gh --version && az version && docker version && terraform version && node --version
```
Install what is missing (Homebrew on macOS: `brew install gh azure-cli terraform node`; Docker Desktop from docker.com). For .NET apps you also need the .NET SDK and `dotnet tool install -g nbgv`; for Node apps, `npm`.

### Log in once
```
gh auth login
az login
az account set --subscription "<name of your subscription>"
docker login dhi.io
```

---

## Part 2 — Install the plugin

### In Claude Code (recommended first)
```
claude plugin marketplace add integranz/slipway
claude plugin install slipway@slipway-marketplace
```
Restart Claude Code. The commands now exist as `/slipway:launch`, `/slipway:bootstrap`, `/slipway:dockerize`, `/slipway:plan`, `/slipway:deploy`, `/slipway:verify`, `/slipway:ticket`.

### In Cursor (desktop)
Option A, team marketplace (Cursor Teams): Dashboard → Plugins & MCPs → Team Marketplaces → Add Marketplace → *Import from Repo* with `https://github.com/integranz/slipway`, then install **slipway**.
Option B, from a checkout (always works and registers the guard hooks):
```
git clone https://github.com/integranz/slipway && cd slipway
npm run install:cursor-local
```
Reload the Cursor window. The same commands exist without the namespace: `/launch`, `/bootstrap`, `/dockerize`, `/plan`, `/deploy`, `/verify`, `/ticket`. Do not run slipway with Cursor's auto-run ("Run Everything") on; the guards rely on Cursor asking you.

### Check the guards before anything else (do this once per host)
Ask the agent, in a session inside any repository:
> run this in the terminal and show me the output: `echo approve-apply-probe && date`

It must be **blocked** with a message starting `slipway guard:`. If the text `approve-apply-probe` is printed, the plugin is not loaded in that session: restart the host and try again before any delivery work.

### Updating later
```
claude plugin update slipway@slipway-marketplace      # Claude Code
npm run install:cursor-local                          # Cursor, from the checkout after git pull
```

---

## Part 3 — Your first delivery with `/slipway:launch`

Open the repository you want to deliver (its root must be the workspace). Start the session and type:
```
/slipway:launch
```
It runs nine phases in order and **resumes** from whatever already exists, so you can run it again at any time. Here is what you will see and what you do.

| # | Phase | What the plugin does | What you do |
|---|---|---|---|
| 0 | Preflight | checks tools, logins, repository secrets, environment, ruleset | run any login command it prints |
| 1 | Bootstrap | finds your apps, interviews you, writes `.slipway/config.yaml`, generates every file | answer the interview (below); merge the pull request if your default branch is protected |
| 2 | Cloud prerequisites | `setup-azure.sh --apply --set-github-secrets`: Entra app with OIDC credentials, state storage, resource group, roles, the `AZURE_*` secrets | approve **one** permission prompt |
| 3 | GitHub | Docker Hub secret from your clipboard, the `dev` environment with you as reviewer, the pull-request-only ruleset | approve a prompt per write; copy the Docker Hub token to the clipboard when asked |
| 4 | Images | builds and probes one hardened image per app locally (health, version, non-root) | nothing; for a custom stack without a Dockerfile it drafts one and asks you |
| 5 | Foundation | `terraform plan` for registry, key vault, identity, logs, Container Apps environment, then apply | read the plan summary in the prompt and approve |
| 6 | Release | pushes or asks you to merge; one CI per app builds, versions, pushes the image, creates the GitHub Release | merge when the branch is protected |
| 7 | Deploy | one CD per app plans, waits at the `dev` environment, applies exactly the reviewed plan, smoke-tests | approve the deployment (in the session or on GitHub) |
| 8 | Verify and track | checks the running app against falsifiable claims; attaches the report to the GitHub Release; closes the Jira subtasks | nothing |

### The interview, decoded
You are asked only for what cannot be detected or defaulted. Have these ready:
- **Azure names**: location (for example `westeurope`), resource group, registry name, key vault name, identity name, and the Terraform state storage (resource group, storage account, container). Pick short lowercase names; the registry and storage account names must be globally unique.
- **Registry scope**: share an existing registry of the subscription (the interview lists the ones you may use) or create one for this repository (default when none exists).
- **Jira**: site URL and project key, optionally an epic key.
- **Per app**: kind (api, frontend, worker), port, health path, test command — the plugin proposes what it detected; confirm or correct.
- **Pipelines**: deploy automatically to `dev` after a green CI (`cd_trigger: on-ci-success`) or on demand; require the per-app checks on the branch.

Everything else has a default. You can change any answer later in `.slipway/config.yaml` and re-run `/slipway:bootstrap`.

### Your human checklist: `.slipway/SETUP.md`
After bootstrap, the repository contains `.slipway/SETUP.md`: one row per step, who does it (you or the plugin), and the exact command. Two things are always yours:
1. **Secret values** for the apps (for example a database connection string) go into Key Vault **after** the foundation apply, with the command printed in SETUP.md. Never paste a value into the chat; put it in `.slipway/.env` (gitignored) or the clipboard as the row says.
2. **Approvals**: the foundation apply and every deployment wait for you.

### How approvals work
- In an interactive session the guard turns a sensitive command into a **permission prompt** that names the action and, for the apply, shows the plan summary. Your answer is the approval.
- In a session that cannot prompt (background, `--yes`, cloud), the same commands are **denied** and the plugin prints what you should run yourself. For the foundation apply from such a session there is a one-shot token that only a human can create in a separate terminal: `bash <plugin-root>/scripts/approve-apply.sh <planfile>`.
- Deployments are approved on the GitHub environment `dev` (you are its required reviewer), or in the session when `cd_approval: in-session` is chosen.

### The end-of-run report
Every `/slipway:launch` ends with a block like:
```
## slipway launch: <project> → dev
preflight: 9 ok / 0 missing
bootstrap: unchanged      cloud: clean      github: secrets 4/4, environment, ruleset
images: api:0.1.3         foundation: no changes
release: api:0.1.3        deploy: api:0.1.3 → dev: approved by <you>
verify: api: 14/14        tracking: story DEVOPS-13: 3 subtasks done
Waiting for you: nothing
```
`Waiting for you` is the only line you must act on.

---

## Part 4 — Day to day

| You want to | Do this | What happens |
|---|---|---|
| Ship a change | open a pull request, merge it | the changed app's CI builds and releases; its CD waits for your approval on `dev`; approve it on GitHub |
| Deploy a specific version | `/slipway:deploy <app> <tag> dev` | the CD plans, waits for your approval, applies that plan |
| Check a deployment | `/slipway:verify <app> dev <tag>` | a report of confirmed / refuted claims, attached to the GitHub Release of the tag |
| See what Terraform would change | `/slipway:plan dev --layer foundation` or `--layer apps/<app>` | plan only, never applies |
| Rebuild an image locally | `/slipway:dockerize <app>` | build, run, health and version check as a non-root user |
| Start a new piece of work in Jira | `/slipway:ticket story create --title "…"` | a new story; every skill then keeps one subtask per unit of work and the story closes itself |
| Change a delivery option | edit `.slipway/config.yaml`, then `/slipway:bootstrap` | the generated files are re-rendered; review the diff in a pull request |
| Roll back | `/slipway:deploy <app> <previous tag> dev` | images are immutable, so the previous tag is still there |

Rules of the house: never hand-edit generated files (AGENTS.md, workflows, `infra/**`, Dockerfiles; change the plugin templates or the config instead), never commit `.tfvars`, state, plan or `.env` files, never use a mutable image tag.

---

## Part 5 — Cursor automations

Three automations exist today. Pick what you need.

### 5.1 Pull request review by a Cursor Automation (zero setup in the repository)
At cursor.com/automations create an automation with the trigger *Pull request opened / pushed*, scope = your repository, tool *Comment on Pull Request*, and the prompt from `docs/CURSOR-AUTOMATION.md`. Every PR then gets one review comment checking the diff against `AGENTS.md` and `.claude/rules/*` (mutable tags, hand-edited generated files, secrets). It never approves or edits. No secrets or MCP servers are given to it.

### 5.2 Run slipway in a Cursor Cloud Agent on a delivered repository
A repository rendered by slipway ≥ 1.6.0 carries `.cursor/environment.json`. When you start a cloud agent on it (cursor.com/agents), Cursor builds a VM, installs the plugin at the repository's version, and marks the session unattended: the guards deny `terraform apply`, cloud administration and secret writes instead of asking. Skills are not slash commands there; ask the agent to read `~/.cursor/plugins/local/slipway/skills/<name>/SKILL.md` and follow it. Good uses: scaffold changes, Dockerfile drafts, `terraform plan`, verification reports, pull requests. The default cloud VM has no Docker, so image builds are proven by CI, not by the agent. Secrets reach the agent only as environment variables from the Cloud Agent **Secrets** tab (for example `GITHUB_MCP_TOKEN` for the GitHub MCP server; with `tracker_transport: both`, `JIRA_EMAIL` and `JIRA_API_TOKEN` for the Jira MCP server). Runbook and proof: `docs/CURSOR-CLOUD-AGENT.md`.

### 5.3 Onboard a new repository with no human in the session
This is the automation for "I have a repository with code, make it deployable." One run of a Cursor Cloud Agent produces the onboarding pull request; you merge it and finish the human-only steps on your desktop.

**One-time setup (an owner does this, in their own terminal):**
1. Cursor API key (team service account recommended, or your own key, from cursor.com dashboard → API Keys):
   ```
   gh secret set CURSOR_API_KEY -R integranz/slipway
   ```
2. A fine-grained GitHub token for the PR annotation (Pull requests: write, Issues: write, Contents: read, Metadata: read on the organisation's repositories):
   ```
   gh secret set ONBOARD_GITHUB_TOKEN -R integranz/slipway
   ```
3. Jira credentials for the workflows (an Atlassian account with access to the project; copy the API token to the clipboard first):
   ```
   gh secret set JIRA_API_TOKEN --org integranz --visibility all --body "$(pbpaste)"
   gh variable set JIRA_EMAIL --org integranz --body <email>
   ```
4. For Cursor sessions with Jira tools: add `JIRA_EMAIL` and `JIRA_API_TOKEN` in the Cloud Agent Secrets tab.

**Per repository:**
1. Write `answers.txt`, one `key: value` per line, with the values the interview could not guess (no ids, no secrets):
   ```
   azure.location: westeurope
   azure.resource_group: rg-<name>-dev
   azure.acr_name: acr<name>dev
   azure.key_vault_name: kv-<name>-dev
   azure.identity_name: id-<name>-dev
   azure.state.resource_group: rg-<name>-tfstate
   azure.state.storage_account: st<name>tf
   azure.state.container: tfstate
   jira.site_url: https://<site>.atlassian.net
   jira.project_key: <KEY>
   options.tracker_transport: both
   ```
2. Dispatch (first with `-f dry_run=true` to see the request and the usable model ids, then for real):
   ```
   gh workflow run onboard.yml -R integranz/slipway -f repository=<owner>/<name> -f answers="$(cat answers.txt)"
   gh run watch -R integranz/slipway
   ```
3. What you get, 5 to 15 minutes later: a pull request titled `slipway: onboard <name>` with `.slipway/config.yaml`, `SETUP.md`, `AGENTS.md`, the rules, the per-app CI/CD workflows, the Terraform modules and the Dockerfiles, plus a **comment** from the workflow listing the human steps and the label `slipway-onboarding`. The agent held no credential: nothing in Azure, GitHub or Jira changed yet.
4. Review and merge the PR. If `tracker_transport` is `rest` or `both`, the merged repository's `slipway-tracker.yml` now creates the Jira story and closes the Bootstrap and Dockerize subtasks on its own.
5. On your desktop, in the merged repository, run the Azure prerequisites and then the rest of the launch:
   ```
   bash .slipway/setup-azure.sh --apply --set-github-secrets
   ```
   then `/slipway:launch` (it resumes at the cloud and GitHub phases, asks for the foundation apply, and continues into the first CI/CD run, which waits for your approval on `dev`). From then on the CD workflow keeps the Deploy subtasks in Jira current by itself.

Details, first-run checks and the exact prompt: `docs/CURSOR-ONBOARDING.md`.

---

## Part 6 — When something looks wrong

| Symptom | Meaning | Fix |
|---|---|---|
| `echo approve-apply-probe && date` prints instead of being blocked | the plugin is not loaded in this session | restart the host; in Cursor run `npm run install:cursor-local` and reload the window |
| `Waiting for you: az login …` | your Azure token expired | run the printed command, run `/slipway:launch` again |
| Launch stops with "missing values" in `--yes` mode | a value without a default was not given | add it to the answers (or answer the interview in an interactive session) |
| The CD run waits forever | it is waiting for your approval on the `dev` environment | approve it on GitHub (Actions → the run → Review deployments) |
| `/slipway:verify` says UNVERIFIABLE | a tool or login is missing in that session (`gh`, `az`, `terraform`) | run it from a desktop session with the logins |
| `tracking: queued` | the Jira MCP needs a browser login the session cannot do | later, in a desktop session: `/mcp` → authorise `atlassian`, then `/slipway:ticket sync` |
| The onboarding dispatch fails with `invalid_model` | the account's default model is refused by the API | pass `-f model=<id>` from the list the dry run prints |

More: `docs/HOOKS.md` (what the guards block and why), `docs/COMMAND-CATALOG.md` (every command and flag), `docs/MCP-INTEGRATION.md` (Jira, GitHub and Azure servers), `docs/NON-INTERACTIVE-TIERS.md` (CI, CD, automations, cloud agents, with proven runs).

---

## What never happens, by design
- No `terraform apply`, `terraform destroy` or `-auto-approve` without a human: the apply is prompted in a session, denied unattended, and only ever applies a reviewed plan file.
- No secret in the repository, the transcript or a command line: `.tfvars`, state, plan and `.env` files are blocked from git; Key Vault values are set from your clipboard or seed file only.
- No mutable image tag leaves the machine; every deployment names one immutable version.
- No subscription or tenant id in a public repository; they live in GitHub secrets.
- Unattended agents (cloud, automations, dispatch) hold no cloud credential; they produce pull requests and reports, humans approve.
