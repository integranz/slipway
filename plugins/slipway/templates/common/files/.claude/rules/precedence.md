# Rule precedence in this repository

When instructions overlap, the more specific and more mechanical one wins:

1. **Guard hooks from the slipway plugin** (PreToolUse). Mechanical; cannot be relaxed by any file in this repo or by `CLAUDE.local.md`. If a hook blocks you, report it; do not work around it.
2. **Managed policy** (organisation-managed settings), if present.
3. **User scope** `~/.claude/CLAUDE.md` — personal preferences only; must not contradict project rules.
4. **Project scope** `CLAUDE.md` (non-negotiables) and `AGENTS.md` (routing).
5. **Path-scoped rules** `.claude/rules/*.md` with `paths:` — apply only to matching files and refine, never override, the non-negotiables.
6. **`CLAUDE.local.md`** — personal, gitignored, lowest precedence.

Procedures (how to do something step by step) belong in plugin skills, not in rules. A rule states what must or must not happen; if it needs more than a few lines, it links to a skill.
