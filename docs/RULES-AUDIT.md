# Rules audit (goal 4) — 2026-09-16

Scope: the two repositories in scope (`integranz/slipway`, `integranz/slipway-demo`) plus the user scope on the workstation that runs them, because always-on instructions from all three layers reach the same session. Method: read every file the agent loads at session start (Claude Code: managed policy → `~/.claude/CLAUDE.md` → `./CLAUDE.md` (+ `@imports`) → `.claude/rules/*.md` (path-scoped) → `CLAUDE.local.md`; skills and commands by description; hooks from settings and plugins), list overlaps, decide a winner, and move procedure into skills.

## 1. Inventory

### 1a. User scope (`~/.claude`, applies to every repo on this machine)
| Item | Count | Notes |
|---|---|---|
| `~/.claude/CLAUDE.md` | 0 bytes | empty: no personal always-on instructions |
| `~/.claude/rules/` | none | |
| Hooks (`settings.json`) | 2 | gitnexus context hook on `PreToolUse` (Grep/Glob/Bash) and `PostToolUse` (Bash); unrelated to delivery, no overlap with plugin guards |
| Permissions | `ask` on `git commit`/`git push`; 55 accumulated `allow` entries in `settings.local.json` | allow-list is machine-local; slipway repos ship their own read-only allow-list in `.claude/settings.json` |
| Legacy commands (`~/.claude/commands`) | 7 | `atlassian`, `bitbucket`, `chainguard-migration`, `defender-scan`, `endorlabs-scan`, `endorlabs`, `sonarcloud-scan` |
| Skills (`~/.claude/skills`) | 15 | 7 `gitnexus-*`, `chainguard-tracker`, `defender-scan`, `endorlabs-scan`, `sonarcloud-scan`, `find-skills`, `infra-build-approval`, `infra-ticket`, `jira-work-item` |
| Cursor (`~/.cursor`) | 7 skills, no rules | `~/.cursor/skills/gitnexus-*` duplicates `~/.claude/skills/gitnexus-*` |

### 1b. `integranz/slipway` (plugin + marketplace)
| Layer | File | Content |
|---|---|---|
| Project | `CLAUDE.md` | `@AGENTS.md` + 6 non-negotiables (no unapproved apply, no secrets/tfvars/state, immutable tags, option status discipline, Conventional Commits, verify before asserting) |
| Routing | `AGENTS.md` | structure, "I want to…", skills index, rules & precedence paragraph, commit convention, multi-repo |
| Path rules | `.claude/rules/precedence.md` | added by this audit (same text as the template) |
| Mechanical | plugin hooks (4), agents (3) | apply to any session that loads the plugin |

### 1c. `integranz/slipway-demo` (target)
| Layer | File | Content / `paths:` |
|---|---|---|
| Project | `CLAUDE.md` (generated) | `@AGENTS.md` + 6 non-negotiables (+ the ticket-path rule added by this audit) |
| Routing | `AGENTS.md` (generated) | 9 sections incl. tool policy (MCP vs CLI) and multi-repo |
| Path rules | `precedence.md` | always |
| | `terraform.md` | `infra/**` |
| | `pipelines.md` | `.github/workflows/**` |
| | `docker.md` | `**/Dockerfile*`, `**/.dockerignore`, `**/nginx.conf` |
| | `versioning.md` | `version.json`, `.github/workflows/**` (nbgv) |
| | `branching.md` | was `.github/workflows/**` + `**/*.md`; now `.github/workflows/**`, `**/CONTRIBUTING.md`, `version.json`, `.releaserc*` |
| Settings | `.claude/settings.json` | marketplace + plugin, 32 read-only allow entries, **no hooks** (plugin provides them) |

