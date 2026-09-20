#!/usr/bin/env node
// Local queue of tracker updates that could not be sent (tracker unreachable or not authorised). Never blocks delivery.
// usage: node tracking-queue.cjs add <action> <json-args> | list [--json] | pop <n> | clear     [--repo <dir>]
// File: <repo>/.slipway/tracking-queue.jsonl (gitignored). `/slipway:ticket sync` replays `list` in order and `pop`s each success.
"use strict";
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2); const flag = n => args.includes(n); const val = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const repo = path.resolve(val("--repo", ".")); const file = path.join(repo, ".slipway", "tracking-queue.jsonl");
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--repo"));
const [cmd, a1, a2] = positional;
const ACTIONS = ["story_create", "story_set", "subtask_start", "subtask_review", "subtask_done", "comment", "story_done"];
const read = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
const write = (entries) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "")); };
switch (cmd) {
  case "add": {
    if (!ACTIONS.includes(a1)) { console.error(`unknown action '${a1}'. Known: ${ACTIONS.join(", ")}`); process.exit(1); }
    let parsed; try { parsed = JSON.parse(a2 || "{}"); } catch (e) { console.error(`args must be JSON: ${e.message}`); process.exit(1); }
    const entry = { ts: new Date().toISOString(), action: a1, args: parsed };
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    console.log(`queued ${a1} (${read().length} pending) -> ${path.relative(repo, file)}`); break;
  }
  case "list": { const q = read(); if (flag("--json")) console.log(JSON.stringify(q, null, 2)); else { if (!q.length) console.log("queue empty"); q.forEach((e, i) => console.log(`${i + 1}. ${e.ts} ${e.action} ${JSON.stringify(e.args)}`)); } break; }
  case "pop": { const n = Math.max(1, parseInt(a1 || "1", 10)); const q = read(); const gone = q.splice(0, n); write(q); console.log(`removed ${gone.length}, ${q.length} pending`); break; }
  case "clear": { write([]); console.log("queue cleared"); break; }
  default: console.error("usage: tracking-queue.cjs add <action> <json-args> | list [--json] | pop <n> | clear   [--repo <dir>]"); process.exit(1);
}
