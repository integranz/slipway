// Integration tests for scaffold.cjs / validate-config.cjs against a temporary repo.
const { test } = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const yaml = require("./lib/js-yaml.min.js");
const HERE = __dirname, EXAMPLE = path.join(HERE, "..", "templates", "common", "slipway", "config.example.yaml");

function mkRepo(mutate, { withLib = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-scaffold-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const cfg = yaml.load(fs.readFileSync(EXAMPLE, "utf8")); if (mutate) mutate(cfg);
  fs.mkdirSync(path.join(repo, ".slipway"), { recursive: true });
  fs.mkdirSync(path.join(repo, "apps/api/src/Api"), { recursive: true });
  fs.writeFileSync(path.join(repo, "apps/api/src/Api/Api.csproj"), withLib
    ? '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><ProjectReference Include="..\\..\\..\\..\\libs\\dotnet\\Demo.Contracts\\Demo.Contracts.csproj" /></ItemGroup></Project>'
    : "<Project/>");
  if (withLib) { fs.mkdirSync(path.join(repo, "libs/dotnet/Demo.Contracts"), { recursive: true }); fs.writeFileSync(path.join(repo, "libs/dotnet/Demo.Contracts/Demo.Contracts.csproj"), '<Project Sdk="Microsoft.NET.Sdk"/>'); }
  fs.mkdirSync(path.join(repo, "apps/api/tests/Api.Tests"), { recursive: true }); fs.writeFileSync(path.join(repo, "apps/api/tests/Api.Tests/Api.Tests.csproj"), "<Project/>");
  fs.mkdirSync(path.join(repo, "apps/web"), { recursive: true }); fs.writeFileSync(path.join(repo, "apps/web/package.json"), "{}");
  fs.writeFileSync(path.join(repo, ".slipway", "config.yaml"), yaml.dump(cfg));
  return repo;
}
const run = (args, cwd) => spawnSync("node", [path.join(HERE, "scaffold.cjs"), ...args], { cwd, encoding: "utf8" });
const validate = (cfgPath) => spawnSync("node", [path.join(HERE, "validate-config.cjs"), cfgPath], { encoding: "utf8" });
const read = (repo, rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const exists = (repo, rel) => fs.existsSync(path.join(repo, rel));
const tfCheck = (dir) => {
  if (spawnSync("terraform", ["version"], { encoding: "utf8" }).status !== 0) { console.log("  (terraform not installed: fmt/validate skipped)"); return; }
  const fmt = spawnSync("terraform", ["-chdir=" + dir, "fmt", "-check", "-recursive"], { encoding: "utf8" }); assert.equal(fmt.status, 0, `terraform fmt -check ${dir}: ${fmt.stdout}${fmt.stderr}`);
  const init = spawnSync("terraform", ["-chdir=" + dir, "init", "-backend=false", "-input=false"], { encoding: "utf8", timeout: 240000 });
  if (init.status !== 0) { console.log("  (terraform init -backend=false failed, likely offline: validate skipped)"); return; }
  const val = spawnSync("terraform", ["-chdir=" + dir, "validate", "-no-color"], { encoding: "utf8" }); assert.equal(val.status, 0, `terraform validate ${dir}: ${val.stdout}${val.stderr}`);
};

test("scaffold renders the common set for the example config", () => {
  const repo = mkRepo();
  const r = run(["--repo", repo], repo);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of ["AGENTS.md", "CLAUDE.md", ".claude/settings.json", ".claude/rules/precedence.md", ".claude/rules/terraform.md",
                   ".claude/rules/pipelines.md", ".claude/rules/docker.md", ".claude/rules/versioning.md", ".claude/rules/branching.md", ".gitignore", ".dockerignore", ".slipway/evidence"]) {
    assert.ok(exists(repo, f), `missing ${f}`);
  }
  const agents = read(repo, "AGENTS.md");
  assert.match(agents, /\| `api` \| `apps\/api` \| api \| dotnet8-api \| 8080 \| `\/health` \|/);
  assert.match(agents, /\| `web` \| `apps\/web` \| frontend \| react-vite \| 8080 \| `\/` \|/);
  assert.match(agents, /\| compute \| `aca` — Azure Container Apps \|/);
  assert.match(agents, /acradlcdemo\.azurecr\.io/);
  assert.match(agents, /\| `api` \| `slipway-demo-api-ci` \| `slipway-demo-api-cd` \| `apps\/api\/version\.json` \| `api\/v<semver>` \|/, "AGENTS.md must list the per-app pipelines");
  assert.match(agents, /`\.github\/workflows\/slipway-demo-web-cd\.yml`/);
  assert.match(agents, /\/slipway:deploy <app> <tag> <env>/); assert.match(agents, /\/slipway:verify <app> <env> <tag>/);
  assert.doesNotMatch(agents, /<%/, "unrendered placeholder left in AGENTS.md");
  assert.match(read(repo, "CLAUDE.md"), /^@AGENTS\.md/); assert.match(read(repo, "CLAUDE.md"), /infra\/apps\/<app>/);
  const settings = JSON.parse(read(repo, ".claude/settings.json"));
  assert.deepEqual(settings.extraKnownMarketplaces["slipway-marketplace"].source, { source: "github", repo: "integranz/slipway" });
  assert.equal(settings.enabledPlugins["slipway@slipway-marketplace"], true);
  for (const rule of ["terraform", "pipelines", "docker", "versioning", "branching"]) {
    const txt = read(repo, `.claude/rules/${rule}.md`);
    const fm = txt.match(/^---\n([\s\S]*?)\n---\n/); assert.ok(fm, `${rule}.md has no frontmatter`);
    assert.ok(Array.isArray(yaml.load(fm[1]).paths), `${rule}.md paths: is not a list`);
    assert.doesNotMatch(txt, /<%/, `unrendered placeholder in ${rule}.md`);
  }
  const versioning = read(repo, ".claude/rules/versioning.md");
  assert.match(versioning, /Every app has its own `<app path>\/version\.json`/); assert.match(versioning, /"\*\*\/version\.json"/); assert.doesNotMatch(versioning, /Conventional Commits/);
  const pipelines = read(repo, ".claude/rules/pipelines.md");
  assert.match(pipelines, /`slipway-demo-<app>-ci` and `slipway-demo-<app>-cd`/); assert.match(pipelines, /changes` job decides/); assert.match(pipelines, /CD starts automatically/);
  assert.match(read(repo, ".claude/rules/terraform.md"), /infra\/apps\/<app>/); assert.match(read(repo, ".claude/rules/terraform.md"), /Container Apps environment/);
  assert.match(read(repo, ".claude/rules/branching.md"), /trunk-based/);
  const setup = read(repo, ".slipway/SETUP.md");
  for (const n of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME", "/slipway:launch",
                   "setup-azure.sh --apply --set-github-secrets", "integranz/slipway-demo", "rg-adlc-demo-dev", "acradlcdemo", "kv-adlc-demo-dev",
                   "`api changes`, `api ci`, `web changes`, `web ci`", "you can give in the session", ".slipway/.env"]) {
    assert.ok(setup.includes(n), `SETUP.md missing ${n}`);
  }
  const seed = read(repo, ".slipway/.env.example");
  assert.match(seed, /^DOCKERHUB_USERNAME=$/m); assert.match(seed, /^DOCKERHUB_TOKEN=$/m); assert.doesNotMatch(seed, /<%/);
  assert.match(read(repo, "CLAUDE.md"), /seed file `\.slipway\/\.env` is only ever sourced/);
  assert.match(agents, /\/slipway:launch/);
  assert.doesNotMatch(setup, /<%/, "unrendered placeholder in SETUP.md");
  const script = read(repo, ".slipway/setup-azure.sh");
  assert.doesNotMatch(script, /<%/, "unrendered placeholder in setup-azure.sh");
  for (const n of ['RG="rg-adlc-demo-dev"', 'STATE_SA="stadlctfstate"', 'GH_OWNER="integranz"', "sp-${PROJECT}-github", "environment:${GH_ENV}", "--allow-shared-key-access false"]) assert.ok(script.includes(n), `setup-azure.sh missing ${n}`);
  assert.equal(spawnSync("bash", ["-n", path.join(repo, ".slipway", "setup-azure.sh")]).status, 0, "setup-azure.sh has a bash syntax error");
  assert.ok((fs.statSync(path.join(repo, ".slipway", "setup-azure.sh")).mode & 0o111) !== 0, "setup-azure.sh should be executable");
  const api = read(repo, "apps/api/Dockerfile"), web = read(repo, "apps/web/Dockerfile"), ng = read(repo, "apps/web/nginx.conf"), ngl = read(repo, "apps/web/nginx.local.conf");
  for (const s of [api, web, ng, ngl, read(repo, "compose.yaml")]) assert.doesNotMatch(s, /<%/, "unrendered placeholder in a stack template");
  assert.match(api, /FROM dhi\.io\/dotnet:\$\{DOTNET_VERSION\}-sdk AS build/); assert.match(api, /ARG DOTNET_VERSION=8\.0/);
  // api builds a shared library outside its path: repository-root context, dependency csproj copied before restore
  assert.match(api, /COPY apps\/api\/src\/Api\/\*\.csproj apps\/api\/src\/Api\//); assert.match(api, /COPY libs\/dotnet\/Demo\.Contracts\/\*\.csproj libs\/dotnet\/Demo\.Contracts\//);
  assert.match(api, /RUN dotnet restore apps\/api\/src\/Api\/Api\.csproj/); assert.match(api, /COPY apps\/api apps\/api\nCOPY libs\/dotnet\/Demo\.Contracts libs\/dotnet\/Demo\.Contracts/);
  assert.match(api, /-f apps\/api\/Dockerfile \./); assert.match(api, /ENTRYPOINT \["dotnet", "Api\.dll"\]/); assert.match(api, /USER 65532/);
  assert.match(api, /org\.opencontainers\.image\.source="https:\/\/github\.com\/integranz\/slipway-demo"/);
  const dfi = read(repo, "apps/api/Dockerfile.dockerignore"); assert.match(dfi, /^\.git$/m); assert.match(dfi, /^infra$/m); assert.match(dfi, /^apps\/api\/tests\/$/m);
  assert.match(web, /FROM dhi\.io\/node:\$\{NODE_VERSION\}-dev AS build/); assert.match(web, /FROM dhi\.io\/nginx:\$\{NGINX_VERSION\} AS runtime/); assert.match(web, /VITE_APP_VERSION=\$\{VERSION\}/);
  assert.match(ng, /location \/api\/ \{[\s\S]*proxy_pass\s+http:\/\/api;/, "cloud nginx must proxy to http://api (Container Apps app name, port 80)");
  assert.match(ngl, /proxy_pass\s+http:\/\/api:8080;/, "local nginx must proxy to the api container port");
  assert.doesNotMatch(ng, /proxy_set_header\s+Host/, "Host must stay $proxy_host for Container Apps routing");
  assert.ok(exists(repo, "apps/api/.dockerignore") && exists(repo, "apps/web/.dockerignore"));
  const compose = read(repo, "compose.yaml"); assert.match(compose, /"8080:8080"/); assert.match(compose, /"8081:8080"/); assert.match(compose, /nginx\.local\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/);
  assert.match(compose, /context: \.\n\s+dockerfile: apps\/api\/Dockerfile/); assert.match(compose, /context: apps\/web\n\s+dockerfile: Dockerfile/);
});

test("an app without inputs outside its path builds from its own directory", () => {
  const repo = mkRepo(c => { delete c.apps[0].paths; }, { withLib: false });
  const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  const api = read(repo, "apps/api/Dockerfile");
  assert.match(api, /COPY src\/Api\/\*\.csproj src\/Api\//); assert.match(api, /RUN dotnet restore src\/Api\/Api\.csproj/); assert.match(api, /\nCOPY \. \.\n/); assert.match(api, /-f apps\/api\/Dockerfile apps\/api/);
  assert.doesNotMatch(api, /libs\//); assert.doesNotMatch(api, /context is the repository root/); assert.ok(!exists(repo, "apps/api/Dockerfile.dockerignore") || !/^infra$/m.test(read(repo, "apps/api/Dockerfile.dockerignore")), "no root-context ignore rules when the context is the app path");
  assert.match(read(repo, "compose.yaml"), /context: apps\/api\n\s+dockerfile: Dockerfile/);
  const ci = yaml.load(read(repo, ".github/workflows/slipway-demo-api-ci.yml"));
  assert.deepEqual(ci.on.push.paths, ["apps/api/**", ".github/workflows/slipway-demo-api-ci.yml", ".github/workflows/slipway-demo-api-cd.yml", ".github/workflows/_ci.yml", ".github/workflows/_cd.yml", "infra/apps/api/**"]);
  assert.equal(ci.jobs.ci.with.context, "apps/api");
});

test("a .NET ProjectReference outside the app is detected and becomes a build input even when `paths` is not declared", () => {
  const repo = mkRepo(c => { delete c.apps[0].paths; }); // csproj references libs/dotnet/Demo.Contracts
  const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(read(repo, "apps/api/version.json"));
  assert.ok(v.pathFilters.includes("/libs/dotnet/Demo.Contracts"), `pathFilters: ${v.pathFilters}`);
  assert.match(read(repo, "apps/api/Dockerfile"), /COPY libs\/dotnet\/Demo\.Contracts\/\*\.csproj/);
  assert.ok(yaml.load(read(repo, ".github/workflows/slipway-demo-api-ci.yml")).on.push.paths.includes("libs/dotnet/Demo.Contracts/**"));
});

test("re-run skips existing files; --force replaces; .gitignore merges; version.json keeps its version", () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ncustom-thing/\n");
  let r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /merge\s+\.gitignore/);
  const gi = read(repo, ".gitignore");
  assert.match(gi, /custom-thing\//); assert.match(gi, /\.slipway\/approvals\//); assert.equal(gi.match(/node_modules\//g).length, 1);
  r = run(["--repo", repo], repo); assert.equal(r.status, 0);
  assert.match(r.stdout, /skip\s+AGENTS\.md \(exists/); assert.match(r.stdout, /0 written/); assert.match(r.stdout, /ok\s+apps\/api\/version\.json \(already complete\)/);
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "stale");
  const v = JSON.parse(read(repo, "apps/api/version.json")); v.version = "0.7"; v.pathFilters = ["/stale"]; v.custom = true; fs.writeFileSync(path.join(repo, "apps/api/version.json"), JSON.stringify(v, null, 2));
  r = run(["--repo", repo, "--force"], repo); assert.equal(r.status, 0);
  assert.match(r.stdout, /replace AGENTS\.md/); assert.match(read(repo, "AGENTS.md"), /start here \(adlc-demo\)/);
  assert.match(read(repo, ".gitignore"), /custom-thing\//, "--force must not drop the repo's own .gitignore rules");
  assert.match(r.stdout, /ok\s+\.gitignore \(already complete\)/);
  assert.match(r.stdout, /merge\s+apps\/api\/version\.json \(pathFilters\/tagName refreshed; version 0\.7 kept\)/);
  const after = JSON.parse(read(repo, "apps/api/version.json"));
  assert.equal(after.version, "0.7", "--force must never rewrite the human-owned version"); assert.equal(after.custom, true);
  assert.ok(after.pathFilters.includes("/apps/api")); assert.equal(after.release.tagName, "api/v{version}");
});

test("--dry-run writes nothing", () => {
  const repo = mkRepo();
  const r = run(["--repo", repo, "--dry-run"], repo); assert.equal(r.status, 0);
  assert.ok(!exists(repo, "AGENTS.md")); assert.ok(!exists(repo, "apps/api/version.json"));
  assert.match(r.stdout, /dry run/);
});

test("planned or later options are rejected before anything is written", () => {
  for (const [mutate, msg] of [
    [c => { c.options.compute = "aci"; }, /compute=aci is 'planned'/],
    [c => { c.options.branching = "gitflow"; }, /branching=gitflow is 'planned'/],
    [c => { c.options.cloud = "aws"; }, /cloud=aws is 'later'/],
    [c => { c.apps[0].stack = "node-ts-api"; }, /stack=node-ts-api is 'planned'/],
    [c => { c.apps[1].upstreams = ["nope"]; }, /'nope' is not an app/],
    [c => { c.apps[0].kind = "frontend"; }, /supports kinds \[api, worker\]/],
    [c => { c.options.versioning = "semantic-release"; }, /semantic-release with several apps is 'planned'/],
    [c => { c.apps[1].paths = ["packages/ui"]; }, /implemented for dotnet8-api only/],
    [c => { c.options.cd_trigger = "nightly"; }, /cd_trigger/],
    [c => { c.apps[1].path = "apps/api/web"; }, /app paths must be disjoint/],
  ]) {
    const repo = mkRepo(mutate);
    const r = run(["--repo", repo], repo);
    assert.equal(r.status, 1, `expected rejection: ${msg}`); assert.match(r.stderr, msg);
    assert.ok(!exists(repo, "AGENTS.md"), "must not write a partial scaffold");
    const v = validate(path.join(repo, ".slipway", "config.yaml")); assert.equal(v.status, 1); assert.match(v.stderr, msg);
  }
});

test("optional dimensions default to manual CD and path-filtered PR checks", () => {
  const repo = mkRepo(c => { delete c.options.cd_trigger; delete c.options.pr_checks; delete c.options.cd_approval; });
  const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  assert.match(read(repo, ".slipway/SETUP.md"), /on the workflow run page/, "default cd_approval is github-ui");
  const ci = yaml.load(read(repo, ".github/workflows/slipway-demo-web-ci.yml")), cd = yaml.load(read(repo, ".github/workflows/slipway-demo-web-cd.yml"));
  assert.deepEqual(Object.keys(ci.jobs), ["ci", "result"], "no gate job in path-filtered mode"); assert.deepEqual(ci.jobs.result.needs, ["ci"]); assert.ok(Array.isArray(ci.on.pull_request.paths), "pull_request must be path-filtered");
  assert.equal(cd.on.workflow_run, undefined, "manual CD has no workflow_run trigger");
  assert.match(read(repo, ".claude/rules/pipelines.md"), /do \*\*not\*\* require per-app checks/);
  assert.match(read(repo, ".claude/rules/pipelines.md"), /CD is started only by/);
});

test("foundation layer renders (with the Container Apps environment) and passes terraform fmt/validate", () => {
  const repo = mkRepo();
  const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  const dir = path.join(repo, "infra", "foundation");
  for (const f of ["versions.tf", "providers.tf", "locals.tf", "main.tf", "outputs.tf", "cae.tf", "README.md"]) assert.ok(fs.existsSync(path.join(dir, f)), `missing infra/foundation/${f}`);
  const versions = read(repo, "infra/foundation/versions.tf"), locals = read(repo, "infra/foundation/locals.tf"), cae = read(repo, "infra/foundation/cae.tf");
  assert.doesNotMatch(versions + locals + cae, /<%/);
  assert.match(versions, /key\s+= "adlc-demo\/foundation\/dev\.tfstate"/); assert.match(versions, /storage_account_name = "stadlctfstate"/); assert.match(versions, /use_azuread_auth\s+= true/);
  assert.match(locals, /acr_name\s+= "acradlcdemo"/); assert.match(locals, /key_vault_name\s+= "kv-adlc-demo-dev"/); assert.match(locals, /cicd_principal_name\s+= "sp-adlc-demo-github"/);
  assert.match(cae, /resource "azurerm_container_app_environment" "this"/); assert.match(cae, /name\s+= "cae-adlc-demo-dev"/); assert.match(cae, /azurerm_log_analytics_workspace\.this\.id/);
  assert.match(read(repo, "infra/foundation/README.md"), /Container Apps environment/);
  tfCheck(dir);
});

test("one root module per app (compute=aca) renders and passes terraform fmt/validate", () => {
  const repo = mkRepo(c => { c.apps[0].secrets = [{ name: "db-password", env: "DB_PASSWORD" }]; c.apps[0].env = { ASPNETCORE_ENVIRONMENT: "Production" }; });
  const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  assert.ok(!exists(repo, "infra/app"), "the combined app layer must not be rendered any more");
  for (const app of ["api", "web"]) {
    const dir = path.join(repo, "infra", "apps", app);
    for (const f of ["versions.tf", "providers.tf", "variables.tf", "locals.tf", "data.tf", "main.tf", "outputs.tf", "README.md"]) assert.ok(fs.existsSync(path.join(dir, f)), `missing infra/apps/${app}/${f}`);
    const main = read(repo, `infra/apps/${app}/main.tf`), out = read(repo, `infra/apps/${app}/outputs.tf`), versions = read(repo, `infra/apps/${app}/versions.tf`);
    assert.doesNotMatch(main + out + versions + read(repo, `infra/apps/${app}/locals.tf`), /<%/);
    assert.match(main, /resource "azurerm_container_app" "this"/); assert.match(main, new RegExp(`name\\s+= "${app}"`), "container app must be named after the app");
    assert.doesNotMatch(main, /azurerm_container_app_environment" "this" \{\n\s+name/, "the environment is created in foundation, not per app");
    assert.match(read(repo, `infra/apps/${app}/data.tf`), /data "azurerm_container_app_environment" "this"/);
    assert.doesNotMatch(main, /depends_on/, "no cross-app dependency: apps live in separate root modules");
    assert.match(versions, new RegExp(`key\\s+= "adlc-demo/apps/${app}/dev\\.tfstate"`)); assert.match(out, /output "url"/); assert.match(out, /output "health_url"/); assert.match(out, /output "image_tag"/);
    tfCheck(dir);
  }
  const api = read(repo, "infra/apps/api/main.tf");
  assert.match(api, /key_vault_secret_id = "\$\{data\.azurerm_key_vault\.this\.vault_uri\}secrets\/db-password"/);
  assert.match(api, /secret_name = "db-password"/); assert.match(api, /name\s+= "ASPNETCORE_ENVIRONMENT"/); assert.match(api, /path\s+= "\/health"/);
  assert.match(read(repo, "infra/apps/api/README.md"), /\/slipway:deploy api <tag> dev/);
});

test("per-app CI workflows: thin callers with path filters, gate job, shared _ci.yml for nbgv and semantic-release", () => {
  for (const [versioning, mutate, must, mustNot] of [
    ["nbgv", null, ["dotnet/nbgv@v0.5.2", "path: ${{ inputs.app_path }}", "nbgv tag -p \"${{ inputs.app_path }}\"", "SemVer2", "git ls-remote --exit-code --tags"], ["semantic-release"]],
    ["semantic-release", c => { c.options.versioning = "semantic-release"; c.apps = [c.apps[1]]; delete c.apps[0].upstreams; }, ["npx semantic-release --dry-run", "npx semantic-release"], ["dotnet/nbgv"]],
  ]) {
    const repo = mkRepo(mutate);
    const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
    const ci = read(repo, ".github/workflows/_ci.yml"); assert.doesNotMatch(ci, /<%/, "unrendered placeholder in _ci.yml");
    const doc = yaml.load(ci); assert.equal(doc.name, "_ci"); assert.ok(doc.on.workflow_call, "_ci.yml must be reusable");
    assert.deepEqual(Object.keys(doc.jobs), ["version", "test", "image", "release"]);
    for (const s of must) assert.ok(ci.includes(s), `${versioning}: _ci.yml missing ${s}`);
    for (const s of mustNot) assert.ok(!ci.includes(s), `${versioning}: _ci.yml must not contain ${s}`);
    for (const s of ["registry: dhi.io", "azure/login@v3", "az acr login --name acradlcdemo", "provenance: false", "acradlcdemo.azurecr.io", "Refuse to overwrite an existing tag", "${{ inputs.image_repository }}", "file: ${{ inputs.dockerfile }}", "release-manifest-${{ inputs.app }}-"]) assert.ok(ci.includes(s), `_ci.yml missing ${s}`);
    assert.doesNotMatch(ci, /:latest/, "no mutable tags in _ci.yml");
    // per-app callers
    const web = yaml.load(read(repo, ".github/workflows/slipway-demo-web-ci.yml"));
    assert.equal(web.name, "slipway-demo-web-ci"); assert.deepEqual(Object.keys(web.jobs), ["changes", "ci", "result"]);
    assert.equal(web.jobs.result.name, "web ci"); assert.equal(web.jobs.result.if, "always()"); assert.deepEqual(web.jobs.result.needs, ["changes", "ci"]);
    assert.equal(web.jobs.changes.name, "web changes"); assert.equal(web.jobs.ci.name, "web", "check names must be unique per app (web / test, web / image)");
    assert.equal(web.jobs.ci.uses, "./.github/workflows/_ci.yml"); assert.equal(web.jobs.ci.secrets, "inherit"); assert.equal(web.jobs.ci.if, "needs.changes.outputs.run == 'true'");
    assert.deepEqual(web.jobs.ci.with, { app: "web", app_path: "apps/web", context: "apps/web", dockerfile: "apps/web/Dockerfile", image_repository: "adlc-demo/web", test_command: "npm --prefix apps/web test", is_dotnet: false, is_node: true, tag_prefix: "web/v" });
    assert.equal(web.on.pull_request.paths, undefined, "gate mode: pull requests are not path-filtered");
    assert.deepEqual(web.on.push.paths, ["apps/web/**", ".github/workflows/slipway-demo-web-ci.yml", ".github/workflows/slipway-demo-web-cd.yml", ".github/workflows/_ci.yml", ".github/workflows/_cd.yml", "infra/apps/web/**"]);
    const gatePaths = web.jobs.changes.steps[0].env.APP_PATHS.trim().split("\n").map(s => s.trim());
    assert.deepEqual(gatePaths, web.on.push.paths.map(p => p.replace(/\/\*\*$/, "")), "gate paths must equal the push trigger paths");
    if (versioning === "nbgv") assert.deepEqual(gatePaths, JSON.parse(read(repo, "apps/web/version.json")).pathFilters.map(p => p.replace(/^\//, "")), "gate paths must equal version.json pathFilters");
    else assert.ok(!exists(repo, "apps/web/version.json"), "semantic-release renders no version.json");
    if (versioning === "nbgv") {
      const api = yaml.load(read(repo, ".github/workflows/slipway-demo-api-ci.yml"));
      assert.equal(api.jobs.ci.with.context, "."); assert.equal(api.jobs.ci.with.dockerfile, "apps/api/Dockerfile"); assert.equal(api.jobs.ci.with.is_dotnet, true);
      assert.ok(api.on.push.paths.includes("libs/dotnet/Demo.Contracts/**")); assert.ok(api.on.push.paths.includes(".dockerignore"));
      const v = JSON.parse(read(repo, "apps/api/version.json"));
      assert.equal(v.version, "0.2"); assert.equal(v.release.tagName, "api/v{version}"); assert.deepEqual(v.publicReleaseRefSpec, ["^refs/heads/main$"]);
      assert.deepEqual(v.pathFilters, api.on.push.paths.map(p => "/" + p.replace(/\/\*\*$/, "")), "version.json pathFilters must equal the CI trigger paths");
    }
    if (spawnSync("actionlint", ["--version"]).status === 0) { const al = spawnSync("actionlint", fs.readdirSync(path.join(repo, ".github/workflows")).map(f => path.join(repo, ".github/workflows", f)), { encoding: "utf8" }); assert.equal(al.status, 0, al.stdout + al.stderr); }
  }
});

test("per-app CD workflows: resolve + shared _cd.yml, workflow_run only with on-ci-success", () => {
  const repo = mkRepo(); const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  const cd = read(repo, ".github/workflows/_cd.yml"); assert.doesNotMatch(cd, /<%/);
  const doc = yaml.load(cd); assert.ok(doc.on.workflow_call); assert.deepEqual(Object.keys(doc.jobs), ["plan", "apply"]);
  assert.equal(doc.jobs.apply.environment.name, "${{ inputs.environment }}"); assert.deepEqual(doc.jobs.apply.needs, "plan");
  for (const s of ["az acr repository show -n acradlcdemo --image \"${{ inputs.image_repository }}:$IMAGE_TAG\"", "terraform plan -input=false -no-color -var \"image_tag=$IMAGE_TAG\" -out=tfplan", "terraform apply -input=false -no-color tfplan", "ARM_USE_OIDC", "ARM_USE_AZUREAD", "deploy-evidence-${{ inputs.app }}-${{ inputs.environment }}-${{ inputs.tag }}", "working-directory: ${{ inputs.infra_dir }}", "previous revision still serving", "expected version {tag} within 240s"]) assert.ok(cd.includes(s), `_cd.yml missing ${s}`);
  assert.doesNotMatch(cd, /-auto-approve/);
  const api = yaml.load(read(repo, ".github/workflows/slipway-demo-api-cd.yml"));
  assert.equal(api.name, "slipway-demo-api-cd"); assert.deepEqual(Object.keys(api.jobs), ["resolve", "cd"]); assert.equal(api.jobs.cd.name, "api"); assert.equal(api.jobs.resolve.name, "api resolve");
  assert.deepEqual(api.on.workflow_run, { workflows: ["slipway-demo-api-ci"], types: ["completed"], branches: ["main"] });
  assert.deepEqual(api.on.workflow_dispatch.inputs.environment.options, ["dev"]);
  assert.equal(api.jobs.cd.uses, "./.github/workflows/_cd.yml"); assert.equal(api.jobs.cd.with.infra_dir, "infra/apps/api"); assert.equal(api.jobs.cd.with.tag, "${{ needs.resolve.outputs.tag }}");
  assert.ok(read(repo, ".github/workflows/slipway-demo-api-cd.yml").includes("pattern: release-manifest-api-*"), "auto CD must read the tag from the CI run's manifest");
});

test("--app renders only that app's files (stack, workflows, infra, version.json)", () => {
  const repo = mkRepo();
  const r = run(["--repo", repo, "--app", "web"], repo); assert.equal(r.status, 0, r.stderr);
  for (const f of ["apps/web/Dockerfile", "apps/web/version.json", ".github/workflows/slipway-demo-web-ci.yml", ".github/workflows/slipway-demo-web-cd.yml", "infra/apps/web/main.tf"]) assert.ok(exists(repo, f), `missing ${f}`);
  for (const f of ["apps/api/Dockerfile", "apps/api/version.json", ".github/workflows/slipway-demo-api-ci.yml", "infra/apps/api/main.tf", "AGENTS.md", ".github/workflows/_ci.yml"]) assert.ok(!exists(repo, f), `${f} must not be rendered for --app web`);
  const bad = run(["--repo", repo, "--app", "nope"], repo); assert.equal(bad.status, 1); assert.match(bad.stderr, /no such app/);
});

test("legacy combined-layout files are reported, never deleted", () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, ".github/workflows"), { recursive: true }); fs.writeFileSync(path.join(repo, ".github/workflows/ci.yml"), "name: ci\n");
  fs.mkdirSync(path.join(repo, "infra/app"), { recursive: true }); fs.writeFileSync(path.join(repo, "version.json"), "{}");
  const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /legacy\s+\.github\/workflows\/ci\.yml, infra\/app, version\.json/);
  assert.ok(exists(repo, ".github/workflows/ci.yml") && exists(repo, "version.json"));
});

test("dotnet app without a detectable csproj fails before writing", () => {
  const repo = mkRepo(); fs.rmSync(path.join(repo, "apps/api/src"), { recursive: true });
  const r = run(["--repo", repo], repo); assert.equal(r.status, 1); assert.match(r.stderr, /no \.csproj found under apps\/api/);
  assert.ok(!exists(repo, "AGENTS.md"));
});

test("semantic-release option (single app) renders its versioning rule", () => {
  const repo = mkRepo(c => { c.options.versioning = "semantic-release"; c.apps = [c.apps[1]]; delete c.apps[0].upstreams; });
  const r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  const v = read(repo, ".claude/rules/versioning.md");
  assert.match(v, /Conventional Commits/); assert.doesNotMatch(v, /version\.json/); assert.ok(!exists(repo, "apps/web/version.json"));
});

test("tracker none disables tracking; story and epic keys render into AGENTS.md; malformed keys are rejected", () => {
  let repo = mkRepo(c => { c.options.tracker = "none"; delete c.jira; });
  let r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  assert.match(read(repo, "AGENTS.md"), /tracker: No tracker/); assert.match(read(repo, "CLAUDE.md"), /Tracking never blocks delivery/);
  assert.match(read(repo, ".gitignore"), /\.slipway\/tracking-queue\.jsonl/);
  repo = mkRepo(c => { c.jira.story_key = "DEVOPS-12"; c.jira.epic_key = "DEVOPS-1"; });
  r = run(["--repo", repo], repo); assert.equal(r.status, 0, r.stderr);
  assert.match(read(repo, "AGENTS.md"), /story `DEVOPS-12`, epic `DEVOPS-1`/);
  repo = mkRepo(c => { c.jira.story_key = "devops-12"; });
  r = run(["--repo", repo], repo); assert.equal(r.status, 1); assert.match(r.stderr, /story_key/);
});

test("validate-config reports OK for the example", () => {
  const v = validate(EXAMPLE); assert.equal(v.status, 0, v.stderr); assert.match(v.stdout, /valid \(2 app\(s\)/);
});
