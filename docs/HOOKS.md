# Guardrail hooks (goal 2)

Plugin hooks live in `plugins/slipway/hooks/hooks.json` and run for every tool call in a session **and inside sub-agents** (the hook input carries `agent_type`). Contract: exit 0 = no objection (optionally a JSON decision on stdout), exit 2 = blocked with the reason on stderr shown to Claude. All guards fail closed: a parse error is a block, not a pass.

Why hooks and not rules: a rule tells the model what to do; a hook makes it impossible to do otherwise. **Corrected 2026-09-20**: a hook `ask` decision does *not* become `allow` in headless sessions; measured in `claude -p`, the tool call is refused and the model receives the hook's reason (the docs: `ask` forces the permission prompt even in auto mode and shows the reason to the human). So `ask` is a real in-session gate in attended sessions, and the approval token remains the only way to approve in unattended ones.

Branch tests: `bash plugins/slipway/hooks/test-hooks.sh` (117 cases, run in CI by `plugin-ci.yml`). Last local run: 2026-09-22, `passed=117 failed=0`. The Cursor adapters have their own 65 cases (`plugins/slipway/cursor/hooks/test-cursor-hooks.sh`, section 6).

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
| **Forces a prompt (attended) / denies (unattended)** | `az keyvault secret set` whose `--value` is a variable or `$(…)` (clipboard) or that uses `--file` (added 2026-09-23 for runtime secrets such as a database connection string); `setup-azure.sh --apply`, `cloud-setup.sh --apply`; `gh api` writes (POST/PUT/PATCH/DELETE or `-f/--input`) on `…/environments…`, `…/rulesets…`, `…/branches/*/protection`, `…/pending_deployments` (deployment approval under the human's account), `…/actions/secrets|variables`; `gh secret set`, `gh variable set` |
| **Denies always** | `az keyvault secret set` with a literal `--value`, `az keyvault secret show` without `--query id|name|attributes|tags`, `az keyvault secret download|backup` (the value would enter the transcript); printing or reading the seed file `.slipway/.env` (`cat`, `grep`, `Read`, …; sourcing with `.`/`source` is allowed), bare `env` / `printenv` / `export -p` / `set` (would dump sourced secrets), `echo`/`printf` of a variable named `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*_KEY`, `*APIKEY*` |
| **Why** | The end user approves administrative actions in the session (the prompt names the action, the answer is the approval) instead of running scripts in a second terminal; secret values never enter the transcript. `CLAUDE_CODE_SESSION_ATTENDED` is not documented: absence fails safe (deny) |

## 6. Cursor: the same guards through adapters (added 2026-09-22)

Cursor loads Claude Code hooks only from `.claude/settings*.json` files, not from a plugin's `hooks/hooks.json`, and its own hook contract differs (cursor.com/docs/hooks, /docs/reference/hooks, /docs/reference/third-party-hooks, read 2026-09-22). So the Cursor plugin declares native hooks in `plugins/slipway/cursor/hooks.json`, and five small adapters in `cursor/hooks/*.sh` rebuild the Claude Code `PreToolUse` input from the Cursor input, run the **unchanged** guard scripts of sections 1–5 and translate the result back to `{"permission": "allow" | "deny" | "ask", "user_message", "agent_message"}`. One implementation, two hosts.

| Cursor event | Adapter | Guards run | Notes |
|---|---|---|---|
| `beforeShellExecution` `{command, cwd}` | `shell.sh` | 1 apply (forced unattended), 2 secrets/state, 3 immutable tags, 5 admin actions | first deny wins; an `ask` from guard 5 is returned as `ask` |
| `beforeMCPExecution` `{tool_name, tool_input (JSON string), mcp_server_name}` | `mcp.sh` | 3 (`run_workflow` on a CD workflow needs an immutable `inputs.tag`) | tool name rebuilt as `mcp__<server>__<tool>` so the guard's matcher applies |
| `beforeReadFile` `{file_path}` | `read.sh` | 5 (the seed file `.slipway/.env` may not be read) | the event has no `ask`; anything but allow is a deny |
| `preToolUse`, matcher `Write\|Edit\|StrReplace\|…` | `write.sh` | 2 (secret literals in IaC, workflow and Dockerfile writes) | Cursor does not document the edit tools' input keys; the adapter tries `file_path`/`path`/`target_file`… and `content`/`code_edit`/`new_string`… |
| `sessionStart` `{is_background_agent}` | `session-start.sh` | — | returns `env.SLIPWAY_SESSION_ATTENDED` (1 for an interactive session) for the later hooks and `additional_context` with the plugin root and the guardrail summary |

Policy differences, deliberate:
- **A local `terraform apply` always needs the approval token in Cursor.** Cursor documents `ask` as "accepted by the schema but not enforced" for `preToolUse` and says nothing about the other events, so a forced prompt cannot be relied on. The adapter runs guard 1 with the attended markers removed: attended or not, no token means a deny with the `approve-apply.sh` instructions. The token flow is unchanged (human, own terminal, single use, 10 minutes). If Cursor later documents `ask` enforcement for `beforeShellExecution`, the change is one word in `shell.sh` (`unattended:` prefix) plus a live test.
- **Administrative actions return `ask`.** A Cursor that enforces it shows the reason; one that does not falls back to its own command approval, which is the user's normal gate. Users must not run slipway with auto-run ("Run Everything") enabled; the README says so.
- **Read-only sub-agents** come from `readonly: true` in `cursor/agents/explore.md` and `verify.md` (generated from `agents/*.md`), because Cursor sends no `agent_type` to hooks. Guard 4 is therefore not wired in Cursor.
- **Failure is a deny.** Every adapter prints an explicit deny when the input cannot be parsed, a guard is missing or crashes, or `python3` is absent; `hooks.json` also sets `failClosed: true` on every blocking hook, because Cursor's default for crashes and timeouts is fail-open.
- The attended marker is shared: `lib.sh` `attended()` accepts `CLAUDE_CODE_SESSION_ATTENDED=1` (Claude Code) or `SLIPWAY_SESSION_ATTENDED=1` (set by the Cursor session-start hook from `is_background_agent`); `bypassPermissions`/`dontAsk` still win.

Tests: `bash plugins/slipway/cursor/hooks/test-cursor-hooks.sh`, 65 cases with Cursor-shaped inputs (incl. the `preToolUse` shape, the decision cache, the project shim and the user-hooks installer) (apply with and without token, destroy, app layer, self-approval, probe, docker push, `git add .env`, seed file read/print/source, bare `env`, admin writes attended → `ask` and unattended → `deny`, MCP `run_workflow` tags, edit tools with alternative keys, malformed input, crashing and missing guards, session-start context). Last local run 2026-09-22: `passed=65 failed=0`. The manifests, generated assets and wiring templates are checked by `node --test scripts/cursor-plugin.test.cjs` (10 tests); both run in CI (`npm run test:cursor`).

**Live finding, Cursor 3.21.16 (2026-09-22, owner's session, Hooks output channel and the agent transcript):** with the plugin installed and visible in Settings → Plugins, `echo approve-apply-probe` **ran** (`tool_output: approve-apply-probe`). The Hooks Service loaded only the enterprise, team, project (`.cursor/hooks.json`), user (`~/.cursor/hooks.json`) and Claude Code (`~/.claude/settings.json`) sources: no plugin hooks. The reason, from the Cursor build itself: `loadPluginHooks()` runs only when Claude Code hooks are enabled **and** the feature gate `enable_cc_plugin_import` is on; on this machine the third-party (Claude Code) plugin import is *disabled by team admin settings* (renderer log), so plugin hooks never load. Two more facts from the same log: the shell tool arrives as a generic **`preToolUse`** event (`tool_name: "Shell"`, `tool_input: {command, cwd: "", timeout}`, `cwd: ""`, `workspace_roots: [...]`, `conversation_id`), and no `beforeShellExecution` step was requested for it.

Wiring that this Cursor does load (both installed by default, both route to the same adapters):
| Source | File | Written by | Runs from |
|---|---|---|---|
| User hooks | `~/.cursor/hooks.json` | `npm run install:cursor-local` (merged; foreign entries kept; `--uninstall` removes only ours) | `~/.cursor`; commands are absolute paths into `~/.cursor/plugins/local/slipway/cursor/hooks/` |
| Project hooks | `.cursor/hooks.json` + `.slipway/cursor-hooks.sh` in every slipway repository | the scaffold (common templates) | the repository root; the shim finds the plugin in `~/.cursor/plugins/local/slipway`, then the newest `~/.cursor/plugins/cache/*/slipway/*/`, then the Claude Code cache; without a plugin it **allows** and says so at session start (a teammate without slipway keeps a working Cursor) |
| Plugin hooks | `cursor/hooks.json` in the plugin | the plugin | for Cursor builds that load plugin hooks; identical entries |

Because a tool call can now reach the same adapter twice (user and project source, or `preToolUse` and `beforeShellExecution`), the adapter caches each decision for 3 seconds keyed by conversation, cwd and command, and replays it: the apply guard consumes the approval token once and the second hook sees the same `allow`. The window is far shorter than a model turn, so a retry is judged again (tested). `preToolUse` is dispatched by `pretooluse.sh` on `tool_name`: `Shell` → the four shell guards with `cwd` falling back to `workspace_roots[0]` (Cursor sends `""` for the workspace root); `Read` → the seed-file guard, allowing when the input shape is unknown; edit tools → the secret-literal guard; `run_workflow`-like tools → the immutable-tag guard; anything else allowed. In Cursor the attended marker defaults to **1** (an IDE session is interactive) unless the session-start hook reported a background agent; it only decides whether administrative actions return `ask` or `deny`, the apply guard never depends on it.

**Verified live, 2026-09-22 evening (owner's Cursor 3.21.16, taskflow workspace):** with the user hooks registered by `npm run install:cursor-local`, the prompt *run this in the terminal: `echo approve-apply-probe && date`* was **blocked**; the agent reported "The command was blocked by the slipway guard: approval tokens are created by a human in a separate terminal, never from an agent session. It did not run." The guard chain therefore holds in Cursor: `preToolUse` (tool `Shell`) → `pretooluse.sh` → `guard-terraform-apply.sh` → deny → Cursor refused the command and fed the reason back to the model.

Still to verify live on 25 Sep: whether `beforeShellExecution`, `beforeReadFile` and `sessionStart` are requested at all in 3.21.x (the build contains them), the real input keys of the edit and read tools, and whether `ask` prompts. The probe covers the wiring: in a fresh Cursor session ask for a real terminal run of `echo approve-apply-probe && date`; it must be blocked with a message starting `slipway guard:`. (Observed 22 Sep after the wiring: the Hooks channel showed `Loaded 5 user hook(s)` and the adapter judging Write and Grep calls, while the bare prompt `echo approve-apply-probe` was answered as text by the model with no tool call, so nothing fired; the `&& date` forces execution.)
