#!/usr/bin/env node
// Deterministic scaffold: renders plugin templates into a target repo according to .slipway/config.yaml.
// usage: node scaffold.cjs [--repo <dir>] [--config <path>] [--force] [--dry-run] [--app <name>]
// Layout: templates/common/files/**              -> always
//         templates/<dimension>/<option>/files/** -> when options.<dimension> == option
//         templates/common/per-app/**             -> once per app; filename tokens __app__ (<prefix>-<app>), __name__, __path__
//         templates/<dimension>/<option>/per-app/** -> once per app when the option is selected (same tokens)
//         templates/stack/<stack>/app/**          -> into each app path with that stack (context: app + root)
// A `.tmpl` suffix means "render placeholders, strip suffix"; other files are copied verbatim.
// Existing files are left untouched unless --force; .gitignore is merged line-wise; version.json keeps its `version`
// (only the generated pathFilters and release.tagName are refreshed).
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { loadConfig, derive, PLUGIN_ROOT } = require("./lib/config.cjs");
const { render } = require("./lib/render.cjs");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const repo = path.resolve(val("--repo", "."));
const configPath = path.resolve(val("--config", path.join(repo, ".slipway", "config.yaml")));
const force = flag("--force"), dry = flag("--dry-run");
const T = path.join(PLUGIN_ROOT, "templates");

const { config, options, errors } = loadConfig(configPath);
if (errors.length) { console.error(`config invalid (${configPath}):`); errors.forEach(e => console.error(`  - ${e}`)); process.exit(1); }
let derived;
try { derived = derive(config, options, repo); } catch (e) { console.error(`config error: ${e.message}\nnothing was written`); process.exit(1); }
const ctx = { ...config, derived };
const onlyApp = val("--app", null); // render only this app's files (stack + per-app sets); used by /slipway:dockerize
if (onlyApp && !derived.apps.some(a => a.name === onlyApp)) { console.error(`--app ${onlyApp}: no such app in config`); process.exit(1); }

function walk(dir) { if (!fs.existsSync(dir)) return []; const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }
const plan = []; // {src, dest, context, tmpl}
const missing = [];
function addSet(srcRoot, destRoot, context, label, tokens) {
  if (!fs.existsSync(srcRoot)) { missing.push(label); return; }
  for (const src of walk(srcRoot)) {
    let rel = path.relative(srcRoot, src);
    if (tokens) for (const [k, v] of Object.entries(tokens)) rel = rel.split(k).join(v);
    const dest = path.join(destRoot, rel.endsWith(".tmpl") ? rel.slice(0, -5) : rel);
    plan.push({ src, dest, context, tmpl: rel.endsWith(".tmpl") });
  }
}
console.log(`scaffold ${config.project.name} -> ${repo}${dry ? " (dry run)" : ""}`);
const optionSets = Object.entries(config.options);
if (!onlyApp) {
  addSet(path.join(T, "common", "files"), repo, ctx, "common");
  for (const [dim, opt] of optionSets) addSet(path.join(T, dim, opt, "files"), repo, ctx, `${dim}=${opt}`);
}
const perAppMissing = new Set();
for (const app of ctx.derived.apps) if (!onlyApp || app.name === onlyApp) {
  const appCtx = { ...ctx, app };
  const tokens = { "__app__": app.workflow_base, "__name__": app.name, "__path__": app.path };
  const before = missing.length;
  addSet(path.join(T, "common", "per-app"), repo, appCtx, "common (per app)", tokens);
  for (const [dim, opt] of optionSets) addSet(path.join(T, dim, opt, "per-app"), repo, appCtx, `${dim}=${opt} (per app)`, tokens);
  missing.splice(before).forEach(m => perAppMissing.add(m)); // per-app sets are optional per option; report once
  const stackDir = path.join(T, "stack", app.stack, "app");
  if (app.build && app.build.error) { console.error(`config error: ${app.build.error}\nnothing was written`); process.exit(1); } // also for stacks without templates (custom: missing Dockerfile)
  addSet(stackDir, path.join(repo, app.path), appCtx, `stack=${app.stack} (${app.name})`);
}
if (missing.length) console.log(`  (no repo-side templates for: ${missing.join(", ")})`);

