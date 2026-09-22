// Validates templates/common/slipway/config.example.yaml with the checked-in standalone validator,
// and checks the validator is up to date with the schema.
import fs from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const base = "plugins/slipway";
const yaml = require(`../${base}/scripts/lib/js-yaml.min.js`);
const before = fs.readFileSync(`${base}/scripts/lib/validate-config.generated.cjs`, "utf8");
execFileSync("node", ["scripts/build-validator.cjs"], { stdio: "ignore" });
const after = fs.readFileSync(`${base}/scripts/lib/validate-config.generated.cjs`, "utf8");
if (before !== after) { console.error("validate-config.generated.cjs is stale: run `node scripts/build-validator.cjs` and commit"); process.exit(1); }
const validate = require(`../${base}/scripts/lib/validate-config.generated.cjs`);
const data = yaml.load(fs.readFileSync(`${base}/templates/common/slipway/config.example.yaml`, "utf8"));
if (!validate(data)) { console.error(JSON.stringify(validate.errors, null, 2)); process.exit(1); }
console.log("config.example.yaml is valid; standalone validator is up to date");
