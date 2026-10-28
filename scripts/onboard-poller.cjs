#!/usr/bin/env node
// Scheduled onboarding poller (docs/CURSOR-ONBOARDING.md, "Automatic onboarding"). Deterministic, no LLM: every tick lists
// the organisation's repositories, classifies each one from facts (archived/fork/empty, private, .slipway/config.yaml
// present, manifests in the tree, our tracking issue, open onboarding PRs) and acts: opens or updates ONE issue per
// repository and dispatches .github/workflows/onboard.yml for the repositories that need onboarding. The only agent run
// is the one onboard.yml starts. Every write to a target repository is an issue, a comment or a label; never a commit,
// a secret or a setting.
// usage: node onboard-poller.cjs [--dry-run] [--org <login>] [--max-dispatches <n>] [--repo <owner/name>]
// env: ONBOARD_GITHUB_TOKEN (org reads, issues, environments and rulesets; fine-grained: Contents read, Issues write,
//      Administration write, Metadata read on the org's repos), ONBOARD_REVIEWERS (comma-separated logins of the required
//      reviewers of the deployment environment; default: the token's owner), GITHUB_TOKEN (dispatches onboard.yml in
//      GITHUB_REPOSITORY; needs actions: write), ONBOARD_SOURCE (free text carried by the dispatcher, e.g. the relay's
//      event and delivery id; shown in the step summary), CURSOR_AUTOMATION_WEBHOOK_URL / _KEY / _KEY_TRANSPORT (optional
//      webhook-trigger Cursor Automation notified after a welcome, a dispatch or a not-deployable issue), ONBOARD_ANSWERS_TEMPLATE
//      (org defaults with <name> placeholders), ONBOARD_EXCLUDE (comma list of owner/name; the poller's own repository is
//      always excluded), ONBOARD_PRIVATE_REPOS (auto | onboard | skip: whether private repositories are onboarded; auto reads
//      the organisation plan once per tick: paid plans have environment protection rules on private repositories, GitHub
//      Free does not), GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY (optional).
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const LABELS = {
  onboarding: { name: "slipway-onboarding", color: "0E8A16", description: "slipway onboarding dispatched; a pull request follows" },
  notDeployable: { name: "slipway-not-deployable", color: "FBCA04", description: "slipway found no deployable application yet; re-checked on the next push" },
  notOnboarded: { name: "slipway-not-onboarded", color: "B60205", description: "slipway cannot onboard this repository as it is (see the issue)" },
  needsHuman: { name: "needs-human", color: "D93F0B", description: "the automation stopped; a person must look" },
  welcome: { name: "slipway-welcome", color: "1D76DB", description: "slipway is waiting for the first push with a deployable application" },
};
const ISSUE_TITLE = "slipway onboarding";
const MANIFESTS = [
  { glob: /(^|\/)[^/]+\.csproj$/, label: "*.csproj" }, { glob: /(^|\/)package\.json$/, label: "package.json" },
  { glob: /(^|\/)Dockerfile[^/]*$/, label: "Dockerfile" }, { glob: /(^|\/)pyproject\.toml$/, label: "pyproject.toml" },
  { glob: /(^|\/)requirements\.txt$/, label: "requirements.txt" }, { glob: /(^|\/)go\.mod$/, label: "go.mod" }, { glob: /(^|\/)pom\.xml$/, label: "pom.xml" },
];
const IGNORED_DIRS = /(^|\/)(node_modules|\.git|vendor|dist|build|bin|obj)\//;
const REDISPATCH_AFTER_MS = 2 * 60 * 60 * 1000;

