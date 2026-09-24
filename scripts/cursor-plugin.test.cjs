// Cursor plugin format checks: manifests, component paths, generated assets in sync, hooks.json shape, skill frontmatter.
// Grounded on cursor.com/docs/reference/plugins (read 2026-09-22). Run: node --test scripts/cursor-plugin.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const yaml = require(path.join(__dirname, "..", "plugins", "slipway", "scripts", "lib", "js-yaml.min.js"));
const R = path.join(__dirname, "..");
const P = path.join(R, "plugins", "slipway");
const read = (f) => fs.readFileSync(f, "utf8");
const json = (f) => JSON.parse(read(f));
const frontmatter = (md) => {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "frontmatter present");
  const fm = {};
  for (const line of m[1].split("\n")) { const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2]; }
  return fm;
};

test("plugin manifest: required and declared components exist", () => {
  const m = json(path.join(P, ".cursor-plugin", "plugin.json"));
  assert.equal(m.name, "slipway");
  assert.match(m.name, /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
  assert.equal(m.author.name, "Abdelazim Ali");
  assert.equal(m.license, "MIT");
  for (const key of ["skills", "agents", "rules", "hooks", "mcpServers"]) assert.ok(fs.existsSync(path.join(P, m[key])), `${key}: ${m[key]} exists`);
  assert.equal(m.variables, undefined, "no plugin variables: they need a Teams dashboard; the GitHub token comes from the environment instead");
  assert.ok(fs.statSync(path.join(P, m.skills)).isDirectory());
  assert.ok(fs.statSync(path.join(P, m.agents)).isDirectory());
  assert.ok(fs.statSync(path.join(P, m.rules)).isDirectory());
  assert.ok(fs.statSync(path.join(P, m.hooks)).isFile());
  assert.ok(fs.statSync(path.join(P, m.mcpServers)).isFile());
});

test("both plugin manifests carry the same version, description and metadata", () => {
  const c = json(path.join(P, ".claude-plugin", "plugin.json"));
  const k = json(path.join(P, ".cursor-plugin", "plugin.json"));
  for (const key of ["name", "version", "description", "license", "repository", "homepage"]) assert.equal(k[key], c[key], key);
  assert.deepEqual(k.keywords, c.keywords);
  assert.deepEqual(k.author, c.author);
});

test("marketplace manifest points at the plugin directory", () => {
  const m = json(path.join(R, ".cursor-plugin", "marketplace.json"));
  assert.equal(m.metadata.pluginRoot, "plugins");
  assert.equal(m.owner.name, "Abdelazim Ali");
  assert.equal(m.plugins.length, 1);
  const p = m.plugins[0];
  assert.equal(p.name, "slipway");
  assert.ok(fs.existsSync(path.join(R, m.metadata.pluginRoot, p.source, ".cursor-plugin", "plugin.json")), "source resolves to a Cursor plugin");
  const claude = json(path.join(R, ".claude-plugin", "marketplace.json"));
  assert.equal(claude.plugins[0].source, `./plugins/${p.source}`, "same plugin directory as the Claude Code marketplace");
});

test("hooks.json: version 1, adapter scripts exist and are executable, blocking hooks fail closed", () => {
  const h = json(path.join(P, "cursor", "hooks.json"));
  assert.equal(h.version, 1);
  const blocking = ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "preToolUse"];
  for (const ev of [...blocking, "sessionStart"]) assert.ok(Array.isArray(h.hooks[ev]) && h.hooks[ev].length, `${ev} registered`);
  for (const [ev, defs] of Object.entries(h.hooks)) for (const d of defs) {
    assert.match(d.command, /^\.\/cursor\/hooks\/[a-z-]+\.sh$/, `${ev}: command is a plugin-relative adapter path`);
    const f = path.join(P, d.command);
    assert.ok(fs.existsSync(f), `${d.command} exists`);
    assert.ok(fs.statSync(f).mode & 0o111, `${d.command} is executable`);
    assert.ok(Number.isInteger(d.timeout) && d.timeout > 0, `${ev}: timeout`);
    if (blocking.includes(ev)) assert.equal(d.failClosed, true, `${ev}: failClosed`);
  }
  assert.equal(h.hooks.preToolUse[0].command, "./cursor/hooks/pretooluse.sh", "preToolUse routes every tool through the dispatcher (the event Cursor 3.21 fires)");
  assert.equal(h.hooks.preToolUse[0].matcher, undefined, "no matcher: the dispatcher decides by tool_name");
});

