---
paths:
  - ".github/workflows/**"
  - "**/CONTRIBUTING.md"
  - "version.json"
  - ".releaserc*"
---
# Branching rules (Gitflow) — PLANNED OPTION, template only

- `develop` integrates features; `release/*` stabilises a version; `main` receives merges from `release/*` and `hotfix/*` only.
- Versioning tool branch config must match: NBGV `publicReleaseRefSpec` includes `refs/heads/main` and `refs/heads/release/.*`; semantic-release `branches` lists `main` plus maintenance/prerelease branches.
- CI runs on every branch; image pushes happen only from `develop` (prerelease tags), `release/*` and `main`.
- This option is not exercised end to end yet; the interview refuses it until its status is `implemented`.
