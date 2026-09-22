// Minimal, dependency-free template renderer for slipway templates.
// Syntax (whitespace inside braces is optional):
//   <% path.to.value %>                 substitution; missing value -> error (fail fast)
//   <% path | upper %>  | lower | json   filters
//   <%#each path%> ... <%/each%>        iterate an array; inside, `<% name %>` resolves against the item first,
//                                        then the root; `<% @index %>`, `<% @first %>`, `<% @last %>` available
//   <%#if path%> ... <%else%> ... <%/if%>          truthy test (empty array/string, 0, false, null -> false)
//   <%#eq path "literal"%> ... <%else%> ... <%/eq%>  equality test against a quoted literal or another path
//   <%! comment %>                       removed
// Blocks may nest. Unknown constructs are an error.
"use strict";

class RenderError extends Error {}

function lookup(scopes, expr) {
  if (expr.startsWith("@")) {
    for (const s of scopes) if (s && Object.prototype.hasOwnProperty.call(s, expr)) return s[expr];
    throw new RenderError(`unknown loop variable ${expr}`);
  }
  const parts = expr.split(".");
  for (const scope of scopes) {
    if (scope == null) continue;
    let cur = scope, ok = true;
    for (const p of parts) {
      if (cur != null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
      else { ok = false; break; }
    }
    if (ok) return cur;
  }
  return undefined;
}

function applyFilter(value, filter, expr) {
  switch (filter) {
    case undefined: return value;
    case "upper": return String(value).toUpperCase();
    case "lower": return String(value).toLowerCase();
    case "json": return JSON.stringify(value);
    default: throw new RenderError(`unknown filter '${filter}' in <% ${expr} %>`);
  }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return !(v === undefined || v === null || v === false || v === 0 || v === "");
}

function literalOrPath(token, scopes) {
  const m = token.match(/^"(.*)"$|^'(.*)'$/);
  if (m) return m[1] !== undefined ? m[1] : m[2];
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  if (token === "true") return true;
  if (token === "false") return false;
  return lookup(scopes, token);
}

// Tokenize into text and tags
const TAG = /<%(#each|#if|#eq|\/each|\/if|\/eq|else|!)?\s*([^%]*?)\s*%>/g;

function parse(template) {
  const tokens = []; let last = 0, m;
  while ((m = TAG.exec(template))) {
    if (m.index > last) tokens.push({ type: "text", value: template.slice(last, m.index) });
    tokens.push({ type: "tag", kind: m[1] || "var", body: m[2] });
    last = TAG.lastIndex;
  }
  if (last < template.length) tokens.push({ type: "text", value: template.slice(last) });
  // build tree
  const root = { children: [] }; const stack = [root];
  // children go to the else-branch once <%else%> has been seen inside the current block
  const push = (blk, node) => (blk.elseChildren ? blk.elseChildren : blk.children).push(node);
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (t.type === "text") { push(top, t); continue; }
    switch (t.kind) {
      case "!": break;
      case "var": push(top, { type: "var", body: t.body }); break;
      case "#each": case "#if": case "#eq": {
        const node = { type: t.kind.slice(1), body: t.body, children: [], elseChildren: null };
        push(top, node); stack.push(node); break;
      }
      case "else": {
        if (stack.length < 2 || !["if", "eq"].includes(top.type)) throw new RenderError("<%else%> outside of #if/#eq");
        top.elseChildren = []; break;
      }
      case "/each": case "/if": case "/eq": {
        const want = t.kind.slice(1);
        if (stack.length < 2 || top.type !== want) throw new RenderError(`unexpected <%/${want}%>`);
        stack.pop(); break;
      }
    }
  }
  if (stack.length !== 1) throw new RenderError(`unclosed <%#${stack[stack.length - 1].type}%> block`);
  return root;
}

function renderNodes(nodes, scopes, out) {
  for (const n of nodes) {
    if (n.type === "text") { out.push(n.value); continue; }
    if (n.type === "var") {
      const [expr, filter] = n.body.split("|").map(s => s.trim());
      const v = lookup(scopes, expr);
      if (v === undefined) throw new RenderError(`missing value for <% ${expr} %>`);
      if (v !== null && typeof v === "object" && filter !== "json") throw new RenderError(`<% ${expr} %> is an object/array; use | json or #each`);
      out.push(String(applyFilter(v, filter, n.body)));
      continue;
    }
    if (n.type === "each") {
      const arr = lookup(scopes, n.body.trim());
      if (arr === undefined) throw new RenderError(`missing array for <%#each ${n.body}%>`);
      if (!Array.isArray(arr)) throw new RenderError(`<%#each ${n.body}%> is not an array`);
      arr.forEach((item, i) => {
        const loopVars = { "@index": i, "@first": i === 0, "@last": i === arr.length - 1 };
        const itemScope = (item !== null && typeof item === "object") ? item : { this: item };
        renderNodes(n.children, [loopVars, itemScope, ...scopes], out);
      });
      continue;
    }
    if (n.type === "if") {
      const v = lookup(scopes, n.body.trim());
      renderNodes(truthy(v) ? n.children : (n.elseChildren || []), scopes, out);
      continue;
    }
    if (n.type === "eq") {
      const parts = n.body.trim().match(/^(\S+)\s+(.+)$/);
      if (!parts) throw new RenderError(`bad <%#eq ${n.body}%>: expected path and value`);
      const a = lookup(scopes, parts[1]); const b = literalOrPath(parts[2].trim(), scopes);
      renderNodes(a === b ? n.children : (n.elseChildren || []), scopes, out);
      continue;
    }
  }
}

function render(template, context) {
  const out = [];
  renderNodes(parse(template).children, [context], out);
  return out.join("");
}

module.exports = { render, RenderError };
