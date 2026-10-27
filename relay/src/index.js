// slipway relay — Cloudflare Worker. GitHub organisation webhook (Repositories + Pushes) in; one `workflow_dispatch` of the
// onboarding poller (integranz/slipway, onboard-poller.yml) out, for the one repository the delivery is about. The poller
// does everything else (welcome issue, gates, agent dispatch) and stays the backstop through its own schedule.
//
// Response codes: 202 dispatched · 200 ping / ignored / duplicate delivery · 401 bad signature · 400 missing headers or bad
// JSON · 405 not POST · 413 body too large · 502 the dispatch call failed (body logged, not deduped, so GitHub's "Redeliver"
// works) · 500 misconfigured (secret, token or KV binding missing).
// Secrets (wrangler secret put): GITHUB_WEBHOOK_SECRET (also set on the GitHub webhook), GITHUB_DISPATCH_TOKEN (fine-grained,
// Actions: write on the dispatch repository only). Vars: see wrangler.jsonc. Nothing here is ever logged except metadata.
import { verifySignature, decide, dispatchBody, dispatchUrl } from "./lib.js";

const MAX_BODY = 2 * 1024 * 1024;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const text = (status, body) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

/** @param {Request} request @param {Record<string, any>} env @param {{fetch?: typeof fetch, ctx?: {waitUntil(p: Promise<unknown>): void}}} deps */
export async function handle(request, env, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const url = new URL(request.url);
  if (request.method === "GET") return url.pathname === "/" || url.pathname === "/healthz" ? text(200, "slipway-relay") : text(404, "not found");
  if (request.method !== "POST") return json(405, { ok: false, error: "method not allowed" });

  const missing = ["GITHUB_WEBHOOK_SECRET", "GITHUB_DISPATCH_TOKEN", "DEDUPE"].filter((k) => !env || !env[k]);
  if (missing.length) { log({ level: "error", msg: "misconfigured", missing }); return json(500, { ok: false, error: "misconfigured" }); }

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY) return json(413, { ok: false, error: "body too large" });
  const raw = await request.text(); // read once: the signature covers these exact bytes
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "body too large" });

  const event = request.headers.get("x-github-event"); const delivery = request.headers.get("x-github-delivery");
  if (!event || !delivery) return json(400, { ok: false, error: "missing X-GitHub-Event or X-GitHub-Delivery" });
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, raw, request.headers.get("x-hub-signature-256")))) {
    log({ level: "warn", msg: "bad signature", delivery, event });
    return json(401, { ok: false, error: "bad signature" });
  }
  let payload; try { payload = JSON.parse(raw); } catch { return json(400, { ok: false, error: "invalid JSON" }); }

  const dispatchRepo = env.GITHUB_DISPATCH_REPO || "integranz/slipway", workflow = env.GITHUB_DISPATCH_WORKFLOW || "onboard-poller.yml";
  const d = decide(event, payload, { dispatchRepo, excludeRepos: env.EXCLUDE_REPOS, forwardPrivatePushes: String(env.FORWARD_PRIVATE_PUSHES) === "true" });
  const base = { delivery, event, action: payload && payload.action ? payload.action : undefined, repository: d.repository, kind: d.kind };
  if (d.kind === "ping") { log({ ...base, decision: "ping" }); return json(200, { ok: true, pong: true }); }
  if (!d.forward) { log({ ...base, decision: "ignore", reason: d.reason }); return json(200, { ok: true, ignored: d.reason }); }

  const key = `d:${delivery}`;
  if (await env.DEDUPE.get(key)) { log({ ...base, decision: "duplicate" }); return json(200, { ok: true, duplicate: true }); }

  const body = dispatchBody(d.repository, { ref: env.GITHUB_DISPATCH_REF || "main", source: `relay:${d.kind}:${delivery}` });
  let res;
  try {
    res = await doFetch(dispatchUrl(dispatchRepo, workflow), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "slipway-relay", "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  } catch (e) { log({ ...base, decision: "dispatch-error", error: String(e && e.message).slice(0, 300) }); return json(502, { ok: false, error: `dispatch failed: ${String(e && e.message).slice(0, 300)}` }); }
  if (res.status !== 200 && res.status !== 204) {
    const err = (await res.text().catch(() => "")).slice(0, 300);
    log({ ...base, decision: "dispatch-failed", status: res.status, error: err });
    return json(502, { ok: false, status: res.status, error: err });
  }
  let runUrl = `https://github.com/${dispatchRepo}/actions/workflows/${workflow}`;
  if (res.status === 200) { try { const j = await res.json(); runUrl = j.html_url || j.run_url || runUrl; } catch { /* keep the workflow page */ } }
  const put = env.DEDUPE.put(key, d.kind, { expirationTtl: 86400 }); // after success only: a failed delivery stays redeliverable
  if (deps.ctx && typeof deps.ctx.waitUntil === "function") deps.ctx.waitUntil(put); else await put;
  log({ ...base, decision: "dispatched", run_url: runUrl });
  return json(202, { ok: true, kind: d.kind, repository: d.repository, run_url: runUrl });
}

export default { fetch: (request, env, ctx) => handle(request, env, { fetch, ctx }) };
