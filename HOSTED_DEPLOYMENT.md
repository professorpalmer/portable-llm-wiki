# Hosted deployment guide

This doc covers running **portablellm.wiki** in multi-tenant mode (the
hosted product) on Vercel + Render. For the OSS self-host path (one wiki
per deploy, single owner) see [README.md](./README.md) — that mode is
unchanged.

## Architecture

Two domains, one wiki per user:

```
portablellm.wiki        →  Vercel  →  Next.js frontend (this repo /frontend)
api.portablellm.wiki    →  Render  →  FastAPI backend  (this repo /backend)
```

Why two subdomains and not one Vercel rewrite proxy: when a user signs in
with GitHub, the backend sets an HttpOnly session cookie. Cookies are
scoped to the host that set them. If the frontend (`portablellm.wiki`)
calls the backend through Vercel's rewrite to `api.portablellm.wiki`, the
browser doesn't send the cookie back to `portablellm.wiki` (because the
cookie is for `api.portablellm.wiki`). The fix is to have the frontend
call the API at its real subdomain, so cookies + CORS line up.

Per-user wikis live under `/<github_login>/`:

```
portablellm.wiki/alice             →  alice's wiki landing
portablellm.wiki/alice/llm         →  LLM handshake (the viral hook)
portablellm.wiki/alice/llms.txt    →  llms.txt convention
api.portablellm.wiki/t/alice/...   →  raw API for alice's wiki
```

## One-time setup

### 1. GitHub OAuth App

Register the OAuth App at <https://github.com/settings/applications/new>:

* **Application name**: Portable LLM Wiki
* **Homepage URL**: `https://portablellm.wiki`
* **Authorization callback URL**: `https://api.portablellm.wiki/auth/github/callback`

Click "Generate a new client secret" — copy both the **Client ID** and
**Client Secret** for the env vars below.

The OAuth app requests `read:user, repo`. We need `repo` (not
`public_repo`) so we can create and push **one** wiki repository on the
user's account and import a private wiki they already have. An OAuth
App cannot be limited to a single repo — that is honest, and it is why
GitHub's consent screen looks broad. Do not switch live OAuth to
`public_repo`; that breaks private-wiki import and push.

The narrower path is a GitHub App the user installs on just that one
repo. Leave the App unset until you create it; OAuth keeps working.

### 1b. GitHub App (optional, later)

When you are ready to narrow trust, create a GitHub App at
<https://github.com/settings/apps/new>:

* **Name**: Portable LLM Wiki
* **Homepage URL**: `https://portablellm.wiki`
* **Webhook**: inactive until you need one
* **Repository permissions**: Contents (read/write), Metadata (read).
  No org or account-wide administration.
* **Where can this GitHub App be installed?**: Only on this account,
  then install it on the one wiki repo (or let each user install it on
  theirs).

Generate a private key. Set on the backend (empty = unused):

```bash
GITHUB_APP_ID=<numeric app id>
GITHUB_APP_PRIVATE_KEY=<PEM; literal \n newlines are fine>
GITHUB_APP_INSTALL_URL=https://github.com/apps/<slug>/installations/new
# Optional, single-install deploys only:
# GITHUB_APP_INSTALLATION_ID=<numeric installation id>
```

You do not need to create the App for the current OAuth path or for
CI. Tests mock the installation-token mint.

### 2. DNS

In Namecheap (or wherever the domain lives), add a CNAME for the API
subdomain:

```
Type  Host  Value
CNAME api   <your-render-app>.onrender.com
```

After DNS propagates (~minutes), add `api.portablellm.wiki` as a custom
domain in Render's settings for your backend service.

### 3. Render: backend env vars

In the Render dashboard for the FastAPI service, set:

```bash
# Multi-tenant mode
SINGLE_TENANT_MODE=0
TENANTS_ROOT=/app/tenants              # must match render.yaml disk mountPath

# Session cookie
SESSION_SECRET=<openssl rand -hex 32>
SESSION_COOKIE_NAME=plw_session

# GitHub OAuth
GITHUB_OAUTH_CLIENT_ID=<from step 1>
GITHUB_OAUTH_CLIENT_SECRET=<from step 1>
GITHUB_OAUTH_REDIRECT_URL=https://api.portablellm.wiki/auth/github/callback

# Public URLs
PUBLIC_BASE_URL=https://portablellm.wiki
CORS_ORIGINS=https://portablellm.wiki

# Default tier for new pages. Private so nothing is public until the
# owner promotes it. Avery demo pages stay public via the seeder.
DEFAULT_TIER=private

# Anthropic + OpenAI keys: still shared in v1.0. v1.1 adds per-tenant
# BYO LLM keys.
ANTHROPIC_API_KEY=<key>
```

