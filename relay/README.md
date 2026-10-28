# slipway relay — instant onboarding trigger

A Cloudflare Worker (free plan) that turns a GitHub **organisation webhook** into one `workflow_dispatch` of the onboarding poller (`onboard-poller.yml` in this repository) for the one repository the delivery is about. The poller does everything else: the welcome issue on an empty repository, the deployment environment and the pull-request ruleset, the Cursor cloud agent run, and it remains the backstop through its own 15-minute schedule. The relay only buys the latency: seconds instead of GitHub's best-effort cron (measured gaps of hours).

```
GitHub org webhook (Repositories + Pushes, HMAC secret)
  → slipway-relay: verify X-Hub-Signature-256 → filter → KV dedupe (X-GitHub-Delivery, 24 h)
  → POST /repos/integranz/slipway/actions/workflows/onboard-poller.yml/dispatches {inputs: {repository, source}}
  → 202 {run_url}
```

| Code | Meaning |
|---|---|
| 202 | dispatched; `run_url` points at the poller run (or the workflow page when GitHub returned 204) |
| 200 | `ping`, an ignored delivery (reason in the body), or a duplicate delivery |
| 401 | bad or missing signature |
| 400 / 405 / 413 | missing GitHub headers or bad JSON / not POST / body over 2 MB |
| 502 | the dispatch call failed (status and GitHub's message in the body and the log; **not** deduped, so *Redeliver* on GitHub retries it) |
| 500 | misconfigured: a secret or the KV binding is missing |

Forwarded: `repository` with action `created`, `publicized`, `unarchived`, `transferred`; `push` to the default branch of a live, non-fork, public repository (`FORWARD_PRIVATE_PUSHES=true` includes private ones). Never forwarded: the dispatch repository itself and `EXCLUDE_REPOS`.

## Secrets and variables
| Name | Where | Value |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Worker secret **and** the GitHub webhook | `openssl rand -hex 32`, clipboard only |
| `GITHUB_DISPATCH_TOKEN` | Worker secret | fine-grained PAT, resource owner the organisation, repository access **only the dispatch repository**, permission **Actions: read and write** (Metadata read implied). Expiry in the calendar |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub repository secrets (for `relay-deploy.yml`) | Cloudflare API token from the template "Edit Cloudflare Workers"; the account id from the Workers overview |
| KV namespace id | `wrangler.jsonc` | `npx wrangler@4 kv namespace create DEDUPE` once; an identifier without rights |

## Deploy
Automatic: a merge to `main` touching `relay/**` runs `.github/workflows/relay-deploy.yml` (tests, `wrangler deploy --dry-run`, then `cloudflare/wrangler-action` deploy). By hand, from this folder, after `npx wrangler@4 login`:
```
npx wrangler@4 secret put GITHUB_WEBHOOK_SECRET      # paste from the clipboard
npx wrangler@4 secret put GITHUB_DISPATCH_TOKEN
npx wrangler@4 deploy
curl -sS -o /dev/null -w '%{http_code}\n' https://slipway-relay.<your-subdomain>.workers.dev/   # 200
```
Then create the organisation webhook (organisation owner): Settings → Webhooks → Add webhook; Payload URL = the Worker URL; Content type `application/json`; Secret = `GITHUB_WEBHOOK_SECRET`; events "Let me select individual events": **Repositories** and **Pushes**. GitHub sends a `ping`: the delivery page must show `200 {"ok":true,"pong":true}`; a 401 means the secrets differ.

## Watch it
```
npx wrangler@4 tail slipway-relay --format pretty      # one JSON line per delivery: delivery, event, repository, decision, run_url; never bodies or tokens
```
A signed local test (`npx wrangler@4 dev` in another terminal):
```
body='{"zen":"ok","hook_id":1}'; sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | sed 's/^.* //')
curl -sS -X POST localhost:8787/ -H 'X-GitHub-Event: ping' -H 'X-GitHub-Delivery: local-1' -H "X-Hub-Signature-256: sha256=$sig" -H 'Content-Type: application/json' --data "$body"
```

## Limits and behaviour to know
Free plan: 100,000 requests/day, 10 ms CPU per request, KV 1,000 writes/day (one per forwarded delivery). KV is eventually consistent, so a replay within seconds can slip through: harmless, the poller is idempotent. GitHub never retries a failed delivery on its own: the poller's schedule covers it, and failed deliveries can be redelivered from the webhook page for three days. The poller runs under one concurrency group: a tick for a second repository within the same minute may wait for, or be replaced by, the newest pending run; the schedule covers that too.

## Tests
`node --test test/*.test.js` (also part of the repository's `npm test`): signature vectors incl. GitHub's documented one, the decision matrix, and the handler end to end against a stubbed `fetch` and an in-memory KV.
