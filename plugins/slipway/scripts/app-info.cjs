#!/usr/bin/env node
// Prints the derived delivery facts of one app (or all apps) from .slipway/config.yaml, for skills and humans.
// usage: node app-info.cjs [<app>] [--repo <dir>] [--json]
"use strict";
const path = require("node:path");
const { loadConfig, derive } = require("./lib/config.cjs");
const args = process.argv.slice(2); const flag = n => args.includes(n); const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const repo = path.resolve(val("--repo", ".")); const name = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--repo"));
const { config, options, errors } = loadConfig(path.join(repo, ".slipway", "config.yaml"));
if (errors.length) { console.error("config invalid:\n  " + errors.join("\n  ")); process.exit(1); }
const d = derive(config, options, repo);
const apps = name ? d.apps.filter(a => a.name === name) : d.apps;
if (name && !apps.length) { console.error(`app '${name}' is not in .slipway/config.yaml (apps: ${d.apps.map(a => a.name).join(", ")})`); process.exit(1); }
const pick = a => ({ name: a.name, path: a.path, kind: a.kind, stack: a.stack, image: a.image, image_repository: a.image_repository,
  workflow_ci: a.workflow_ci, workflow_cd: a.workflow_cd, version_file: a.version_file, tag_prefix: a.tag_prefix, infra_dir: a.infra_dir, state_key: a.state_key, evidence_dir: a.evidence_dir,
  build: { context: a.build.context, dockerfile: a.build.dockerfile, dockerfile_from_context: a.build.dockerfile_from_context }, pipeline_paths: a.pipeline_paths, upstreams: a.upstream_names });
const out = { project: config.project.name, pipelines: d.pipelines, environments: config.environments, cd_environment: config.github?.cd_environment, apps: apps.map(pick) };
if (flag("--json")) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`${out.project}: prefix ${d.pipelines.name_prefix}, cd_trigger ${d.pipelines.cd_trigger}, pr_checks ${d.pipelines.pr_checks}, environments ${config.environments.join(", ")}`);
for (const a of out.apps) {
  console.log(`\n${a.name} (${a.kind}, ${a.stack}) at ${a.path}`);
  console.log(`  ci: ${a.workflow_ci}    cd: ${a.workflow_cd}    tag: ${a.tag_prefix}<semver>    image: ${a.image}:<semver>`);
  console.log(`  version file: ${a.version_file}    infra: ${a.infra_dir}    state: ${a.state_key}    evidence: ${a.evidence_dir}/<tag>.md`);
  console.log(`  build: docker build -f ${a.build.dockerfile} ${a.build.context}`);
  console.log(`  inputs (triggers = pathFilters): ${a.pipeline_paths.join(", ")}`);
}
