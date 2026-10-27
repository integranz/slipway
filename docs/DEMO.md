# Demo script — a repository becomes a deployed service without a human in the session

Audience: management. Length: 20–25 minutes. Story: an engineer creates an empty repository and pushes a small service; within a minute slipway has welcomed it, gated it and started one cloud agent; within fifteen minutes a pull request with the whole delivery exists; a human merges, approves the deployment, and the service answers on the shared platform with its Jira story updated. Every write to the engineer's repository until the merge is an issue, a comment or a label. Humans approve exactly three things: the pull request, the deployment, and the secret values.

```
gh repo create ──► org webhook ──► Cloudflare relay (free) ──► poller tick ──► welcome issue            (~1 min)
git push       ──► org webhook ──► relay ──► poller tick ──► gates (dev environment, PR-only ruleset) + one Cursor cloud agent
                                                              └─► pull request "slipway: onboard <name>"  (5–15 min)
merge ──► CI (test, version, image → shared registry, tag, Release) ──► Jira story ──► CD waits on `dev`
approve ──► Terraform apply (identity, roles, container app) ──► /health answers ──► Jira Deploy subtask Done   (~3–4 min)
```

## Roles and tabs
| Who | Does | Tabs |
|---|---|---|
| Presenter (organisation owner) | creates the repository, pushes, merges, approves | terminal with `wrangler tail`; the new repository; `integranz/slipway` Actions; Jira board; Cursor automations |
| Second terminal | `git push`, `curl /health` | — |

## Pre-demo checklist (T-60 minutes)
- [ ] `main` of `integranz/slipway` frozen since the day before; the release tag of the current version exists; nothing merges today.
- [ ] Poller: the last scheduled tick is green; `gh workflow run onboard-poller.yml -R integranz/slipway -f dry_run=true` → green, every repository `skip`.
- [ ] Relay: `curl -sS -o /dev/null -w '%{http_code}\n' https://slipway-relay.<subdomain>.workers.dev/` → `200`; the last webhook delivery on the organisation is 2xx; `npx wrangler@4 tail slipway-relay --format pretty` running in a visible terminal.
- [ ] Cursor: the assistant automation is active (when F1 passed); `gh workflow run onboard.yml -R integranz/slipway -f repository=integranz/taskflow-app -f dry_run=true` → green and lists the models; `CURSOR_API_KEY` not expired.
- [ ] Platform: `cae-slipway-dev` provisioning state Succeeded; `taskflow-app` `/health` answers; `ONBOARD_ANSWERS_TEMPLATE` says `options.platform_scope: shared` and names the platform; `ONBOARD_REVIEWERS` = the presenter's login.
- [ ] Organisation secrets present: `AZURE_*`, `DOCKERHUB_*`, `JIRA_API_TOKEN` + `JIRA_EMAIL`; `ONBOARD_GITHUB_TOKEN` and the relay's `GITHUB_DISPATCH_TOKEN` not expired (calendar).
- [ ] Sample app ready in a local folder: Node 22 Express `orders-api` with `GET /health` → `{status, version}` reading `VERSION`, `PORT` honoured, `npm test` green, **no Dockerfile** (the agent drafts it, CI proves it); `git init`, one commit on `main`, remote not yet added. Repository name `integranz/orders-api` free.
- [ ] Fallback material: links to the rehearsal run (issue, agent run, PR, CI, CD, Jira); a rehearsal repository parked at "PR open, CI green" (**demo-B**); a 3-minute recording of a full rehearsal.
- [ ] Browser tabs opened in order; terminal font large; notifications off.

## Timeline
| T | Action | Show | Fallback |
|---|---|---|---|
| 0:00 | One diagram (above): webhook → relay → poller → one agent → PR → CI → CD | slide | — |
| 0:02 | `gh repo create integranz/orders-api --public` (empty) | `wrangler tail`: `repository.created → dispatched` within 2–5 s; the webhook delivery `202`; the welcome issue `slipway onboarding` on the new repository within 45–90 s, with what to push and the answers the organisation provides | *Redeliver* on the webhook page; else `gh workflow run onboard-poller.yml -R integranz/slipway -f repository=integranz/orders-api -f source=demo` |
| 0:04 | `git remote add origin … && git push -u origin main` | tail: `push main → dispatched`; the issue relabelled `slipway-onboarding` with the gates comment; Settings → Environments shows `dev` with a required reviewer; Rules shows the PR-only ruleset; the `onboard` run in `integranz/slipway`; the agent page at cursor.com/agents | a manual `onboard.yml` dispatch with the template as answers |
| 0:05 | The assistant automation comments on the issue (when F1 passed) | cursor.com/automations run + the comment | the rehearsal run |
| 0:06–0:14 | The agent works. Talk track: what is deterministic (relay, poller, gates, CI, CD) and what is one LLM run (the onboarding pull request); the agent holds no credential; the Worker's token can start one workflow in one repository; the poller's token cannot push code; every write to the engineer's repository is an issue, a comment or a label until a human merges | the `onboard` run summary with the prompt; `integranz/taskflow-app#4` as the reference pull request | **demo-B** if the agent is still running after 12 minutes |
| ~0:14 | The pull request opens; CI runs on it (gate, test, version, image, ~3 min); the human-steps comment appears | `.slipway/config.yaml` (platform names, no ids), the hardened Dockerfile, `infra/apps/api` with its identity and roles, `SETUP.md` | the demo-B pull request |
| ~0:17 | Merge | CI on `main`: image pushed to `acrslipwaydev`, tag `api/v0.1.0`, Release; `slipway-tracker` creates the Jira story and closes Bootstrap and Dockerize; CD waits on `dev` | the demo-B run |
| ~0:20 | Approve `dev` | apply 2–4 min; `curl https://<fqdn>/health` → the version; the Jira Deploy subtask Done; the verification report on the Release | the live `taskflow-app` URL and its Jira story |
| ~0:24 | Close: what humans approved (pull request, deployment, secret values); cost: the relay is $0 on the free plan, one cloud-agent run per repository; what is next (per-app identities, more stacks) | — | — |

## Talk track, one line each
- "The organisation webhook is GitHub's own; the relay only checks the signature and forwards one repository name to one workflow."
- "The poller is a script with a token that can open issues and create a deployment environment. It cannot push code."
- "One cloud agent runs once per repository, with no credential at all. Its output is a pull request a human reads."
- "The deployment waits on a GitHub environment with a required reviewer that existed before the pull request did."
- "Jira follows the merge and the deployment from the workflows; nobody types a ticket update."

## After the demo
- Keep `integranz/orders-api` as evidence (issue, PR, Release, Jira story) or delete it; the container app and its identity are removed by `terraform destroy` from a human session only (never from an agent).
- Record the measured timings in the table below and in `docs/CURSOR-ONBOARDING.md` (first-run checks).

## Rehearsals (record here)
| Date | Repository | create → welcome | push → dispatch | dispatch → PR | merge → app answers | Notes |
|---|---|---|---|---|---|---|
| pending | | | | | | |
