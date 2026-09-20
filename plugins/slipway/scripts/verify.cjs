#!/usr/bin/env node
// Deterministic post-deployment verification for ONE app (cloud=azure, compute=aca, runner=github-actions).
// usage: node verify.cjs <app> <env> <tag> [--repo <dir>] [--json] [--evidence <path>] [--no-write]
// Every claim is a literal comparison with the command that produced the evidence. Exit 0 = all CONFIRMED,
// 2 = at least one REFUTED, 3 = only UNVERIFIABLE issues. Nothing here mutates anything.
"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const { loadConfig, derive } = require("./lib/config.cjs");
const yaml = require("./lib/js-yaml.min.js");

const USAGE = "usage: verify.cjs <app> <env> <tag> [--repo <dir>] [--json] [--evidence <path>] [--no-write]";
const args = process.argv.slice(2); const flag = n => args.includes(n); const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--repo", "--evidence"].includes(args[i - 1])));
const [appName, env, tag] = positional;
if (!appName || !env || !tag) { console.error(USAGE); process.exit(1); }
const repo = path.resolve(val("--repo", "."));
const { config, options, errors } = loadConfig(path.join(repo, ".slipway", "config.yaml"));
if (errors.length) { console.error("config invalid:\n  " + errors.join("\n  ")); process.exit(1); }
if (!config.apps.some(a => a.name === appName)) { console.error(`app '${appName}' is not in .slipway/config.yaml (apps: ${config.apps.map(a => a.name).join(", ")})`); process.exit(1); }
if (!config.environments.includes(env)) { console.error(`environment '${env}' is not in .slipway/config.yaml`); process.exit(1); }
if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(tag)) { console.error(`'${tag}' is not a semver tag`); process.exit(1); }
const derived = derive(config, options, repo);
const app = derived.apps.find(a => a.name === appName);

