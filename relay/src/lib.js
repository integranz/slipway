// slipway relay — pure functions (tested with node:test; no Cloudflare APIs needed).
// GitHub organisation webhook deliveries in, one decision out: forward (dispatch the onboarding poller for ONE repository)
// or ignore. Everything that touches the network lives in index.js.

const enc = new TextEncoder();

/** Hex string -> Uint8Array. Throws on odd length or non-hex characters. */
export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * GitHub signs the raw body with HMAC-SHA256 and sends `X-Hub-Signature-256: sha256=<hex>`
 * (docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries). crypto.subtle.verify compares in constant time.
 * Anything malformed is "not verified", never an exception.
 */
export async function verifySignature(secret, rawBody, signatureHeader) {
  if (!secret || typeof rawBody !== "string" || typeof signatureHeader !== "string") return false;
  if (!/^sha256=[0-9a-f]{64}$/.test(signatureHeader)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("HMAC", key, hexToBytes(signatureHeader.slice(7)), enc.encode(rawBody));
  } catch { return false; }
}

const REPOSITORY_ACTIONS = new Set(["created", "publicized", "unarchived", "transferred"]);

/**
 * Which deliveries start a poller tick. The poller is idempotent and does the real classification; the relay only keeps
 * the noise out: default-branch pushes of live, non-fork repositories, and repository lifecycle events that can make a
 * repository onboardable. The dispatch repository itself and EXCLUDE_REPOS are never forwarded.
 * @returns {{forward: boolean, kind: string, repository: string|null, reason: string}}
 */
export function decide(eventName, payload, { dispatchRepo = "", excludeRepos = "", forwardPrivatePushes = false } = {}) {
  const repo = payload && payload.repository && typeof payload.repository === "object" ? payload.repository : null;
  const fullName = repo && typeof repo.full_name === "string" ? repo.full_name : null;
  const excluded = new Set([dispatchRepo, ...String(excludeRepos || "").split(",")].map((s) => s.trim().toLowerCase()).filter(Boolean));
  const ignore = (kind, reason) => ({ forward: false, kind, repository: fullName, reason });
  if (eventName === "ping") return ignore("ping", "ping");
  if (!fullName) return ignore(eventName || "unknown", "no repository in the payload");
  if (excluded.has(fullName.toLowerCase())) return ignore(eventName, `${fullName} is excluded`);
  if (eventName === "repository") {
    const action = String(payload.action || "");
    if (!REPOSITORY_ACTIONS.has(action)) return ignore(`repository.${action}`, `repository action '${action}' needs no tick`);
    if (repo.fork) return ignore(`repository.${action}`, "fork");
    return { forward: true, kind: `repository.${action}`, repository: fullName, reason: `repository ${action}` };
  }
  if (eventName === "push") {
    const branch = `refs/heads/${repo.default_branch || "main"}`;
    if (payload.deleted === true) return ignore("push", "branch deleted");
    if (payload.ref !== branch) return ignore("push", `not the default branch (${payload.ref})`);
    if (repo.archived) return ignore("push", "archived");
    if (repo.fork) return ignore("push", "fork");
    if (repo.private && !forwardPrivatePushes) return ignore("push", "private repository (FORWARD_PRIVATE_PUSHES is false)");
    return { forward: true, kind: "push", repository: fullName, reason: `push to ${repo.default_branch || "main"}` };
  }
  return ignore(eventName, `event '${eventName}' is not handled`);
}

/** Body of POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches (docs.github.com/rest/actions/workflows). */
export function dispatchBody(repository, { ref = "main", source = "" } = {}) {
  return { ref, inputs: { repository, source }, return_run_details: true };
}

export function dispatchUrl(dispatchRepo, workflow) {
  return `https://api.github.com/repos/${dispatchRepo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
}