// ---- pure functions (tested) -------------------------------------------------------------------------------------
function isDeployable(paths) {
  const found = new Set();
  for (const p of paths || []) { if (IGNORED_DIRS.test(p)) continue; for (const m of MANIFESTS) if (m.glob.test(p)) found.add(m.label); }
  return { deployable: found.size > 0, found: [...found].sort(), lookedFor: MANIFESTS.map((m) => m.label) };
}
const hyphenSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const alnumSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
function renderAnswers(template, repoName) {
  const lines = String(template || "").split("\n").map((l) => l.replace(/\r$/, ""));
  const out = [];
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z0-9_.]+)\s*:\s*(.*)$/); if (!m) throw new Error(`answers template: not a 'key: value' line: ${line}`);
    const [, key, value] = m; const slug = /acr_name|storage_account/.test(key) ? alnumSlug(repoName) : hyphenSlug(repoName);
    const v = value.split("<name>").join(slug); if (/<[a-z_]+>/.test(v)) throw new Error(`answers template: unknown placeholder in '${key}: ${value}' (only <name> is supported)`);
    out.push(`${key}: ${v}`);
  }
  return out.join("\n");
}
// Per-repository overrides: a fenced block tagged `answers` in the issue body or any comment, `key: value` per line.
// Blocks are merged in chronological order (later keys win); `at` is the time of the newest block.
function answersBlocks(issue) {
  const out = [];
  const scan = (text, at) => { const re = /```answers[ \t]*\n([\s\S]*?)```/g; let m; while ((m = re.exec(String(text || "")))) out.push({ text: m[1].trim(), at }); };
  if (!issue) return out;
  scan(issue.body, issue.created_at || "1970-01-01T00:00:00Z");
  for (const c of issue.comments || []) scan(c.body, c.created_at || "1970-01-01T00:00:00Z");
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function latestAnswers(issue) { const blocks = answersBlocks(issue); if (!blocks.length) return null; return { text: blocks.map((b) => b.text).join("\n"), at: blocks[blocks.length - 1].at }; }
function parseAnswers(text) { const map = new Map(); for (const line of String(text || "").split("\n")) { const m = line.match(/^\s*([A-Za-z0-9_.\[\]]+)\s*:\s*(.*?)\s*$/); if (m && !line.trim().startsWith("#")) map.set(m[1], m[2]); } return map; }
function mergeAnswers(base, override) { const map = parseAnswers(base); for (const [k, v] of parseAnswers(override)) map.set(k, v); return [...map].map(([k, v]) => `${k}: ${v}`).join("\n"); }
// GitHub gates created at dispatch, so the first CD run is protected before the pull request exists:
// the deployment environment with required reviewers (GitHub would otherwise auto-create it unprotected on first use) and
// a pull-request-only ruleset on the default branch (no required checks yet: app names are unknown until the agent decides,
// and with pr_checks: path-filtered they must not be required; /slipway:launch adds them for always-run-gate).
function environmentBody(reviewerIds) { return { reviewers: reviewerIds.map((id) => ({ type: "User", id })), deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }; }
function prOnlyRuleset(defaultBranch) {
  return { name: `${defaultBranch}: pull requests (slipway)`, target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [],
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } }] };
}
function gatesPlan({ envJson, rulesJson }) {
  const reviewers = envJson && Array.isArray(envJson.protection_rules) ? envJson.protection_rules.filter((r) => r.type === "required_reviewers").length : 0;
  const hasPr = Array.isArray(rulesJson) && rulesJson.some((r) => r.type === "pull_request");
  return { createEnv: !envJson || reviewers === 0, createRuleset: !hasPr };
}
function environmentName(answersText) { return parseAnswers(answersText).get("github.cd_environment") || "dev"; }
function runEndedMarkers(issue) { return (issue.comments || []).map((c) => marker(c.body, "run-ended")).filter(Boolean); }
function marker(text, key) { const m = String(text || "").match(new RegExp(`<!-- slipway:${key}((?: [a-z_]+=[^ >]+)*) -->`)); if (!m) return null; const o = {}; for (const kv of m[1].trim().split(/\s+/).filter(Boolean)) { const [k, v] = kv.split("="); o[k] = v; } return o; }
function dispatchMarkers(issue) { return (issue.comments || []).map((c) => marker(c.body, "dispatched")).filter(Boolean); }
function hasLabel(issue, name) { return (issue.labels || []).some((l) => (typeof l === "string" ? l : l.name) === name); }
// Private repositories: GitHub Free has no environment protection rules on them (a deployment would apply without a human
// approval); paid plans do. `org.plan` is GET /orgs/{org} .plan.name (free | team | business | enterprise; null when the
// token cannot see it) and `org.privateRepos` is ONBOARD_PRIVATE_REPOS (auto | onboard | skip). Pure.
function privatePolicy(org = {}) {
  const mode = String(org.privateRepos || "auto").toLowerCase(); const plan = org.plan ? String(org.plan).toLowerCase() : null;
  if (mode === "onboard") return { onboard: true, why: "ONBOARD_PRIVATE_REPOS=onboard" };
  if (mode === "skip") return { onboard: false, why: "ONBOARD_PRIVATE_REPOS=skip" };
  if (!plan) return { onboard: false, why: "the organisation plan is not visible to the poller's token, and GitHub Free has no environment protection on private repositories (set ONBOARD_PRIVATE_REPOS=onboard on a paid plan)" };
  if (plan === "free") return { onboard: false, why: "no environment protection rules on private repositories with the GitHub Free plan" };
  return { onboard: true, why: `GitHub ${plan} plan: environment protection rules apply to private repositories` };
}
// Decide what to do for one repository. Inputs are facts; the output is one action with reasons.
function classify(ctx) {
  const { repo, head, configExists, tree, issue, openOnboardingPr, now = new Date() } = ctx;
  if (repo.excluded) return { action: "skip", reason: "excluded" };
  if (repo.archived) return { action: "skip", reason: "archived" };
  if (repo.fork) return { action: "skip", reason: "fork" };
  if (configExists) return issue && issue.state === "open" ? { action: "close-issue", reason: ".slipway/config.yaml is on the default branch" } : { action: "skip", reason: "onboarded" };
  const priv = repo.private ? privatePolicy(ctx.org) : null;
  if (priv && !priv.onboard) return issue && hasLabel(issue, LABELS.notOnboarded.name) ? { action: "skip", reason: "private; already reported" } : { action: "issue-private", reason: `private repository: ${priv.why}`, why: priv.why };
  if (issue && issue.state === "open" && hasLabel(issue, LABELS.notOnboarded.name)) return { action: "close-issue", reason: priv ? `private repositories are onboarded on this plan (${priv.why}); re-evaluating on the next tick` : "repository is public now; re-evaluating on the next tick" };
  if (!head) { // empty default branch: greet once (the instant path reacts to repository.created); a closed welcome never reopens and does not opt out
    if (issue) return { action: "skip", reason: issue.state === "open" && hasLabel(issue, LABELS.welcome.name) ? "welcome posted; waiting for the first push" : "empty repository; an issue exists" };
    return { action: "welcome", reason: "empty repository: welcome issue" };
  }
  const fromWelcome = !!issue && issue.state === "open" && hasLabel(issue, LABELS.welcome.name);
  const det = isDeployable(tree);
  const answers = latestAnswers(issue);
  if (issue && issue.state === "open" && hasLabel(issue, LABELS.onboarding.name)) {
    if (openOnboardingPr) return { action: "skip", reason: `onboarding pull request open: ${openOnboardingPr.url}` };
    const dsAll = dispatchMarkers(issue); const lastD = dsAll.length ? dsAll[dsAll.length - 1] : null; const lastAt = lastD ? Date.parse(lastD.at || 0) : NaN;
    // the annotation job reports the end of a run on the issue; dispatches older than the retry window count as ended too
    // (issues created before the marker existed, or an annotation job that never ran)
    const ended = !!lastD && (runEndedMarkers(issue).some((m) => Date.parse(m.at || 0) >= lastAt) || (now - lastAt) >= REDISPATCH_AFTER_MS);
    const sinceAnswers = answers ? dsAll.filter((d) => Date.parse(d.at || 0) > Date.parse(answers.at)) : dsAll; // attempts since the newest answers
    if (answers && sinceAnswers.length === 0) { // new answers on the issue: retry as soon as the previous run has ended
      if (!lastD || ended) return { action: "redispatch", reason: `new answers on the issue (${answers.at})`, detector: det, overrides: answers, clearNeedsHuman: hasLabel(issue, LABELS.needsHuman.name) };
      return { action: "wait", reason: "new answers on the issue; waiting for the current run to end" };
    }
    if (hasLabel(issue, LABELS.needsHuman.name)) return { action: "skip", reason: "needs-human (add an ```answers block to the issue to retry)" };
    if (!dsAll.length || (now - lastAt) < REDISPATCH_AFTER_MS) return { action: "wait", reason: dsAll.length ? `dispatched ${Math.round((now - lastAt) / 60000)} min ago, no pull request yet` : "dispatch pending" };
    if (sinceAnswers.length >= 2) return { action: "needs-human", reason: "two dispatches without a pull request" };
    return { action: "redispatch", reason: "no pull request two hours after the dispatch", detector: det, overrides: answers };
  }
  if (issue && issue.state === "open" && hasLabel(issue, LABELS.notDeployable.name)) {
    const m = marker(issue.body, "not-deployable") || {};
    if (answers && Date.parse(answers.at) > Date.parse(issue.created_at || 0) && !dispatchMarkers(issue).some((d) => Date.parse(d.at || 0) > Date.parse(answers.at)))
      return { action: "dispatch", reason: `answers on the issue override the detector (${answers.at})`, detector: det, relabel: true, overrides: answers };
    if (m.head === head) return { action: "skip", reason: "not deployable; head unchanged" };
    return det.deployable ? { action: "dispatch", reason: `deployable since ${head.slice(0, 7)}: ${det.found.join(", ")}`, detector: det, relabel: true } : { action: "update-not-deployable", reason: "head changed, still not deployable", detector: det };
  }
  if (issue && issue.state === "closed" && hasLabel(issue, LABELS.onboarding.name) && !openOnboardingPr) return { action: "skip", reason: "onboarding issue closed by a human; not re-dispatching" };
  if (det.deployable) return { action: "dispatch", reason: `deployable: ${det.found.join(", ")}${fromWelcome ? " (first push after the welcome)" : ""}`, detector: det, relabel: fromWelcome, overrides: fromWelcome && answers ? answers : undefined };
  return { action: "issue-not-deployable", reason: `no manifest found (looked for ${det.lookedFor.join(", ")})`, detector: det, relabel: fromWelcome };
}

