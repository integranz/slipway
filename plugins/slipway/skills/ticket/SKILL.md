---
name: ticket
description: Keep the tracker current for this repository's delivery through the Atlassian Rovo MCP Server: one Story per delivery (attached to an optional Epic), one Subtask per unit of work, read-backs after every write, and an offline queue so an unreachable tracker never blocks delivery.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/*), Read, Glob, Grep, Edit, Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tracking-queue.cjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/app-info.cjs" *), Bash(git rev-parse *), Bash(git remote *), Bash(git status *), Bash(gh run list *), Bash(gh run view *)
---

# /slipway:ticket — tracker lifecycle (epic → story → subtasks)

Model: an **Epic** you own (optional) → one **Story** per delivery of this repository (the onboarding first, then one story per change request, named in `.slipway/config.yaml`) → one **Subtask** per unit of work, created and kept current by the skill that does the work (`bootstrap`, `dockerize`, `plan`, `deploy`; `verify` comments on the deploy subtask). The story closes itself when its last subtask is done.

Arguments: `$0` action, then:
| Action | Arguments | Effect |
|---|---|---|
| `story create` | `--title "<text>"` (default `Onboard <project> to slipway delivery`), `--epic <KEY>` (default `jira.epic_key`) | creates the Story (parent = epic when given), writes `jira.story_key` into `.slipway/config.yaml` |
| `story set <KEY>` | | verifies the issue exists in `jira.project_key` and is not a subtask, writes `jira.story_key` |
| `subtask start "<title>"` | `--message` | finds the subtask `<title>` under the story or creates it, transitions it to `jira.transitions.start`; prints its key. **Story follows**: when the story is still in the To Do status category, transition it to `jira.transitions.start` too (work has begun) |
| `subtask review <KEY\|"<title>">` | `--message`, `--evidence <file>` | by title: find or create; comment + transition to `jira.transitions.review` (a deploy waiting for the human approval, or a verification with findings) |
| `subtask done <KEY\|"<title>">` | `--message`, `--evidence <file>` | by title: find or create the subtask (deploys started by `workflow_run` have no skill run before `verify`); comment + transition to `jira.transitions.done`; then **auto-close**: if no subtask of the story is left open, transition the story to done with the comment "all subtasks done; closed by slipway" |
| `comment <KEY>` | `--message`, `--evidence <file>` | comment (evidence trimmed to the claims table and result line) |
| `show [<KEY>]` | | story (default `jira.story_key`) with status and its subtasks (key, summary, status) |
| `done <KEY>` | `--evidence` | manual close of a story or subtask; refused when the evidence file reports any REFUTED claim |
| `sync` | | replays `.slipway/tracking-queue.jsonl` in order (see Availability), popping each entry that succeeds |
| `create`, `start`, `review` | | kept for compatibility: `create` = `story create`; `start`/`review` act on the story |

## Preconditions and availability (never a blocker)
1. `.slipway/config.yaml` validates. `options.tracker: none` → print `tracking: disabled (tracker=none)` and stop successfully; the calling skill continues.
2. `options.tracker: jira` → read `jira.site_url`, `jira.project_key`, `jira.epic_key`, `jira.story_key`, `jira.issue_type`, `jira.subtask_issue_type`, `jira.transitions`.
3. The Atlassian Rovo MCP Server (plugin server `atlassian`, `https://mcp.atlassian.com/v2/mcp`) must answer `getAccessibleAtlassianResources` (gives the `cloudId` every other call needs). Primary Jira tools on the server (2026-09-20): `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `searchJiraIssuesUsingJql`, `getAccessibleAtlassianResources`, `atlassianUserInfo`; anything else (listing a project's issue types or an issue's available transitions) goes through the `discover` / `executeRead` / `executeWrite` meta-tools, which headless sessions must allow explicitly. **If it does not** (not connected, not authorised, headless session without a grant): do not stop the caller. Queue the intended update with `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracking-queue.cjs" add <action> '<json>'` (actions `story_create`, `story_set`, `subtask_start`, `subtask_review`, `subtask_done`, `comment`, `story_done`; args = the same arguments as the action) and print `tracking: queued <action> (<n> pending); run /mcp, authorise atlassian, then /slipway:ticket sync`. Never fall back to `curl` with tokens and never fabricate a key.
4. Every write is followed by a read-back (`getJiraIssue`) and the read-back is what you report: key, status, summary. A key you did not read back does not exist.

