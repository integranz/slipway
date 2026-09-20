# Tracker option `jira` — Jira Cloud through the Atlassian Rovo MCP Server

## Model (decided 2026-09-17 with the owner)
- **Epic** (optional, owned by the team) → **Story** per delivery of the repository (the onboarding, then one story per change request, its key kept in `jira.story_key`) → **Subtask** per unit of work: `Bootstrap <project>`, `Dockerize <app>`, `Foundation <env>: plan and apply`, `Deploy <app> <tag> → <env>` (verification is a comment on the deploy subtask).
- Each skill keeps its subtask current: start (In Progress) when the work starts, review while a deploy waits for the human approval, done with the result and links. The story auto-closes when no subtask is open.
- `options.tracker: none` disables tracking (skills print `tracking: disabled`). An unreachable or unauthorised Jira never blocks: updates go to `.slipway/tracking-queue.jsonl` (gitignored) and `/slipway:ticket sync` replays them.

## Facts verified against Atlassian sources (2026-09-17)
- Jira Cloud REST v3 "Create issue": a subtask is created with a subtask issue type (`subtask: true` in the project's issue-type metadata) and `parent` = the parent issue key or id; the parent must be in the same project.
- Epic linkage: Atlassian deprecated the `Epic Link` and `Parent Link` custom fields (announcement of 2021-11-30, effective 2022–2023); company-managed and team-managed projects both use the `parent` field for story → epic.
- Issue-type names differ by project type: team-managed projects call it `Subtask`, company-managed `Sub-task`; `jira.subtask_issue_type` pins it, otherwise the skill discovers the type flagged `subtask: true`.
- Rovo MCP Server: remote endpoint `https://mcp.atlassian.com/v2/mcp`, OAuth 2.1 per user (interactive `/mcp` login), Standard plan or higher, consumes Rovo credits. Tools exercised on 2026-09-16 (DEVOPS-5): `getAccessibleAtlassianResources`, `listJiraProjects`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `getJiraIssue`, `listJiraIssueTransitions`, `transitionJiraIssue`, `addOrEditJiraIssueComment`.
- **To confirm in the next interactive golden path**: whether `createJiraIssue` exposes the `parent` field directly (expected as an additional field) or the parent must be set with the edit tool after creation. The skill handles both and reads the parent back.

## JQL used
- Story lookup: `project = <KEY> AND summary ~ "<title>" AND statusCategory != Done`
- Subtask lookup: `parent = <STORY> AND summary ~ "\"<title>\""` (exact summary match wins)
- Auto-close check: `parent = <STORY> AND statusCategory != Done` → 0 results closes the story

## Evidence
- Golden path (flat story, 2026-09-16): https://integranz.atlassian.net/browse/DEVOPS-5 (org access).
- Story + subtasks golden path: scheduled with the owner after plugin 0.14.0.
