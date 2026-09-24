// Tests for registries.cjs: the eligibility logic on fixtures, and the CLI against a stub `az`.
const { test } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { assess, canAssign, scopeCovers } = require("./registries.cjs");
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000001";
const reg = (name, rg, location = "westeurope", sku = "Basic") => ({ name, resourceGroup: rg, location, sku: { name: sku }, loginServer: `${name}.azurecr.io`, id: `${SUB}/resourceGroups/${rg}/providers/Microsoft.ContainerRegistry/registries/${name}` });

test("scope matching: subscription and resource group cover the registry; a sibling group with a longer name does not", () => {
  const id = reg("acrshared", "rg-a").id;
  assert.ok(scopeCovers(SUB, id)); assert.ok(scopeCovers(`${SUB}/resourceGroups/rg-a`, id)); assert.ok(scopeCovers(id, id));
  assert.ok(!scopeCovers(`${SUB}/resourceGroups/rg-ab`, id)); assert.ok(!scopeCovers(`${SUB}/resourceGroups/rg-b`, id));
  assert.deepEqual(canAssign([{ roleDefinitionName: "Contributor", scope: SUB }], id), [], "Contributor cannot assign roles");
  assert.deepEqual(canAssign([{ roleDefinitionName: "User Access Administrator", scope: SUB }], id), ["User Access Administrator @ subscription"]);
  assert.deepEqual(canAssign([{ roleDefinitionName: "Owner", scope: `${SUB}/resourceGroups/rg-a` }], id), ["Owner @ resource group rg-a"]);
});

test("no registry: create one, no question", () => {
  const r = assess({ registries: [], assignments: [], location: "westeurope", identityKnown: true });
  assert.equal(r.recommendation, "per-repository"); assert.deepEqual(r.eligible, []); assert.match(r.reason, /no container registry/);
});

test("registries you can grant roles on come first, same location preferred, recommendation ask", () => {
  const registries = [reg("acrother", "rg-other", "northeurope"), reg("acrshared", "rg-platform"), reg("acrlocked", "rg-locked")];
  const assignments = [{ roleDefinitionName: "Owner", scope: `${SUB}/resourceGroups/rg-platform` }, { roleDefinitionName: "Role Based Access Control Administrator", scope: `${SUB}/resourceGroups/rg-other` }];
  const r = assess({ registries, assignments, location: "westeurope", identityKnown: true });
  assert.equal(r.recommendation, "ask");
  assert.deepEqual(r.registries.map((x) => x.name), ["acrshared", "acrother", "acrlocked"]);
  assert.deepEqual(r.eligible, ["acrshared", "acrother"]);
  assert.equal(r.registries[0].same_location, true); assert.equal(r.registries[1].same_location, false);
  assert.equal(r.registries[2].can_assign_roles, false); assert.deepEqual(r.registries[2].via, []);
  assert.match(r.reason, /2 of 3 registries can be shared/);
});

test("registries exist but none can be granted on: create one, explain what to ask for", () => {
  const r = assess({ registries: [reg("acrlocked", "rg-locked")], assignments: [{ roleDefinitionName: "Contributor", scope: SUB }], location: null, identityKnown: true });
  assert.equal(r.recommendation, "per-repository"); assert.match(r.reason, /cannot assign roles on it/); assert.match(r.reason, /AcrPush\/Reader\/AcrPull/);
  assert.equal(r.registries[0].same_location, null);
});

test("unknown identity (assignments unreadable): registries are offered with eligibility unknown", () => {
  const r = assess({ registries: [reg("acrx", "rg-x")], assignments: [], location: "westeurope", identityKnown: false });
  assert.equal(r.registries[0].can_assign_roles, "unknown"); assert.equal(r.recommendation, "ask");
});

function stubAz(dir, { loggedIn = true, registries = [], assignments = [] } = {}) {
  const bin = path.join(dir, "az");
  const payload = JSON.stringify({ registries, assignments }).replace(/'/g, "'\\''");
  fs.writeFileSync(bin, `#!/usr/bin/env bash
case "$1 $2" in
  "account show") ${loggedIn ? `echo '{"id":"00000000-0000-0000-0000-000000000001","name":"Test Sub","user":{"name":"tester@example.com","type":"user"}}'` : "echo 'Please run az login' >&2; exit 1"};;
  "ad signed-in-user") echo '{"id":"11111111-1111-1111-1111-111111111111","userPrincipalName":"tester@example.com"}';;
  "role assignment") echo '${payload}' | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["assignments"]))';;
  "acr list") echo '${payload}' | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["registries"]))';;
  *) echo "unexpected az $*" >&2; exit 1;;
esac
`); fs.chmodSync(bin, 0o755); return bin;
}
const cli = (args, env) => spawnSync("node", [path.join(__dirname, "registries.cjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("CLI: JSON and table against a stub az", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-az-"));
  const az = stubAz(dir, { registries: [reg("acrshared", "rg-platform")], assignments: [{ roleDefinitionName: "User Access Administrator", scope: SUB }] });
  const j = cli(["--location", "westeurope", "--json"], { SLIPWAY_AZ_BIN: az }); assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.subscription.name, "Test Sub"); assert.equal(out.identity, "tester@example.com"); assert.equal(out.identity_known, true);
  assert.equal(out.recommendation, "ask"); assert.deepEqual(out.eligible, ["acrshared"]); assert.equal(out.registries[0].same_location, true);
  const t = cli(["--location", "westeurope"], { SLIPWAY_AZ_BIN: az }); assert.equal(t.status, 0);
  assert.match(t.stdout, /acrshared\s+rg-platform\s+westeurope\s+Basic\s+can assign roles: yes \(User Access Administrator @ subscription\)\s+\(same location\)/);
  assert.match(t.stdout, /Recommendation: ask/);
});

test("CLI: not logged in exits 2 with the login command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-az-")); const az = stubAz(dir, { loggedIn: false });
  const r = cli(["--json"], { SLIPWAY_AZ_BIN: az }); assert.equal(r.status, 2); assert.match(r.stderr, /az login/);
});
