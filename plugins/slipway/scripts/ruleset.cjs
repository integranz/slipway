#!/usr/bin/env node
// Prints the GitHub ruleset JSON that protects the default branch for this repository: pull requests only, no force
// push or deletion, and the per-app required checks `<app> changes` and `<app> ci` (the always-running gate and result
// jobs; nested reusable-workflow checks vanish when an app is skipped and must not be required).
// usage: node ruleset.cjs [--repo <dir>] [--name <ruleset name>]      (apply with: gh api -X POST repos/O/R/rulesets --input -)
"use strict";
const path = require("node:path");
const { loadConfig, derive } = require("./lib/config.cjs");
const args = process.argv.slice(2); const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const repo = path.resolve(val("--repo", "."));
const { config, options, errors } = loadConfig(path.join(repo, ".slipway", "config.yaml"));
if (errors.length) { console.error("config invalid:\n  " + errors.join("\n  ")); process.exit(1); }
const d = derive(config, options, repo);
const checks = d.pipelines.gate
  ? d.apps.flatMap(a => [{ context: `${a.name} changes` }, { context: `${a.name} ci` }])
  : d.apps.map(a => ({ context: `${a.name} ci` })); // path-filtered mode: `<app> ci` exists only when the app runs; requiring it blocks untouched PRs
if (!d.pipelines.gate) console.error("warning: pr_checks=path-filtered; required per-app checks block pull requests that do not touch the app. Switch to pr_checks=always-run-gate before applying this ruleset.");
const ruleset = {
  name: val("--name", `${config.github?.default_branch || "main"}: pull requests and per-app checks (slipway)`),
  target: "branch", enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  bypass_actors: [],
  rules: [
    { type: "deletion" }, { type: "non_fast_forward" },
    { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ["squash", "merge"] } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: checks } },
  ],
};
console.log(JSON.stringify(ruleset, null, 2));
