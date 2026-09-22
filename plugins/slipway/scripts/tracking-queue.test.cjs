const { test } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"); const { spawnSync } = require("node:child_process");
const Q = path.join(__dirname, "tracking-queue.cjs");
const run = (repo, ...a) => spawnSync(process.execPath, [Q, ...a, "--repo", repo], { encoding: "utf8" });
test("tracking queue: add, list, pop, clear; unknown actions and bad JSON rejected", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-queue-"));
  let r = run(repo, "list"); assert.equal(r.status, 0); assert.match(r.stdout, /queue empty/);
  r = run(repo, "add", "subtask_start", '{"title":"Deploy api 0.2.3 → dev"}'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /queued subtask_start \(1 pending\)/);
  r = run(repo, "add", "comment", '{"key":"DEVOPS-9","message":"hello"}'); assert.equal(r.status, 0);
  r = run(repo, "add", "delete_everything", "{}"); assert.equal(r.status, 1); assert.match(r.stderr, /unknown action/);
  r = run(repo, "add", "comment", "not json"); assert.equal(r.status, 1); assert.match(r.stderr, /must be JSON/);
  const q = JSON.parse(run(repo, "list", "--json").stdout); assert.equal(q.length, 2); assert.equal(q[0].action, "subtask_start"); assert.equal(q[0].args.title, "Deploy api 0.2.3 → dev");
  r = run(repo, "pop", "1"); assert.match(r.stdout, /removed 1, 1 pending/);
  assert.equal(JSON.parse(run(repo, "list", "--json").stdout)[0].action, "comment");
  r = run(repo, "clear"); assert.equal(r.status, 0); assert.match(run(repo, "list").stdout, /queue empty/);
  assert.ok(fs.existsSync(path.join(repo, ".slipway", "tracking-queue.jsonl")));
});
