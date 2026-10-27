import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature, decide, dispatchBody, dispatchUrl, hexToBytes } from "../src/lib.js";

const sign = (secret, body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("verifySignature: GitHub's documented vector, our own vectors, and every malformed form is false", async () => {
  // docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
  assert.equal(await verifySignature("It's a Secret to Everybody", "Hello, World!", "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"), true);
  const body = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "integranz/x" } });
  assert.equal(await verifySignature("s3cret", body, sign("s3cret", body)), true);
  assert.equal(await verifySignature("s3cret", body + " ", sign("s3cret", body)), false, "any byte change fails");
  assert.equal(await verifySignature("other", body, sign("s3cret", body)), false, "wrong secret fails");
  assert.equal(await verifySignature("s3cret", body, sign("s3cret", body).toUpperCase()), false, "header must be lowercase hex");
  assert.equal(await verifySignature("s3cret", body, "sha1=abc"), false);
  assert.equal(await verifySignature("s3cret", body, undefined), false);
  assert.equal(await verifySignature("", body, sign("", body)), false, "empty secret never verifies");
  assert.deepEqual([...hexToBytes("00ff10")], [0, 255, 16]); assert.throws(() => hexToBytes("abc"));
});

const repo = (o = {}) => ({ id: 1, name: "orders-api", full_name: "integranz/orders-api", default_branch: "main", private: false, archived: false, fork: false, ...o });
const opts = { dispatchRepo: "integranz/slipway", excludeRepos: "integranz/slipway-platform, integranz/opentelemetry-demo" };

test("decide: ping, repository lifecycle, push to the default branch; forks, archives, deletions, other branches and excluded repositories are ignored", () => {
  assert.deepEqual(decide("ping", { zen: "x" }, opts), { forward: false, kind: "ping", repository: null, reason: "ping" });
  assert.equal(decide("repository", { action: "created", repository: repo() }, opts).forward, true);
  assert.equal(decide("repository", { action: "created", repository: repo() }, opts).kind, "repository.created");
  for (const a of ["publicized", "unarchived", "transferred"]) assert.equal(decide("repository", { action: a, repository: repo() }, opts).forward, true, a);
  for (const a of ["deleted", "archived", "renamed", "edited", "privatized"]) assert.equal(decide("repository", { action: a, repository: repo() }, opts).forward, false, a);
  assert.equal(decide("repository", { action: "created", repository: repo({ fork: true }) }, opts).forward, false);
  const push = (p = {}, r = {}) => decide("push", { ref: "refs/heads/main", deleted: false, ...p, repository: repo(r) }, opts);
  assert.deepEqual(push(), { forward: true, kind: "push", repository: "integranz/orders-api", reason: "push to main" });
  assert.equal(push({ ref: "refs/heads/feature" }).forward, false);
  assert.equal(push({ ref: "refs/heads/develop" }, { default_branch: "develop" }).forward, true, "the default branch may not be main");
  assert.equal(push({ deleted: true }).forward, false);
  assert.equal(push({}, { archived: true }).forward, false); assert.equal(push({}, { fork: true }).forward, false);
  assert.equal(push({}, { private: true }).forward, false, "private pushes are off by default");
  assert.equal(decide("push", { ref: "refs/heads/main", repository: repo({ private: true }) }, { ...opts, forwardPrivatePushes: true }).forward, true);
  assert.equal(push({}, { full_name: "integranz/slipway" }).forward, false, "the dispatch repository never triggers itself");
  assert.equal(push({}, { full_name: "Integranz/Slipway-Platform" }).forward, false, "EXCLUDE_REPOS, case-insensitive");
  assert.equal(decide("issues", { action: "opened", repository: repo() }, opts).forward, false);
  assert.equal(decide("push", {}, opts).forward, false, "no repository in the payload");
});

test("dispatchBody and dispatchUrl match the GitHub REST shape", () => {
  assert.deepEqual(dispatchBody("integranz/orders-api", { ref: "main", source: "relay:push:guid" }), { ref: "main", inputs: { repository: "integranz/orders-api", source: "relay:push:guid" }, return_run_details: true });
  assert.equal(dispatchUrl("integranz/slipway", "onboard-poller.yml"), "https://api.github.com/repos/integranz/slipway/actions/workflows/onboard-poller.yml/dispatches");
});
