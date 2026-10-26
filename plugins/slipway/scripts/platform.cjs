#!/usr/bin/env node
// Renders the slipway platform repository: the organisation's one cloud foundation (infra/foundation), the HUMAN-ONLY
// setup-platform.sh (resource groups, state storage, the CI/CD managed identity with flexible federated credentials,
// roles, organisation secrets), the organisation template for the onboarding poller (org-defaults.yaml) and a README.
// Repositories then join it with options.platform_scope: shared (see skills/delivery-knowledge/references/platform-shared.md).
// usage: node platform.cjs render --config platform.yaml --out <dir> [--force]
//        node platform.cjs example                 # prints templates/platform/platform.example.yaml
"use strict";
const fs = require("node:fs"), path = require("node:path");
const yaml = require("./lib/js-yaml.min.js");
const { render } = require("./lib/render.cjs");
const { PLUGIN_ROOT } = require("./lib/config.cjs");

const T = path.join(PLUGIN_ROOT, "templates", "platform");
const args = process.argv.slice(2); const cmd = args[0];
const flag = (n) => args.includes(n); const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

function fail(msg) { console.error(`platform: ${msg}`); process.exit(1); }
function check(cfg) {
  const errors = [];
  const need = (p, re, hint) => { const v = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), cfg); if (v === undefined || v === null || v === "") errors.push(`${p} is required${hint ? ` (${hint})` : ""}`); else if (re && !re.test(String(v))) errors.push(`${p}='${v}' ${hint || "has an invalid format"}`); };
  need("name", /^[a-z][a-z0-9-]{1,20}$/, "lowercase letters, digits, hyphens; used in resource names");
  need("environment", /^[a-z][a-z0-9-]{1,15}$/); need("location", /^[a-z0-9]+$/);
  need("github.org", /^[A-Za-z0-9-]+$/); need("github.org_id", /^[0-9]+$/, "the organisation's numeric id: gh api orgs/<org> --jq .id"); need("github.default_branch", /^[A-Za-z0-9_./-]+$/);
  need("azure.resource_group", /^[-\w.()]{1,90}$/); need("azure.registry.name", /^[a-zA-Z0-9]{5,50}$/); need("azure.key_vault_name", /^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/);
  need("azure.container_app_environment", /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/); need("azure.log_analytics_name", /^[A-Za-z0-9][A-Za-z0-9-]{2,61}[A-Za-z0-9]$/); need("azure.cicd_identity_name", /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
  need("azure.state.resource_group", /^[-\w.()]{1,90}$/); need("azure.state.storage_account", /^[a-z0-9]{3,24}$/); need("azure.state.container", /^[a-z0-9-]{3,63}$/);
  if (cfg.azure && cfg.azure.registry && typeof cfg.azure.registry.existing !== "boolean") errors.push("azure.registry.existing must be true or false");
  if (cfg.jira) { need("jira.site_url", /^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/); need("jira.project_key", /^[A-Z][A-Z0-9]{1,9}$/); if (!["rest", "both"].includes(cfg.jira.tracker_transport)) errors.push("jira.tracker_transport must be rest or both (the generated workflows need a token path)"); }
  if (/^(2e8a6e6a|b1a09054)/.test(JSON.stringify(cfg))) errors.push("platform.yaml must not contain subscription or tenant ids");
  return errors;
}
function walk(dir) { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }

if (cmd === "example") { process.stdout.write(fs.readFileSync(path.join(T, "platform.example.yaml"), "utf8")); process.exit(0); }
if (cmd !== "render") { console.error("usage: platform.cjs render --config platform.yaml --out <dir> [--force] | example"); process.exit(2); }
const cfgPath = path.resolve(val("--config", "platform.yaml")); const out = path.resolve(val("--out", "."));
if (!fs.existsSync(cfgPath)) fail(`${cfgPath} not found (start from: node platform.cjs example > platform.yaml)`);
const cfg = yaml.load(fs.readFileSync(cfgPath, "utf8")) || {};
const errors = check(cfg); if (errors.length) { console.error("platform.yaml invalid:"); errors.forEach((e) => console.error(`  - ${e}`)); process.exit(1); }
const ctx = { ...cfg, derived: { apps_identity_name: `id-${cfg.name}-apps-${cfg.environment}`, state_key: `${cfg.name}/platform/${cfg.environment}.tfstate` } };
const src = path.join(T, "files"); const rendered = [];
for (const file of walk(src)) {
  const rel = path.relative(src, file); const dest = path.join(out, rel.endsWith(".tmpl") ? rel.slice(0, -5) : rel);
  let content = fs.readFileSync(file, "utf8");
  if (rel.endsWith(".tmpl")) { try { content = render(content, ctx); } catch (e) { fail(`template error in ${rel}: ${e.message}`); } if (/<%/.test(content)) fail(`template error in ${rel}: unrendered '<%' left in output`); }
  rendered.push({ dest, rel: path.relative(out, dest), content });
}
let written = 0, skipped = 0;
for (const r of rendered) {
  if (fs.existsSync(r.dest) && !flag("--force")) { console.log(`  skip    ${r.rel} (exists; use --force to overwrite)`); skipped++; continue; }
  fs.mkdirSync(path.dirname(r.dest), { recursive: true }); fs.writeFileSync(r.dest, r.content); if (/\.sh$/.test(r.dest)) fs.chmodSync(r.dest, 0o755);
  console.log(`  write   ${r.rel}`); written++;
}
fs.copyFileSync(cfgPath, path.join(out, "platform.yaml")); // the input travels with the output so re-rendering is one command
console.log(`platform ${cfg.name}/${cfg.environment} -> ${out}: ${written} written, ${skipped} skipped. Next: read README.md, then bash setup-platform.sh`);
