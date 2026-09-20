# Guardrail hooks (goal 2)

Plugin hooks live in `plugins/slipway/hooks/hooks.json` and run for every tool call in a session **and inside sub-agents** (the hook input carries `agent_type`). Contract: exit 0 = no objection (optionally a JSON decision on stdout), exit 2 = blocked with the reason on stderr shown to Claude. All guards fail closed: a parse error is a block, not a pass.

Why hooks and not rules: a rule tells the model what to do; a hook makes it impossible to do otherwise. **Corrected 2026-09-20**: a hook `ask` decision does *not* become `allow` in headless sessions; measured in `claude -p`, the tool call is refused and the model receives the hook's reason (the docs: `ask` forces the permission prompt even in auto mode and shows the reason to the human). So `ask` is a real in-session gate in attended sessions, and the approval token remains the only way to approve in unattended ones.

Branch tests: `bash plugins/slipway/hooks/test-hooks.sh` (113 cases, run in CI by `plugin-ci.yml`). Last local run: 2026-09-20, `passed=113 failed=0`.

**Live gate test (2026-09-14, `adlc-demo` foundation layer):** in a Claude Code session with the plugin, `terraform -chdir=infra/foundation apply tfplan.dev` was blocked (`slipway guard: BLOCKED`, no approval); the human ran `scripts/approve-apply.sh infra/foundation/tfplan.dev` in another terminal; the same command then applied 8 resources and the hook consumed the token (`.slipway/approvals/` empty afterwards); a subsequent read-only plan reported no changes. Nothing was applied twice.

---

