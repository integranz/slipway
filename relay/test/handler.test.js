import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handle } from "../src/index.js";

const SECRET = "whsec-test";
const fakeKv = () => { const store = new Map(); return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } }; };
const env = (over = {}) => ({ GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_DISPATCH_TOKEN: "ghp_test", GITHUB_DISPATCH_REPO: "integranz/slipway", GITHUB_DISPATCH_WORKFLOW: "onboard-poller.yml", GITHUB_DISPATCH_REF: "main", EXCLUDE_REPOS: "", FORWARD_PRIVATE_PUSHES: "false", DEDUPE: fakeKv(), ...over });
const repo = (o = {}) => ({ id: 1, name: "orders-api", full_name: "integranz/orders-api", default_branch: "main", private: false, archived: false, fork: false, ...o });
const req = (body, { event = "push", delivery = "11111111-2222-3333-4444-555555555555", secret = SECRET, sign = true, method = "POST", path = "/" } = {}) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery };
  if (sign) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return new Request(`https://relay.example${path}`, { method, headers, body: method === "GET" ? undefined : raw });
};
const stubFetch = (status = 200, bodyObj = { html_url: "https://github.com/integranz/slipway/actions/runs/123" }) => {
  const calls = []; const fn = async (url, init) => { calls.push({ url, init }); return new Response(status === 204 ? null : JSON.stringify(bodyObj), { status }); }; fn.calls = calls; return fn;
};
const push = { ref: "refs/heads/main", deleted: false, after: "abc", repository: repo() };

test("health check and method handling", async () => {
  assert.equal((await handle(new Request("https://relay.example/"), env())).status, 200);
  assert.equal(await (await handle(new Request("https://relay.example/healthz"), env())).text(), "slipway-relay");
  assert.equal((await handle(new Request("https://relay.example/nope"), env())).status, 404);
  assert.equal((await handle(new Request("https://relay.example/", { method: "PUT" }), env())).status, 405);
});

test("misconfigured worker answers 500 before reading anything", async () => {
  const r = await handle(req(push), env({ GITHUB_DISPATCH_TOKEN: "" })); assert.equal(r.status, 500); assert.deepEqual(await r.json(), { ok: false, error: "misconfigured" });
  assert.equal((await handle(req(push), env({ DEDUPE: undefined }))).status, 500);
});

test("bad or missing signature → 401; missing headers → 400; bad JSON → 400; nothing dispatched or stored", async () => {
  const f = stubFetch(); const e = env();
  assert.equal((await handle(req(push, { sign: false }), e, { fetch: f })).status, 401);
  assert.equal((await handle(req(push, { secret: "wrong" }), e, { fetch: f })).status, 401);
  const noEvent = new Request("https://relay.example/", { method: "POST", headers: { "x-github-delivery": "d1" }, body: "{}" });
  assert.equal((await handle(noEvent, e, { fetch: f })).status, 400);
  assert.equal((await handle(req("{not json", {}), e, { fetch: f })).status, 400);
  assert.equal(f.calls.length, 0); assert.equal(e.DEDUPE.store.size, 0);
});

test("ping → 200 pong; ignored events → 200 with the reason; no dispatch", async () => {
  const f = stubFetch(); const e = env();
  const p = await handle(req({ zen: "Keep it logically awesome.", hook_id: 1 }, { event: "ping" }), e, { fetch: f }); assert.equal(p.status, 200); assert.deepEqual(await p.json(), { ok: true, pong: true });
  const i = await handle(req({ ...push, ref: "refs/heads/feature" }), e, { fetch: f }); assert.equal(i.status, 200); assert.match((await i.json()).ignored, /not the default branch/);
  const own = await handle(req({ ...push, repository: repo({ full_name: "integranz/slipway" }) }), e, { fetch: f }); assert.match((await own.json()).ignored, /excluded/);
  assert.equal(f.calls.length, 0); assert.equal(e.DEDUPE.store.size, 0);
});

test("a default-branch push dispatches the poller for that repository with the relay source, then dedupes the delivery", async () => {
  const f = stubFetch(); const e = env(); const waited = [];
  const r = await handle(req(push), e, { fetch: f, ctx: { waitUntil: (p) => waited.push(p) } });
  assert.equal(r.status, 202); const j = await r.json(); assert.equal(j.kind, "push"); assert.equal(j.repository, "integranz/orders-api"); assert.equal(j.run_url, "https://github.com/integranz/slipway/actions/runs/123");
  assert.equal(f.calls.length, 1); const call = f.calls[0];
  assert.equal(call.url, "https://api.github.com/repos/integranz/slipway/actions/workflows/onboard-poller.yml/dispatches");
  assert.equal(call.init.headers.Authorization, "Bearer ghp_test"); assert.equal(call.init.headers["User-Agent"], "slipway-relay"); assert.equal(call.init.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.deepEqual(JSON.parse(call.init.body), { ref: "main", inputs: { repository: "integranz/orders-api", source: "relay:push:11111111-2222-3333-4444-555555555555" }, return_run_details: true });
  await Promise.all(waited); assert.equal(e.DEDUPE.store.get("d:11111111-2222-3333-4444-555555555555"), "push");
  const again = await handle(req(push), e, { fetch: f }); assert.equal(again.status, 200); assert.deepEqual(await again.json(), { ok: true, duplicate: true }); assert.equal(f.calls.length, 1, "no second dispatch for the same delivery");
});

test("repository.created dispatches with its own kind; a 204 answer still counts as dispatched (workflow page as run_url)", async () => {
  const f = stubFetch(204); const e = env();
  const r = await handle(req({ action: "created", repository: repo() }, { event: "repository", delivery: "d-created" }), e, { fetch: f });
  assert.equal(r.status, 202); const j = await r.json(); assert.equal(j.kind, "repository.created"); assert.equal(j.run_url, "https://github.com/integranz/slipway/actions/workflows/onboard-poller.yml");
  assert.equal(JSON.parse(f.calls[0].init.body).inputs.source, "relay:repository.created:d-created");
});

test("a failed dispatch → 502 with GitHub's error, nothing deduped (GitHub's Redeliver can retry); a network error → 502 too", async () => {
  const f = stubFetch(422, { message: "Unexpected inputs provided: [\"source\"]" }); const e = env();
  const r = await handle(req(push), e, { fetch: f }); assert.equal(r.status, 502); const j = await r.json(); assert.equal(j.status, 422); assert.match(j.error, /Unexpected inputs/);
  assert.equal(e.DEDUPE.store.size, 0, "failed deliveries are not deduped");
  const boom = async () => { throw new Error("connect timeout"); };
  const n = await handle(req(push), e, { fetch: boom }); assert.equal(n.status, 502); assert.match((await n.json()).error, /connect timeout/);
});