test("project wiring templates reference adapters that exist and the user-hooks installer registers the same five events", () => {
  const tmpl = read(path.join(P, "templates", "common", "files", ".cursor", "hooks.json.tmpl"));
  const cfg = JSON.parse(tmpl);
  assert.equal(cfg.version, 1);
  const adapters = new Set(fs.readdirSync(path.join(P, "cursor", "hooks")).filter((f) => f.endsWith(".sh") && !f.startsWith("test-") && f !== "common.sh").map((f) => f.replace(/\.sh$/, "")));
  for (const [ev, defs] of Object.entries(cfg.hooks)) for (const d of defs) {
    const m = d.command.match(/^bash \.slipway\/cursor-hooks\.sh ([a-z-]+)$/);
    assert.ok(m, `${ev}: command goes through the shim`);
    assert.ok(adapters.has(m[1]), `${ev}: adapter ${m[1]} exists`);
    if (ev !== "sessionStart") assert.equal(d.failClosed, true, `${ev}: failClosed`);
  }
  const shim = read(path.join(P, "templates", "common", "files", ".slipway", "cursor-hooks.sh.tmpl"));
  for (const a of ["pretooluse", "shell", "mcp", "read", "session-start"]) assert.ok(shim.includes(a), `shim accepts ${a}`);
  assert.ok(shim.includes(".cursor/plugins/local/slipway") && shim.includes(".cursor/plugins/cache"), "shim looks in the local folder and the marketplace cache");
  const installer = read(path.join(R, "scripts", "cursor-local-install.sh"));
  for (const ev of ["sessionStart", "preToolUse", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile"]) assert.ok(installer.includes(ev), `installer registers ${ev}`);
});

test("generated Cursor assets (subagents, mcp.json) are in sync with the Claude Code sources", () => {
  execFileSync(process.execPath, [path.join(R, "scripts", "build-cursor-assets.cjs"), "--check"], { stdio: "pipe" });
});

test("Cursor subagents: frontmatter name/description/model, explore and verify read-only", () => {
  const dir = path.join(P, "cursor", "agents");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(files, ["execute.md", "explore.md", "verify.md"]);
  for (const f of files) {
    const fm = frontmatter(read(path.join(dir, f)));
    assert.equal(fm.name, f.replace(/\.md$/, ""));
    assert.ok(fm.description && fm.description.length > 40, `${f}: description`);
    assert.equal(fm.model, "inherit");
    assert.equal(fm.readonly, f === "execute.md" ? undefined : "true", `${f}: readonly`);
    for (const claudeOnly of ["tools", "disallowedTools", "maxTurns", "skills", "color"]) assert.equal(fm[claudeOnly], undefined, `${f}: no ${claudeOnly}`);
  }
});

test("Cursor MCP config: same servers as .mcp.json without Claude's type key", () => {
  const c = json(path.join(P, ".mcp.json")).mcpServers;
  const k = json(path.join(P, "cursor", "mcp.json")).mcpServers;
  assert.deepEqual(Object.keys(k).sort(), Object.keys(c).sort());
  for (const [name, def] of Object.entries(k)) {
    assert.equal(def.type, undefined, `${name}: no type`);
    assert.ok(def.url || def.command, `${name}: url or command`);
    if (c[name].url) assert.equal(def.url, c[name].url);
    if (name === "github") assert.equal(def.headers.Authorization, "Bearer ${env:GITHUB_MCP_TOKEN}", "GitHub MCP reads the token from the environment (Cloud Agents secrets); desktop OAuth applies when unset");
    if (c[name].args) assert.deepEqual(def.args, c[name].args);
    const text = JSON.stringify(def);
    assert.doesNotMatch(text, /(ghp_|github_pat_|Bearer [A-Za-z0-9])/, `${name}: no token literal`);
  }
});

test("rule: alwaysApply with a description, names every user-invoked skill and the approval token", () => {
  const md = read(path.join(P, "cursor", "rules", "slipway.mdc"));
  const fm = frontmatter(md);
  assert.equal(fm.alwaysApply, "true");
  assert.ok(fm.description);
  for (const s of ["launch", "bootstrap", "dockerize", "plan", "deploy", "verify", "ticket"]) assert.ok(md.includes(`/${s}`), `mentions /${s}`);
  assert.ok(md.includes("approve-apply.sh"));
  assert.ok(md.includes("${CLAUDE_PLUGIN_ROOT}"));
});

test("skills follow the Agent Skills format Cursor loads (name + description frontmatter, one SKILL.md per folder)", () => {
  const dir = path.join(P, "skills");
  const skills = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort();
  assert.ok(skills.length >= 7);
  for (const s of skills) {
    const fm = frontmatter(read(path.join(dir, s, "SKILL.md")));
    assert.equal(fm.name, s, `${s}: name matches folder`);
    assert.ok(fm.description && fm.description.length > 20, `${s}: description`);
  }
});

test("every frontmatter Cursor loads is strict YAML with a string description (lenient Claude Code parsing hid 4 dropped skills)", () => {
  const files = [
    ...fs.readdirSync(path.join(P, "skills")).map((s) => path.join(P, "skills", s, "SKILL.md")),
    ...fs.readdirSync(path.join(P, "agents")).map((a) => path.join(P, "agents", a)),
    ...fs.readdirSync(path.join(P, "cursor", "agents")).map((a) => path.join(P, "cursor", "agents", a)),
    ...fs.readdirSync(path.join(P, "cursor", "rules")).map((r) => path.join(P, "cursor", "rules", r)),
  ];
  for (const f of files) {
    const m = read(f).match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, `${f}: frontmatter`);
    let fm;
    assert.doesNotThrow(() => { fm = yaml.load(m[1]); }, `${f}: strict YAML`);
    assert.equal(typeof fm.description, "string", `${f}: description is a string`);
    assert.ok(fm.description.length > 20, `${f}: description`);
  }
});
