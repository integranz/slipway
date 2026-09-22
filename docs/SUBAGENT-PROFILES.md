# Sub-agent profiles (goal 6)

Three role profiles in `plugins/slipway/agents/`. The parent session stays thin: it interviews, decides, delegates scoped slices, and stores evidence. Domain knowledge (Container Apps, Docker Hardened Images, GitHub Actions + OIDC, NBGV, semantic-release, Key Vault, verification recipes) lives in the model-invoked `delivery-knowledge` skill, preloaded into `execute` and `verify` via `skills:`, not in extra domain agents.

Plugin-agent constraints (docs, verified 2026-09-09): plugin agents ignore `hooks`, `mcpServers` and `permissionMode` frontmatter. Read-only behaviour is therefore enforced by `tools`/`disallowedTools` plus the plugin-wide `guard-readonly-agents.sh` hook, and MCP access comes from the plugin's `.mcp.json`.

| Profile | Job | Tools | Inputs | Outputs | Stops when | Escalates when |
|---|---|---|---|---|---|---|
| `explore` | gather facts | Read, Grep, Glob, Bash (read-only), WebFetch; no Edit/Write/Agent | decidable question(s), repo root, config | findings with `path:line` evidence, app inventory table, unknowns | every question answered or marked "not present" | a decision is needed, sources conflict, access missing |
| `execute` | make one scoped change | Read, Edit, Write, Grep, Glob, Bash; no Agent; preloads `delivery-knowledge` | target, intended outcome, acceptance command, option values | changed-file list, verbatim acceptance output, PASS/FAIL, follow-ups | acceptance passes; scope exceeded; same failure twice | a hook blocks; a new secret/resource/scope is needed |
| `verify` | test claims | Read, Grep, Glob, Bash (read-only), WebFetch; no Edit/Write/Agent; preloads `delivery-knowledge` | falsifiable claims with env/tag/URL | CONFIRMED / REFUTED / UNVERIFIABLE table with command → output | every claim has a verdict | a check needs missing credentials or resources |

`maxTurns`: explore 30, execute 60, verify 40. `model: inherit`.

## Anti-patterns these profiles prevent
- **Circular delegation**: none of the three can spawn sub-agents (`Agent` is disallowed).
- **Verification that "fixes"**: verify has no Edit/Write and the read-only hook blocks mutating shell/MCP calls.
- **Execution without proof**: execute must run the acceptance command and paste real output.
- **Exploration that guesses**: every finding needs `path:line` or a command output; unknowns are listed, not filled in.

## Run log (real workflows)
| Date | Profile | Task | Outcome |
|---|---|---|---|
| 2026-09-09 | (all) | headless check that the plugin exposes the three agents | listed as `slipway:explore`, `slipway:execute`, `slipway:verify` |
| 2026-09-13 | explore | app discovery on `integranz/slipway-demo` (bootstrap step 1, headless `claude -p --plugin-dir`, real repo) | Returned the inventory table with `path:line` evidence for kind, stack, port, health and test command. Reported test commands as **not verified** when the permission system blocked them instead of guessing. Found a real defect: the web app fetched `/api/health` while the API only served `/health` (fixed in adlc-demo `28d10b3`). Flagged that the web runtime port came from the README, not code. No edits attempted. |
| 2026-09-13 | verify | bootstrap step 5 during the first headless `/slipway:bootstrap --yes --no-ticket` run (scratch clone) | 7 claims, 7 CONFIRMED (config validates, generated files exist without placeholders, settings names marketplace + plugin, rules carry `paths:`, `.gitignore` entries). Did not modify anything. |
| 2026-09-13 | (parent) | first end-to-end `/slipway:bootstrap` on `adlc-demo`: interview (AskUserQuestion), config, `scaffold.cjs`, 14 verification claims, commit `28d10b3` | Ticket step deferred: Atlassian MCP for `integranz.atlassian.net` not yet authorised in the session. |
| 2026-09-14 | execute | `/slipway:dockerize api` (headless, real plugin run): build `adlc-demo/api:0.1.6` with version and commit build-args | Built from the rendered Dockerfile without editing generated files; pulled both `dhi.io` stages with the user's login; pushed nothing; reported the exact acceptance output. |
| 2026-09-14 | verify | same run: 9 claims about the running container | 8 CONFIRMED (running, `/health` 200 with `version == 0.1.6`, user 65532, labels, no shell, size 57 MB, clean logs), 1 UNVERIFIABLE (`docker top` blocked by the permission harness; reported instead of guessed). Stopped the container afterwards. |
| _pending_ | verify | post-deploy verification of the first CD run | |
