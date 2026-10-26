// platform.cjs: renders the platform repository from platform.yaml (foundation Terraform, setup-platform.sh, org template).
const { test } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const yaml = require("./lib/js-yaml.min.js");
const HERE = __dirname, SCRIPT = path.join(HERE, "platform.cjs"), EXAMPLE = path.join(HERE, "..", "templates", "platform", "platform.example.yaml");

function renderWith(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-platform-")); const cfg = yaml.load(fs.readFileSync(EXAMPLE, "utf8"));
  cfg.github.org_id = 326982263; cfg.github.org = "integranz"; if (mutate) mutate(cfg);
  fs.writeFileSync(path.join(dir, "platform.yaml"), yaml.dump(cfg));
  const r = spawnSync("node", [SCRIPT, "render", "--config", path.join(dir, "platform.yaml"), "--out", path.join(dir, "out")], { encoding: "utf8" });
  return { dir: path.join(dir, "out"), r, cfg };
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const tfCheck = (dir) => {
  if (spawnSync("terraform", ["version"], { encoding: "utf8" }).status !== 0) { console.log("  (terraform not installed: fmt/validate skipped)"); return; }
  const fmt = spawnSync("terraform", ["-chdir=" + dir, "fmt", "-check", "-recursive"], { encoding: "utf8" }); assert.equal(fmt.status, 0, `terraform fmt -check: ${fmt.stdout}${fmt.stderr}`);
  const init = spawnSync("terraform", ["-chdir=" + dir, "init", "-backend=false", "-input=false"], { encoding: "utf8", timeout: 240000 });
  if (init.status !== 0) { console.log("  (terraform init failed, likely offline: validate skipped)"); return; }
  const val = spawnSync("terraform", ["-chdir=" + dir, "validate", "-no-color"], { encoding: "utf8" }); assert.equal(val.status, 0, `terraform validate: ${val.stdout}${val.stderr}`);
};

test("renders the platform repository: foundation, setup script, organisation template, README; no placeholders; valid Terraform", () => {
  const { dir, r } = renderWith(); assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ["README.md", "org-defaults.yaml", "setup-platform.sh", ".gitignore", "platform.yaml", "infra/foundation/versions.tf", "infra/foundation/locals.tf", "infra/foundation/main.tf", "infra/foundation/cae.tf", "infra/foundation/outputs.tf", "infra/foundation/README.md"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} rendered`); if (f !== "platform.yaml") assert.doesNotMatch(read(dir, f), /<%/, `unrendered placeholder in ${f}`);
  }
  assert.ok(fs.statSync(path.join(dir, "setup-platform.sh")).mode & 0o111, "setup script executable");
  const syntax = spawnSync("bash", ["-n", path.join(dir, "setup-platform.sh")], { encoding: "utf8" }); assert.equal(syntax.status, 0, syntax.stderr);
  const sh = read(dir, "setup-platform.sh");
  assert.match(sh, /GH_ORG="integranz"; GH_ORG_ID="326982263"; GH_BRANCH="main"/); assert.match(sh, /repo:\$\{GH_ORG\}@\$\{GH_ORG_ID\}\/\*:ref:refs\/heads\/\$\{GH_BRANCH\}/); assert.match(sh, /repo:\$\{GH_ORG\}@\$\{GH_ORG_ID\}\/\*:environment:\$\{ENVIRONMENT\}/); assert.match(sh, /repo:\$\{GH_ORG\}\/\*:environment:\$\{ENVIRONMENT\}/); assert.match(sh, /ENVIRONMENT="dev"/);
  assert.match(sh, /claims\['repository_owner_id'\] eq '\$\{GH_ORG_ID\}'/); assert.match(sh, /api-version=\$\{FIC_API\}/); assert.match(sh, /FIC_API="2025-01-31-preview"/);
  assert.match(sh, /gh secret set AZURE_CLIENT_ID\s+--org "\$GH_ORG" --visibility all/); assert.match(sh, /--condition "\$COND_ACR" --condition-version "2.0"/); assert.match(sh, /7f951dda-4ed3-4680-a7ca-43fe172d538d/); assert.match(sh, /4633458b-17de-408a-b874-0445c86b69e6/);
  assert.doesNotMatch(sh, /2e8a6e6a|b1a09054/, "no subscription or tenant id");
  const main = read(dir, "infra/foundation/main.tf"); assert.match(main, /resource "azurerm_container_registry" "this"/); assert.match(main, /data "azurerm_user_assigned_identity" "cicd"/); assert.doesNotMatch(main, /azurerm_user_assigned_identity" "apps"/, "no shared apps identity by default");
  assert.match(read(dir, "infra/foundation/versions.tf"), /key\s+= "slipway\/platform\/dev\.tfstate"/);
  const tpl = read(dir, "org-defaults.yaml"); assert.match(tpl, /^options\.platform_scope: shared$/m); assert.match(tpl, /^options\.registry_scope: existing$/m); assert.match(tpl, /^azure\.acr_name: acrslipwaydev$/m); assert.match(tpl, /^azure\.acr_resource_group: rg-slipway-dev$/m); assert.match(tpl, /^azure\.container_app_environment: cae-slipway-dev$/m); assert.match(tpl, /^jira\.project_key: DEVOPS$/m); assert.doesNotMatch(tpl, /azure\.identity_name/);
  tfCheck(path.join(dir, "infra", "foundation"));
});

test("setup-platform.sh dry run walks every step against a stubbed az (nothing exists yet)", () => {
  const { dir, r } = renderWith(); assert.equal(r.status, 0, r.stderr + r.stdout);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "stub-az-")); // az: identity and account queries answer, every "show"/GET of a resource says "not found"
  fs.writeFileSync(path.join(bin, "az"), `#!/usr/bin/env bash
args="$*"
case "$args" in
  "account show --query id"*) echo 00000000-0000-0000-0000-000000000001;;
  "account show --query tenantId"*) echo 00000000-0000-0000-0000-000000000002;;
  "account show --query name"*) echo "Stub subscription";;
  "ad signed-in-user show --query id"*) echo 00000000-0000-0000-0000-000000000003;;
  "ad signed-in-user show --query userPrincipalName"*) echo me@example.com;;
  "role assignment list"*"--scope"*) echo 0;;
  "role assignment list"*) printf 'Owner\\n';;
  "role definition list"*) echo "";;
  "group show"*|"storage account show"*|"identity show"*|"rest --method GET"*|"storage container show"*|"acr show"*|"keyvault show"*) exit 1;;
  *) exit 0;;
