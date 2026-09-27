#!/usr/bin/env bash
# Prints the prompt that onboards a repository to slipway delivery from a Cursor Cloud Agent, unattended
# (docs/CURSOR-ONBOARDING.md). Used by .github/workflows/onboard.yml and by humans who start the agent at
# cursor.com/agents. The agent installs the plugin at the given version itself (a repository that is not yet
# delivered by slipway has no .cursor/environment.json), runs `/slipway:launch --yes --until bootstrap` and commits on a
# branch; Cursor pushes the branch and opens the pull request. No credential is needed or given to the agent.
# Usage: onboard-prompt.sh <owner/repo> [--ref <branch>] [--version <plugin version>] [--answers <file>]
#   --ref      branch the agent starts from (default main)
#   --version  slipway version to install (default: this checkout's plugins/slipway/.claude-plugin/plugin.json)
#   --answers  file with interview answers the agent may not guess, one `key: value` per line
#              (azure.location, azure.resource_group, azure.acr_name, azure.key_vault_name, azure.identity_name,
#              azure.state.*, jira.site_url, jira.project_key, options.*); the file's text is inserted verbatim
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo="${1:-}"; shift || true
ref=main; version=""; answers_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="${2:?--ref needs a value}"; shift 2;;
    --version) version="${2:?--version needs a value}"; shift 2;;
    --answers) answers_file="${2:?--answers needs a file}"; shift 2;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done
case "$repo" in
  */*) [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must be owner/name: $repo" >&2; exit 2; };;
  *) echo "usage: onboard-prompt.sh <owner/repo> [--ref <branch>] [--version <plugin version>] [--answers <file>]" >&2; exit 2;;
esac
[[ "$ref" =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "ref must be a branch name: $ref" >&2; exit 2; }
if [ -z "$version" ]; then
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$here/plugins/slipway/.claude-plugin/plugin.json")"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$ ]] || { echo "version must be a plugin version like 1.6.0: $version" >&2; exit 2; }
name="${repo#*/}"
answers="(none given: rely on detections and the documented defaults; stop and report when a value without a default is missing)"
if [ -n "$answers_file" ]; then
  [ -s "$answers_file" ] || { echo "answers file is empty or missing: $answers_file" >&2; exit 2; }
  answers="$(sed 's/^/  /' "$answers_file")"
fi
cat <<PROMPT
You are onboarding the repository ${repo} (branch ${ref}) to slipway delivery. This run is UNATTENDED: nobody can
answer a question. Never ask; when a value is needed, not detectable and not given below, stop and report the list of
missing values instead of guessing.

Setup, in the terminal, before anything else (the plugin is not installed in this environment yet):
  rm -rf /tmp/slipway "\$HOME/.cursor/plugins/local/slipway"
  git clone -q --depth 1 --branch v${version} https://github.com/integranz/slipway /tmp/slipway
  mkdir -p "\$HOME/.cursor/plugins/local" && cp -R /tmp/slipway/plugins/slipway "\$HOME/.cursor/plugins/local/slipway"
  export CLAUDE_PLUGIN_ROOT="\$HOME/.cursor/plugins/local/slipway" SLIPWAY_PLUGIN_ROOT="\$HOME/.cursor/plugins/local/slipway" SLIPWAY_SESSION_ATTENDED=0 SLIPWAY_HOST=cursor
Keep these variables exported in every terminal you use; the skills run \`node "\${CLAUDE_PLUGIN_ROOT}/scripts/..."\`.

Then read "\$CLAUDE_PLUGIN_ROOT/skills/launch/SKILL.md" and execute, exactly as that skill describes:
  /slipway:launch --yes --until bootstrap --no-ticket
Interview answers for the bootstrap (they count as given; do not re-ask them):
${answers}

Rules for this run:
- Only preflight and bootstrap run. Missing \`az\`/\`gh\` logins are expected here: record them in the report and continue.
  No cloud, GitHub or secret administration, no terraform apply, no \`az\`, no \`gh secret\`, no \`gh api\` writes; print any
  human-only command instead of running it.
- When a skill delegates to a sub-agent (explore, execute, verify) that is not available here, do that step yourself.
- For a \`stack: custom\` app without a Dockerfile, draft one as the dockerize skill describes and write it without
  asking (\`--yes\`); it lands in the pull request. Build it only if \`docker version\` works; otherwise mark the image
  claims UNVERIFIABLE and say so.
- If the repository holds no deployable application, write nothing and report why.
- Commit your changes on a new branch: \`git switch -c slipway/onboard\`, one commit titled "slipway: onboard ${name}".
  Do NOT push and do NOT open a pull request: Cursor pushes the branch and opens the pull request when you finish.
- Never write a secret, a token, a subscription or tenant id into a file or a message.

End with a report: apps found (kind, stack, port, health path, evidence), files written, the human steps that remain
(from .slipway/SETUP.md: Azure prerequisites, GitHub secrets and environment, first CD approval), and every value you
could not decide.
PROMPT
