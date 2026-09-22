const { test } = require("node:test"); const assert = require("node:assert/strict");
const { render, RenderError } = require("./render.cjs");
const ctx = { project: { name: "demo" }, options: { compute: "aca" }, apps: [
  { name: "api", kind: "api", port: 8080 }, { name: "web", kind: "frontend", port: 8080, upstreams: ["api"] } ], empty: [] };

test("substitution and filters", () => {
  assert.equal(render("p=<% project.name %> c=<%options.compute|upper%>", ctx), "p=demo c=ACA");
  assert.equal(render("<% apps | json %>", { apps: [1] }), "[1]");
});
test("each with item scope, root fallback and loop vars", () => {
  const t = "<%#each apps%><%@index%>:<% name %>/<% project.name %><%#if @last%>.<%else%>,<%/if%><%/each%>";
  assert.equal(render(t, ctx), "0:api/demo,1:web/demo.");
});
test("if / else and eq", () => {
  assert.equal(render("<%#if empty%>yes<%else%>no<%/if%>", ctx), "no");
  assert.equal(render("<%#each apps%><%#eq kind \"frontend\"%>[<%name%>]<%/eq%><%/each%>", ctx), "[web]");
  assert.equal(render("<%#eq options.compute 'aci'%>aci<%else%>other<%/eq%>", ctx), "other");
});
test("nested each over string arrays", () => {
  assert.equal(render("<%#each apps%><%#if upstreams%><%name%>-><%#each upstreams%><%this%><%/each%>;<%/if%><%/each%>", ctx), "web->api;");
});
test("comments removed, whitespace tolerant", () => {
  assert.equal(render("a<%! note %>b<%project.name%>", ctx), "abdemo");
});
test("fail fast on missing values and bad blocks", () => {
  assert.throws(() => render("<% nope.x %>", ctx), RenderError);
  assert.throws(() => render("<%#each apps%>x", ctx), RenderError);
  assert.throws(() => render("<% apps %>", ctx), RenderError);
  assert.throws(() => render("<% project.name | nope %>", ctx), RenderError);
});
