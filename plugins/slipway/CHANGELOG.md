## [1.1.4](https://github.com/integranz/slipway/compare/v1.1.3...v1.1.4) (2026-09-23)

### Bug Fixes

* **hooks:** concurrent deliveries of one tool call share one approval; stale replay markers cleaned ([#10](https://github.com/integranz/slipway/issues/10)) ([f2a0003](https://github.com/integranz/slipway/commit/f2a00039251b7da7d413d46eea21f4a11a75b255))

## [1.1.3](https://github.com/integranz/slipway/compare/v1.1.2...v1.1.3) (2026-09-23)

### Bug Fixes

* **skills:** strict-YAML frontmatter so Cursor loads all 8 skills and 3 subagents ([#9](https://github.com/integranz/slipway/issues/9)) ([29bff79](https://github.com/integranz/slipway/commit/29bff79c31b14668d6c549bcc82cb2fb14b48e97))

## [1.1.2](https://github.com/integranz/slipway/compare/v1.1.1...v1.1.2) (2026-09-23)

### Bug Fixes

* **secrets:** Key Vault secret values are a listed human step; launch and deploy check them; guard gates az keyvault secret ([#8](https://github.com/integranz/slipway/issues/8)) ([85fa7e7](https://github.com/integranz/slipway/commit/85fa7e77b4d66e35ad235d539f702c6540a66fe9))

## [1.1.1](https://github.com/integranz/slipway/compare/v1.1.0...v1.1.1) (2026-09-22)

### Bug Fixes

* **cursor:** enforce the guards through the hook sources Cursor 3.21 actually loads ([#5](https://github.com/integranz/slipway/issues/5)) ([5cbf7ff](https://github.com/integranz/slipway/commit/5cbf7ffd4aa711ccdbf0a2935fa758417b24beae))

## [1.1.0](https://github.com/integranz/slipway/compare/v1.0.1...v1.1.0) (2026-09-22)

### Features

* **cursor:** slipway installs as a Cursor plugin ([#4](https://github.com/integranz/slipway/issues/4)) ([062803b](https://github.com/integranz/slipway/commit/062803b95543bb7bac474da6f1f1689fa81fd5aa))

## [1.0.1](https://github.com/integranz/slipway/compare/v1.0.0...v1.0.1) (2026-09-22)

### Bug Fixes

* **release:** push release commits and tags with the slipway-release app token ([43d1bab](https://github.com/integranz/slipway/commit/43d1bab2f1a3381b5afe48d49f6729e0dde07c19))

## [1.0.0](https://github.com/integranz/slipway/compare/v0.16.1...v1.0.0) (2026-09-21)

### ⚠ BREAKING CHANGES

* **freeze:** first stable release; the 0.x line is closed. No consumer-facing contract changes
relative to 0.16.1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>

### Miscellaneous Chores

* **freeze:** freeze plugin contents as 1.0.0 for the Q3 review ([f350c57](https://github.com/integranz/slipway/commit/f350c5752bbde0af880ae161f3b55b87d8899242))

## [0.16.1](https://github.com/integranz/slipway/compare/v0.16.0...v0.16.1) (2026-09-21)

### Bug Fixes

* **ci:** a re-run of the same workflow run reuses the image its earlier attempt already pushed ([95e1b5e](https://github.com/integranz/slipway/commit/95e1b5ef122e0e30aa6bbeac03c0b1b327843949))

## [0.16.0](https://github.com/integranz/slipway/compare/v0.15.2...v0.16.0) (2026-09-21)

### Features

* **stacks:** any stack, any structure — custom Dockerfile stack, apps at the repository root, per-app CI service containers ([3b9dfa2](https://github.com/integranz/slipway/commit/3b9dfa27c971c02f5573a6ac203a6cea8cec88d7))

## [0.15.2](https://github.com/integranz/slipway/compare/v0.15.1...v0.15.2) (2026-09-20)

### Bug Fixes

* **templates:** track the seed-file example template (was excluded by the repo's .env ignore rule) ([1a5d30c](https://github.com/integranz/slipway/commit/1a5d30c7b367eda82edf6caa48a95a2488cdbaaa))

## [0.15.1](https://github.com/integranz/slipway/compare/v0.15.0...v0.15.1) (2026-09-20)

### Bug Fixes

* **preflight:** drop an unused variable flagged by shellcheck ([7a65e72](https://github.com/integranz/slipway/commit/7a65e7203a7f035ecca51b80200ba7dd3c5413c4))

## [0.15.0](https://github.com/integranz/slipway/compare/v0.14.3...v0.15.0) (2026-09-20)

### Features

* **launch:** one command end to end with in-session approvals, secret seeding and GitHub administration ([63104bb](https://github.com/integranz/slipway/commit/63104bb35911f751bdc29cf7afa08cb26f4eddcc))

## [0.14.3](https://github.com/integranz/slipway/compare/v0.14.2...v0.14.3) (2026-09-20)

### Bug Fixes

* **tracking:** story follows its subtasks, mandatory auto-close line, tool surface facts; verify hygiene claim refutes only on sensitive files ([85e32ee](https://github.com/integranz/slipway/commit/85e32ee74d57f55b14513faa5f05a6c59a05f7e2))

## [0.14.2](https://github.com/integranz/slipway/compare/v0.14.1...v0.14.2) (2026-09-20)

### Bug Fixes

* **skills:** verify records the deploy subtask (find or create), covering deployments started by workflow_run ([8e1afb6](https://github.com/integranz/slipway/commit/8e1afb6afc49535798e6e962c4523739d7da09be))

## [0.14.1](https://github.com/integranz/slipway/compare/v0.14.0...v0.14.1) (2026-09-20)

### Bug Fixes

* **workflows:** always-run `<app> ci` result job so required checks resolve when the gate skips the app ([2e28326](https://github.com/integranz/slipway/commit/2e28326ebeea3bbc40dde9b42c977a09f8f69411)), closes [#7](https://github.com/integranz/slipway/issues/7)

## [0.14.0](https://github.com/integranz/slipway/compare/v0.13.3...v0.14.0) (2026-09-20)

### Features

* **tracking:** epic → story → subtask model, tracker none, offline queue that never blocks delivery ([3335248](https://github.com/integranz/slipway/commit/3335248f256730ea1cb9fbe1c00f183206e69258))

## [0.13.3](https://github.com/integranz/slipway/compare/v0.13.2...v0.13.3) (2026-09-17)

### Bug Fixes

* **hooks:** deny self-approval even without terraform in the same command ([ad58119](https://github.com/integranz/slipway/commit/ad581193faafd94690aedd2b3af750f4d0c5bd5c))

## [0.13.2](https://github.com/integranz/slipway/compare/v0.13.1...v0.13.2) (2026-09-17)

### Bug Fixes

* **workflows:** check names carry the app name so branch protection can require them per app ([b4ada74](https://github.com/integranz/slipway/commit/b4ada7472cb7659234b3ce0710ab5ad6353f2693))

## [0.13.1](https://github.com/integranz/slipway/compare/v0.13.0...v0.13.1) (2026-09-17)

### Bug Fixes

* **cd:** smoke test waits until the new revision serves the deployed version ([749c530](https://github.com/integranz/slipway/commit/749c5303fe778d5325e086965c3935ceb20c4f0f))

## [0.13.0](https://github.com/integranz/slipway/compare/v0.12.3...v0.13.0) (2026-09-17)

### Features

* **pipelines:** one CI and one CD workflow per app, path-filtered, with per-app versions and Terraform modules ([b9dfce9](https://github.com/integranz/slipway/commit/b9dfce9cec89a7a6dd5249713630efad9073aef1))

## [0.12.3](https://github.com/integranz/slipway/compare/v0.12.2...v0.12.3) (2026-09-16)

### Bug Fixes

* **azure-setup:** dry run reports an existing state container instead of 'would create' ([01579c2](https://github.com/integranz/slipway/commit/01579c24476296b19d1da3683742806fa8d3c495))

## [0.12.2](https://github.com/integranz/slipway/compare/v0.12.1...v0.12.2) (2026-09-16)

### Bug Fixes

* **azure-setup:** update a federated credential whose name exists with a stale subject ([0374dd3](https://github.com/integranz/slipway/commit/0374dd3e3cfb09a041ae197df06c7ea5d60ae12c))

## [0.12.1](https://github.com/integranz/slipway/compare/v0.12.0...v0.12.1) (2026-09-16)

### Bug Fixes

* **hooks:** shellcheck directive for the literal-tilde case pattern in guard-terraform-apply ([7e81cf0](https://github.com/integranz/slipway/commit/7e81cf05a7ac2e5b2dc81b09bd82e797b778afda))

## [0.12.0](https://github.com/integranz/slipway/compare/v0.11.0...v0.12.0) (2026-09-16)

### Features

* **rename:** plugin adlc -> slipway (marketplace slipway-marketplace, config dir .slipway, namespace /slipway:*) ([0adda30](https://github.com/integranz/slipway/commit/0adda305e1312362b43f1fb8a276fca34d9e425a))

## [0.11.0](https://github.com/integranz/adlc/compare/v0.10.1...v0.11.0) (2026-09-16)

### Features

* **plugin:** MIT license, security and license checklist completed, cloud environment setup script template ([6a536d6](https://github.com/integranz/adlc/commit/6a536d61ebbcf8c6046850fd32d1114290668299))

## [0.10.1](https://github.com/integranz/adlc/compare/v0.10.0...v0.10.1) (2026-09-15)

### Bug Fixes

* **verify:** drift means resource changes (outputs-only refresh is confirmed with a note); ignore own evidence files in the clean-tree claim ([2b7b41c](https://github.com/integranz/adlc/commit/2b7b41c7bb43da3497b9a88bf9c1943b15faf941))

## [0.10.0](https://github.com/integranz/adlc/compare/v0.9.0...v0.10.0) (2026-09-15)

### Features

* **verify:** deterministic verification script, verify and ticket skills; stable resource tags ([a50437e](https://github.com/integranz/adlc/commit/a50437efae836c557efa4dbfe30d013540902332))

## [0.9.0](https://github.com/integranz/adlc/compare/v0.8.2...v0.9.0) (2026-09-15)

### Features

* **deploy:** Container Apps app layer, gated CD workflow, deploy skill, immutable-tag guard in CI ([f05ee2d](https://github.com/integranz/adlc/commit/f05ee2db66a1f9638d1773a0427c933082fe1626))

## [0.8.2](https://github.com/integranz/adlc/compare/v0.8.1...v0.8.2) (2026-09-15)

### Bug Fixes

* **setup-azure:** read GitHub's OIDC subject prefix (immutable subject claims) before creating federated credentials ([d359fee](https://github.com/integranz/adlc/commit/d359feed45a82c7f85bd89af3a5379cbad4cd53d))

## [0.8.1](https://github.com/integranz/adlc/compare/v0.8.0...v0.8.1) (2026-09-15)

### Bug Fixes

* **ci:** install Node dependencies (npm ci) per app before running tests ([c854226](https://github.com/integranz/adlc/commit/c8542267103af9f82f69bc8ef0588062b9ab2925))

## [0.8.0](https://github.com/integranz/adlc/compare/v0.7.1...v0.8.0) (2026-09-15)

### Features

* **ci:** GitHub Actions CI template with nbgv and semantic-release variants ([e7803e0](https://github.com/integranz/adlc/commit/e7803e0382b3e927f8218c425fcc49bfd06f010c))

## [0.7.1](https://github.com/integranz/adlc/compare/v0.7.0...v0.7.1) (2026-09-14)

### Bug Fixes

* **hooks:** resolve the plan file before pipes and redirects in guard-terraform-apply ([0ecf6e2](https://github.com/integranz/adlc/commit/0ecf6e2a7baa4046a5c2c526521f97f990d98957))

## [0.7.0](https://github.com/integranz/adlc/compare/v0.6.0...v0.7.0) (2026-09-14)

### Features

* **plan:** Terraform foundation layer templates and the plan skill ([44104ea](https://github.com/integranz/adlc/commit/44104eac56868d7d2215b83eb3bcbbe5eadff722))

## [0.6.0](https://github.com/integranz/adlc/compare/v0.5.1...v0.6.0) (2026-09-14)

### Features

* **dockerize:** DHI stack templates, compose, per-app build config and the dockerize skill ([8f6f81c](https://github.com/integranz/adlc/commit/8f6f81c4503e2bc55de21d93469205946f07dce1))

## [0.5.1](https://github.com/integranz/adlc/compare/v0.5.0...v0.5.1) (2026-09-13)

### Bug Fixes

* **setup-azure:** count inherited roles, never assign privileged roles, soft human assignments, report ABAC conditions ([7314301](https://github.com/integranz/adlc/commit/73143016cfce65f35aa50b89f2fa9be245f09b99))

## [0.5.0](https://github.com/integranz/adlc/compare/v0.4.1...v0.5.0) (2026-09-13)

### Features

* **templates:** idempotent .adlc/setup-azure.sh for Entra OIDC app registration, state storage and RBAC ([b691591](https://github.com/integranz/adlc/commit/b6915910916f53f01198c8ed8e9bbc3bf863d9d9))

## [0.4.1](https://github.com/integranz/adlc/compare/v0.4.0...v0.4.1) (2026-09-13)

### Bug Fixes

* **scaffold:** always merge .gitignore (even with --force) and check the <% delimiter in tests ([1580951](https://github.com/integranz/adlc/commit/1580951418531f9441f2cf4e15f4dab4db1b01c7))

## [0.4.0](https://github.com/integranz/adlc/compare/v0.3.0...v0.4.0) (2026-09-13)

### Features

* **templates:** .adlc/SETUP.md prerequisites checklist and identity-and-secrets reference ([d579c29](https://github.com/integranz/adlc/commit/d579c290131195400b7b2711a417bad8aeeaaed4))

## [0.3.0](https://github.com/integranz/adlc/compare/v0.2.0...v0.3.0) (2026-09-13)

### Features

* **bootstrap:** full intake skill with explicit defaults table and non-interactive refusal ([d35ab84](https://github.com/integranz/adlc/commit/d35ab84ee1a08f324d0255477adc354aa0b32749))

## [0.2.0](https://github.com/integranz/adlc/compare/v0.1.0...v0.2.0) (2026-09-09)

### Features

* **scaffold:** option-driven scaffold engine, repo-side templates and config validators ([64b29f1](https://github.com/integranz/adlc/commit/64b29f18d7cf446a7e35d3ad86b213959add51e6))

## [0.1.0](https://github.com/integranz/adlc/compare/v0.0.0...v0.1.0) (2026-09-09)

### Features

* guardrail hooks, role sub-agents and MCP servers for the adlc plugin ([03119b9](https://github.com/integranz/adlc/commit/03119b9cb2158e9304ff41e4264f317669f5d281))

### Bug Fixes

* point install docs at integranz, make azure ids optional, drop ignored plugin settings ([002368a](https://github.com/integranz/adlc/commit/002368a98f9ac506dfce6a7cc3e521081d158ffd))
* **release:** correct argv handling in plugin version bump script and self-test it in CI ([d3ece30](https://github.com/integranz/adlc/commit/d3ece30bddc2685735cb7f3748c5c83efd9cccf6))
* **release:** pin conventionalcommits preset to v8 for semantic-release writer compatibility ([335b7cf](https://github.com/integranz/adlc/commit/335b7cfdd7bb38522f0ac80db1dce41261cde070))

# Changelog

All notable changes to the `adlc` plugin are recorded here. Generated by semantic-release from Conventional Commits on `main`.
