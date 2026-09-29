#!/usr/bin/env node
// Jira Cloud REST v3 transport for slipway tracking (options.tracker_transport: rest | both). Deterministic, no MCP:
// used by the generated workflows (slipway-tracker.yml, _cd.yml) and by unattended sessions (Cursor Cloud Agents with
// JIRA_EMAIL / JIRA_API_TOKEN in the environment). Same model as skills/ticket: one Story per delivery, one Subtask per
// unit of work, a read-back after every write, auto-close of the story when no subtask is open; same JQL as
// skills/delivery-knowledge/references/tracker-jira.md.
// Auth: Basic <email:api token> (developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis, read 2026-09-27).
// Search: GET /rest/api/3/search/jql, the enhanced search (the old /search is being removed; read 2026-09-29).
// usage: node jira-rest.cjs [--repo <dir>] [--soft] [--json] <command>
//   story ensure [--title "<t>"] [--epic <KEY>]                          find (jira.story_key, then by title) or create; prints the key
//   story done [--story <KEY>] [--message "<m>"]                          close the story
//   subtask start|review|done "<title>" [--story <KEY>] [--message "<m>"] [--evidence <file|url>]
//   comment <KEY> --message "<m>" [--evidence <file|url>]
// env: JIRA_EMAIL and JIRA_API_TOKEN (required); JIRA_SITE_URL overrides jira.site_url. Never printed.
// exit: 0 done; 3 tracker off/unconfigured (0 with --soft, tracking never blocks delivery); 1 error (0 with --soft).
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { loadConfig } = require("./lib/config.cjs");

const argv = process.argv.slice(2);
const flags = {}; const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--soft" || a === "--json") { flags[a.slice(2)] = true; continue; }
  if (a.startsWith("--")) { flags[a.slice(2)] = argv[i + 1]; i++; continue; }
  positional.push(a);
}
const soft = !!flags.soft, asJson = !!flags.json;
const out = (line, obj) => { if (asJson) console.log(JSON.stringify(obj || { message: line })); else console.log(line); };
const stop = (code, line) => { out(line, { message: line, code }); process.exit(soft && code !== 0 ? 0 : code); };

const [group, action, ...rest] = positional;
if (!group || !["story", "subtask", "comment"].includes(group)) stop(2, "usage: jira-rest.cjs [--repo <dir>] [--soft] [--json] story ensure|done | subtask start|review|done \"<title>\" | comment <KEY> --message ...");

const repo = path.resolve(flags.repo || ".");
const { config, errors } = loadConfig(path.join(repo, ".slipway", "config.yaml"));
if (errors.length) stop(1, `tracking: .slipway/config.yaml invalid: ${errors[0]}`);
if (config.options.tracker !== "jira") stop(0, `tracking: disabled (tracker=${config.options.tracker})`);
const jira = config.jira || {};
const site = (process.env.JIRA_SITE_URL || jira.site_url || "").replace(/\/$/, "");
const email = process.env.JIRA_EMAIL, token = process.env.JIRA_API_TOKEN;
if (!site) stop(3, "tracking: jira.site_url missing");
if (!email || !token) stop(3, "tracking: jira-rest not configured (JIRA_EMAIL and JIRA_API_TOKEN must be in the environment); queue the update or run /slipway:ticket sync from a session with the Atlassian MCP");
const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
const transitions = { start: "In Progress", review: "In Review", done: "Done", ...(jira.transitions || {}) };
const issueType = jira.issue_type || "Story", subtaskType = jira.subtask_issue_type || "Subtask";
const defaultTitle = `Onboard ${config.project.name} to slipway delivery`;