## How each action maps to tools
- Project and types: `listJiraProjects` (or JQL `project = <KEY>` limited to 1) confirms the project; the project's issue types give the subtask type (`subtask: true`); when `jira.subtask_issue_type` is set, use it, otherwise take the discovered one and say which.
- Story: `createJiraIssue` with `cloudId`, `projectKey`, `issueType = jira.issue_type`, `summary`, `description` (structure below; `contentFormat: markdown`) and, when an epic is given, `parent = <EPIC>` (a direct string parameter of the tool, confirmed 2026-09-20); read the issue back and confirm `parent.key`. Jira Cloud links stories to epics and subtasks to parents through the same `parent` field in team-managed and company-managed projects (Epic Link is deprecated).
- Subtask lookup before create: JQL `parent = <STORY> AND summary ~ "\"<title>\""`; exact summary match wins; none → `createJiraIssue` with `issueType = <subtask type>`, `summary = <title>`, `parent = <STORY>`, description = one line "Created by slipway <skill> on <date>; repository <owner>/<repo>". Titles are canonical so lookups stay idempotent: `Bootstrap <project>`, `Dockerize <app>`, `Foundation <env>: plan and apply`, `Deploy <app> <tag> → <env>`.
- Transitions: `transitionJiraIssue` with the transition whose target status name equals the configured name (`start`/`review`/`done`); when the tool needs a transition id, read the available transitions first (`getJiraIssue` with transitions expanded, or `executeRead`); none matching → list what exists and stop that action (queue nothing; a wrong workflow is a config problem, report it).
- Comments: `addOrEditJiraIssueComment` with plain text and line breaks; evidence files are trimmed to the `Result:` line, the deployment URL and the claims table.
- **Auto-close is mandatory after every `subtask done`** (and after `done <SUBTASK>`): run JQL `parent = <STORY> AND statusCategory != Done`; 0 issues → transition the story to `jira.transitions.done` (through `jira.transitions.start` first if the workflow requires it) and comment "all subtasks done; closed by slipway"; otherwise print `story <KEY> stays open: <n> subtask(s) left: <keys>`. The output block must always contain one of these two lines. A story still in To Do while a subtask is done is a bug: move it to `jira.transitions.start` before closing.
- Writing `jira.story_key`: edit `.slipway/config.yaml` (the only file this skill edits), validate it, then tell the user to commit it through a pull request; do not commit yourself.

## Description structure (story)
```
Objective: <one sentence: what the repo delivers and where>
Scope: apps <name (kind, stack)>…; options <cloud/compute/registry/runner/versioning/branching/tracker/secret store/base image>
Units of work: one subtask each — bootstrap, dockerize per app, foundation per environment, deploy per app/tag/environment (verification recorded on the deploy subtask)
Acceptance: every subtask done; the last /slipway:verify of each app reports 0 refuted claims
Generated by slipway <plugin version> on <date>; repository <owner>/<repo>
```

## Output
```
## slipway ticket: <action> <KEY>
<site_url>/browse/<KEY> — <issue type> — status: <status>   (parent: <STORY or EPIC>)
<what changed: created | transitioned <from> → <to> | comment added | queued (n pending) | tracking disabled>
```

## Do not
- Do not create duplicate stories or subtasks: search before every create (story: `project = <KEY> AND summary ~ "<title>" AND statusCategory != Done`; subtask: by parent and summary).
- Do not delete issues, change workflows, permissions or sprints (the `delete_jira` and `manage_jira` tool groups stay disabled).
- Do not invent transitions, keys, statuses or evidence; do not mark anything done without the corresponding output or URL.
- Do not block or delay delivery work because the tracker is unavailable: queue and continue.
