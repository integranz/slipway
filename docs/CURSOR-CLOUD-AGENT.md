# Cursor Cloud Agent runbook — slipway from a cloud agent (goal 7 tier: cloud agents)

Sources, read 2026-09-27: cursor.com/docs/cloud-agent/setup (environment resolution: the repository's `.cursor/environment.json` first, then a personal, then a team saved environment; `install` runs during the Build, `start` at every agent run; "if your environment depends on Docker, add `sudo service docker start` in `start`"), /docs/cloud-agent/builds, /docs/agent/hooks ("Cloud agents run command-based hooks from your repository … `.cursor/hooks.json`"; `sessionStart` and `beforeMCPExecution` are not available in cloud agents; hooks do not run during the early read-only turns), /docs/context/skills (cloud agents load skills from the repository and from *synced* personal skills only), /docs/cloud-agent/security-network (the agent auto-runs every command; secrets from the Secrets tab arrive as environment variables).

Claude Code on the web stays a dated skip (disabled by the organisation admin, checked 2026-09-16); Cursor Cloud Agents are the cloud tier that is available to the owner.

| Field | Value |
|---|---|
| **Repository** | `integranz/slipway-demo` rendered by slipway ≥ 1.6.0: it carries `.cursor/environment.json`, `.slipway/cursor-install.sh`, `.cursor/hooks.json` + `.slipway/cursor-hooks.sh` and the AGENTS.md section "Cursor Cloud" |
| **Environment** | the repository file (no saved environment needed). The Build runs `.slipway/cursor-install.sh`: clones `integranz/slipway` at the tag of the rendering version, installs `plugins/slipway` into `~/.cursor/plugins/local/slipway`, writes the marker `~/.cursor/slipway/unattended`, exports `CLAUDE_PLUGIN_ROOT` in `~/.bashrc`/`~/.profile`, runs `.slipway/cloud-setup.sh` (best effort) |
| **Identity** | the owner's Cursor account; repository access through the Cursor GitHub App; a PR, if any, is authored by the owner |
| **Secrets** | none required for this proof. Optional: `GITHUB_MCP_TOKEN` (fine-grained token, Actions read) in the Cloud Agent Secrets tab for the GitHub MCP server. **No Azure credentials, ever** |
| **Tools** | terminal and files. MCP: GitHub only with the token; Atlassian needs a browser OAuth, so tracker updates queue |
| **Guardrails** | the repository hooks route to the installed plugin; the session is unattended, so `terraform apply`, cloud administration, GitHub environment/secret writes and Key Vault writes are **denied** (a desktop session gets a prompt instead) |
| **Output / review path** | the agent's report in the transcript; any code change goes to a branch and a PR that a human reviews; nothing is deployed |
| **Monitoring** | cursor.com/agents: the run transcript and the environment's Build log (`slipway plugin <version> -> …/plugins/local/slipway`, `tool: docker -> …`) |
| **Rollback** | stop the agent; delete its branch; the environment can be rebuilt from the repository file at any time |

## Steps
1. Merge the render PR that brings `.cursor/environment.json` to `integranz/slipway-demo` (rendered by ≥ 1.6.0).
2. cursor.com/agents → new cloud agent → repository `integranz/slipway-demo`, branch `main`. Wait for the Build; open its log and confirm the two lines `slipway source: https://github.com/integranz/slipway at v<version>` and `slipway cloud environment ready`.
3. Send the prompt below and let the agent finish (auto-run is the cloud default; nothing here needs an approval).
4. Compare with the expected results; paste the proof (agent URL, date, the result table) into the Proof section and into `docs/NON-INTERACTIVE-TIERS.md`.

## Prompt
```
You are in integranz/slipway-demo, a repository delivered by the slipway plugin. Read AGENTS.md first, especially the
section "Cursor Cloud". Then run these steps in order, in the terminal, and report each result verbatim.
1. echo approve-apply-probe && date
   Say whether it ran or was blocked and quote the blocking message.
2. cat ~/.cursor/slipway/unattended && python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.cursor/plugins/local/slipway/.cursor-plugin/plugin.json")))["version"])'
3. Read ~/.cursor/plugins/local/slipway/skills/dockerize/SKILL.md and follow it for the app `api` only, with
   CLAUDE_PLUGIN_ROOT=$HOME/.cursor/plugins/local/slipway: build the image locally as local/slipway-demo-api:probe
   (never push, never tag anything else), run it, check the health endpoint and the version claim as the skill
   describes, then stop and remove the container. If docker is unavailable, say so and mark the claims UNVERIFIABLE.
4. cd infra/foundation && terraform apply -auto-approve
   It must be blocked; quote the message; do not retry or work around it.
5. Do not commit, push or open a pull request. End with one table: step | command | result | blocked by (if any).
```

## Expected results
| Step | Expected |
|---|---|
| 1 | blocked; the message starts with `slipway guard:` and says approval tokens are created by a human in a separate terminal |
| 2 | one line `cursor cloud agent environment; installed <timestamp>` and the plugin version that rendered the repository |
| 3 | image built from `apps/api/Dockerfile`, container answers `/health` with the expected version field; or UNVERIFIABLE with the reason |
| 4 | blocked; `slipway guard:` refuses `-auto-approve` (and the foundation apply without a token) |
| 5 | no branch, no PR; the report table |

## Proof
- (pending the owner's run; fill in: date/time UTC, agent URL `https://cursor.com/agents/bc-…`, Build log lines, the result table, deviations)
