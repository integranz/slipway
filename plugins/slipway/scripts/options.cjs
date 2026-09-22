#!/usr/bin/env node
// Lists the option registry for the intake interview.
// usage: node options.cjs [dimension] [--json]     (statuses: implemented = selectable; planned/later = shown, not selectable)
"use strict";
const { loadOptions } = require("./lib/config.cjs");
const args = process.argv.slice(2); const json = args.includes("--json"); const dim = args.find(a => !a.startsWith("--"));
const o = loadOptions();
const dims = dim ? { [dim]: o.dimensions[dim] } : o.dimensions;
if (dim && !o.dimensions[dim]) { console.error(`unknown dimension '${dim}'. Known: ${Object.keys(o.dimensions).join(", ")}`); process.exit(1); }
if (json) { console.log(JSON.stringify({ distribution: o.distribution, dimensions: dims, app_kinds: o.app_kinds }, null, 2)); process.exit(0); }
for (const [name, d] of Object.entries(dims)) {
  console.log(`\n${name}${d.per_app ? " (per app)" : ""}${d.depends_on ? ` [depends on ${d.depends_on}]` : ""}: ${d.question}`);
  for (const [k, v] of Object.entries(d.options)) {
    const flags = [v.status, v.cloud ? `cloud=${v.cloud}` : null, v.kinds ? `kinds=${v.kinds.join("/")}` : null].filter(Boolean).join(", ");
    console.log(`  ${v.status === "implemented" ? "●" : "○"} ${k.padEnd(20)} ${v.label || ""}  [${flags}]${v.note ? `\n      ${v.note}` : ""}`);
  }
}
