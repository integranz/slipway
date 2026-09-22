# Versioning option `semantic-release`

- Source of truth: commit messages (Conventional Commits via `conventional-changelog-conventionalcommits@^8`; v10 of the preset is incompatible with the writer bundled in `@semantic-release/release-notes-generator`, learned on `integranz/slipway`). `feat:` → minor, `fix:` → patch, `!`/`BREAKING CHANGE:` → major; `docs:`/`chore:` → no release.
- Config: `.releaserc.json` (`branches: ["main"]`, `tagFormat: v${version}`, plugins commit-analyzer, release-notes-generator, changelog, exec, git, github). Runs only on the release branch in CI with `GITHUB_TOKEN`; creates the tag, the GitHub release and the `chore(release): vX.Y.Z [skip ci]` commit.
- In the slipway CI template the `version` job runs `npx semantic-release --dry-run --no-ci` and parses "The next release version is X.Y.Z" so images can be tagged **before** the release is published; the `release` job then runs `npx semantic-release` for real. Commits without a releasable type produce no version and the images are tagged `0.0.0-sha.<sha>` (not deployable by policy).
- Proven on the plugin repository itself (`integranz/slipway`: v0.1.0 → v0.7.1 cut automatically). The CI-image variant is rendered and YAML-validated by the scaffold tests but has not yet been exercised on an application repository.
- One versioning scheme per repository; switching is a `/slipway:bootstrap` decision.
