#!/usr/bin/env node
// Validates a target repo's .slipway/config.yaml: schema + option statuses + cross-dimension constraints. Exit 1 on errors.
"use strict";
const path = require("node:path");
const { loadConfig } = require("./lib/config.cjs");
const file = path.resolve(process.argv[2] || ".slipway/config.yaml");
let res;
try { res = loadConfig(file); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
if (res.errors.length) { console.error(`${file}: ${res.errors.length} problem(s)`); for (const e of res.errors) console.error(`  - ${e}`); process.exit(1); }
console.log(`${file}: valid (${res.config.apps.length} app(s), options: ${Object.entries(res.config.options).map(([k, v]) => `${k}=${v}`).join(" ")})`);