async function api(method, p, body) {
  const res = await fetch(`${site}/rest/api/3${p}`, { method, headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  return json;
}
const q = (s) => encodeURIComponent(s);
const jqlText = (s) => s.replace(/["\\]/g, "\\$&");
async function search(jql, max = 50) { const r = await api("GET", `/search/jql?jql=${q(jql)}&maxResults=${max}&fields=summary,status,parent,issuetype`); return r && r.issues ? r.issues : []; }
async function getIssue(key) { return api("GET", `/issue/${key}?fields=summary,status,parent,issuetype`); }
const adf = (text) => ({ type: "doc", version: 1, content: text.split(/\n{2,}/).filter(Boolean).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) });
function evidenceText() {
  const e = flags.evidence; if (!e) return "";
  if (/^https?:\/\//.test(e)) return `Evidence: ${e}`;
  if (!fs.existsSync(e)) return `Evidence file not found: ${e}`;
  const lines = fs.readFileSync(e, "utf8").split("\n").filter((l) => /^\|/.test(l) || /^Result:/.test(l) || /^evidence:/.test(l));
  return lines.length ? lines.join("\n") : fs.readFileSync(e, "utf8").slice(0, 2000);
}
function messageText(fallback) { const parts = [flags.message || fallback, evidenceText()].filter(Boolean); return parts.join("\n\n"); }
async function comment(key, text) { if (!text) return; await api("POST", `/issue/${key}/comment`, { body: adf(text) }); }
async function createIssue(fields) { const r = await api("POST", "/issue", { fields }); return getIssue(r.key); }
async function transitionTo(key, target) {
  const cur = await getIssue(key); const now = cur.fields.status && cur.fields.status.name;
  if (now && now.toLowerCase() === target.toLowerCase()) return cur;
  const list = (await api("GET", `/issue/${key}/transitions`)).transitions || [];
  const pick = (name) => list.find((t) => t.to && t.to.name && t.to.name.toLowerCase() === name.toLowerCase());
  let t = pick(target);
  if (!t && target.toLowerCase() !== transitions.start.toLowerCase() && pick(transitions.start)) { // some workflows need In Progress first
    await api("POST", `/issue/${key}/transitions`, { transition: { id: pick(transitions.start).id } });
    const again = (await api("GET", `/issue/${key}/transitions`)).transitions || [];
    t = again.find((x) => x.to && x.to.name && x.to.name.toLowerCase() === target.toLowerCase());
  }
  if (!t) throw new Error(`${key}: no transition to '${target}' from '${now}'; available: ${list.map((x) => x.to && x.to.name).filter(Boolean).join(", ") || "none"} (check jira.transitions)`);
  await api("POST", `/issue/${key}/transitions`, { transition: { id: t.id } });
  return getIssue(key);
}
async function ensureStory() {
  const key = flags.story || jira.story_key;
  if (key) { const s = await getIssue(key); return { issue: s, created: false }; }
  const title = flags.title || defaultTitle;
  const found = await search(`project = ${jira.project_key} AND summary ~ "${jqlText(title)}" AND statusCategory != Done ORDER BY created DESC`, 5);
  const exact = found.find((i) => i.fields.summary === title) || found[0];
  if (exact) return { issue: await getIssue(exact.key), created: false };
  const fields = { project: { key: jira.project_key }, summary: title, issuetype: { name: issueType },
    description: adf(`Delivery story of ${config.project.name} (slipway). One subtask per unit of work; the story closes when no subtask is open.`) };
  const epic = flags.epic || jira.epic_key; if (epic) fields.parent = { key: epic };
  return { issue: await createIssue(fields), created: true };
}
async function ensureSubtask(storyKey, title) {
  const found = await search(`parent = ${storyKey} AND summary ~ "\\"${jqlText(title)}\\"" ORDER BY created DESC`, 10);
  const exact = found.find((i) => i.fields.summary === title) || found[0];
  if (exact) return { issue: await getIssue(exact.key), created: false };
  return { issue: await createIssue({ project: { key: jira.project_key }, parent: { key: storyKey }, summary: title, issuetype: { name: subtaskType }, description: adf(`Unit of work of ${storyKey}, kept current by slipway.`) }), created: true };
}
async function autoClose(storyKey) {
  const open = await search(`parent = ${storyKey} AND statusCategory != Done`, 1);
  if (open.length) return { closed: false, open: open.length };
  const s = await transitionTo(storyKey, transitions.done);
  await comment(storyKey, "All subtasks done; closed by slipway.");
  return { closed: true, status: s.fields.status.name };
}
const fmt = (i) => `${i.key} "${i.fields.summary}" → ${i.fields.status ? i.fields.status.name : "?"}`;

(async () => {
  if (group === "story" && action === "ensure") {
    const { issue, created } = await ensureStory();
    out(`tracking: story ${created ? "created" : "found"} ${fmt(issue)} (jira-rest)`, { key: issue.key, created, status: issue.fields.status.name, summary: issue.fields.summary });
    return;
  }
  if (group === "story" && action === "done") {
    const { issue } = await ensureStory(); await comment(issue.key, messageText("")); const s = await transitionTo(issue.key, transitions.done);
    out(`tracking: story done ${fmt(s)} (jira-rest)`, { key: s.key, status: s.fields.status.name }); return;
  }
  if (group === "subtask") {
    if (!["start", "review", "done"].includes(action) || !rest[0]) stop(2, "usage: jira-rest.cjs subtask start|review|done \"<title>\" [--story KEY] [--message ..] [--evidence <file|url>]");
    const title = rest[0]; const { issue: story } = await ensureStory();
    const { issue: sub, created } = await ensureSubtask(story.key, title);
    await comment(sub.key, messageText(""));
    const s = await transitionTo(sub.key, transitions[action]);
    let closed = null; if (action === "done") closed = await autoClose(story.key);
    out(`tracking: subtask ${action} ${fmt(s)}${created ? " (created)" : ""} under ${story.key}${closed && closed.closed ? `; story closed (${closed.status})` : ""} (jira-rest)`,
      { story: story.key, key: s.key, created, status: s.fields.status.name, story_closed: !!(closed && closed.closed) });
    return;
  }
  if (group === "comment") {
    const key = action; if (!key || !flags.message) stop(2, "usage: jira-rest.cjs comment <KEY> --message \"<m>\" [--evidence <file|url>]");
    await comment(key, messageText("")); const i = await getIssue(key);
    out(`tracking: comment added ${fmt(i)} (jira-rest)`, { key: i.key, status: i.fields.status.name }); return;
  }
  stop(2, `unknown command: ${group} ${action || ""}`);
})().catch((e) => { const msg = String(e && e.message || e).replace(token, "***"); stop(1, `tracking: jira-rest failed: ${msg}`); });