// ---- GitHub plumbing (gh CLI) -----------------------------------------------------------------------------------------
const args = process.argv.slice(2); const flag = (n) => args.includes(n); const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DRY = flag("--dry-run");
function gh(token, ghArgs, { input, ok404 } = {}) {
  try { return execFileSync("gh", ghArgs, { encoding: "utf8", env: { ...process.env, GH_TOKEN: token }, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { const msg = String(e.stderr || e.message); if (ok404 && /HTTP 404|Not Found|409|Git Repository is empty/.test(msg)) return null; throw new Error(`gh ${ghArgs.slice(0, 3).join(" ")}: ${msg.trim().split("\n")[0]}`); }
}
const json = (s) => (s == null || s === "" ? null : JSON.parse(s));

async function main() {
  const readToken = process.env.ONBOARD_GITHUB_TOKEN, dispatchToken = process.env.GITHUB_TOKEN, template = process.env.ONBOARD_ANSWERS_TEMPLATE;
  const source = process.env.ONBOARD_SOURCE || ""; const eventName = process.env.GITHUB_EVENT_NAME || "";
  const self = process.env.GITHUB_REPOSITORY || ""; const org = val("--org", process.env.ONBOARD_ORG || self.split("/")[0]);
  const maxDispatches = Number(val("--max-dispatches", process.env.ONBOARD_MAX_DISPATCHES || 2));
  const only = val("--repo", null); const privateRepos = String(val("--private-repos", process.env.ONBOARD_PRIVATE_REPOS || "auto")).toLowerCase();
  if (!["auto", "onboard", "skip"].includes(privateRepos)) { console.error(`::error::ONBOARD_PRIVATE_REPOS must be auto, onboard or skip (got ${privateRepos})`); process.exit(1); }
  if (!readToken) { console.error("::error::ONBOARD_GITHUB_TOKEN is not set"); process.exit(1); }
  if (!template || !template.trim()) { console.error("::error::ONBOARD_ANSWERS_TEMPLATE is not set (repository variable with the organisation defaults, <name> placeholders)"); process.exit(1); }
  if (!org) { console.error("::error::organisation unknown (--org or GITHUB_REPOSITORY)"); process.exit(1); }
  if (!DRY && !dispatchToken) { console.error("::error::GITHUB_TOKEN is not set (needed to dispatch onboard.yml)"); process.exit(1); }
  renderAnswers(template, "probe"); // fail early on a bad template
  const exclude = new Set([self.toLowerCase(), ...String(process.env.ONBOARD_EXCLUDE || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]);
  // one repository: read it directly (no listing lag right after creation); otherwise the whole organisation
  const repos = only
    ? [json(gh(readToken, ["api", `repos/${only}`]))].filter((r) => { if (String(r.owner && r.owner.login).toLowerCase() !== org.toLowerCase()) throw new Error(`${only} is not in organisation ${org}`); return true; })
    : json(gh(readToken, ["api", `orgs/${org}/repos?per_page=100&type=all`, "--paginate", "--slurp"])).flat().sort((a, b) => a.name.localeCompare(b.name));
  // the organisation plan decides whether private repositories can be gated (GET /orgs/{org}; plan hidden from some tokens)
  let orgInfo = {}; try { orgInfo = json(gh(readToken, ["api", `orgs/${org}`], { ok404: true })) || {}; } catch { orgInfo = {}; }
  const orgCtx = { plan: orgInfo.plan && orgInfo.plan.name ? orgInfo.plan.name : null, privateRepos }; const privateOk = privatePolicy(orgCtx).onboard;
  const reviewers = DRY ? [] : resolveReviewers(readToken);
  const rows = []; let dispatched = 0;
  for (const r of repos) {
    const full = r.full_name; const repo = { name: r.name, full_name: full, private: !!r.private, archived: !!r.archived, fork: !!r.fork, default_branch: r.default_branch, excluded: exclude.has(full.toLowerCase()) };
    let ctx = { repo, head: null, configExists: false, tree: [], issue: null, openOnboardingPr: null, org: orgCtx };
    try {
      if (!repo.excluded && !repo.archived && !repo.fork) {
        const br = json(gh(readToken, ["api", `repos/${full}/branches/${encodeURIComponent(r.default_branch)}`], { ok404: true }));
        ctx.head = br && br.commit ? br.commit.sha : null;
        const issues = json(gh(readToken, ["api", `repos/${full}/issues?state=all&per_page=50&creator=@me`], { ok404: true })) || []; // also on an empty repository (welcome)
        const ours = issues.filter((i) => !i.pull_request && i.title === ISSUE_TITLE).sort((a, b) => (a.state === "open" ? -1 : 1) - (b.state === "open" ? -1 : 1) || b.number - a.number)[0];
        if (ours) { ours.comments = json(gh(readToken, ["api", `repos/${full}/issues/${ours.number}/comments?per_page=100`], { ok404: true })) || []; ctx.issue = ours; }
        if (ctx.head) {
          ctx.configExists = !!gh(readToken, ["api", `repos/${full}/contents/.slipway/config.yaml?ref=${encodeURIComponent(r.default_branch)}`], { ok404: true });
          if (!ctx.configExists && (!repo.private || privateOk)) {
            const tree = json(gh(readToken, ["api", `repos/${full}/git/trees/${ctx.head}?recursive=1`], { ok404: true }));
            ctx.tree = tree && tree.tree ? tree.tree.filter((t) => t.type === "blob").map((t) => t.path) : [];
            const prs = json(gh(readToken, ["api", `repos/${full}/pulls?state=open&per_page=50`], { ok404: true })) || [];
            const pr = prs.find((p) => /^(cursor|slipway)\//.test(p.head.ref)); if (pr) ctx.openOnboardingPr = { url: p_url(pr) };
          }
        }
      }
      const d = classify(ctx); let detail = d.reason;
      if ((d.action === "dispatch" || d.action === "redispatch") && dispatched >= maxDispatches) { d.action = "deferred"; detail = `dispatch deferred: ${maxDispatches} per tick already used`; }
      if (!DRY) {
        detail = act(full, repo, ctx, d, { readToken, dispatchToken, self, template, reviewers }) || detail;
        if (["welcome", "dispatch", "redispatch", "issue-not-deployable"].includes(d.action)) { const note = await notifyAutomation(automationPayload({ action: d.action, repo, ctx, detail, source })); if (note) detail += ` (${note})`; }
      } else if (d.action === "dispatch" || d.action === "redispatch") detail += " (would also ensure the deployment environment and the pull-request ruleset)";
      if (d.action === "dispatch" || d.action === "redispatch") dispatched++;
      rows.push({ repo: full, action: d.action, detail });
    } catch (e) { rows.push({ repo: full, action: "error", detail: String(e.message).slice(0, 200) }); }
  }
  const table = ["| repository | action | detail |", "|---|---|---|", ...rows.map((x) => `| ${x.repo} | ${x.action} | ${x.detail.replace(/\|/g, "\\|")} |`)].join("\n");
  console.log(`onboard poller${DRY ? " (dry run)" : ""}: ${repos.length} repositories, ${dispatched} dispatched\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## onboard poller${DRY ? " (dry run)" : ""} — ${new Date().toISOString()}${eventName ? ` — ${eventName}` : ""}${only ? ` — repository=${only}` : ""}${source ? ` — source=${source}` : ""} — plan=${orgCtx.plan || "unknown"} — private repositories: ${privateOk ? "onboarded" : "reported"}\n\n${table}\n`);
  if (rows.some((x) => x.action === "error")) process.exitCode = 2;
}
const p_url = (pr) => pr.html_url;
function ensureLabels(full, token) { for (const l of Object.values(LABELS)) { try { gh(token, ["api", "-X", "POST", `repos/${full}/labels`, "-f", `name=${l.name}`, "-f", `color=${l.color}`, "-f", `description=${l.description}`]); } catch { /* exists */ } } }
function createIssue(full, token, body, label) { const i = json(gh(token, ["api", "-X", "POST", `repos/${full}/issues`, "-f", `title=${ISSUE_TITLE}`, "-f", `body=${body}`, "-f", `labels[]=${label}`])); return i; }
function comment(full, token, n, body) { gh(token, ["api", "-X", "POST", `repos/${full}/issues/${n}/comments`, "-f", `body=${body}`]); }
function setLabels(full, token, n, labels) { gh(token, ["api", "-X", "PUT", `repos/${full}/issues/${n}/labels`, "--input", "-"], { input: JSON.stringify({ labels }) }); }
function closeIssue(full, token, n) { gh(token, ["api", "-X", "PATCH", `repos/${full}/issues/${n}`, "-f", "state=closed", "-f", "state_reason=completed"]); }
function dispatch(repoFull, branch, answers, { dispatchToken, self }) {
  const before = new Date().toISOString();
  gh(dispatchToken, ["workflow", "run", "onboard.yml", "-R", self, "-f", `repository=${repoFull}`, "-f", `ref=${branch}`, "-f", `answers=${answers}`]);
  let url = `https://github.com/${self}/actions/workflows/onboard.yml`;
  for (let i = 0; i < 6; i++) { // the run id is not returned; look it up
    try { const runs = json(gh(dispatchToken, ["run", "list", "-R", self, "--workflow", "onboard.yml", "--limit", "5", "--json", "url,createdAt,event"])) || []; const r = runs.find((x) => x.event === "workflow_dispatch" && x.createdAt >= before); if (r) { url = r.url; break; } } catch { /* retry */ }
    execFileSync("sleep", ["5"]);
  }
  return url;
}
function resolveReviewers(token) { // ONBOARD_REVIEWERS (comma-separated logins) or the token's owner
  const logins = String(process.env.ONBOARD_REVIEWERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  if (!logins.length) { const me = json(gh(token, ["api", "user"])); if (me && me.id) out.push({ login: me.login, id: me.id }); return out; }
  for (const l of logins) { const u = json(gh(token, ["api", `users/${l}`], { ok404: true })); if (u && u.id) out.push({ login: u.login, id: u.id }); }
  return out;
}
function ensureGates(full, repo, envName, token, reviewers) {
  const lines = [];
  try {
    const envJson = json(gh(token, ["api", `repos/${full}/environments/${encodeURIComponent(envName)}`], { ok404: true }));
    const rulesJson = json(gh(token, ["api", `repos/${full}/rules/branches/${encodeURIComponent(repo.default_branch)}`], { ok404: true })) || [];
    const plan = gatesPlan({ envJson, rulesJson });
    if (plan.createEnv) {
      if (!reviewers.length) lines.push(`environment \`${envName}\`: NOT created (no reviewer resolved: set the ONBOARD_REVIEWERS variable)`);
      else {
        gh(token, ["api", "-X", "PUT", `repos/${full}/environments/${encodeURIComponent(envName)}`, "--input", "-"], { input: JSON.stringify(environmentBody(reviewers.map((r) => r.id))) });
        try { gh(token, ["api", "-X", "POST", `repos/${full}/environments/${encodeURIComponent(envName)}/deployment-branch-policies`, "-f", `name=${repo.default_branch}`, "-f", "type=branch"]); } catch { /* exists */ }
        lines.push(`environment \`${envName}\` created with required reviewer${reviewers.length > 1 ? "s" : ""} ${reviewers.map((r) => "@" + r.login).join(", ")}; deployments from \`${repo.default_branch}\` only`);
      }
    } else lines.push(`environment \`${envName}\` already protected`);
    if (plan.createRuleset) { gh(token, ["api", "-X", "POST", `repos/${full}/rulesets`, "--input", "-"], { input: JSON.stringify(prOnlyRuleset(repo.default_branch)) }); lines.push(`ruleset \`${repo.default_branch}: pull requests (slipway)\` created (pull requests only; required checks are added by /slipway:launch when pr_checks is always-run-gate)`); }
    else lines.push(`ruleset with pull requests already applies to \`${repo.default_branch}\``);
  } catch (e) { lines.push(`GitHub gates: could not create (${String(e.message).slice(0, 140)}); the token needs Administration: read and write on the organisation's repositories; /slipway:launch creates them later`); }
  return lines;
}
// Optional Cursor Automation (webhook trigger): a visible assistant that comments on the onboarding issue. The poller only
// notifies it; onboarding itself runs through onboard.yml. Unset CURSOR_AUTOMATION_WEBHOOK_URL -> nothing happens.
function automationPayload({ action, repo, ctx, detail, source }) {
  return { event: "slipway.onboarding", action, repository: repo.full_name, default_branch: repo.default_branch, head: ctx.head || null,
    issue_url: ctx.issue && ctx.issue.html_url ? ctx.issue.html_url : null, issue_number: ctx.issue && ctx.issue.number ? ctx.issue.number : null,
    detected: ctx.tree && ctx.tree.length ? isDeployable(ctx.tree).found : [], detail: detail || null, source: source || null, at: new Date().toISOString() };
}
function automationRequest({ url, key, transport, payload }) { // transport: bearer (default) | header:<Name> | query:<param>
  const t = String(transport || "bearer"); const headers = { "Content-Type": "application/json", "User-Agent": "slipway-onboard-poller" }; let href = url;
  if (t === "bearer") headers.Authorization = `Bearer ${key}`;
  else if (t.startsWith("header:")) headers[t.slice(7)] = key;
  else if (t.startsWith("query:")) { const u = new URL(url); u.searchParams.set(t.slice(6), key); href = u.toString(); }
  else throw new Error(`unknown CURSOR_AUTOMATION_KEY_TRANSPORT '${t}' (bearer | header:<Name> | query:<param>)`);
  return { href, init: { method: "POST", headers, body: JSON.stringify(payload) } };
}
async function notifyAutomation(payload) {
  const url = process.env.CURSOR_AUTOMATION_WEBHOOK_URL; if (!url) return null;
  try {
    const { href, init } = automationRequest({ url, key: process.env.CURSOR_AUTOMATION_WEBHOOK_KEY || "", transport: process.env.CURSOR_AUTOMATION_KEY_TRANSPORT, payload });
    const res = await fetch(href, { ...init, signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.warn(`::warning::cursor automation webhook answered HTTP ${res.status}`); return `automation notify failed: HTTP ${res.status}`; }
    return "automation notified";
  } catch (e) { console.warn(`::warning::cursor automation webhook: ${String(e.message).slice(0, 160)}`); return "automation notify failed"; }
}
function act(full, repo, ctx, d, env) {
  const { readToken } = env; const n = ctx.issue && ctx.issue.number; const openN = ctx.issue && ctx.issue.state === "open" ? n : null; const head7 = ctx.head ? ctx.head.slice(0, 7) : "";
  switch (d.action) {
    case "welcome": { ensureLabels(full, readToken); const i = createIssue(full, readToken, welcomeBody(repo, renderAnswers(env.template, repo.name)), LABELS.welcome.name); ctx.issue = i; return `opened welcome issue #${i.number}`; }
    case "close-issue": comment(full, readToken, n, `Closed by the slipway poller: ${d.reason}.`); closeIssue(full, readToken, n); return `closed issue #${n}: ${d.reason}`;
    case "issue-private": { ensureLabels(full, readToken); const i = createIssue(full, readToken, `## slipway onboarding\n\nThis repository is **private** and slipway does not onboard it as it is: ${d.why}. Without a required reviewer on its deployment environment, a deployment workflow would apply without a human approval.\n\nOptions: make the repository public; move the organisation to a paid GitHub plan (the poller re-evaluates on its own); or, when the plan already supports environment protection on private repositories, set the repository variable \`ONBOARD_PRIVATE_REPOS=onboard\` on the poller's repository.\n\n<!-- slipway:not-onboarded reason=private -->`, LABELS.notOnboarded.name); return `opened issue #${i.number} (private repository)`; }
    case "issue-not-deployable": {
      ensureLabels(full, readToken);
      if (openN && d.relabel) { setLabels(full, readToken, openN, [LABELS.notDeployable.name]); gh(readToken, ["api", "-X", "PATCH", `repos/${full}/issues/${openN}`, "-f", `body=${notDeployableBody(repo, ctx.head, d.detector)}`]); comment(full, readToken, openN, `First push seen at \`${head7}\`: no manifest yet (looked for ${d.detector.lookedFor.join(", ")}). Push one and the next tick onboards this repository.\n\n<!-- slipway:not-deployable head=${ctx.head} -->`); return `welcome issue #${openN} → not deployable at ${head7}`; }
      const i = createIssue(full, readToken, notDeployableBody(repo, ctx.head, d.detector), LABELS.notDeployable.name); ctx.issue = i; return `opened issue #${i.number} (not deployable)`;
    }
    case "update-not-deployable": comment(full, readToken, n, `Re-checked at \`${head7}\`: still no manifest (looked for ${d.detector.lookedFor.join(", ")}).\n\n<!-- slipway:not-deployable head=${ctx.head} -->`); gh(readToken, ["api", "-X", "PATCH", `repos/${full}/issues/${n}`, "-f", `body=${notDeployableBody(repo, ctx.head, d.detector)}`]); return `updated issue #${n}: head ${head7}, still not deployable`;
    case "needs-human": setLabels(full, readToken, n, [LABELS.onboarding.name, LABELS.needsHuman.name]); comment(full, readToken, n, "Two dispatches produced no pull request. The poller stops here until you add the missing or corrected values: comment on this issue with a fenced block tagged `answers` (one `key: value` per line, for example `apps[0].health_path: /health`); the next tick dispatches again with the template plus your block and removes this label. Close this issue to stop onboarding this repository for good."); return `labelled needs-human on #${n}`;
    case "dispatch": case "redispatch": {
      const base = renderAnswers(env.template, repo.name); const answers = d.overrides ? mergeAnswers(base, d.overrides.text) : base; ensureLabels(full, readToken);
      let num = openN;
      if (!num) { const i = createIssue(full, readToken, onboardingBody(repo, ctx.head, d.detector, answers), LABELS.onboarding.name); num = i.number; ctx.issue = i; }
      else if (d.relabel || d.clearNeedsHuman) { setLabels(full, readToken, num, [LABELS.onboarding.name]); if (d.relabel) gh(readToken, ["api", "-X", "PATCH", `repos/${full}/issues/${num}`, "-f", `body=${onboardingBody(repo, ctx.head, d.detector, answers)}`]); }
      const gates = ensureGates(full, repo, environmentName(answers), readToken, env.reviewers || []);
      const url = dispatch(full, repo.default_branch, answers, env);
      const withWhat = d.overrides ? `the organisation template plus the \`\`\`answers block(s) on this issue` : "the organisation template";
      comment(full, readToken, num, `Dispatched onboarding run: ${url}\n\nGitHub gates (so the first deployment waits for a human and the default branch takes pull requests only):\n${gates.map((l) => `- ${l}`).join("\n")}\n\nAnswers given to the agent (${withWhat}):\n\n\`\`\`\n${answers}\n\`\`\`\n\nA Cursor Cloud Agent installs slipway, runs \`/slipway:launch --yes --until bootstrap\` with these answers, commits, pushes its branch and opens the pull request \`slipway: onboard ${repo.name}\` (the workflow opens it from the pushed branch if the agent cannot) and the workflow comments the human steps on it. To change an answer, add a comment with a fenced block tagged \`answers\` (one \`key: value\` per line); the next tick retries with it once the current run has ended.\n\n<!-- slipway:dispatched at=${new Date().toISOString()} run=${url} -->`);
      return `${d.action} → issue #${num}, run ${url}${d.overrides ? " (with answers from the issue)" : ""}`;
    }
    default: return null;
  }
}
function onboardingBody(repo, head, det, answers) {
  return `## slipway onboarding\n\nDetected on \`${repo.default_branch}\` at \`${(head || "").slice(0, 7)}\`: ${det.found.join(", ")}.\n\nAnswers given to the agent (rendered from the organisation template; no secrets, no ids):\n\n\`\`\`\n${answers}\n\`\`\`\n\nWhat happens next: the dispatch run linked in the comments starts a Cursor Cloud Agent; it writes the files, commits, pushes its branch and opens the pull request \`slipway: onboard ${repo.name}\`, which gets the human steps as a comment (merge, \`bash .slipway/setup-azure.sh --apply --set-github-secrets\` in your terminal, then \`/slipway:launch\` on a desktop). To override or add a value for this repository, comment with a fenced block tagged \`answers\` (one \`key: value\` per line); it is merged over the template on the next dispatch. This issue closes by itself when \`.slipway/config.yaml\` is on \`${repo.default_branch}\`.\n\n<!-- slipway:state=dispatched head=${head} -->`;
}
function welcomeBody(repo, answers) {
  return `## slipway onboarding\n\nWelcome. This repository is empty, so nothing is onboarded yet. As soon as the first push lands on \`${repo.default_branch}\` with a deployable application, slipway will: create the \`${repo.default_branch}\` pull-request ruleset and the deployment environment with a required reviewer, start one Cursor cloud agent that writes the delivery setup (config, Dockerfile, CI/CD pipelines, Terraform for the app) and opens a pull request, then, after a human merges it, build, release and deploy the app on the shared platform behind the environment approval.\n\n**What to push:** a project manifest (${MANIFESTS.map((m) => `\`${m.label}\``).join(", ")}), a \`GET /health\` route that returns \`{status, version}\` from the \`VERSION\` environment variable (added for you on known frameworks), a server that listens on \`PORT\`. A Dockerfile is optional: the agent drafts a hardened one.\n\nAnswers the agent will receive (from the organisation template; no secrets, no ids):\n\n\`\`\`\n${answers}\n\`\`\`\n\nTo override or add a value before you push, comment with a fenced block tagged \`answers\` (one \`key: value\` per line). This issue becomes the onboarding issue on the first push; closing it does not opt the repository out (closing the onboarding issue later does).\n\n<!-- slipway:welcome at=${new Date().toISOString()} -->`;
}
function notDeployableBody(repo, head, det) {
  return `## slipway onboarding\n\nNo deployable application found on \`${repo.default_branch}\` at \`${(head || "").slice(0, 7)}\`. The poller looked for: ${det.lookedFor.join(", ")} (outside node_modules, vendor, dist, build, bin, obj).\n\nPush code with one of those manifests and the next tick (every 15 minutes) re-checks this repository. If the detector is wrong, comment with a fenced block tagged \`answers\` (for example \`apps[0].path: .\` and the app's kind, stack, port and health path): the next tick onboards with it. If this repository is not meant to be deployed, close this issue.\n\n<!-- slipway:not-deployable head=${head} -->`;
}
module.exports = { classify, privatePolicy, isDeployable, renderAnswers, hyphenSlug, alnumSlug, marker, answersBlocks, latestAnswers, mergeAnswers, environmentBody, prOnlyRuleset, gatesPlan, environmentName, automationPayload, automationRequest, welcomeBody, LABELS, ISSUE_TITLE, MANIFESTS };
if (require.main === module) main().catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