// Phase 1: render everything in memory. Any template error aborts before a single file is written.
const rendered = [];
for (const item of plan) {
  const relDest = path.relative(repo, item.dest);
  if (relDest.startsWith("..")) { console.error(`refusing to write outside repo: ${item.dest}`); process.exit(1); }
  let content = fs.readFileSync(item.src, "utf8");
  if (item.tmpl) {
    try { content = render(content, item.context); }
    catch (e) { console.error(`template error in ${path.relative(T, item.src)}: ${e.message}\nnothing was written`); process.exit(1); }
    if (/<%/.test(content)) { console.error(`template error in ${path.relative(T, item.src)}: unrendered '<%' left in output\nnothing was written`); process.exit(1); }
  }
  rendered.push({ ...item, relDest, content });
}
// Two templates may target one file only when an app-level (stack) file shadows a common one, e.g. an app at the repository
// root whose .dockerignore replaces the common .dockerignore: the later set wins and the earlier is dropped.
const seen = new Map(); for (const r of rendered) { if (seen.has(r.relDest)) console.log(`  shadow  ${r.relDest} (app-level template replaces the common one)`); seen.set(r.relDest, r); }
rendered.splice(0, rendered.length, ...seen.values());

// Phase 2: write.
const summary = { written: 0, skipped: 0, merged: 0 };
for (const item of rendered) {
  const { relDest, content } = item;
  const exists = fs.existsSync(item.dest);
  if (exists && path.basename(item.dest) === ".gitignore") { // always merge, even with --force: never drop a repo's own ignore rules
    const have = new Set(fs.readFileSync(item.dest, "utf8").split("\n").map(l => l.trim()));
    const add = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !have.has(l.trim()));
    if (add.length) { if (!dry) fs.appendFileSync(item.dest, `\n# added by slipway\n${add.join("\n")}\n`); console.log(`  merge   ${relDest} (+${add.length} lines)`); summary.merged++; }
    else { console.log(`  ok      ${relDest} (already complete)`); summary.skipped++; }
    continue;
  }
  if (exists && path.basename(item.dest) === "version.json") { // the version is owned by humans; only generated fields are refreshed
    let have, want;
    try { have = JSON.parse(fs.readFileSync(item.dest, "utf8")); want = JSON.parse(content); }
    catch (e) { console.error(`cannot merge ${relDest}: ${e.message}`); process.exit(1); }
    const merged = { ...have };
    if (want.pathFilters) merged.pathFilters = want.pathFilters;
    if (want.release && want.release.tagName) merged.release = { ...(have.release || {}), tagName: want.release.tagName };
    if (JSON.stringify(merged) !== JSON.stringify(have)) { if (!dry) fs.writeFileSync(item.dest, JSON.stringify(merged, null, 2) + "\n"); console.log(`  merge   ${relDest} (pathFilters/tagName refreshed; version ${have.version} kept)`); summary.merged++; }
    else { console.log(`  ok      ${relDest} (already complete)`); summary.skipped++; }
    continue;
  }
  if (exists && !force) { console.log(`  skip    ${relDest} (exists; use --force to overwrite)`); summary.skipped++; continue; }
  if (!dry) { fs.mkdirSync(path.dirname(item.dest), { recursive: true }); fs.writeFileSync(item.dest, content); if (/\.(sh|cjs|mjs)$/.test(item.dest)) fs.chmodSync(item.dest, 0o755); }
  console.log(`  ${exists ? "replace" : "write  "} ${relDest}`); summary.written++;
}
if (!dry) fs.mkdirSync(path.join(repo, ".slipway", "evidence"), { recursive: true });
console.log(`done: ${summary.written} written, ${summary.merged} merged, ${summary.skipped} skipped`);

// Files from the combined-pipeline layout (before one CI/CD per app) are never deleted by the scaffold; point at them.
if (!onlyApp) {
  const legacy = [".github/workflows/ci.yml", ".github/workflows/cd.yml", "infra/app", ...(config.options.versioning === "nbgv" && !derived.has_root_app ? ["version.json"] : [])]
    .filter(p => fs.existsSync(path.join(repo, p)));
  if (legacy.length) console.log(`  legacy  ${legacy.join(", ")}: combined-pipeline layout; every app now has its own workflows, infra/apps/<app> and version.json. Remove these after migrating (see the plugin docs, PIPELINES-PER-APP.md).`);
}
