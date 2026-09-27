// Tests for scripts/onboard-prompt.sh and the onboard workflow (docs/CURSOR-ONBOARDING.md).
const { test } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const ROOT = path.join(__dirname, ".."); const SH = path.join(ROOT, "scripts", "onboard-prompt.sh");
const yaml = require(path.join(ROOT, "plugins", "slipway", "scripts", "lib", "js-yaml.min.js"));
const run = (args) => spawnSync("bash", [SH, ...args], { encoding: "utf8" });
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "slipway", ".claude-plugin", "plugin.json"), "utf8")).version;

test("prompt: pinned version, repository, headless launch, answers inserted verbatim, no push", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-")); const ans = path.join(dir, "answers.txt");
  fs.writeFileSync(ans, "azure.location: westeurope\njira.project_key: DEVOPS\n");
  const r = run(["integranz/foo", "--ref", "develop", "--version", "1.6.0", "--answers", ans]);
  assert.equal(r.status, 0, r.stderr);
  const p = r.stdout;
  assert.match(p, /repository integranz\/foo \(branch develop\)/);
  assert.match(p, /--branch v1\.6\.0 https:\/\/github\.com\/integranz\/slipway/);
  assert.match(p, /\/slipway:launch --yes --until bootstrap --no-ticket/);
  assert.match(p, /^  azure\.location: westeurope$/m); assert.match(p, /^  jira\.project_key: DEVOPS$/m);
  assert.match(p, /Do NOT push and do NOT open a pull request/); assert.match(p, /"slipway: onboard foo"/);
  assert.match(p, /SLIPWAY_SESSION_ATTENDED=0/); assert.doesNotMatch(p, /\$\{answers\}|\$\{repo\}/, "unexpanded placeholder");
});

test("prompt: defaults (main, checkout version, no answers) and argument validation", () => {
  const r = run(["integranz/bar"]); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(branch main\)/); assert.ok(r.stdout.includes(`--branch v${version} `), "must default to the checkout version");
  assert.match(r.stdout, /none given: rely on detections/);
  assert.equal(run([]).status, 2); assert.equal(run(["not-a-repo"]).status, 2); assert.equal(run(["o/r", "--ref", "bad ref"]).status, 2);
  assert.equal(run(["o/r", "--version", "latest"]).status, 2); assert.equal(run(["o/r", "--bogus"]).status, 2);
  const empty = path.join(os.tmpdir(), `onboard-empty-${process.pid}`); fs.writeFileSync(empty, ""); assert.equal(run(["o/r", "--answers", empty]).status, 2);
});

test("onboard.yml: dispatch inputs, no input interpolation inside run blocks, API call shape", () => {
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, ".github", "workflows", "onboard.yml"), "utf8"));
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs).sort(), ["answers", "dry_run", "model", "plugin_version", "ref", "repository"]);
  assert.equal(wf.permissions.contents, "read");
  const steps = wf.jobs.dispatch.steps; const runs = steps.filter((s) => s.run).map((s) => s.run).join("\n");
  assert.equal((runs.match(/\$\{\{\s*inputs\./g) || []).length, 0, "inputs must reach the shell through env, never by interpolation");
  assert.match(runs, /scripts\/onboard-prompt\.sh/); assert.match(runs, /https:\/\/api\.cursor\.com\/v1\/agents/);
  assert.match(runs, /autoCreatePR: true/); assert.match(runs, /startingRef: \$ref/);
  assert.ok((runs.match(/https:\/\/api\.cursor\.com\/v1\/models/g) || []).length >= 2, "dry run and the invalid_model path must list the usable models");
  const start = steps.find((s) => s.name === "Start the cloud agent"); assert.ok(start.env.CURSOR_API_KEY.includes("secrets.CURSOR_API_KEY"));
  assert.match(start.if, /!inputs\.dry_run/);
});