## 2. Overlaps found and resolutions
| # | Overlap | Where | Resolution | Status |
|---|---|---|---|---|
| 1 | Same task as legacy command **and** skill: `defender-scan`, `endorlabs-scan`, `sonarcloud-scan` | user scope | Keep the skills (documented primary unit), delete the three `~/.claude/commands/*.md` duplicates | **done 2026-09-16** (backup in `~/.claude/backups/rules-audit-2026-09-16/`) |
| 2 | `infra-ticket` skill has no frontmatter → never discoverable by description, only by name | user scope | Add `name`/`description` frontmatter (done; description also states it does not apply to slipway repos) | **done 2026-09-16** |
| 3 | Personal `jira-work-item` skill ("DEVOPS board", Datavant site) vs plugin `/slipway:ticket` (project `DEVOPS` on integranz.atlassian.net): same project key, different sites; a "create a ticket" request could trigger the personal skill inside slipway repos | user scope × both repos | Repo side (done): CLAUDE.md non-negotiable "work tracking goes through `/slipway:ticket` only; personal Jira skills do not apply here". Plugin skills are namespaced, so there is no name clash; the rule removes the trigger ambiguity | done in template; user may also narrow the personal skill's description to its site |
| 4 | `gitnexus-*` skills duplicated in `~/.cursor/skills` while Cursor already loads `~/.claude/skills` | user scope | Delete the `~/.cursor/skills/gitnexus-*` copies (single source, no drift); verified byte-identical before removal | **done 2026-09-16** |
| 5 | `branching.md` loaded on every `*.md` edit (too broad; overlapped with docs work) | adlc-demo template | Paths tightened to workflows, CONTRIBUTING, version files | done |
| 6 | Three path rules (`pipelines`, `versioning`, `branching`) all match `.github/workflows/**` | adlc-demo | Intentional: each covers a different concern (CI/CD shape, version source, branch policy) and none contradicts another; kept short (≤ 8 bullets each) | accepted |
| 7 | "Immutable tags", "no secrets", "no unapproved apply" stated in CLAUDE.md **and** AGENTS.md **and** rules | adlc-demo | Intentional layering: CLAUDE.md = one-line non-negotiable, AGENTS.md = where to go, rule = path-scoped detail with a link to the skill reference. Wording checked for contradictions: none | accepted |
| 8 | Plugin repo had no `.claude/rules/` | slipway | `precedence.md` added so both repos in scope carry the same precedence statement | done |
| 9 | User `settings.local.json` allow-list (55 entries incl. Ontellus/ADO commands) applies inside slipway sessions | user scope | Harmless (allow-only, read-mostly); slipway repos add their own explicit allow-list; no `deny` rules exist anywhere, so nothing can conflict | accepted |

## 3. Precedence (recorded in `.claude/rules/precedence.md` in both repos)
1. Plugin guard hooks (mechanical; cannot be relaxed by any file or by `CLAUDE.local.md`)
2. Managed policy (none present)
3. User `~/.claude/CLAUDE.md` (empty)
4. Project `CLAUDE.md` + `AGENTS.md`
5. Path-scoped `.claude/rules/*.md` (refine, never override)
6. `CLAUDE.local.md` (none present)
Skill name conflicts follow Claude Code's documented order (enterprise → personal → project); plugin skills are namespaced (`slipway:<name>`) and therefore never collide.

## 4. Procedures moved out of rules
Every rule is ≤ 8 bullets and links to a skill reference for the procedure: `terraform.md` → `delivery-knowledge/references/cloud-azure-foundation.md`, `compute-aca.md`; `docker.md` → `base-image-dhi.md`; `pipelines.md`/`versioning.md` → `runner-github-actions.md`, `versioning-nbgv.md`; identity and secrets → `identity-and-secrets.md`; the apply protocol lives in the `plan` skill and `scripts/approve-apply.sh`.

## 5. Sign-off
| Repo | Inventory | Overlaps resolved | Precedence doc | Skills linked | Result |
|---|---|---|---|---|---|
| `integranz/slipway` | done | done (#8) | done | done | 100 % |
| `integranz/slipway-demo` | done | done (#3, #5; #6/#7 accepted) | done | done | 100 % |
| user scope (context, not a repo in scope) | done | done (#1, #2, #4 applied 2026-09-16 with backups) | n/a | n/a | clean |
