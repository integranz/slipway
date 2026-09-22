#!/usr/bin/env bash
set -euo pipefail

npm ci

if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code --prefix "${HOME}/.local"
fi
