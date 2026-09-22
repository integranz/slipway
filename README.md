# slipway marketplace

Source and marketplace for the **slipway** (Agentic Delivery Lifecycle) Claude Code plugin.

- Plugin: [`plugins/slipway`](plugins/slipway/README.md)
- Option registry: [`plugins/slipway/templates/common/slipway/options.yaml`](plugins/slipway/templates/common/slipway/options.yaml)
- Goal evidence docs: [`docs/`](docs/)

## Use the marketplace
```
/plugin marketplace add integranz/slipway
/plugin install slipway@slipway-marketplace
```

## Develop
```
npm ci
npm run validate:config-example
npm run validate:plugin        # needs the claude CLI
npm test                       # renderer + scaffold integration + 72 hook cases
node plugins/slipway/scripts/options.cjs            # what the interview offers
node plugins/slipway/scripts/scaffold.cjs --repo <target> --dry-run
claude --plugin-dir ./plugins/slipway
```
Releases: semantic-release on `main` from Conventional Commits; `plugins/slipway/.claude-plugin/plugin.json` and `plugins/slipway/CHANGELOG.md` are updated automatically.
