# REVIEW-PACKET

Status: not started (scheduled in week 3, see adlc-poc/docs/04-schedule-prereqs-risks.md).

## Reviewer questions, answered

### Why are the slipway commands skills (`skills/<name>/SKILL.md`) and not command files (`commands/<name>.md`)?
Claude Code merged custom slash commands into skills. The official documentation, "Extend Claude with skills" (https://code.claude.com/docs/en/skills, read 2026-09-29), states:

> **Custom commands have been merged into skills.** A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way. Your existing `.claude/commands/` files keep working. Skills add optional features: a directory for supporting files, frontmatter to control whether you or Claude invokes them, and the ability for Claude to load them automatically when relevant.

The former slash-commands page (https://code.claude.com/docs/en/slash-commands) now serves that same document, and the plugin reference (https://code.claude.com/docs/en/plugins-reference) lists `commands` as "flat `.md` command files" next to `skills` as directories of `<name>/SKILL.md`; both load, the folder form is the current one.

slipway's seven commands (`launch`, `bootstrap`, `dockerize`, `plan`, `deploy`, `verify`, `ticket`) are skills with `disable-model-invocation: true`, the documented way to make a skill user-invoked only: the model never starts them on its own, you type `/slipway:<name>`. The folder form is what they need: scripts under `${CLAUDE_PLUGIN_ROOT}/scripts`, shared references in `delivery-knowledge/`, and `allowed-tools` limits per skill. The same `SKILL.md` folders are what Cursor loads (`/<name>` in the Cursor plugin, and the cloud agents read them from the installed plugin), so one implementation serves both hosts. Goal 3 ("Commands") is therefore delivered as user-only skills; `docs/COMMAND-CATALOG.md` lists them with arguments, defaults and safety notes.
