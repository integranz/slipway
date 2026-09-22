const { test } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"); const { spawnSync, execFileSync } = require("node:child_process");
const yaml = require("./lib/js-yaml.min.js");
const S = path.join(__dirname, "ruleset.cjs"); const EXAMPLE = path.join(__dirname, "..", "templates", "common", "slipway", "config.example.yaml");
function repo(mutate) { const r = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-ruleset-")); execFileSync("git", ["init", "-q", "-b", "main", r]); const c = yaml.load(fs.readFileSync(EXAMPLE, "utf8")); if (mutate) mutate(c); fs.mkdirSync(path.join(r, ".slipway")); fs.writeFileSync(path.join(r, ".slipway", "config.yaml"), yaml.dump(c)); return r; }
test("ruleset.cjs prints a branch ruleset requiring the per-app gate and result checks", () => {
  const r = spawnSync(process.execPath, [S, "--repo", repo()], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.target, "branch"); assert.equal(j.enforcement, "active"); assert.deepEqual(j.conditions.ref_name.include, ["~DEFAULT_BRANCH"]); assert.deepEqual(j.bypass_actors, []);
  assert.deepEqual(j.rules.map(x => x.type), ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]);
  assert.deepEqual(j.rules[3].parameters.required_status_checks.map(c => c.context), ["api changes", "api ci", "web changes", "web ci"]);
  assert.equal(r.stderr.trim(), "", "no warning in gate mode");
});
test("ruleset.cjs warns in path-filtered mode and requires only the result checks", () => {
  const r = spawnSync(process.execPath, [S, "--repo", repo(c => { c.options.pr_checks = "path-filtered"; })], { encoding: "utf8" }); assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).rules[3].parameters.required_status_checks.map(c => c.context), ["api ci", "web ci"]); assert.match(r.stderr, /path-filtered/);
});
