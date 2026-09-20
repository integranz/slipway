"use strict";
const fs = require("node:fs"), path = require("node:path");
const yaml = require("./js-yaml.min.js");
const validateSchema = require("./validate-config.generated.cjs");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const OPTIONS_PATH = path.join(PLUGIN_ROOT, "templates", "common", "slipway", "options.yaml");
// Optional dimensions and the value they take when the config omits them.
const OPTION_DEFAULTS = { cd_trigger: "manual", pr_checks: "path-filtered", cd_approval: "github-ui" };

function loadYaml(file) { return yaml.load(fs.readFileSync(file, "utf8")); }
function loadOptions() { return loadYaml(OPTIONS_PATH); }
function pluginVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version || "0.0.0"; }
  catch { return "0.0.0"; }
}
function applyDefaults(config) {
  if (config && config.options && typeof config.options === "object") {
    for (const [k, v] of Object.entries(OPTION_DEFAULTS)) if (config.options[k] === undefined) config.options[k] = v;
  }
  return config;
}

// Returns a list of human-readable errors (empty = valid).
function checkConfig(config, options) {
  const errors = [];
  if (!validateSchema(config)) {
    for (const e of validateSchema.errors) errors.push(`schema: ${e.instancePath || "/"} ${e.message}`);
    return errors; // shape errors first; option checks assume a valid shape
  }
  const dims = options.dimensions;
  const implemented = (dim) => Object.entries(dims[dim].options).filter(([, o]) => o.status === "implemented").map(([k]) => k);
  for (const [dim, value] of Object.entries(config.options)) {
    const d = dims[dim];
    if (!d) { errors.push(`options.${dim}: unknown dimension`); continue; }
    const opt = d.options[value];
    if (!opt) { errors.push(`options.${dim}=${value}: unknown option. Implemented: ${implemented(dim).join(", ")}`); continue; }
    if (opt.status !== "implemented") {
      errors.push(`options.${dim}=${value} is '${opt.status}' and not selectable yet${opt.note ? ` (${opt.note})` : ""}. Implemented: ${implemented(dim).join(", ")}`);
    }
    if (opt.cloud && opt.cloud !== config.options.cloud) {
      errors.push(`options.${dim}=${value} requires cloud=${opt.cloud} but cloud=${config.options.cloud}`);
    }
  }
  // per-app stack checks
  const stackOpts = dims.stack.options;
  const names = new Set();
  for (const app of config.apps) {
    if (names.has(app.name)) errors.push(`apps: duplicate app name '${app.name}'`); names.add(app.name);
    const s = stackOpts[app.stack];
    if (!s) { errors.push(`apps.${app.name}.stack=${app.stack}: unknown stack`); continue; }
    if (s.status !== "implemented") errors.push(`apps.${app.name}.stack=${app.stack} is '${s.status}' and not selectable yet. Implemented: ${Object.entries(stackOpts).filter(([, o]) => o.status === "implemented").map(([k]) => k).join(", ")}`);
    if (s.kinds && !s.kinds.includes(app.kind)) errors.push(`apps.${app.name}: stack ${app.stack} supports kinds [${s.kinds.join(", ")}], not '${app.kind}'`);
  }
  for (const app of config.apps) for (const up of app.upstreams || []) {
    if (!names.has(up)) errors.push(`apps.${app.name}.upstreams: '${up}' is not an app in this config`);
  }
  // one pipeline pair per app: an app path must not contain another app's path
  for (const a of config.apps) for (const b of config.apps) {
    if (a !== b && (normPath(b.path) === normPath(a.path) || normPath(b.path).startsWith(normPath(a.path) + "/"))) errors.push(`apps: path of '${b.name}' (${b.path}) lies inside the path of '${a.name}' (${a.path}); app paths must be disjoint`);
  }
  for (const app of config.apps) if ((app.paths || []).length && !String(app.stack).startsWith("dotnet")) {
    errors.push(`apps.${app.name}.paths: shared inputs outside the app path are implemented for dotnet8-api only (the ${app.stack} Dockerfile builds from the app path; JS shared packages are planned)`);
  }
  if (config.options.versioning === "semantic-release" && config.apps.length > 1) {
    errors.push("options.versioning=semantic-release with several apps is 'planned': per-app tags in a monorepo are not implemented yet. Use nbgv, or keep a single app.");
  }
  const envs = config.environments; if (new Set(envs).size !== envs.length) errors.push("environments: duplicate names");
  if (config.options.branching === "gitflow" && !envs.includes("dev")) errors.push("branching=gitflow expects a 'dev' environment for the develop branch");
  return errors;
}

function loadConfig(file) {
  if (!fs.existsSync(file)) throw new Error(`config not found: ${file}`);
  const config = applyDefaults(loadYaml(file));
  const options = loadOptions();
  const errors = checkConfig(config, options);
  return { config, options, errors };
}

