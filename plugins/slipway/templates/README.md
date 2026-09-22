# Templates

Rendered into a target repository by `scripts/scaffold.cjs` according to `.slipway/config.yaml`.

| Location | Rendered when | Into |
|---|---|---|
| `common/files/**` | always | repo root |
| `<dimension>/<option>/files/**` | `options.<dimension> == <option>` | repo root |
| `stack/<stack>/app/**` | for each app with that stack | the app's `path` (context also has `app`) |
| `common/slipway/*` | never rendered: option registry, config schema, example config used by the plugin itself | — |

Rules: a `.tmpl` suffix is rendered with `scripts/lib/render.cjs` (`<% path %>`, `<%#each%>`, `<%#if%>`, `<%#eq%>`, `<%! comment %>`) and the suffix is stripped; any other file is copied verbatim. Existing files are never overwritten without `--force`; `.gitignore` is merged line-wise. Template context = the config plus `derived` (`plugin_version`, `marketplace`, `registry_host`, `apps[*].image`, `has_frontend`, `has_worker`, `option_rows`).

Adding an option: set its `status` in `common/slipway/options.yaml`, add the enum value to `common/slipway/config.schema.json` and rebuild the validator (`node scripts/build-validator.cjs` in the repo root), then add `<dimension>/<option>/files/` and `skills/delivery-knowledge/references/<dimension>-<option>.md`.
