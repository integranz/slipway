// jira-rest.cjs against a local Jira Cloud REST v3 stub: story/subtask model, transitions, auto-close, auth, soft mode.
const { test, before, after } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { execFile } = require("node:child_process");
const yaml = require("./lib/js-yaml.min.js");
const HERE = __dirname, SCRIPT = path.join(HERE, "jira-rest.cjs"), EXAMPLE = path.join(HERE, "..", "templates", "common", "slipway", "config.example.yaml");

// ---- stub -----------------------------------------------------------------------------------------------------
const state = { issues: new Map(), n: 0, requests: [] };
const FLOW = { "To Do": ["In Progress"], "In Progress": ["In Review", "Done"], "In Review": ["Done"], "Done": [] };
const TID = { "In Progress": "11", "In Review": "21", "Done": "31" };
function issueJson(i) { return { key: i.key, fields: { summary: i.summary, status: { name: i.status }, parent: i.parent ? { key: i.parent } : undefined, issuetype: { name: i.type } } }; }
function matches(i, jql) {
  const m = jql.match(/summary ~ "\\?"?([^"\\]+)/); const title = m && m[1];
  if (/parent = (\S+)/.test(jql)) { const p = jql.match(/parent = (\S+)/)[1]; if (i.parent !== p) return false; } else if (/project = /.test(jql)) { if (i.parent && i.type === "Subtask") return false; }
  if (title && !i.summary.includes(title)) return false;
  if (/statusCategory != Done/.test(jql) && i.status === "Done") return false;
  return true;
}
let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
      const url = new URL(req.url, "http://x"); state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Basic ${Buffer.from("dev@example.com:tok-secret-123").toString("base64")}`) return send(401, { errorMessages: ["unauthorized"] });
      const parts = url.pathname.split("/").filter(Boolean); // rest api 3 ...
      if (url.pathname === "/rest/api/3/search/jql") { const jql = url.searchParams.get("jql") || ""; return send(200, { isLast: true, issues: [...state.issues.values()].filter((i) => matches(i, jql)).map(issueJson) }); }
      if (url.pathname === "/rest/api/3/issue" && req.method === "POST") {
        const f = JSON.parse(body).fields; const key = `T-${++state.n}`;
        state.issues.set(key, { key, summary: f.summary, status: "To Do", type: f.issuetype.name, parent: f.parent && f.parent.key, comments: [] }); return send(201, { id: String(state.n), key });
      }
      if (parts[3] === "issue" && parts[4]) {
        const i = state.issues.get(parts[4]); if (!i) return send(404, { errorMessages: ["Issue does not exist"] });
        if (parts[5] === "transitions" && req.method === "GET") return send(200, { transitions: FLOW[i.status].map((to) => ({ id: TID[to], name: to, to: { name: to } })) });
        if (parts[5] === "transitions" && req.method === "POST") { const id = JSON.parse(body).transition.id; const to = Object.keys(TID).find((k) => TID[k] === id); if (!FLOW[i.status].includes(to)) return send(400, { errorMessages: ["transition not allowed"] }); i.status = to; return send(204, {}); }
        if (parts[5] === "comment" && req.method === "POST") { i.comments.push(JSON.parse(body).body.content.map((p) => p.content[0].text).join("\n\n")); return send(201, { id: "c" }); }
        if (!parts[5]) return send(200, issueJson(i));
      }
      send(404, { errorMessages: [`no route ${req.method} ${url.pathname}`] });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); port = server.address().port;
});
after(() => server.close());

function mkRepo(mutate) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jira-rest-")); fs.mkdirSync(path.join(repo, ".slipway"));
  const cfg = yaml.load(fs.readFileSync(EXAMPLE, "utf8")); if (mutate) mutate(cfg); fs.writeFileSync(path.join(repo, ".slipway", "config.yaml"), yaml.dump(cfg)); return repo;
}
// async child: the stub server lives in this process, so a blocking child (spawnSync) would deadlock the event loop
const run = (repo, args, env = {}) => new Promise((resolve) => execFile("node", [SCRIPT, "--repo", repo, ...args],
  { encoding: "utf8", env: { PATH: process.env.PATH, JIRA_SITE_URL: `http://127.0.0.1:${port}`, JIRA_EMAIL: "dev@example.com", JIRA_API_TOKEN: "tok-secret-123", ...env } },
  (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr })));