const normPath = p => String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
const uniq = arr => [...new Set(arr)];
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");

// .NET ProjectReferences of a csproj, recursively, as repository-relative csproj paths (deterministic order).
function dotnetRefs(repoRoot, csprojRel, seen = new Set()) {
  const abs = path.join(repoRoot, csprojRel);
  if (seen.has(csprojRel) || !fs.existsSync(abs)) return [];
  seen.add(csprojRel);
  const out = [];
  for (const m of fs.readFileSync(abs, "utf8").matchAll(/<ProjectReference\s+[^>]*Include\s*=\s*"([^"]+)"/g)) {
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(csprojRel), m[1].replace(/\\/g, "/")));
    if (rel.startsWith("..")) continue; // outside the repository: cannot be a build input of this repo
    out.push(rel, ...dotnetRefs(repoRoot, rel, seen));
  }
  return out;
}

// Values derived from config used by templates.
// Deterministic build defaults per stack; repoRoot is needed to detect the .NET project file.
function buildDefaults(app, repoRoot) {
  const b = { ...(app.build || {}) };
  if (app.stack === "dotnet8-api") {
    b.dotnet_version = b.dotnet_version || "8.0";
    if (!b.project && repoRoot) {
      const dir = path.join(repoRoot, app.path);
      const found = [];
      const walk = (d, depth) => { if (depth > 4 || !fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!/^(bin|obj|node_modules|\.git)$/.test(e.name)) walk(path.join(d, e.name), depth + 1); }
        else if (e.name.endsWith(".csproj") && !/test/i.test(path.relative(dir, path.join(d, e.name)))) found.push(path.relative(dir, path.join(d, e.name))); } };
      walk(dir, 0);
      if (found.length === 1) b.project = found[0].split(path.sep).join("/");
      else if (found.length > 1) b.error = `apps.${app.name}: several .csproj candidates (${found.join(", ")}); set build.project in .slipway/config.yaml`;
      else b.error = `apps.${app.name}: no .csproj found under ${app.path}; set build.project in .slipway/config.yaml`;
    }
    if (!b.assembly && b.project) b.assembly = path.basename(b.project, ".csproj");
    b.project_dir = b.project ? path.posix.dirname(b.project) : ".";
  }
  if (app.stack === "react-vite" || app.stack === "node-ts-api") { b.node_version = b.node_version || "22"; b.dist_dir = b.dist_dir || "dist"; }
  if (app.stack === "react-vite") b.nginx_version = b.nginx_version || "1.29";
  return b;
}

// Is `p` (repository-relative) a file? Existing paths answer for themselves; unrendered workflow files and dotfiles are files.
function isFilePath(repoRoot, p) {
  try { if (repoRoot) return fs.statSync(path.join(repoRoot, p)).isFile(); } catch { /* not on disk yet */ }
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /^\.[^/]+$/.test(p);
}

