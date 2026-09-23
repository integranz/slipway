# CLEAN-INSTALL-TEST

Status: **pre-check passed (2026-09-16)**; the full clean-install test (install, bootstrap a fresh repo, run the lifecycle from the installed copy only) is scheduled for 25 Sep 2026, see adlc-poc/docs/04-schedule-prereqs-risks.md.

## Pre-check after the rename (2026-09-16)

Purpose: prove that a consumer with no prior state can install the plugin under its new name from the public marketplace, and that the installed copy (not a `--plugin-dir` checkout) exposes the `slipway:` namespace.

| Step | Command | Result |
|---|---|---|
| 1 | `export CLAUDE_CONFIG_DIR="$(mktemp -d)"` | empty config, no marketplaces, no plugins |
| 2 | `claude plugin marketplace add integranz/slipway` | `Successfully added marketplace: slipway-marketplace` |
| 3 | `claude plugin install slipway@slipway-marketplace` | `Successfully installed plugin: slipway@slipway-marketplace (scope: user)` |
| 4 | `claude plugin list` | `slipway@slipway-marketplace`, Version 0.12.1 |
| 5 | `claude -p` from an unrelated directory, asked to list skills containing `slipway` | `slipway:bootstrap`, `slipway:delivery-knowledge` (the other skills are user-invoked only, so they are not listed to the model by design) |

Not covered by the pre-check (left for 25 Sep): hooks firing from the installed copy, MCP servers from the installed `.mcp.json`, a bootstrap run into a fresh repo, and the install from `extraKnownMarketplaces` in a consumer repo's `.claude/settings.json`.

## Plan for 25 Sep 2026: the clean install runs in **Cursor**

Decided with the owner on 2026-09-22 ("the test and demo will be done using cursor"). Claude Code steps 1–5 above stay as the secondary check.

| Step | Action | Pass criterion |
|---|---|---|
| C1 | Cursor with no slipway state: `npm run install:cursor-local -- --uninstall`, remove any slipway entries from `~/.cursor/hooks.json`; then `npm run install:cursor-local` from a checkout of the released tag (or the team marketplace import plus the install script for the hooks), *Developer: Reload Window* | Settings → Plugins lists **slipway** with 8 skills, 3 subagents, 1 rule and 3 MCP servers; the *Hooks* output channel shows the user hooks loaded |
| C2 | New Agent session in `integranz/taskflow` (fresh clone) | the first assistant context mentions `slipway plugin root: …` (session-start hook) |
| C3 | Ask the agent: *run this in the terminal and show me the output: `echo approve-apply-probe && date`* (first in a repository without `.cursor/hooks.json`, then in the rendered repository) | blocked both times, message starts `slipway guard:`. 22 Sep findings: before the user-hooks wiring the command ran; afterwards the model answered the bare text without any tool call, which exercises nothing, hence the `&& date`; with that wording the owner's Cursor blocked the command the same evening (1.1.1, user hooks) |
| C4 | Ask the agent to read `.slipway/.env` (create an empty one first) | read denied by the hook |
| C5 | `/launch` | preflight table, interview, `.slipway/config.yaml`, scaffold, story in Jira (DEVOPS), Azure/GitHub prerequisites with the user approving each command |
| C6 | Foundation apply | the agent is denied without a token; the human runs `approve-apply.sh` in a terminal; the retry applies; `.slipway/approvals/` empty afterwards |
| C7 | CI, CD approval, `/verify api dev <tag>` | evidence file written, subtasks Done, story Done |
| C8 | Record the real Cursor edit-tool input keys and whether `ask` prompted (Hooks output channel) | `docs/HOOKS.md` §6 updated with the findings |
