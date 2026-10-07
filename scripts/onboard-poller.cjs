#!/usr/bin/env node
// Scheduled onboarding poller (docs/CURSOR-ONBOARDING.md, "Automatic onboarding"). Deterministic, no LLM: every tick lists
// the organisation's repositories, classifies each one from facts (archived/fork/empty, private, .slipway/config.yaml
// present, manifests in the tree, our tracking issue, open onboarding PRs) and acts: opens or updates ONE issue per
// repository and dispatches .github/workflows/onboard.yml for the repositories that need onboarding. The only agent run
// is the one onboard.yml starts. Every write to a target repository is an issue, a comment or a label; never a commit,
// a secret or a setting.
// usage: node onboard-poller.cjs [--dry-run] [--org <login>] [--max-dispatches <n>] [--repo <owner/name>]
// env: ONBOARD_GITHUB_TOKEN (org reads, issues; fine-grained: Contents read, Issues write, Metadata read on the org's
//      repos), GITHUB_TOKEN (dispatches onboard.yml in GITHUB_REPOSITORY; needs actions: write), ONBOARD_ANSWERS_TEMPLATE
//      (org defaults with <name> placeholders), ONBOARD_EXCLUDE (comma list of owner/name; the poller's own repository is
//      always excluded), GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY (optional).
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const LABELS = {
  onboarding: { name: "slipway-onboarding", color: "0E8A16", description: "slipway onboarding dispatched; a pull request follows" },
  notDeployable: { name: "slipway-not-deployable", color: "FBCA04", description: "slipway found no deployable application yet; re-checked on the next push" },
  notOnboarded: { name: "slipway-not-onboarded", color: "B60205", description: "slipway cannot onboard this repository as it is (see the issue)" },
  needsHuman: { name: "needs-human", color: "D93F0B", description: "the automation stopped; a person must look" },
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
function marker(text, key) { const m = String(text || "").match(new RegExp(`<!-- slipway:${key}((?: [a-z_]+=[^ >]+)*) -->`)); if (!m) return null; const o = {}; for (const kv of m[1].trim().split(/\s+/).filter(Boolean)) { const [k, v] = kv.split("="); o[k] = v; } return o; }
function dispatchMarkers(issue) { return (issue.comments || []).map((c) => marker(c.body, "dispatched")).filter(Boolean); }
function hasLabel(issue, name) { return (issue.labels || []).some((l) => (typeof l === "string" ? l : l.name) === name); }
// Decide what to do for one repository. Inputs are facts; the output is one action with reasons.
function classify(ctx) {
  const { repo, head, configExists, tree, issue, openOnboardingPr, now = new Date() } = ctx;
  if (repo.excluded) return { action: "skip", reason: "excluded" };
  if (repo.archived) return { action: "skip", reason: "archived" };
  if (repo.fork) return { action: "skip", reason: "fork" };
  if (!head) return { action: "skip", reason: "empty repository (no commit on the default branch)" };
  if (configExists) return issue && issue.state === "open" ? { action: "close-issue", reason: ".slipway/config.yaml is on the default branch" } : { action: "skip", reason: "onboarded" };
  if (repo.private) return issue && hasLabel(issue, LABELS.notOnboarded.name) ? { action: "skip", reason: "private; already reported" } : { action: "issue-private", reason: "private repository: no environment protection on GitHub Free" };
  if (issue && issue.state === "open" && hasLabel(issue, LABELS.notOnboarded.name)) return { action: "close-issue", reason: "repository is public now; re-evaluating on the next tick" };
  const det = isDeployable(tree);
  if (issue && issue.state === "open" && hasLabel(issue, LABELS.onboarding.name)) {
    if (openOnboardingPr) return { action: "skip", reason: `onboarding pull request open: ${openOnboardingPr.url}` };
    if (hasLabel(issue, LABELS.needsHuman.name)) return { action: "skip", reason: "needs-human" };
    const ds = dispatchMarkers(issue); const last = ds.length ? Date.parse(ds[ds.length - 1].at || 0) : NaN;
    if (!ds.length || (now - last) < REDISPATCH_AFTER_MS) return { action: "wait", reason: ds.length ? `dispatched ${Math.round((now - last) / 60000)} min ago, no pull request yet` : "dispatch pending" };
    if (ds.length >= 2) return { action: "needs-human", reason: "two dispatches without a pull request" };
    return { action: "redispatch", reason: "no pull request two hours after the dispatch", detector: det };
  }
  if (issue && issue.state === "open" && hasLabel(issue, LABELS.notDeployable.name)) {
    const m = marker(issue.body, "not-deployable") || {};
    if (m.head === head) return { action: "skip", reason: "not deployable; head unchanged" };
    return det.deployable ? { action: "dispatch", reason: `deployable since ${head.slice(0, 7)}: ${det.found.join(", ")}`, detector: det, relabel: true } : { action: "update-not-deployable", reason: "head changed, still not deployable", detector: det };
  }
  if (issue && issue.state === "closed" && hasLabel(issue, LABELS.onboarding.name) && !openOnboardingPr) return { action: "skip", reason: "onboarding issue closed by a human; not re-dispatching" };
  return det.deployable ? { action: "dispatch", reason: `deployable: ${det.found.join(", ")}`, detector: det } : { action: "issue-not-deployable", reason: `no manifest found (looked for ${det.lookedFor.join(", ")})`, detector: det };
}

// ---- GitHub plumbing (gh CLI) -----------------------------------------------------------------------------------------
const args = process.argv.slice(2); const flag = (n) => args.includes(n); const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DRY = flag("--dry-run");
function gh(token, ghArgs, { input, ok404 } = {}) {
  try { return execFileSync("gh", ghArgs, { encoding: "utf8", env: { ...process.env, GH_TOKEN: token }, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { const msg = String(e.stderr || e.message); if (ok404 && /HTTP 404|Not Found|409|Git Repository is empty/.test(msg)) return null; throw new Error(`gh ${ghArgs.slice(0, 3).join(" ")}: ${msg.trim().split("\n")[0]}`); }
}
const json = (s) => (s == null || s === "" ? null : JSON.parse(s));

function main() {
  const readToken = process.env.ONBOARD_GITHUB_TOKEN, dispatchToken = process.env.GITHUB_TOKEN, template = process.env.ONBOARD_ANSWERS_TEMPLATE;
  const self = process.env.GITHUB_REPOSITORY || ""; const org = val("--org", process.env.ONBOARD_ORG || self.split("/")[0]);
  const maxDispatches = Number(val("--max-dispatches", process.env.ONBOARD_MAX_DISPATCHES || 2));
  const only = val("--repo", null);
  if (!readToken) { console.error("::error::ONBOARD_GITHUB_TOKEN is not set"); process.exit(1); }
  if (!template || !template.trim()) { console.error("::error::ONBOARD_ANSWERS_TEMPLATE is not set (repository variable with the organisation defaults, <name> placeholders)"); process.exit(1); }
  if (!org) { console.error("::error::organisation unknown (--org or GITHUB_REPOSITORY)"); process.exit(1); }
  if (!DRY && !dispatchToken) { console.error("::error::GITHUB_TOKEN is not set (needed to dispatch onboard.yml)"); process.exit(1); }
  renderAnswers(template, "probe"); // fail early on a bad template
  const exclude = new Set([self.toLowerCase(), ...String(process.env.ONBOARD_EXCLUDE || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]);
  const repos = json(gh(readToken, ["api", `orgs/${org}/repos?per_page=100&type=all`, "--paginate", "--slurp"])).flat()
    .filter((r) => !only || r.full_name.toLowerCase() === only.toLowerCase()).sort((a, b) => a.name.localeCompare(b.name));
  const rows = []; let dispatched = 0;
  for (const r of repos) {
    const full = r.full_name; const repo = { name: r.name, full_name: full, private: !!r.private, archived: !!r.archived, fork: !!r.fork, default_branch: r.default_branch, excluded: exclude.has(full.toLowerCase()) };
    let ctx = { repo, head: null, configExists: false, tree: [], issue: null, openOnboardingPr: null };
    try {
      if (!repo.excluded && !repo.archived && !repo.fork) {
        const br = json(gh(readToken, ["api", `repos/${full}/branches/${encodeURIComponent(r.default_branch)}`], { ok404: true }));
        ctx.head = br && br.commit ? br.commit.sha : null;
        if (ctx.head) {
          ctx.configExists = !!gh(readToken, ["api", `repos/${full}/contents/.slipway/config.yaml?ref=${encodeURIComponent(r.default_branch)}`], { ok404: true });
          const issues = json(gh(readToken, ["api", `repos/${full}/issues?state=all&per_page=50&creator=@me`], { ok404: true })) || [];
          const ours = issues.filter((i) => !i.pull_request && i.title === ISSUE_TITLE).sort((a, b) => (a.state === "open" ? -1 : 1) - (b.state === "open" ? -1 : 1) || b.number - a.number)[0];
          if (ours) { ours.comments = json(gh(readToken, ["api", `repos/${full}/issues/${ours.number}/comments?per_page=100`], { ok404: true })) || []; ctx.issue = ours; }
          if (!ctx.configExists && !repo.private) {
            const tree = json(gh(readToken, ["api", `repos/${full}/git/trees/${ctx.head}?recursive=1`], { ok404: true }));
            ctx.tree = tree && tree.tree ? tree.tree.filter((t) => t.type === "blob").map((t) => t.path) : [];
            const prs = json(gh(readToken, ["api", `repos/${full}/pulls?state=open&per_page=50`], { ok404: true })) || [];
            const pr = prs.find((p) => /^(cursor|slipway)\//.test(p.head.ref)); if (pr) ctx.openOnboardingPr = { url: p_url(pr) };
          }
        }
      }
      const d = classify(ctx); let detail = d.reason;
      if ((d.action === "dispatch" || d.action === "redispatch") && dispatched >= maxDispatches) { d.action = "deferred"; detail = `dispatch deferred: ${maxDispatches} per tick already used`; }
      if (!DRY) detail = act(full, repo, ctx, d, { readToken, dispatchToken, self, template }) || detail;
      if (d.action === "dispatch" || d.action === "redispatch") dispatched++;
      rows.push({ repo: full, action: d.action, detail });
    } catch (e) { rows.push({ repo: full, action: "error", detail: String(e.message).slice(0, 200) }); }
  }
  const table = ["| repository | action | detail |", "|---|---|---|", ...rows.map((x) => `| ${x.repo} | ${x.action} | ${x.detail.replace(/\|/g, "\\|")} |`)].join("\n");
  console.log(`onboard poller${DRY ? " (dry run)" : ""}: ${repos.length} repositories, ${dispatched} dispatched\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## onboard poller${DRY ? " (dry run)" : ""} — ${new Date().toISOString()}\n\n${table}\n`);
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
function act(full, repo, ctx, d, env) {
  const { readToken } = env; const n = ctx.issue && ctx.issue.number; const head7 = ctx.head ? ctx.head.slice(0, 7) : "";
  switch (d.action) {
    case "close-issue": comment(full, readToken, n, `Closed by the slipway poller: ${d.reason}.`); closeIssue(full, readToken, n); return `closed issue #${n}: ${d.reason}`;
    case "issue-private": { ensureLabels(full, readToken); const i = createIssue(full, readToken, `## slipway onboarding\n\nThis repository is **private**. On the GitHub Free plan a private repository has no environment protection rules, so a deployment workflow would apply without a human approval. slipway does not onboard it as it is.\n\nOptions: make the repository public, or move the organisation to a paid GitHub plan; the poller re-evaluates when the repository becomes public.\n\n<!-- slipway:not-onboarded reason=private -->`, LABELS.notOnboarded.name); return `opened issue #${i.number} (private repository)`; }
    case "issue-not-deployable": { ensureLabels(full, readToken); const i = createIssue(full, readToken, notDeployableBody(repo, ctx.head, d.detector), LABELS.notDeployable.name); return `opened issue #${i.number} (not deployable)`; }
    case "update-not-deployable": comment(full, readToken, n, `Re-checked at \`${head7}\`: still no manifest (looked for ${d.detector.lookedFor.join(", ")}).\n\n<!-- slipway:not-deployable head=${ctx.head} -->`); gh(readToken, ["api", "-X", "PATCH", `repos/${full}/issues/${n}`, "-f", `body=${notDeployableBody(repo, ctx.head, d.detector)}`]); return `updated issue #${n}: head ${head7}, still not deployable`;
    case "needs-human": setLabels(full, readToken, n, [LABELS.onboarding.name, LABELS.needsHuman.name]); comment(full, readToken, n, "Two dispatches produced no pull request. The poller stops here; read the agent transcripts linked above, fix the cause, then remove the `needs-human` label (and this issue's dispatch comments) to let it retry, or close the issue."); return `labelled needs-human on #${n}`;
    case "dispatch": case "redispatch": {
      const answers = renderAnswers(env.template, repo.name); ensureLabels(full, readToken);
      let num = n;
      if (!num) { const i = createIssue(full, readToken, onboardingBody(repo, ctx.head, d.detector, answers), LABELS.onboarding.name); num = i.number; }
      else if (d.relabel) { setLabels(full, readToken, num, [LABELS.onboarding.name]); gh(readToken, ["api", "-X", "PATCH", `repos/${full}/issues/${num}`, "-f", `body=${onboardingBody(repo, ctx.head, d.detector, answers)}`]); }
      const url = dispatch(full, repo.default_branch, answers, env);
      comment(full, readToken, num, `Dispatched onboarding run: ${url}\n\nA Cursor Cloud Agent installs slipway, runs \`/slipway:launch --yes --until bootstrap\` with the answers above and commits; Cursor opens the pull request \`slipway: onboard ${repo.name}\` and the workflow comments the human steps on it.\n\n<!-- slipway:dispatched at=${new Date().toISOString()} run=${url} -->`);
      return `${d.action} → issue #${num}, run ${url}`;
    }
    default: return null;
  }
}
function onboardingBody(repo, head, det, answers) {
  return `## slipway onboarding\n\nDetected on \`${repo.default_branch}\` at \`${(head || "").slice(0, 7)}\`: ${det.found.join(", ")}.\n\nAnswers given to the agent (rendered from the organisation template; no secrets, no ids):\n\n\`\`\`\n${answers}\n\`\`\`\n\nWhat happens next: the dispatch run linked in the comments starts a Cursor Cloud Agent; a pull request \`slipway: onboard ${repo.name}\` follows with the human steps as a comment (merge, \`bash .slipway/setup-azure.sh --apply --set-github-secrets\` in your terminal, then \`/slipway:launch\` on a desktop). This issue closes by itself when \`.slipway/config.yaml\` is on \`${repo.default_branch}\`.\n\n<!-- slipway:state=dispatched head=${head} -->`;
}
function notDeployableBody(repo, head, det) {
  return `## slipway onboarding\n\nNo deployable application found on \`${repo.default_branch}\` at \`${(head || "").slice(0, 7)}\`. The poller looked for: ${det.lookedFor.join(", ")} (outside node_modules, vendor, dist, build, bin, obj).\n\nPush code with one of those manifests and the next tick (every 15 minutes) re-checks this repository. If this repository is not meant to be deployed, close this issue.\n\n<!-- slipway:not-deployable head=${head} -->`;
}
module.exports = { classify, isDeployable, renderAnswers, hyphenSlug, alnumSlug, marker, LABELS, ISSUE_TITLE, MANIFESTS };
if (require.main === module) main();