const claims = [];
const record = (claim, verdict, evidence) => claims.push({ claim, verdict, evidence: String(evidence).replace(/\s+/g, " ").trim().slice(0, 400) });
const sh = (cmd, cmdArgs, opts = {}) => { const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", timeout: opts.timeout || 120000, cwd: opts.cwd || repo, env: { ...process.env, ...(opts.env || {}) } }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status }; };
const have = cmd => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;
async function http(url, { timeout = 20000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try { const r = await fetch(url, { redirect: "manual", signal: ctl.signal }); const body = await r.text(); return { status: r.status, body, location: r.headers.get("location") }; }
  catch (e) { return { status: 0, body: String(e), location: null }; } finally { clearTimeout(t); }
}
const tf = (dir, tfArgs, timeout) => sh("terraform", [`-chdir=${dir}`, ...tfArgs], { timeout: timeout || 240000, env: { TF_IN_AUTOMATION: "1" } });

(async () => {
  const owner = config.github?.owner, repoName = config.github?.repo, ghRepo = `${owner}/${repoName}`;
  const acr = config.azure?.acr_name, rg = config.azure?.resource_group;
  const artifact = `deploy-evidence-${app.name}-${env}-${tag}`;
  // ---- 1. CD run and evidence artifact ----
  let outputs = null, runId = null;
  if (have("gh")) {
    const a = sh("gh", ["api", `repos/${ghRepo}/actions/artifacts?name=${artifact}&per_page=5`, "--jq", ".artifacts | sort_by(.created_at) | last | \"\\(.workflow_run.id) \\(.name) \\(.created_at)\""]);
    if (a.ok && a.out && !a.out.startsWith("null")) {
      runId = a.out.split(" ")[0];
      const run = sh("gh", ["run", "view", "-R", ghRepo, runId, "--json", "conclusion,workflowName,jobs", "--jq", "\"\\(.conclusion) [\\(.workflowName)] | \" + ([.jobs[] | \"\\(.name)=\\(.conclusion)\"] | join(\", \"))"]);
      record(`${app.name}: CD run for ${tag} → ${env} succeeded (${app.workflow_cd})`, run.ok && run.out.startsWith("success") && run.out.includes(`[${app.workflow_cd}]`) ? "CONFIRMED" : "REFUTED", `gh run view ${runId} → ${run.out || run.err}`);
      const ap = sh("gh", ["api", `repos/${ghRepo}/actions/runs/${runId}/approvals`, "--jq", ".[] | \"\\(.state) by \\(.user.login) for \\([.environments[].name]|join(\",\"))\""]);
      record(`Deployment was approved by a human on environment '${env}'`, ap.ok && /approved by \S+/.test(ap.out) ? "CONFIRMED" : "UNVERIFIABLE", `run approvals → ${ap.out || "(none)"}`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slipway-verify-"));
      const dl = sh("gh", ["run", "download", "-R", ghRepo, runId, "-n", artifact, "-D", tmp]);
      if (dl.ok && fs.existsSync(path.join(tmp, "outputs.json"))) { outputs = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(tmp, "outputs.json"), "utf8"))).map(([k, v]) => [k, v.value])); record("Deploy evidence artifact present with Terraform outputs", "CONFIRMED", `artifact ${artifact}: ${Object.keys(outputs).length} outputs`); }
      else record("Deploy evidence artifact present with Terraform outputs", "REFUTED", dl.err || dl.out);
    } else record(`${app.name}: CD run for ${tag} → ${env} exists (artifact ${artifact})`, "REFUTED", a.err || `no artifact ${artifact} in ${ghRepo}`);
    const ref = sh("gh", ["api", `repos/${ghRepo}/git/ref/tags/${app.tag_prefix}${tag}`, "--jq", ".object.sha"]);
    record(`Git tag ${app.tag_prefix}${tag} exists`, ref.ok && /^[0-9a-f]{40}$/.test(ref.out) ? "CONFIRMED" : "REFUTED", ref.ok ? `refs/tags/${app.tag_prefix}${tag} → ${ref.out.slice(0, 12)}` : (ref.err.split("\n")[0] || "not found"));
  } else record("CD run lookup", "UNVERIFIABLE", "gh CLI not available");
  if (!outputs && have("terraform") && fs.existsSync(path.join(repo, app.infra_dir))) {
    // fall back to live Terraform outputs (read-only) when the artifact is missing
    const o = tf(app.infra_dir, ["output", "-json"]);
    if (o.ok) { try { outputs = Object.fromEntries(Object.entries(JSON.parse(o.out)).map(([k, v]) => [k, v.value])); } catch { /* not JSON */ } }
  }
  if (outputs && outputs.image_tag !== undefined) record("Deployed image_tag output equals the requested tag", outputs.image_tag === tag ? "CONFIRMED" : "REFUTED", `outputs.image_tag=${outputs.image_tag}`);

  // ---- 2. HTTP checks for this app ----
  let upstreamVersions = {};
  if (app.kind !== "worker") {
    const url = outputs?.url;
    if (!url) record(`${app.name}: URL known`, "UNVERIFIABLE", "no url output");
    else {
      const health = outputs.health_url || url + (app.health_path || "/");
      const r = await http(health);
      if (r.status !== 200) record(`${app.name}: ${health} answers 200`, "REFUTED", `HTTP ${r.status} ${r.body.slice(0, 80)}`);
      else if (r.body.trim().startsWith("{")) { let v = null; try { v = JSON.parse(r.body).version; } catch { /* not JSON */ } record(`${app.name}: health reports version ${tag}`, v === tag ? "CONFIRMED" : "REFUTED", `GET ${health} → 200 version=${v}`); }
      else {
        record(`${app.name}: ${health} answers 200`, "CONFIRMED", `GET ${health} → 200`);
        const m = r.body.match(/assets\/index-[A-Za-z0-9_-]+\.js/); if (m) { const js = await http(url + "/" + m[0]); const n = (js.body.match(new RegExp(tag.replace(/\./g, "\\."), "g")) || []).length; record(`${app.name}: bundle carries version ${tag}`, n > 0 ? "CONFIRMED" : "REFUTED", `${m[0]}: ${n} occurrence(s)`); }
      }
      for (const up of app.upstreams || []) {
        // Each app has its own version: the proxied upstream must answer with the upstream's running version, not this tag.
        const upApp = config.apps.find(a => a.name === up); const upHealth = "/api" + (upApp?.health_path || "/health");
        const px = await http(url + upHealth); let v = null; try { v = JSON.parse(px.body).version; } catch { /* not JSON */ }
        upstreamVersions[up] = v;
        record(`${app.name} → ${up}: proxied ${upHealth} answers 200 with a version`, px.status === 200 && v ? "CONFIRMED" : "REFUTED", `GET ${url}${upHealth} → ${px.status} version=${v}`);
      }
      const plain = await http(url.replace(/^https:/, "http:") + (app.health_path || "/"));
      record(`${app.name}: HTTP redirects to HTTPS`, [301, 302, 307, 308].includes(plain.status) && /^https:/.test(plain.location || "") ? "CONFIRMED" : "REFUTED", `GET http → ${plain.status} ${plain.location || ""}`);
    }
  }

  // ---- 3. Azure: revision, image, registry digest (this app), upstream running versions ----
  if (have("az") && config.options.compute === "aca") {
    const revision = name => { const rev = sh("az", ["containerapp", "revision", "list", "-n", name, "-g", rg, "--query", "[?properties.active] | [0].{name:name,image:properties.template.containers[0].image,traffic:properties.trafficWeight,health:properties.healthState,running:properties.runningState}", "-o", "json"]); return rev.ok && rev.out && rev.out !== "null" ? JSON.parse(rev.out) : null; };
    const j = revision(app.name);
    if (!j) record(`${app.name}: active revision`, "UNVERIFIABLE", "no active revision found");
    else {
      const expected = `${acr}.azurecr.io/${app.image_repository}:${tag}`;
      record(`${app.name}: active revision runs ${expected}`, j.image === expected ? "CONFIRMED" : "REFUTED", `revision ${j.name} image=${j.image}`);
      record(`${app.name}: active revision Healthy/Running with 100 % traffic`, j.health === "Healthy" && j.running === "Running" && j.traffic === 100 ? "CONFIRMED" : "REFUTED", `health=${j.health} running=${j.running} traffic=${j.traffic}`);
    }
    const dig = sh("az", ["acr", "repository", "show", "-n", acr, "--image", `${app.image_repository}:${tag}`, "--query", "digest", "-o", "tsv"]);
    record(`${app.name}: registry holds ${app.image_repository}:${tag}`, dig.ok && /^sha256:/.test(dig.out) ? "CONFIRMED" : "REFUTED", dig.ok && dig.out ? `az acr repository show → digest ${dig.out.slice(0, 23)}…` : (dig.err.split("\n")[0] || "no digest returned"));
    for (const [up, v] of Object.entries(upstreamVersions)) {
      const uj = revision(up); const running = uj && uj.image ? uj.image.split(":").pop() : null;
      record(`${app.name} → ${up}: proxied version equals the upstream's running image tag`, v && running && v === running ? "CONFIRMED" : (running ? "REFUTED" : "UNVERIFIABLE"), `proxied version=${v}, ${up} active revision image tag=${running}`);
    }
  } else record("Azure revision checks", "UNVERIFIABLE", "az CLI not available or compute is not aca");

  // ---- 4. Pipeline definition: triggers, version pathFilters and config agree ----
  {
    const ciFile = path.join(repo, ".github", "workflows", `${app.workflow_ci}.yml`), vFile = path.join(repo, app.version_file);
    if (!fs.existsSync(ciFile) || !fs.existsSync(vFile)) record(`${app.name}: trigger paths and version.json pathFilters agree`, "REFUTED", `missing ${!fs.existsSync(ciFile) ? ciFile : vFile}`);
    else {
      try {
        const ci = yaml.load(fs.readFileSync(ciFile, "utf8")); const trig = (ci.on?.push?.paths || []).map(p => p.replace(/\/\*\*$/, ""));
        const filt = (JSON.parse(fs.readFileSync(vFile, "utf8")).pathFilters || []).map(p => p.replace(/^\//, ""));
        const same = JSON.stringify(trig) === JSON.stringify(filt) && JSON.stringify(trig) === JSON.stringify(app.pipeline_paths);
        record(`${app.name}: trigger paths, version.json pathFilters and .slipway/config.yaml agree`, same ? "CONFIRMED" : "REFUTED", same ? `${trig.length} paths: ${trig.join(", ")}` : `push.paths=${JSON.stringify(trig)} pathFilters=${JSON.stringify(filt)} config=${JSON.stringify(app.pipeline_paths)} (re-scaffold)`);
      } catch (e) { record(`${app.name}: trigger paths and version.json pathFilters agree`, "UNVERIFIABLE", e.message); }
    }
  }

  // ---- 5. No drift (read-only plan of this app's module) ----
  if (have("terraform") && fs.existsSync(path.join(repo, app.infra_dir))) {
    const init = tf(app.infra_dir, ["init", "-input=false", "-no-color"]);
    if (init.ok) {
      const planFile = path.join(os.tmpdir(), `slipway-verify-${process.pid}.plan`);
      const p = tf(app.infra_dir, ["plan", "-input=false", "-no-color", "-detailed-exitcode", "-lock=false", "-var", `image_tag=${tag}`, `-out=${planFile}`], 300000);
      if (p.status === 0) record(`${app.name}: ${app.infra_dir} has no drift (terraform plan -detailed-exitcode)`, "CONFIRMED", "exit 0: No changes");
      else if (p.status === 2) {
        const show = tf(app.infra_dir, ["show", "-json", planFile], 120000);
        let resChanges = null, outChanges = [];
        try { const j = JSON.parse(show.out); resChanges = (j.resource_changes || []).filter(r => r.change.actions.join("/") !== "no-op").map(r => `${r.address} (${r.change.actions.join("/")})`); outChanges = Object.entries(j.output_changes || {}).filter(([, v]) => v.actions.join("/") !== "no-op").map(([k]) => k); } catch { /* keep null */ }
        if (resChanges && resChanges.length === 0) record(`${app.name}: ${app.infra_dir} has no drift (no resource changes; outputs refresh only)`, "CONFIRMED", `plan exit 2 with 0 resource changes; outputs to refresh: ${outChanges.join(", ") || "none listed"}`);
        else record(`${app.name}: ${app.infra_dir} has no drift (terraform plan -detailed-exitcode)`, "REFUTED", resChanges ? `resource changes pending: ${resChanges.join("; ")}` : (p.out.match(/^Plan:.*$/m) || ["changes pending"])[0]);
      } else record(`${app.name}: ${app.infra_dir} has no drift`, "UNVERIFIABLE", p.err.split("\n")[0] || "plan error");
      try { fs.unlinkSync(planFile); } catch { /* already gone */ }
    } else record(`${app.name}: ${app.infra_dir} has no drift`, "UNVERIFIABLE", `terraform init failed: ${init.err.split("\n").find(l => /Error|error/.test(l)) || init.err.slice(0, 120)}`);
  }

  // ---- 6. Repo hygiene ----
  const st = sh("git", ["status", "--porcelain"]);
  const dirty = st.out.split("\n").filter(l => l.trim() && !/\s\.slipway\/evidence\//.test(l)); // the verifier's own evidence files are committed afterwards
  const DANGEROUS = /(^|\/)(\.env(\..*)?|.*\.tfstate(\..*)?|.*\.tfvars|tfplan.*|.*\.pem|.*\.key|backend\.hcl)$/;
  const dangerous = dirty.filter(l => DANGEROUS.test(l.slice(3).trim()) && !/\.example$/.test(l));
  // Unrelated uncommitted edits (a config change, a doc) do not touch the deployed artefact; only delivery-sensitive files refute.
  record("Working tree holds no uncommitted state, plan, tfvars, env or key files", st.ok && dangerous.length === 0 ? "CONFIRMED" : "REFUTED",
    dangerous.length ? dangerous.slice(0, 3).join("; ") : (dirty.length ? `no sensitive files; ${dirty.length} other uncommitted change(s) noted: ${dirty.slice(0, 3).map(l => l.trim()).join(", ")}` : "git status --porcelain → nothing outside .slipway/evidence"));
  const tracked = sh("git", ["ls-files"]); const bad = tracked.out.split("\n").filter(f => /(^|\/)(\.env(\..*)?|.*\.tfstate(\..*)?|.*\.tfvars|tfplan.*|.*\.pem|.*\.key)$/.test(f) && !/\.example$/.test(f));
  record("No state, plan, tfvars or key files are tracked in git", bad.length === 0 ? "CONFIRMED" : "REFUTED", bad.length ? bad.join(", ") : "git ls-files → none matched");

  // ---- report ----
  const counts = { CONFIRMED: 0, REFUTED: 0, UNVERIFIABLE: 0 }; for (const c of claims) counts[c.verdict]++;
  const date = new Date().toISOString().slice(0, 10);
  const md = [`# Verification: ${app.name} ${env} ${tag} (${date})`, "", runId ? `Deployment: https://github.com/${ghRepo}/actions/runs/${runId}` : "Deployment run: not found", "",
    "| # | Claim | Verdict | Evidence |", "|---|---|---|---|", ...claims.map((c, i) => `| ${i + 1} | ${c.claim} | ${c.verdict} | ${c.evidence.replace(/\|/g, "\\|")} |`), "",
    `Result: ${counts.CONFIRMED} confirmed / ${counts.REFUTED} refuted / ${counts.UNVERIFIABLE} unverifiable`,
    ...(outputs && outputs.url ? ["", `- url: ${outputs.url}`] : [])].join("\n") + "\n";
  const evidencePath = val("--evidence", path.join(repo, app.evidence_dir, `${tag}.md`));
  if (!flag("--no-write")) { fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, md); }
  if (flag("--json")) console.log(JSON.stringify({ app: app.name, env, tag, run_id: runId, counts, claims, evidence: evidencePath }, null, 2)); else { console.log(md); console.log(`evidence written: ${path.relative(repo, evidencePath)}`); }
  process.exit(counts.REFUTED ? 2 : counts.UNVERIFIABLE ? 3 : 0);
})();
