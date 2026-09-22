# Vendored runtime libraries

| File | Package | Version | License | Why |
|---|---|---|---|---|
| `js-yaml.min.js` | js-yaml | 4.3.2 | MIT (see header of the file / https://github.com/nodeca/js-yaml/blob/master/LICENSE) | Parse `.slipway/config.yaml` and `options.yaml` with no `npm install` in target repos |
| `validate-config.generated.cjs` | generated from `templates/common/slipway/config.schema.json` by `scripts/build-validator.cjs` (ajv standalone) | — | — | Schema validation with no runtime dependency on ajv. Regenerate after every schema change (CI checks it is up to date). |
