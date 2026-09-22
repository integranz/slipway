# AGENTS.md — start here (slipway marketplace repo)

This repo is the source of the **slipway** plugin (Claude Code and Cursor) and its marketplaces. It is also a "repo in scope" for the Q3 2026 upskilling goals, so it follows its own rules.

## Structure
| Path | What |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code marketplace manifest; one plugin entry pointing at `./plugins/slipway` |
| `.cursor-plugin/marketplace.json` | Cursor marketplace manifest (`pluginRoot: plugins`); same single plugin |
| `plugins/slipway/` | The plugin: `skills/` (shared by both hosts), `agents/` (Claude Code), `hooks/` (Claude Code guards, the single implementation), `.mcp.json`, `templates/`, `scripts/` |
| `plugins/slipway/.claude-plugin/plugin.json`, `plugins/slipway/.cursor-plugin/plugin.json` | Host manifests; both carry the release version |
| `plugins/slipway/cursor/` | Cursor-only assets: `hooks.json` + `hooks/*.sh` (adapters that feed Cursor hook input to the guards; `pretooluse.sh` dispatches the generic event), `rules/slipway.mdc` (always-on mapping rule), generated `agents/*.md` and `mcp.json`. Wiring Cursor actually loads: `scripts/cursor-local-install.sh` (user hooks file) and the templates `.cursor/hooks.json` + `.slipway/cursor-hooks.sh` (project hooks) |
| `plugins/slipway/scripts/` | `scaffold.cjs` (render templates into a target repo), `validate-config.cjs`, `options.cjs` (what the interview may offer), `approve-apply.sh` (human-only Terraform approval), `lib/` (renderer, vendored js-yaml, generated schema validator) |
| `plugins/slipway/templates/` | `common/files` always; `<dimension>/<option>/files` per chosen option; `stack/<stack>/app` per app. `.tmpl` files use `<% %>` placeholders (see `templates/README.md`) |
| `plugins/slipway/templates/common/slipway/options.yaml` | Option registry: what the interview offers and what is implemented |
| `plugins/slipway/templates/common/slipway/config.schema.json` | Schema for a target repo's `.slipway/config.yaml` |
| `docs/` | Evidence documents for the nine goals (catalog, hooks, rules audit, MCP, sub-agents, tiers, clean install, review packet) |
| `.releaserc.json`, `.github/workflows/release.yml` | This repo versions itself with semantic-release (Conventional Commits) |

## I want to…
- **work on a skill** → `plugins/slipway/skills/<name>/SKILL.md` (Agent Skills format, loaded by Claude Code and Cursor); test with `claude --plugin-dir ./plugins/slipway`
- **change a guardrail** → `plugins/slipway/hooks/` (one implementation for both hosts); run `plugins/slipway/hooks/test-hooks.sh` and `plugins/slipway/cursor/hooks/test-cursor-hooks.sh` before committing
- **change a sub-agent or an MCP server** → edit `plugins/slipway/agents/*.md` or `.mcp.json`, then `npm run build:cursor` (the Cursor copies are generated; CI fails when they are stale)
- **test in Cursor** → `npm run install:cursor-local` (plugin folder + `~/.cursor/hooks.json` entries), reload Cursor, `echo approve-apply-probe` must be blocked; read the *Hooks* output channel when it is not
- **add a platform option** → add it to `options.yaml` with `status`, add the enum value to `config.schema.json`, run `npm run build:validator`, add `templates/<dimension>/<option>/files/`, add `skills/delivery-knowledge/references/<dimension>-<option>.md`
- **change a template** → edit under `plugins/slipway/templates/`, then `npm test` (renderer + scaffold integration + hooks)
- **release** → merge to `main` with Conventional Commit messages; semantic-release tags and updates `plugins/slipway/CHANGELOG.md`

## Skills available
<available_skills>
- slipway:bootstrap — intake interview, app classification, scaffold, ticket
- slipway:dockerize — hardened multi-stage Dockerfile for one app
- slipway:plan — terraform fmt/validate/plan for one layer (never applies)
- slipway:deploy — trigger and monitor CD for an immutable tag
- slipway:verify — falsifiable post-deploy checks, evidence file
- slipway:ticket — tracker lifecycle
- slipway:delivery-knowledge — reference knowledge (model-invoked)
</available_skills>

## Rules and precedence
Non-negotiables live in `CLAUDE.md`; path-scoped rules live in `.claude/rules/` (added day 3). Precedence: managed policy > user > project > path rules > local. Hooks are mechanical and cannot be relaxed by a local setting.

## Commit convention
Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`; `!` or `BREAKING CHANGE:` for majors). The release version is derived from them.

## Multi-repo
Open this repo alone when changing the plugin. Open `adlc-demo` alone when exercising the plugin on a target. Cross-cutting changes (templates, schema) are owned here.
