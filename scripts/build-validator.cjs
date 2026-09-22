// Compiles the config schema into a dependency-free validator module (ajv standalone code).
// Run: node scripts/build-validator.cjs   (CI fails if the checked-in output is stale)
const fs = require("node:fs"), path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const standalone = require("ajv/dist/standalone").default;
const base = path.join(__dirname, "..", "plugins", "slipway");
const schema = JSON.parse(fs.readFileSync(path.join(base, "templates/common/slipway/config.schema.json"), "utf8"));
const ajv = new Ajv2020({ code: { source: true, esm: false }, strict: true, strictRequired: false, allErrors: true });
const validate = ajv.compile(schema);
let code = standalone(ajv, validate);
const header = `// GENERATED FILE - do not edit. Source: templates/common/slipway/config.schema.json. Rebuild: node scripts/build-validator.cjs\n`;
const out = path.join(base, "scripts/lib/validate-config.generated.cjs");
fs.writeFileSync(out, header + code);
const deps = [...code.matchAll(/require\(([^)]+)\)/g)].map(m => m[1]);
console.log("wrote", path.relative(process.cwd(), out), "| external requires:", deps.length ? deps.join(", ") : "none");
if (deps.length) { console.error("validator must be dependency-free"); process.exit(1); }
