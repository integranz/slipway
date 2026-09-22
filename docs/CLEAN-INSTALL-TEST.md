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