function derive(config, options, repoRoot) {
  const registryHost = config.options.registry === "acr" ? `${config.azure.acr_name}.azurecr.io`
    : config.options.registry === "ghcr" ? "ghcr.io" : "<registry>";
  const env = config.environments[0];
  const byName = Object.fromEntries(config.apps.map(a => [a.name, a]));
  const namePrefix = (config.pipelines && config.pipelines.name_prefix) || (config.github && config.github.repo) || config.project.name;
  const sharedPaths = uniq((config.shared_paths || []).map(normPath));
  const pipelines = {
    name_prefix: namePrefix,
    cd_trigger: config.options.cd_trigger, pr_checks: config.options.pr_checks, cd_approval: config.options.cd_approval, in_session_approval: config.options.cd_approval === "in-session",
    auto_cd: config.options.cd_trigger === "on-ci-success", gate: config.options.pr_checks === "always-run-gate",
  };
  // Upstream reachability differs per compute: on Container Apps every app is reachable as http://<app-name> (port 80,
  // through the environment proxy); in local docker compose the service name resolves and the container port is used.
  const apps = config.apps.map((a, i) => {
    const appPath = normPath(a.path);
    const upstreams = (a.upstreams || []).map(n => ({ name: n, port: byName[n]?.port || 8080, path_prefix: "/api/",
      url_cloud: config.options.compute === "aca" ? `http://${n}` : `http://${n}:${byName[n]?.port || 8080}`,
      url_local: `http://${n}:${byName[n]?.port || 8080}` }));
    const build = buildDefaults(a, repoRoot);
    // Build inputs outside the app path: declared `paths` plus detected .NET project references.
    const refs = a.stack.startsWith("dotnet") && build.project && repoRoot ? dotnetRefs(repoRoot, `${appPath}/${build.project}`) : [];
    const refDirs = uniq(refs.map(r => path.posix.dirname(r)));
    const extraPaths = uniq([...(a.paths || []).map(normPath), ...refDirs.filter(d => !inside(d, appPath))]);
    const contextRoot = extraPaths.length > 0; // the Docker build context must contain every input
    build.context = contextRoot ? "." : appPath;
    build.dockerfile = `${appPath}/Dockerfile`;
    build.dockerfile_from_context = contextRoot ? `${appPath}/Dockerfile` : "Dockerfile";
    build.context_root = contextRoot;
    build.src_prefix = contextRoot ? `${appPath}/` : ""; // prefix of app-relative paths when copied from the context
    build.copy_dirs = contextRoot ? [appPath, ...extraPaths] : ["."];
    build.dep_project_dirs = refDirs.map(d => contextRoot ? d : path.posix.relative(appPath, d) || ".");
    if (build.project) {
      build.project_from_context = contextRoot ? `${appPath}/${build.project}` : build.project;
      build.project_dir_from_context = path.posix.dirname(build.project_from_context);
    }
    const workflowBase = `${namePrefix}-${a.name}`, workflowCi = `${workflowBase}-ci`, workflowCd = `${workflowBase}-cd`;
    const infraDir = `infra/apps/${a.name}`;
    const pipelinePaths = uniq([appPath, ...extraPaths, ...sharedPaths,
      `.github/workflows/${workflowCi}.yml`, `.github/workflows/${workflowCd}.yml`, `.github/workflows/_ci.yml`, `.github/workflows/_cd.yml`,
      infraDir, ...(contextRoot ? [".dockerignore"] : [])]);
    const triggerPaths = pipelinePaths.map(p => isFilePath(repoRoot, p) ? p : `${p}/**`);
    return { ...a, path: appPath, image: `${registryHost}/${a.image_repository}`, image_local: `${config.project.name}/${a.name}`, local_port: 8080 + i,
      is_node: a.stack === "react-vite" || a.stack === "node-ts-api", is_dotnet: a.stack.startsWith("dotnet"),
      external: a.kind !== "worker", has_ingress: a.kind !== "worker",
      secrets: a.secrets || [], env_list: Object.entries(a.env || {}).map(([k, v]) => ({ name: k, value: v })),
      cpu: (a.resources && a.resources.cpu) || 0.25, memory: (a.resources && a.resources.memory) || "0.5Gi",
      min_replicas: (a.scale && a.scale.min !== undefined) ? a.scale.min : 1, max_replicas: (a.scale && a.scale.max) || 2,
      upstream_names: a.upstreams || [],
      build, upstream_list: upstreams, primary_upstream: upstreams[0] || null,
      // per-app delivery
      workflow_base: workflowBase, workflow_ci: workflowCi, workflow_cd: workflowCd,
      extra_paths: extraPaths, pipeline_paths: pipelinePaths, trigger_paths: triggerPaths,
      path_filters: pipelinePaths.map(p => `/${p}`),
      version_file: `${appPath}/version.json`, initial_version: a.version || "0.1",
      tag_prefix: `${a.name}/v`, tag_name_format: `${a.name}/v{version}`, release_branch_format: `release/${a.name}-v{version}`,
      infra_dir: infraDir, state_key: `${config.project.name}/apps/${a.name}/${env}.tfstate`, evidence_dir: `.slipway/evidence/${a.name}` };
  });
  return {
    env,
    plugin_version: pluginVersion(),
    marketplace: { name: options.distribution.marketplace, repo: options.distribution.repo, plugin: options.distribution.plugin },
    registry_host: registryHost,
    pipelines, shared_paths: sharedPaths, multi_app: apps.length > 1,
    tracking: { enabled: config.options.tracker !== "none", tracker: config.options.tracker,
      story_key: config.jira?.story_key || null, epic_key: config.jira?.epic_key || null, subtask_issue_type: config.jira?.subtask_issue_type || "Subtask" },
    apps,
    has_frontend: apps.some(a => a.kind === "frontend"),
    has_dotnet: apps.some(a => a.stack.startsWith("dotnet")),
    has_node: apps.some(a => a.stack === "react-vite" || a.stack === "node-ts-api"),
    has_worker: apps.some(a => a.kind === "worker"),
    option_labels: Object.fromEntries(Object.entries(config.options).map(([dim, v]) => [dim, options.dimensions[dim].options[v]?.label || v])),
    option_rows: Object.entries(config.options).map(([dim, v]) => ({ dimension: dim, option: v, label: options.dimensions[dim].options[v]?.label || v, status: options.dimensions[dim].options[v]?.status || "unknown" })),
  };
}

module.exports = { PLUGIN_ROOT, OPTIONS_PATH, OPTION_DEFAULTS, loadYaml, loadOptions, loadConfig, checkConfig, applyDefaults, derive, pluginVersion, dotnetRefs };
