# Tracker option `jira` — Jira Cloud through the Atlassian Rovo MCP Server

## Model (decided 2026-09-17 with the owner)
- **Epic** (optional, owned by the team) → **Story** per delivery of the repository (the onboarding, then one story per change request, its key kept in `jira.story_key`) → **Subtask** per unit of work: `Bootstrap <project>`, `Dockerize <app>`, `Foundation <env>: plan and apply`, `Deploy <app> <tag> → <env>` (verification is a comment on the deploy subtask).
- Each skill keeps its subtask current: start (In Progress) when the work starts, review while a deploy waits for the human approval, done with the result and links. The story auto-closes when no subtask is open.
- `options.tracker: none` disables tracking (skills print `tracking: disabled`). An unreachable or unauthorised Jira never blocks: updates go to `.slipway/tracking-queue.jsonl` (gitignored) and `/slipway:ticket sync` replays them.

## Facts verified against Atlassian sources (2026-09-17)
- Jira Cloud REST v3 "Create issue": a subtask is created with a subtask issue type (`subtask: true` in the project's issue-type metadata) and `parent` = the parent issue key or id; the parent must be in the same project.
- Epic linkage: Atlassian deprecated the `Epic Link` and `Parent Link` custom fields (announcement of 2021-11-30, effective 2022–2023); company-managed and team-managed projects both use the `parent` field for story → epic.
- Issue-type names differ by project type: team-managed projects call it `Subtask`, company-managed `Sub-task`; `jira.subtask_issue_type` pins it, otherwise the skill discovers the type flagged `subtask: true`.
- Rovo MCP Server: remote endpoint `https://mcp.atlassian.com/v2/mcp`, OAuth 2.1 per user (interactive `/mcp` login), Standard plan or higher, consumes Rovo credits. Tools exercised on 2026-09-16 (DEVOPS-5) and 2026-09-20 (DEVOPS-6/7/8): `getAccessibleAtlassianResources`, `listJiraProjects`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `getJiraIssue`, `listJiraIssueTransitions`, `transitionJiraIssue`, `addOrEditJiraIssueComment`.
- **Confirmed 2026-09-20** (schema of `createJiraIssue` read from the server): parameters `cloudId`, `projectKey`, `summary`, `issueType` (required) and `description`, `contentFormat` (`markdown`/`html`), `parent` (parent issue key for subtasks or child issues), `additional_fields`, `labels`, `priority`, `assignee`, `assignToSprint` (optional; `additionalProperties: false`). Subtasks DEVOPS-7 and DEVOPS-8 were created under story DEVOPS-6 with `parent`. Note the parameter is `issueType`, not `issueTypeName`.
- **Tool surface (2026-09-20, 21 tools)**: primary Jira tools `getJiraIssue`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `searchJiraIssuesUsingJql`, `getAccessibleAtlassianResources`, `atlassianUserInfo`; Confluence and Loom tools; and the meta-tools `discover`, `executeRead`, `executeWrite`, `executeDestructive` for everything else (issue-type metadata, available transitions). `listJiraIssueTransitions` / `listJiraProjects` are not primary tools. A headless `claude -p` session must name every tool it may call in `--allowedTools` (`mcp__plugin_slipway_atlassian__<tool>`).
- **Headless reuse of the grant confirmed 2026-09-20**: after the owner authorised `atlassian` in an interactive session, `claude -p` sessions on the same machine used the read tools without a new login.

## JQL used
- Story lookup: `project = <KEY> AND summary ~ "<title>" AND statusCategory != Done`
- Subtask lookup: `parent = <STORY> AND summary ~ "\"<title>\""` (exact summary match wins)
- Auto-close check: `parent = <STORY> AND statusCategory != Done` → 0 results closes the story

## Evidence
- Golden path (flat story, 2026-09-16): https://integranz.atlassian.net/browse/DEVOPS-5 (org access).
- Story + subtasks golden path (2026-09-20, plugin 0.14.2): https://integranz.atlassian.net/browse/DEVOPS-6 with subtasks DEVOPS-7 (`Deploy api 0.2.4 → dev`) and DEVOPS-8 (`Deploy web 0.2.4 → dev`), created by `/slipway:verify` through `subtask done|review` (org access).
