---
paths:
  - ".github/workflows/**"
  - "**/CONTRIBUTING.md"
  - "version.json"
  - ".releaserc*"
---
# Branching rules (trunk-based)

- `main` is always releasable. Work happens on short-lived branches (`feat/<topic>`, `fix/<topic>`), merged by pull request with CI green.
- No long-lived `develop`, `release/*` or environment branches. Environments are promoted by deploying the same immutable tag, not by merging branches.
- Rebase or squash before merge so every commit on `main` is meaningful to the versioning tool.
- Hotfixes are ordinary fixes on `main`, released with the next version.
