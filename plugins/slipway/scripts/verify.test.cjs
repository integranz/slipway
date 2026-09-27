const { test } = require("node:test"); const assert = require("node:assert/strict");
const path = require("node:path"), fs = require("node:fs"), os = require("node:os"); const { spawnSync, execFileSync } = require("node:child_process");
const yaml = require("./lib/js-yaml.min.js");
const V = path.join(__dirname, "verify.cjs"); const EXAMPLE = path.join(__dirname, "..", "templates", "common", "slipway", "config.example.yaml");
function repo(mutate) { const r = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-verify-")); execFileSync("git", ["init", "-q", "-b", "main", r]); fs.mkdirSync(path.join(r, ".slipway")); const cfg = yaml.load(fs.readFileSync(EXAMPLE, "utf8")); if (mutate) mutate(cfg); fs.writeFileSync(path.join(r, ".slipway", "config.yaml"), yaml.dump(cfg)); return r; }
test("verify.cjs refuses bad arguments before touching anything", () => {
  const r = repo();
  let x = spawnSync(process.execPath, [V], { encoding: "utf8", cwd: r }); assert.equal(x.status, 1); assert.match(x.stderr, /usage/);
  x = spawnSync(process.execPath, [V, "api", "dev", "--repo", r], { encoding: "utf8" }); assert.equal(x.status, 1); assert.match(x.stderr, /usage/);
  x = spawnSync(process.execPath, [V, "nope", "dev", "0.1.0", "--repo", r], { encoding: "utf8" }); assert.equal(x.status, 1); assert.match(x.stderr, /app 'nope' is not in/);
  x = spawnSync(process.execPath, [V, "api", "prod", "0.1.0", "--repo", r], { encoding: "utf8" }); assert.equal(x.status, 1); assert.match(x.stderr, /environment 'prod' is not in/);
  x = spawnSync(process.execPath, [V, "api", "dev", "latest", "--repo", r], { encoding: "utf8" }); assert.equal(x.status, 1); assert.match(x.stderr, /not a semver tag/);
  assert.ok(!fs.existsSync(path.join(r, ".slipway", "evidence")), "must not write evidence for invalid input");
});
test("verify.cjs --no-write leaves the repo untouched and reports per claim for one app", () => {
  const r = repo(); const env = { ...process.env, PATH: "/nonexistent" }; // no gh/az/terraform: everything unverifiable/refuted but well-formed
  const x = spawnSync(process.execPath, [V, "web", "dev", "0.1.0", "--repo", r, "--no-write", "--json"], { encoding: "utf8", env, timeout: 120000 });
  assert.ok([2, 3].includes(x.status), `exit ${x.status}: ${x.stderr}`);
  const j = JSON.parse(x.stdout); assert.equal(j.app, "web"); assert.equal(j.env, "dev"); assert.equal(j.tag, "0.1.0"); assert.ok(j.claims.length >= 3);
  for (const c of j.claims) assert.ok(["CONFIRMED", "REFUTED", "UNVERIFIABLE"].includes(c.verdict));
  assert.ok(j.claims.some(c => /trigger paths and version\.json pathFilters/.test(c.claim) && c.verdict === "REFUTED"), "missing workflow/version.json must refute the pipeline-definition claim");
  assert.equal(j.evidence_store.store, "release", "the example config uses the default store"); assert.match(j.evidence, /verify-web-dev-0\.1\.0\.md$/);
  assert.ok(!fs.existsSync(j.evidence), "--no-write writes nothing, not even the temp copy"); assert.ok(!fs.existsSync(path.join(r, ".slipway", "evidence")));
});

// A stub `gh` that records its calls: releases can be viewed (missing at first), created and uploaded; everything else fails,
// so the claims are UNVERIFIABLE/REFUTED but the report is still produced and stored.
function ghStub(dir) {
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1" in --version) echo "gh stub 0.0.0"; exit 0;; esac
case "$1 $2" in
  "release view") grep -q "release create" "$GH_LOG" && exit 0 || exit 1;;
  "release create"|"release upload") exit 0;;
  *) echo "stub: not available" >&2; exit 1;;
esac
`); fs.chmodSync(path.join(bin, "gh"), 0o755); return bin;
}
const storeRun = (r, extra = []) => { const log = path.join(r, "gh.log"); fs.writeFileSync(log, ""); const bin = ghStub(r);
  const x = spawnSync(process.execPath, [V, "api", "dev", "0.1.0", "--repo", r, "--json", ...extra], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GH_LOG: log }, timeout: 180000 }); // system dirs for bash/grep; no real gh/az/terraform there
  return { x, log: fs.readFileSync(log, "utf8"), j: (() => { try { return JSON.parse(x.stdout); } catch { return null; } })() }; };

test("evidence_store=release (default): the report is uploaded to the GitHub Release of the tag, nothing lands in the repo", () => {
  const r = repo(); const { x, log, j } = storeRun(r);
  assert.ok(j, `json output expected, got: ${x.stdout.slice(0, 200)} ${x.stderr.slice(0, 200)}`);
  assert.equal(j.evidence_store.store, "release"); assert.equal(j.evidence_store.release_tag, "api/v0.1.0"); assert.equal(j.evidence_store.uploaded, true);
  assert.match(j.evidence_store.release_url, /releases\/tag\/api%2Fv0\.1\.0$/);
  assert.ok(!fs.existsSync(path.join(r, ".slipway", "evidence")), "no committed evidence file");
  assert.match(log, /release create api\/v0\.1\.0 -R integranz\/slipway-demo --verify-tag/, "creates the release when it is missing (tags released before 1.5.0)");
  assert.match(log, /release upload api\/v0\.1\.0 \S+\/verify-api-dev-0\.1\.0\.md -R integranz\/slipway-demo --clobber/);
  assert.ok(fs.existsSync(j.evidence), "local copy kept in the temp directory");
});

test("evidence_store=repo writes the committed file; none stores nothing; --store overrides the config", () => {
  const r = repo(c => { c.options.evidence_store = "repo"; }); const a = storeRun(r);
  assert.equal(a.j.evidence_store.store, "repo"); assert.ok(fs.existsSync(path.join(r, ".slipway", "evidence", "api", "0.1.0.md"))); assert.doesNotMatch(a.log, /release upload/);
  const r2 = repo(c => { c.options.evidence_store = "none"; }); const b = storeRun(r2);
  assert.equal(b.j.evidence_store.store, "none"); assert.equal(b.j.evidence, null); assert.ok(!fs.existsSync(path.join(r2, ".slipway", "evidence"))); assert.doesNotMatch(b.log, /release/);
  const r3 = repo(); const c = storeRun(r3, ["--store", "repo"]);
  assert.equal(c.j.evidence_store.store, "repo"); assert.ok(fs.existsSync(path.join(r3, ".slipway", "evidence", "api", "0.1.0.md")));
  const t = storeRun(repo(), ["--store", "nowhere"]); assert.equal(t.x.status, 1); assert.match(t.x.stderr, /--store must be/);
});