`OWNER_TOKEN` is **not a master key** in hosted mode — it must not
unlock another tenant's `/owner/*` routes. Each tenant is owned by a
matching session cookie or that tenant's private personal-LLM share
token. You can leave `OWNER_TOKEN` unset.

Make sure the Render disk `mountPath` is `/app/tenants` so
`TENANTS_ROOT=/app/tenants` survives restarts (see `render.yaml`).

Sign-out and switch-account in the nav must **POST** (`POST /auth/logout`,
`POST /auth/switch-account`). GET on those paths does not clear the
session.

### 4. Vercel: frontend env vars

In the Vercel project for the frontend, set:

```bash
NEXT_PUBLIC_HOSTED_MODE=1
NEXT_PUBLIC_BACKEND_URL=https://api.portablellm.wiki
```

Redeploy — `next.config.mjs` reads these at build time.

### 5. Avery demo (one-time seed)

The Avery demo wiki seeds itself on first cold-start in multi-tenant
mode (see `backend/app/avery_seed.py`). If you ever want to re-seed,
SSH into the Render shell and run:

```bash
python scripts/seed_avery_tenant.py --force
```

## Verify the flow

After deploy, walk through the viral path manually:

1. <https://portablellm.wiki/> — landing page should show "Sign in with GitHub"
2. <https://portablellm.wiki/avery> — Avery demo loads, chat works
3. <https://portablellm.wiki/api/backend/t/avery/llm> — returns markdown briefing
4. Click "Sign in with GitHub" → GitHub consent → land on `/welcome`
5. Paste a bio in the welcome wizard → wait for orchestrator → land on `/<your-login>`
6. Copy the LLM URL `portablellm.wiki/<your-login>/llm` into a ChatGPT/Claude chat → it should fetch and respond with context about you

If any step fails, check the Render service logs first — every hosted
route logs the tenant id it resolved and any error from GitHub.

## Cost expectations

* **Vercel** Hobby ($0): plenty for the frontend.
* **Render** Starter ($7/mo): web service + 1 GB persistent disk for
  tenant wikis. Free tier works but cold-starts hurt OAuth latency.
* **Anthropic / OpenAI**: pay-per-use. With a shared key + cheap models
  (Sonnet for query, Haiku for orchestrator drafts), expect ~$0.01 per
  ten-page wiki seed. Set a monthly cap on the API console.

## GitHub sync (shipped)

Every content mutation (ingest, capture, import, page edit) is committed
and pushed to the user's own GitHub repo using their stored OAuth token —
debounced so a burst of writes coalesces into one commit. The round-trip
is implemented in `backend/app/persistence.py` (`flush_async` /
`flush_tenant_async`, plus the pull path `pull_tenant_now`) and surfaced
through `POST /owner/sync/now`, `POST /owner/sync/pull`, and
`GET /owner/sync/status`. On owner login the backend does a best-effort
pull so edits made on github.com (or another device) show up.

Durability is observable, never silent: every create/mutate response
carries a `sync` verdict (`persistence.describe_sync`) reporting whether
the write will actually reach a remote. When it won't — self-host with no
`WIKI_GIT_REMOTE`, or a hosted tenant that hasn't connected a repo — the
MCP and the web UI surface a loud, actionable warning instead of a green
"saved" that implies durability it doesn't have.

## What's intentionally NOT included in v1.0

* **BYO LLM keys**: users share our keys with a per-account monthly cap.
  v1.1 adds a settings UI for pasting their own key + opt-out of the
  shared key.
* **Per-tenant rate limiting**: in v1.0 the existing IP-based limiter
  applies. v1.1 adds per-tenant quotas.
* **Page edit UI under `/<tenant>/`**: existing single-tenant editor at
  `/owner` works but isn't yet wired to the tenant routing. v1.1 moves
  these pages under `/<tenant>/owner`.
