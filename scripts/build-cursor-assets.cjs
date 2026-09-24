#!/usr/bin/env node
// Generates the Cursor-format assets of the slipway plugin from the Claude Code sources so the two cannot drift:
//   plugins/slipway/agents/*.md -> plugins/slipway/cursor/agents/*.md  (frontmatter: name, description, model, readonly)
//   plugins/slipway/.mcp.json   -> plugins/slipway/cursor/mcp.json     (Cursor infers the transport from url/command)
// Usage: node scripts/build-cursor-assets.cjs [--check]   --check exits 1 when a generated file is stale (CI, tests).
"use strict";
const fs = require("fs");
const path = require("path");
const P = path.join(__dirname, "..", "plugins", "slipway");
const check = process.argv.includes("--check");
const stale = [];

function write(file, content) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (current === content) return;
  if (check) { stale.push(path.relative(P, file)); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log("wrote", path.relative(P, file));
}

const yaml = require(path.join(P, "scripts", "lib", "js-yaml.min.js"));
function parseFrontmatter(md, name) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${name}: no frontmatter`);
  // Strict YAML on purpose: Cursor's loader is strict (a description with ": " unquoted silently drops the component,
  // seen 2026-09-23 with 4 of 8 skills), while Claude Code's parser is lenient. Fail loudly here instead.
  let fm;
  try { fm = yaml.load(m[1]); } catch (e) { throw new Error(`${name}: frontmatter is not strict YAML: ${e.message.split("\n")[0]}`); }
  return { fm: fm || {}, body: m[2] };
}

// Subagents: Cursor frontmatter is name/description/model/readonly (cursor.com/docs/subagents, read 2026-09-22).
// Read-only when the Claude definition disallows Edit and Write and grants neither.
for (const f of fs.readdirSync(path.join(P, "agents")).filter((x) => x.endsWith(".md")).sort()) {
  const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(P, "agents", f), "utf8"), f);
  if (!fm.name || !fm.description) throw new Error(`${f}: name and description are required`);
  const disallowed = Array.isArray(fm.disallowedTools) ? fm.disallowedTools.join(", ") : String(fm.disallowedTools || "");
  const tools = Array.isArray(fm.tools) ? fm.tools.join(", ") : String(fm.tools || "");
  const readonly = /\bEdit\b/.test(disallowed) && /\bWrite\b/.test(disallowed) && !/\b(Edit|Write)\b/.test(tools);
  const out = [
    "---",
    `name: ${fm.name}`,
    `description: ${JSON.stringify(String(fm.description))}`,
    "model: inherit",
    ...(readonly ? ["readonly: true"] : []),
    "---",
    `<!-- generated from plugins/slipway/agents/${f} by scripts/build-cursor-assets.cjs; edit the source, then run: npm run build:cursor -->`,
    "",
    body.replace(/^\n+/, ""),
  ].join("\n");
  write(path.join(P, "cursor", "agents", f), out);
}

// MCP servers: same servers, minus Claude Code's `type` key (Cursor's mcp.json uses url for HTTP and command for stdio).
const mcp = JSON.parse(fs.readFileSync(path.join(P, ".mcp.json"), "utf8"));
const servers = {};
for (const [name, def] of Object.entries(mcp.mcpServers || {})) {
  const { type, ...rest } = def; // eslint-disable-line no-unused-vars
  servers[name] = rest;
}
// GitHub's remote MCP server: the Cursor desktop (3.21.18) completes OAuth on its own, but a Cursor Cloud Agent has no
// browser and falls back to OAuth dynamic client registration, which GitHub rejects (HTTP 422, "incompatible auth
// server"; observed 2026-09-24). Cloud Agents expose their secrets as environment variables, so the header reads
// ${env:GITHUB_MCP_TOKEN} (Cursor's mcp.json interpolation): set that secret to a fine-grained PAT (Actions read/write,
// Metadata read) in the cloud environment. Unset locally, OAuth proceeds as before; without either, gh CLI is the fallback.
if (servers.github && servers.github.url) servers.github.headers = { Authorization: "Bearer ${env:GITHUB_MCP_TOKEN}" };
write(path.join(P, "cursor", "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2) + "\n");

if (check && stale.length) {
  console.error(`stale generated Cursor assets: ${stale.join(", ")}\nrun: npm run build:cursor`);
  process.exit(1);
}
