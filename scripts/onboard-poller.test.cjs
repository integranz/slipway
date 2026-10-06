// Tests for scripts/onboard-poller.cjs: the classifier, the detector, the answers renderer and the workflow shape.
const { test } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const P = require("./onboard-poller.cjs");
const yaml = require(path.join(__dirname, "..", "plugins", "slipway", "scripts", "lib", "js-yaml.min.js"));

const repo = (o = {}) => ({ name: "widgets", full_name: "integranz/widgets", private: false, archived: false, fork: false, default_branch: "main", excluded: false, ...o });
const base = (o = {}) => ({ repo: repo(), head: "abcdef1234567890", configExists: false, tree: ["src/index.js", "package.json", "README.md"], issue: null, openOnboardingPr: null, now: new Date("2026-10-06T12:00:00Z"), ...o });
const issue = (labels, o = {}) => ({ number: 7, state: "open", labels: labels.map((n) => ({ name: n })), body: "", comments: [], ...o });
const dispatchedAt = (iso) => ({ body: `Dispatched\n\n<!-- slipway:dispatched at=${iso} run=https://x/1 -->` });

test("detector: manifests outside build and dependency folders", () => {
  assert.deepEqual(P.isDeployable(["docs/a.md", "README.md"]).deployable, false);
  assert.deepEqual(P.isDeployable(["node_modules/x/package.json", "dist/Dockerfile"]).deployable, false, "ignored folders do not count");
  const d = P.isDeployable(["apps/api/Api.csproj", "web/package.json", "Dockerfile.web", "svc/go.mod"]);
  assert.equal(d.deployable, true); assert.deepEqual(d.found, ["*.csproj", "Dockerfile", "go.mod", "package.json"]);
  assert.ok(d.lookedFor.includes("pyproject.toml"));
});

test("answers: <name> renders as a hyphen slug, or alphanumeric for registry and storage account; bad templates fail", () => {
  const t = "azure.location: westeurope\n# comment\nazure.resource_group: rg-<name>-dev\nazure.acr_name: acr<name>dev\nazure.state.storage_account: st<name>tf\njira.project_key: DEVOPS\n";
  assert.equal(P.renderAnswers(t, "My_Cool.App"), "azure.location: westeurope\nazure.resource_group: rg-my-cool-app-dev\nazure.acr_name: acrmycoolappdev\nazure.state.storage_account: stmycoolapptf\njira.project_key: DEVOPS");
  assert.throws(() => P.renderAnswers("just text", "x"), /not a 'key: value' line/);
  assert.throws(() => P.renderAnswers("a: <owner>", "x"), /unknown placeholder/);
  assert.equal(P.hyphenSlug("--Weird__Name--"), "weird-name"); assert.equal(P.alnumSlug("Weird-Name"), "weirdname");
});

test("classifier: skips, onboarded, private", () => {
  assert.equal(P.classify(base({ repo: repo({ excluded: true }) })).action, "skip");
  assert.equal(P.classify(base({ repo: repo({ archived: true }) })).action, "skip");
  assert.equal(P.classify(base({ repo: repo({ fork: true }) })).action, "skip");
  assert.equal(P.classify(base({ head: null })).action, "skip");
  assert.equal(P.classify(base({ configExists: true })).action, "skip");
  assert.equal(P.classify(base({ configExists: true, issue: issue([P.LABELS.onboarding.name]) })).action, "close-issue");
  assert.equal(P.classify(base({ repo: repo({ private: true }) })).action, "issue-private");
  assert.equal(P.classify(base({ repo: repo({ private: true }), issue: issue([P.LABELS.notOnboarded.name]) })).action, "skip", "private reported once");
  assert.equal(P.classify(base({ issue: issue([P.LABELS.notOnboarded.name]) })).action, "close-issue", "public again: close the not-onboarded issue");
});

test("classifier: new repositories dispatch or get a not-deployable issue; not-deployable is re-checked on a new head", () => {
  const d = P.classify(base()); assert.equal(d.action, "dispatch"); assert.match(d.reason, /package\.json/);
  const nd = P.classify(base({ tree: ["README.md"] })); assert.equal(nd.action, "issue-not-deployable"); assert.match(nd.reason, /looked for/);
  const same = P.classify(base({ tree: ["README.md"], issue: issue([P.LABELS.notDeployable.name], { body: "<!-- slipway:not-deployable head=abcdef1234567890 -->" }) })); assert.equal(same.action, "skip");
  const moved = P.classify(base({ tree: ["README.md"], issue: issue([P.LABELS.notDeployable.name], { body: "<!-- slipway:not-deployable head=0000000 -->" }) })); assert.equal(moved.action, "update-not-deployable");
  const now = P.classify(base({ issue: issue([P.LABELS.notDeployable.name], { body: "<!-- slipway:not-deployable head=0000000 -->" }) })); assert.equal(now.action, "dispatch"); assert.equal(now.relabel, true);
});

test("classifier: in-progress onboarding waits, re-dispatches once after two hours, then needs a human", () => {
  const open = (comments, extra = []) => issue([P.LABELS.onboarding.name, ...extra], { comments });
  assert.equal(P.classify(base({ issue: open([]) })).action, "wait");
  assert.equal(P.classify(base({ issue: open([dispatchedAt("2026-10-06T11:30:00Z")]) })).action, "wait");
  assert.equal(P.classify(base({ issue: open([dispatchedAt("2026-10-06T11:30:00Z")]), openOnboardingPr: { url: "https://x/pull/1" } })).action, "skip");
  assert.equal(P.classify(base({ issue: open([dispatchedAt("2026-10-06T09:00:00Z")]) })).action, "redispatch");
  assert.equal(P.classify(base({ issue: open([dispatchedAt("2026-10-06T07:00:00Z"), dispatchedAt("2026-10-06T09:00:00Z")]) })).action, "needs-human");
  assert.equal(P.classify(base({ issue: open([dispatchedAt("2026-10-06T07:00:00Z")], [P.LABELS.needsHuman.name]) })).action, "skip");
  assert.equal(P.classify(base({ issue: issue([P.LABELS.onboarding.name], { state: "closed" }) })).action, "skip", "a human closed it: never re-dispatch");
});

test("onboard-poller.yml: schedule off the hour, dispatch permission, concurrency, no input interpolation in run blocks", () => {
  const wf = yaml.load(fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "onboard-poller.yml"), "utf8"));
  assert.equal(wf.on.schedule[0].cron, "7,22,37,52 * * * *"); assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs).sort(), ["dry_run", "repository"]);
  assert.equal(wf.permissions.actions, "write"); assert.equal(wf.permissions.contents, "read"); assert.equal(wf.concurrency.group, "onboard-poller");
  const runs = wf.jobs.tick.steps.filter((s) => s.run).map((s) => s.run).join("\n");
  assert.equal((runs.match(/\$\{\{\s*inputs\./g) || []).length, 0); assert.match(runs, /onboard-poller\.cjs/);
  const step = wf.jobs.tick.steps.find((s) => s.name === "Poll the organisation");
  assert.ok(step.env.ONBOARD_GITHUB_TOKEN.includes("secrets.ONBOARD_GITHUB_TOKEN")); assert.ok(step.env.ONBOARD_ANSWERS_TEMPLATE.includes("vars.ONBOARD_ANSWERS_TEMPLATE")); assert.ok(step.env.GITHUB_TOKEN.includes("github.token"));
});
