#!/usr/bin/env node
// Discover the Azure Container Registries of the current subscription that this repository could share, and whether the
// signed-in identity can assign the roles the foundation layer needs on each (AcrPush and Reader for the CI/CD principal,
// AcrPull for the app identity). Used by the bootstrap interview for `registry_scope`:
//   - no registry at all            -> recommendation per-repository (create one), no question
//   - registries you can grant on   -> recommendation ask (offer them, plus "create a new one")
//   - registries you cannot grant on -> listed with the reason, recommendation per-repository
// Read-only: az account show, az ad signed-in-user show, az role assignment list, az acr list.
// Usage: node registries.cjs [--location <azure-region>] [--json]     exit 2 = az is not logged in / unusable
"use strict";
const { spawnSync } = require("child_process");
const AZ = process.env.SLIPWAY_AZ_BIN || "az";
// Roles that may create role assignments (RBAC Administrator only for non-privileged roles, which is all we need).
const ROLE_ASSIGNERS = ["Owner", "User Access Administrator", "Role Based Access Control Administrator"];

function az(args) {
  const r = spawnSync(AZ, [...args, "-o", "json"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`az ${args.slice(0, 3).join(" ")}: ${(r.stderr || "").trim().split("\n")[0] || "failed"}`);
  return r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

// A scope covers a resource when it is the resource itself or an ancestor (subscription, resource group).
function scopeCovers(scope, resourceId) {
  const s = String(scope || "").toLowerCase().replace(/\/+$/, ""), id = resourceId.toLowerCase();
  return id === s || id.startsWith(s + "/");
}
function scopeLabel(scope) {
  const parts = String(scope).split("/").filter(Boolean); // subscriptions, <id>, resourceGroups, <rg>, providers, ...
  if (parts.length <= 2) return "subscription";
  if (parts.length === 4) return `resource group ${parts[3]}`;
  return "the registry";
}
function canAssign(assignments, registryId) {
  return (assignments || [])
    .filter((a) => ROLE_ASSIGNERS.includes(a.roleDefinitionName) && scopeCovers(a.scope, registryId))
    .map((a) => `${a.roleDefinitionName} @ ${scopeLabel(a.scope)}`);
}

function assess({ registries, assignments, location, identityKnown }) {
  const rows = (registries || []).map((r) => {
    const via = identityKnown ? canAssign(assignments, r.id) : [];
    return {
      name: r.name, resource_group: r.resourceGroup, location: r.location, sku: (r.sku && r.sku.name) || r.sku || null,
      login_server: r.loginServer || `${r.name}.azurecr.io`, id: r.id,
      same_location: location ? String(r.location).toLowerCase() === String(location).toLowerCase() : null,
      can_assign_roles: identityKnown ? via.length > 0 : "unknown", via,
    };
  });
  rows.sort((a, b) => (b.can_assign_roles === true) - (a.can_assign_roles === true) || (b.same_location === true) - (a.same_location === true) || a.name.localeCompare(b.name));
  const eligible = rows.filter((r) => r.can_assign_roles === true || r.can_assign_roles === "unknown");
  let recommendation, reason;
  if (rows.length === 0) { recommendation = "per-repository"; reason = "no container registry in this subscription: the foundation layer creates one for this repository"; }
  else if (eligible.length > 0) { recommendation = "ask"; reason = `${eligible.length} of ${rows.length} registr${rows.length === 1 ? "y" : "ies"} can be shared (you can assign AcrPush, Reader and AcrPull there); offer them and the option to create a new one`; }
  else { recommendation = "per-repository"; reason = `${rows.length} registr${rows.length === 1 ? "y exists" : "ies exist"} but you cannot assign roles on ${rows.length === 1 ? "it" : "any of them"}; create one for this repository, or ask an owner to grant AcrPush/Reader/AcrPull (or Owner) on the shared one`; }
  return { registries: rows, eligible: eligible.map((r) => r.name), recommendation, reason };
}

function discover(location) {
  let account;
  try { account = az(["account", "show"]); } catch (e) { const err = new Error(`not logged in to Azure (${e.message}); run: az login && az account set --subscription <id>`); err.exitCode = 2; throw err; }
  let identity = null, identityKnown = false, assignments = [];
  try { const u = az(["ad", "signed-in-user", "show"]); identity = { id: u.id, name: u.userPrincipalName || u.displayName }; }
  catch { const name = account.user && account.user.name; if (name) { try { const sp = az(["ad", "sp", "show", "--id", name]); identity = { id: sp.id, name }; } catch { identity = { id: null, name }; } } }
  if (identity && identity.id) {
    try { assignments = az(["role", "assignment", "list", "--assignee", identity.id, "--all", "--include-inherited", "--include-groups"]) || []; identityKnown = true; }
    catch { identityKnown = false; }
  }
  const registries = az(["acr", "list"]) || [];
  const result = assess({ registries, assignments, location, identityKnown });
  return { subscription: { id: account.id, name: account.name }, identity: identity ? identity.name : null, identity_known: identityKnown, location: location || null, ...result };
}

function table(r) {
  const lines = [`Registries in subscription ${r.subscription.name} (${r.subscription.id})${r.identity ? `, signed in as ${r.identity}` : ""}${r.identity_known ? "" : " (role assignments could not be read: eligibility unknown)"}`];
  if (r.registries.length === 0) lines.push("  (none)");
  const w = Math.max(4, ...r.registries.map((x) => x.name.length)), wg = Math.max(14, ...r.registries.map((x) => x.resource_group.length));
  for (const x of r.registries) {
    const can = x.can_assign_roles === true ? `yes (${x.via.join(", ")})` : x.can_assign_roles === "unknown" ? "unknown" : "no";
    lines.push(`  ${x.name.padEnd(w)}  ${x.resource_group.padEnd(wg)}  ${String(x.location).padEnd(14)}  ${String(x.sku || "").padEnd(8)}  can assign roles: ${can}${x.same_location ? "  (same location)" : ""}`);
  }
  lines.push(`Recommendation: ${r.recommendation} — ${r.reason}`);
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const li = args.indexOf("--location"); const location = li >= 0 ? args[li + 1] : null;
  let r;
  try { r = discover(location); } catch (e) { console.error(e.message); process.exit(e.exitCode || 1); }
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 2)); else console.log(table(r));
}

module.exports = { assess, canAssign, scopeCovers, scopeLabel, discover, table };
if (require.main === module) main();