test("subtask done: creates the story and the subtask, walks the workflow, comments, auto-closes the story; token never printed", async () => {
  state.issues.clear(); state.n = 0; state.requests.length = 0; const repo = mkRepo();
  const r = await run(repo, ["subtask", "done", "Bootstrap adlc-demo", "--message", "onboarding PR merged"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tracking: subtask done T-2 "Bootstrap adlc-demo" → Done \(created\) under T-1; story closed \(Done\) \(jira-rest\)/);
  const story = state.issues.get("T-1"), sub = state.issues.get("T-2");
  assert.equal(story.summary, "Onboard adlc-demo to slipway delivery"); assert.equal(story.type, "Story"); assert.equal(story.status, "Done");
  assert.equal(sub.parent, "T-1"); assert.equal(sub.type, "Subtask"); assert.equal(sub.status, "Done"); assert.deepEqual(sub.comments, ["onboarding PR merged"]);
  assert.ok(story.comments.includes("All subtasks done; closed by slipway."));
  assert.ok(state.requests.every((q) => q.auth.startsWith("Basic ")), "every request carries Basic auth");
  assert.doesNotMatch(r.stdout + r.stderr, /tok-secret-123/);
});

test("subtask start then done: no duplicate subtask; the story stays open while another subtask is open", async () => {
  state.issues.clear(); state.n = 0; const repo = mkRepo();
  assert.equal((await run(repo, ["subtask", "start", "Deploy api 0.1.0 → dev", "--message", "run https://x/1"])).status, 0);
  assert.equal((await run(repo, ["subtask", "start", "Dockerize api"])).status, 0);
  const r = await run(repo, ["subtask", "done", "Deploy api 0.1.0 → dev", "--evidence", "https://github.com/o/r/releases/tag/api%2Fv0.1.0"]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /story closed/);
  const subs = [...state.issues.values()].filter((i) => i.type === "Subtask"); assert.equal(subs.length, 2, "no duplicate subtask");
  const deploy = subs.find((i) => i.summary.startsWith("Deploy")); assert.equal(deploy.status, "Done"); assert.ok(deploy.comments.some((c) => c.includes("Evidence: https://github.com")));
  assert.equal(state.issues.get("T-1").status, "To Do", "story untouched while a subtask is still open");
  const r2 = await run(repo, ["subtask", "done", "Dockerize api"]); assert.match(r2.stdout, /story closed \(Done\)/); assert.equal(state.issues.get("T-1").status, "Done");
});

test("story ensure honours jira.story_key; comment posts; --json output", async () => {
  state.issues.clear(); state.n = 0; state.issues.set("DEV-9", { key: "DEV-9", summary: "Existing story", status: "In Progress", type: "Story", comments: [] });
  const repo = mkRepo((c) => { c.jira.story_key = "DEV-9"; });
  const r = await run(repo, ["story", "ensure", "--json"]); assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), { key: "DEV-9", created: false, status: "In Progress", summary: "Existing story" });
  const c = await run(repo, ["comment", "DEV-9", "--message", "hello"]); assert.equal(c.status, 0, c.stderr); assert.deepEqual(state.issues.get("DEV-9").comments, ["hello"]);
  const s = await run(repo, ["subtask", "done", "Bootstrap adlc-demo"]); assert.match(s.stdout, /under DEV-9/);
});

test("not configured: exit 3, or 0 with --soft; tracker none exits 0; bad credentials fail without leaking the token", async () => {
  const repo = mkRepo();
  const r = await run(repo, ["story", "ensure"], { JIRA_API_TOKEN: "" }); assert.equal(r.status, 3); assert.match(r.stdout, /not configured/);
  const s = await run(repo, ["story", "ensure", "--soft"], { JIRA_API_TOKEN: "" }); assert.equal(s.status, 0); assert.match(s.stdout, /not configured/);
  const none = await run(mkRepo((c) => { c.options.tracker = "none"; }), ["story", "ensure"]); assert.equal(none.status, 0); assert.match(none.stdout, /tracking: disabled/);
  const bad = await run(repo, ["story", "ensure"], { JIRA_API_TOKEN: "wrong-token" }); assert.equal(bad.status, 1); assert.match(bad.stdout, /HTTP 401/); assert.doesNotMatch(bad.stdout + bad.stderr, /wrong-token/);
  const badSoft = await run(repo, ["story", "ensure", "--soft"], { JIRA_API_TOKEN: "wrong-token" }); assert.equal(badSoft.status, 0);
});