esac
`); fs.chmodSync(path.join(bin, "az"), 0o755);
  const run = spawnSync("bash", ["setup-platform.sh"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const s of ["create resource group rg-slipway-tfstate", "create storage account stslipwaytf", "create identity id-slipway-cicd-dev", "add github-ci-immutable", "add github-cd-immutable", "add github-ci-classic", "add github-cd-classic", "cicd identity: Contributor on resourceGroups/rg-slipway-dev", "create container tfstate", "--grant-per-app-roles"]) assert.ok(run.stdout.includes(s), `dry run mentions '${s}'`);
  assert.match(run.stdout, /claims\['sub'\] matches 'repo:integranz@326982263\/\*:ref:refs\/heads\/main' and claims\['repository_owner_id'\] eq '326982263'/);
  assert.doesNotMatch(run.stdout + run.stderr, /unbound variable|command not found/);
  assert.match(run.stdout, /Done \(dry run\)/);
});

test("existing registry and shared apps identity variants; re-render skips existing files unless --force", () => {
  const { dir, r } = renderWith((c) => { c.azure.registry.existing = true; c.azure.registry.resource_group = "rg-taskflow-dev"; c.azure.registry.name = "acrtaskflowdev"; c.azure.shared_apps_identity = true; delete c.jira; });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const main = read(dir, "infra/foundation/main.tf"); assert.match(main, /data "azurerm_container_registry" "this"/); assert.doesNotMatch(main, /resource "azurerm_container_registry"/); assert.match(main, /"cicd_acr_reader"/); assert.match(main, /resource "azurerm_user_assigned_identity" "apps"/);
  assert.match(read(dir, "infra/foundation/locals.tf"), /acr_resource_group_name = "rg-taskflow-dev"/);
  const tpl = read(dir, "org-defaults.yaml"); assert.match(tpl, /^azure\.acr_resource_group: rg-taskflow-dev$/m); assert.match(tpl, /^azure\.identity_name: id-slipway-apps-dev$/m); assert.doesNotMatch(tpl, /jira/);
  assert.match(read(dir, "setup-platform.sh"), /ACR_RG="rg-taskflow-dev"/);
  const again = spawnSync("node", [SCRIPT, "render", "--config", path.join(dir, "platform.yaml"), "--out", dir], { encoding: "utf8" }); assert.equal(again.status, 0); assert.match(again.stdout, /skip\s+README\.md/); assert.match(again.stdout, /0 written/);
  tfCheck(path.join(dir, "infra", "foundation"));
});

test("platform.yaml validation: placeholder org id, bad names and ids are rejected; example prints", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-platform-")); const cfg = yaml.load(fs.readFileSync(EXAMPLE, "utf8")); fs.writeFileSync(path.join(dir, "p.yaml"), yaml.dump(cfg));
  const r = spawnSync("node", [SCRIPT, "render", "--config", path.join(dir, "p.yaml"), "--out", path.join(dir, "o")], { encoding: "utf8" }); assert.equal(r.status, 0, "the example renders (org id is only checked for the placeholder by the setup script)");
  cfg.azure.state.storage_account = "Has-Upper"; cfg.github.org_id = "abc"; fs.writeFileSync(path.join(dir, "bad.yaml"), yaml.dump(cfg));
  const b = spawnSync("node", [SCRIPT, "render", "--config", path.join(dir, "bad.yaml"), "--out", path.join(dir, "o2")], { encoding: "utf8" }); assert.equal(b.status, 1); assert.match(b.stderr, /storage_account/); assert.match(b.stderr, /org_id/);
  const e = spawnSync("node", [SCRIPT, "example"], { encoding: "utf8" }); assert.equal(e.status, 0); assert.match(e.stdout, /^name: slipway\b/m);
});