## 1. `guard-terraform-apply.sh` — no apply without a human, never destroy
| | |
|---|---|
| **Runs** | `PreToolUse`, matcher `Bash`, whenever the command contains `terraform` |
| **Blocks** | `terraform destroy`; `apply -auto-approve`; `apply -destroy`; `apply` without a saved plan file; `apply` whose plan file does not exist; any `apply` in `infra/app` or `infra/apps/<app>` (the app layer is applied only by the app's CD workflow behind the GitHub Environment approval); `apply` of a plan file that has **no valid human approval token**; any attempt to run `approve-apply.sh` from the agent |
| **Allows** | `plan`, `validate`, `fmt`, `init`, `show`, `output`; `apply <planfile>` in `infra/foundation` when a matching approval token exists (then consumes the token). **Attended session without a token** (`CLAUDE_CODE_SESSION_ATTENDED=1`, permission mode not `bypassPermissions`/`dontAsk`): returns `ask` with the plan summary (`terraform show` of the plan file) as the reason, so the human approves in the permission prompt; unattended without a token: denied with the token instructions |
| **Human approval** | In a separate terminal: `bash <plugin-root>/scripts/approve-apply.sh infra/foundation/tfplan.dev`. Writes `.slipway/approvals/<sha256 of plan>` with a 10-minute expiry (`SLIPWAY_APPROVAL_TTL` to change). Single use: the hook deletes it on the first allowed apply. A changed plan file has a different hash and needs a new approval. |
| **On failure** | Missing `jq` and `python3` → block. Unknown layout → block with instructions. Expired token → deleted and blocked. |
| **Evidence** | `test-hooks.sh` section `guard-terraform-apply` (24 cases incl. `cd … &&` chains, `-chdir=`, pipes and redirects after the plan file); live headless checks 2026-09-09 on both layers; live approved apply 2026-09-14 (see above) |

## 2. `guard-secrets-and-state.sh` — nothing secret reaches git or IaC
| | |
|---|---|
| **Runs** | `PreToolUse` on `Bash` (for `git add`, `git commit`, `git stage`) and on `Edit`/`Write` |
| **Blocks (git)** | staging or committing `.env*`, `*.tfvars` (except `*.example`/`.sample`/`.template`), `*.tfstate*`, `tfplan*`, `*.tfplan`, `backend.hcl`, `*.pem`, `*.p12`, `*.pfx`, `*.key`, `id_rsa*`, `id_ed25519*`. Bulk stages (`git add -A`, `git add .`, `git commit -a`) are inspected via `git status --porcelain`, honouring `.gitignore`. `git -C <dir>` is respected. |
| **Blocks (files)** | writing a secret-looking literal (`client_secret = "…"`, `password: "…"`, `token = "…"`, AWS/GitHub/Slack token shapes, JWTs, `BEGIN … PRIVATE KEY`) into `*.tf`, `*.tfvars`, `*.hcl`, `*.bicep`, Dockerfiles, or YAML/JSON under `infra/`, `terraform/`, `.github/workflows/`, `deploy/`, `k8s/`, `helm/`, `charts/`. References are allowed: `var.*`, `local.*`, `data.*`, `${{ secrets.NAME }}`, `secretref:`, `key_vault_secret_id`, `random_password`. |
| **Does not inspect** | application source files (a hard-coded credential in app code is a code-review concern, not an IaC guard) |
| **On failure** | Unparseable input → block. |
| **Evidence** | `test-hooks.sh` section `guard-secrets-and-state` (18 cases) |

## 3. `guard-immutable-tags.sh` — only immutable tags leave the machine
| | |
|---|---|
| **Runs** | `PreToolUse` on `Bash` and on MCP tools matching `actions_run_trigger` |
| **Blocks** | `docker push` with no tag or a mutable tag (`latest`, `main`, `master`, `dev`, `develop`, `staging`, `prod`, `test`, `qa`, `edge`, `nightly`, `stable`, `release` …); `az acr build|import` with a mutable/absent tag; `gh workflow run <cd|deploy|release>*` without `-f tag=<immutable>`; `terraform … -var image_tag=<mutable>` or `TF_VAR_image_tag=<mutable>`; GitHub MCP `run_workflow` on a CD/deploy/release workflow without an immutable `inputs.tag` |
| **Warns only** | local `docker build -t x:latest` (shown as a system message, not blocked) |
| **On failure** | Unparseable input → block. |
| **Evidence** | `test-hooks.sh` section `guard-immutable-tags` (18 cases) |

## 4. `guard-readonly-agents.sh` — explore and verify cannot mutate (supporting guard)
| | |
|---|---|
| **Runs** | `PreToolUse` on `Bash` and on every `mcp__*` tool, only when `agent_type` matches `explore` or `verify` |
| **Blocks** | mutating shell commands (`rm/mv/cp/chmod/tee/sed -i`, `git add/commit/push/checkout/…`, `terraform apply/destroy/import/state …`, `docker push/build/rm`, `kubectl apply/delete/…`, `helm install/upgrade`, `az … create/delete/update/set/…`, `gh workflow run/pr create/…`, package installs, `curl -X POST/PUT/PATCH/DELETE`), output redirection into files (fd duplication and `/dev/null` are fine), and MCP tools whose name implies a write (`create`, `edit`, `update`, `delete`, `transition`, `run_trigger`, …) |
| **Why** | Goal 6 says the verification role "never fixes". The agents' `tools` lists already exclude Edit/Write; this hook makes the shell and MCP side mechanical too. |
| **Evidence** | `test-hooks.sh` section `guard-readonly-agents` (16 cases) |

---

## Testing a hook on a branch
1. Edit the script; run `bash -n` and `bash plugins/slipway/hooks/test-hooks.sh`.
2. Add a case to `test-hooks.sh` for every new block/allow path (name, script, expected exit, JSON input).
3. Open a PR; `plugin-ci.yml` runs the suite. Merge only when `failed=0`.
4. For a live check: `claude -p --plugin-dir ./plugins/slipway --allowedTools "Bash(terraform *)" "run: terraform apply tfplan"` in a scratch repo; expect `slipway guard: BLOCKED`.

## Coverage: a hook only protects the session that loads it

Found on 2026-09-17: a background Claude Code job started from a folder **without** the repository's `.claude/settings.json` (and without the plugin enabled at user scope) ran the whole per-app cutover with **no slipway hooks active**. The human-approval protocol was still followed by discipline (plan, `approve-apply.sh` by the human, apply), but nothing enforced it mechanically, and the approval token was not consumed because no hook ran. A moved `--plugin-dir` path (`~/personal/adlc` → `~/personal/slipway`) fails the same way, silently.

Rules that follow:
- Enable the plugin at **user scope** on every machine that runs agents against these repositories (`claude plugin marketplace add integranz/slipway`, `claude plugin install slipway@slipway-marketplace`), not only through the repository's `.claude/settings.json`; background jobs and sessions opened elsewhere then carry the hooks too.
- Prefer the marketplace install over `--plugin-dir`; if `--plugin-dir` is used for development, point it at the current checkout and restart the session after moving it.
- Before an apply, prove the guard is present: a harmless command containing the text `approve-apply` (for example `echo approve-apply-probe`) must be **blocked** (plugin ≥ 0.13.3; earlier versions only denied it when the command also contained `terraform`, which also let a lone `bash scripts/approve-apply.sh <plan>` through: fixed the same day). If it prints, the hooks are not loaded; stop and fix the session first.
- After an allowed apply, `.slipway/approvals/` must be empty; a leftover token means the guard did not run.

## 5. `guard-admin-actions.sh` — administration and secrets stay behind a human (added 2026-09-20)
| | |
|---|---|
| **Runs** | `PreToolUse`, matchers `Bash` and `Read` |
| **Forces a prompt (attended) / denies (unattended)** | `setup-azure.sh --apply`, `cloud-setup.sh --apply`; `gh api` writes (POST/PUT/PATCH/DELETE or `-f/--input`) on `…/environments…`, `…/rulesets…`, `…/branches/*/protection`, `…/pending_deployments` (deployment approval under the human's account), `…/actions/secrets|variables`; `gh secret set`, `gh variable set` |
| **Denies always** | printing or reading the seed file `.slipway/.env` (`cat`, `grep`, `Read`, …; sourcing with `.`/`source` is allowed), bare `env` / `printenv` / `export -p` / `set` (would dump sourced secrets), `echo`/`printf` of a variable named `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*_KEY`, `*APIKEY*` |
| **Why** | The end user approves administrative actions in the session (the prompt names the action, the answer is the approval) instead of running scripts in a second terminal; secret values never enter the transcript. `CLAUDE_CODE_SESSION_ATTENDED` is not documented: absence fails safe (deny) |
