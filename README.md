# Portable LLM Wiki

**The open protocol for piping your personal context into any LLM.**

Markdown files in your git repo, exposed over HTTP + native MCP, so
Cursor, Claude, ChatGPT, Gemini, or a local model can all read the
*same you* without re-onboarding.

<p align="center">
  <a href="https://portablellm.wiki">
    <img src="./docs/hero.png" alt="Portable LLM Wiki. The open protocol for piping your context into any LLM. Live demo streams a real answer with markdown citations." width="900">
  </a>
  <br>
  <em>The hosted demo answers in real time over SSE. Try it at <a href="https://portablellm.wiki">portablellm.wiki</a></em>
</p>

<p align="left">
  <a href="https://render.com/deploy?repo=https://github.com/professorpalmer/portable-llm-wiki">
    <img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="40">
  </a>
  &nbsp;
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fprofessorpalmer%2Fportable-llm-wiki&project-name=portable-llm-wiki-frontend&repository-name=portable-llm-wiki-frontend&root-directory=frontend&env=NEXT_PUBLIC_BACKEND_URL&envDescription=URL%20of%20your%20Render-deployed%20backend%20(no%20trailing%20slash)&envLink=https%3A%2F%2Fgithub.com%2Fprofessorpalmer%2Fportable-llm-wiki%2Fblob%2Fmain%2Fscripts%2Fdeploy.md">
    <img src="https://vercel.com/button" alt="Deploy to Vercel" height="40">
  </a>
</p>

> **Protocol**: implements the [llm-wiki spec v1](./SPEC.md). Any LLM
> that speaks the spec can talk to any conformant wiki.

> Mental model: the car-seat memory button. When you sit in a new car
> you don't re-explain your height. You press a button and the seat
> adjusts. Same idea for LLM sessions: instead of re-explaining
> yourself in every new chat, you plug in your wiki and the LLM
> adjusts.

## What it is

- **Vendor-neutral.** Your context lives in a git folder you own, not in
  a vendor's RAG database. Switch from Cursor to Claude to ChatGPT
  tomorrow and every assistant sees the same pages.
- **Three protocols, one source of truth.** HTTP
  (`/.well-known/llm-wiki.json`) for any client, **MCP** for Cursor /
  Claude Desktop, and a chat UI in the browser. All backed by the same
  markdown files.
- **Self-maintaining.** Optional `puppetmaster` integration runs the
  Karpathy ingest pipeline. Paste a Slack thread or upload a PDF and
  the wiki drafts entities, concepts, and cross-references for you,
  with a semantic lint swarm to catch contradictions and missing pages.

**Live demo:** [portablellm.wiki](https://portablellm.wiki). Meet Avery Chen, a fictional founding engineer at a synthetic-biology startup.

## Three ways to run your own

### Cloud (recommended. ~60 seconds)

Hit the **Deploy to Render** + **Deploy to Vercel** buttons above.
Render provisions the backend from `render.yaml`; Vercel deploys the
frontend from `frontend/vercel.json`. Render auto-generates your
`OWNER_TOKEN` and prompts you for `WIKI_GIT_REMOTE` (your own private
content repo).

→ Step-by-step in [scripts/deploy.md](scripts/deploy.md).

### Local (npx scaffolder)

```bash
npx create-portable-llm-wiki my-wiki
cd my-wiki   # → push to a private GitHub repo, then hit Deploy to Render
```

Or, to run the dev servers locally first:

```bash
git clone https://github.com/professorpalmer/portable-llm-wiki
cd portable-llm-wiki
./scripts/init.sh             # generates OWNER_TOKEN, prompts for wiki location
./scripts/dev-backend.sh      # terminal 1
(cd frontend && npm run dev)  # terminal 2
```

→ Details in [scripts/deploy.md → Local development](scripts/deploy.md#2-local-development-npx-scaffolder).

### Self-host (Docker)

For full self-hosting (your laptop, a Mac mini, a $5 VPS), the repo
ships a working `docker-compose.yml` that brings up both the backend
and the frontend wired together:

```bash
git clone https://github.com/professorpalmer/portable-llm-wiki
cd portable-llm-wiki
export OWNER_TOKEN="$(openssl rand -hex 32)"
docker compose up --build
# → http://localhost:3000
```

By default the compose stack mounts the bundled `wiki-demo/` so you can
see what works before you replace it with your own markdown folder.

For backend-only or custom orchestration:

```bash
docker run --rm -p 8000:8000 \
  -v /path/to/my-wiki:/app/wiki \
  -e OWNER_TOKEN="$(openssl rand -hex 32)" \
  -e DEFAULT_TIER=private \
  $(docker build -q -f backend/Dockerfile .)
```

→ Full compose walkthrough in [scripts/deploy.md → Self-host](scripts/deploy.md#3-self-host-docker).

## Connect from any LLM

Once your backend is up at e.g. `https://<your>.onrender.com`, point
any client at it.

**Cursor / Claude Desktop / any MCP client** (the package is on npm as
[`portable-llm-wiki-mcp`](https://www.npmjs.com/package/portable-llm-wiki-mcp)):

```json
{
  "mcpServers": {
    "portable-llm-wiki": {
      "command": "npx",
      "args": ["-y", "portable-llm-wiki-mcp"],
      "env": {
        "WIKI_API_BASE": "https://<your-backend>.onrender.com",
        "WIKI_OWNER_TOKEN": "<paste OWNER_TOKEN from Render>"
      }
    }
  }
}
```

The frontend's `/connect` page renders this config with your URLs
pre-filled, so you can copy-paste it directly into
`~/.cursor/mcp.json`.

**ChatGPT custom GPT / OpenWebUI / any HTTP client:**

```
GET https://<your-backend>.onrender.com/.well-known/llm-wiki.json
```

That one well-known document describes every endpoint (pages, search,
query, streaming chat, manifest), so a fresh LLM can introspect the
wiki without any vendor-specific glue.

## Fork checklist (after Deploy to Render)

When the Render Blueprint deploy finishes, your post-click runway is:

1. **Read your `OWNER_TOKEN`.** Render auto-generated one. Find it
   under your service → **Environment** → reveal `OWNER_TOKEN`. You'll
   paste this on the `/owner` page in the frontend.
2. **Create a private GitHub repo** for your wiki content (e.g.
   `https://github.com/<you>/my-wiki`). Easiest path: run
   `npx create-portable-llm-wiki my-wiki`, then push to that repo.
3. **Generate a GitHub PAT** at
   <https://github.com/settings/tokens?type=beta>. *Repository access:
   only my-wiki*; *Permissions: Contents → read and write*.
4. **Set `WIKI_GIT_REMOTE`** in the Render dashboard to
   `https://USER:PAT@github.com/<you>/my-wiki.git`. Render redeploys;
   on next boot the container clones your content repo and every write
   pushes back. Without this, writes are ephemeral and wiped on the
   next cold-start.
5. **(Optional) Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`** in the
   same env-var panel to upgrade `/wiki/query` from keyword fallback
   to LLM-backed answers.
6. **Click Deploy to Vercel**, set `NEXT_PUBLIC_BACKEND_URL` to your
   Render URL. Then return to Render and tighten `CORS_ORIGINS` +
   `PUBLIC_BASE_URL` to your Vercel URL.

Detailed walkthrough in [scripts/deploy.md](scripts/deploy.md).

## What's in the box

- **Backend**: FastAPI service that reads markdown, exposes a
  vendor-neutral HTTP API, enforces a 4-tier auth model (public /
  recruiter / friend / private), and optionally pushes every mutation
  back to a git remote for free-tier persistence. Render-ready
  Dockerfile, healthchecked, 100+ pytest tests on the
  security-critical paths.
- **Frontend**: Next.js + Tailwind app for browsing, querying,
  in-browser page editing, frictionless capture (paste / screenshot /
  voice memo), semantic lint, and tier management. Mobile-first nav.
  Open Graph metadata + dynamic `/og` image baked in.
- **MCP server**: Published as
  [`portable-llm-wiki-mcp`](https://www.npmjs.com/package/portable-llm-wiki-mcp)
  on npm. Exposes `query_wiki`, `read_page`, `search_wiki`,
  `list_pages`, `get_neighbors`, `ingest_source`, `lint_wiki` as
  first-class MCP tools. Inherits the backend's tier filtering for
  free.
- **`create-portable-llm-wiki` scaffolder**: One command to bootstrap
  a fresh content repo with starter pages, `.gitignore`, and an
  initialized git repo, ready to push to GitHub.

---

## Reference

Everything below this line is reference documentation. Read it when
you want to understand the internals. Not just to deploy your own
copy.

- For the wire protocol, see [SPEC.md](./SPEC.md).
- For contribution guidelines, see [CONTRIBUTING.md](./CONTRIBUTING.md).
- For security reporting, see [SECURITY.md](./SECURITY.md).
- For per-version ship notes, see [CHANGELOG.md](./CHANGELOG.md).

## Architecture

```
┌────────────────────┐  HTTP (vendor-neutral) ┌────────────────────┐
│  any LLM client    │ ─────────────────────► │  FastAPI backend   │
│  (Cursor / Claude  │                        │  (port 8000)       │
│   / GPT / browser) │ ◄───────────────────── │                    │
└────────────────────┘     JSON + markdown    └──────────┬─────────┘
                                                         │ reads
                                                         ▼
                                              ┌────────────────────┐
                                              │  ~/your-wiki/      │
                                              │   ├─ wiki/*.md     │
                                              │   └─ raw/*.md      │
                                              └────────────────────┘
                                                         ▲
                                                         │ proxies
┌────────────────────┐                        ┌──────────┴─────────┐
│       you          │ ─────────────────────► │ Next.js frontend   │
│   (browser)        │                        │ (port 3000)        │
└────────────────────┘                        └────────────────────┘
```

Four top-level components:

- **`backend/`**: FastAPI. Reads the wiki folder, exposes
  `/wiki/manifest.json`, `/wiki/page/{slug}`, `/wiki/search`,
  `/wiki/query`, `/wiki/chat`, plus owner-only `/owner/*` endpoints.
  Tier-based access via bearer token.
- **`frontend/`**: Next.js + Tailwind. Browser UI for browsing,
  querying, ingesting, lint, tier management. Same backend as any
  other LLM uses.
- **`mcp/`**: Native MCP server (TypeScript). Proxies the FastAPI
  backend so MCP clients (Cursor, Claude Desktop) see typed tools.
  Shipped on npm as `portable-llm-wiki-mcp`.
- **`create-portable-llm-wiki/`**: Standalone scaffolder published on
  npm; `npx create-portable-llm-wiki my-wiki` generates a fresh content
  repo with starter pages and an initialized git repo.

The wiki folder itself is yours. Any folder with `wiki/` + optional
`raw/` subdirectories following the Karpathy schema works.

## Local setup

The full one-command setup (used by the **Local** deploy path above):

```bash
./scripts/init.sh
```

That script installs Python + Node deps, writes `backend/.env` with a
freshly-generated `OWNER_TOKEN`, and asks where your wiki lives. The
default is the bundled demo wiki at `wiki-demo/` (Avery Chen). Pick
that for a zero-config first run. Or pick "scaffold a fresh wiki" to
clone the demo as a starting point you can then edit.

Then start the dev servers:

```bash
./scripts/dev-backend.sh        # terminal 1. Backend on :8000
(cd frontend && npm run dev)    # terminal 2. Frontend on :3000
```

Open <http://localhost:3000>. Paste the `OWNER_TOKEN` from
`backend/.env` on the `/owner` page to authenticate. The backend's
<http://localhost:8000/healthz> should respond with `{"status":"ok",…}`.

For the cloud path instead, see [scripts/deploy.md](scripts/deploy.md).

## Tier model

Every wiki page can declare `tier:` in its frontmatter. Valid tiers:

- `public`: anyone with the URL.
- `recruiter`: public + curated extended professional info.
- `friend`: above + personal projects and opinions.
- `private`: above + medical, financial, legal, family-identity material.

Pages without an explicit `tier:` default to **`private`** (configurable in
`backend/.env` via `DEFAULT_TIER`). This is a safe default so nothing leaks
when you point the backend at an existing wiki.

### Auth

- Anonymous requests → `public` tier.
- `Authorization: Bearer <OWNER_TOKEN>` → `private` (everything visible).
- `Authorization: Bearer <SHARE_TOKEN>` → tier configured in `SHARE_TOKENS`
  env var (format `tokenA:recruiter,tokenB:friend`).

## API

The LLM-facing wire protocol. `/.well-known/llm-wiki.json`,
`/wiki/manifest.json`, `/wiki/page/{slug}`, `/wiki/search`, `/wiki/query`,
`/wiki/chat`, `/wiki/chat/stream`. Is specified in
[SPEC.md](./SPEC.md). That document is the canonical reference for
endpoint shapes, status codes, auth/tier semantics, and conformance.
The implementation serves the spec at `/.well-known/llm-wiki.json`
and adds the owner-only extensions below.

Owner-only (`Authorization: Bearer <OWNER_TOKEN>`):

| Method | Path | Description |
|---|---|---|
| POST | `/owner/reload` | rescan the wiki folder |
| POST | `/owner/lint` | structural lint report |
| POST | `/owner/ingest` | save a raw source file |
| POST | `/owner/page` | create/update a wiki page |
| PATCH | `/owner/page/{slug}/tier` | change a page's tier |
| GET | `/owner/raw` | list raw sources |
| GET | `/owner/raw/{rel_path}` | read a raw source |

## Query backend

`/wiki/query` (one-shot) and `/wiki/chat` (multi-turn) pick the LLM in this order:

1. `ANTHROPIC_API_KEY` → Anthropic Messages API (default `claude-sonnet-4-5`, override with `ANTHROPIC_MODEL`).
2. `OPENAI_API_KEY` → OpenAI Chat Completions (`gpt-4o-mini`).
3. Neither → keyword-scoring fallback (returns the top matching pages with
   excerpts, labeled clearly so the user knows no LLM was used).

Either way, the response includes the citation list (page titles + slugs) so
the frontend can render sourced answers regardless of which backend ran.

`/wiki/chat/stream` is the SSE variant of `/wiki/chat`. Tokens stream in
as the upstream LLM generates them, so perceived latency is "first token
in ~500ms" instead of "wait 8 seconds for the whole completion". Event
shapes and conformance rules are in
[SPEC.md → `/wiki/chat/stream`](./SPEC.md#post-wikichatstream).

The frontend `/ask` page uses this for the chat UI. If a configured
Anthropic model returns a deprecation error mid-stream, the
implementation falls back through a known-good model chain before
bottoming out at the keyword fallback. See `backend/app/llm.py` for
the chain logic.

## Pointing at a different wiki

Edit `WIKI_ROOT` in `backend/.env`. The folder must contain a `wiki/` subdir
with markdown pages. Optional `raw/` for immutable source files.

Page frontmatter the backend reads:

```yaml
---
type: entity | concept | decision | source | query | project | overview
title: Page Title
created: 2026-05-23
updated: 2026-05-23
tier: public          # optional; defaults to DEFAULT_TIER
sources:              # optional
  - raw/conversations/2026-05-23-example.md
tags: [tag1, tag2]    # optional
---
```

`[[Wikilinks]]` are recognized and resolved to other pages when their target
title matches.

## Puppetmaster orchestration

`/owner/ingest` runs the full Karpathy ingest pipeline server-side when
the request body sets `"run_orchestrator": true`. Under the hood this
shells out to:

```bash
puppetmaster cursor "<ingest goal>" --cwd $WIKI_ROOT --timeout-seconds 600
```

…which starts a Cursor SDK worker inside the wiki root that reads the new
source, extracts entities/concepts/decisions, drafts wiki pages with proper
frontmatter, cross-references with `[[wikilinks]]`, updates `index.md`,
appends to `log.md`, and explicitly flags any contradictions with existing
pages instead of silently reconciling.

The Owner console (`/owner` in the UI) shows live job status. Every
Puppetmaster invocation is tracked in `backend/.jobs.json` with its
streaming log at `backend/.job-logs/<tracking_id>.log`.

Endpoints:

| Method | Path | Description |
|---|---|---|
| POST | `/owner/ingest` with `run_orchestrator: true` | save raw + kick off Puppetmaster Cursor agent |
| GET | `/owner/jobs` | list all tracked Puppetmaster jobs |
| GET | `/owner/jobs/{tracking_id}` | live status + log tail + Puppetmaster `status`/`show` output |

Requires `puppetmaster` on `PATH` (override via `PUPPETMASTER_BIN` env var)
and a working Cursor SDK setup (`CURSOR_API_KEY` set). Run
`puppetmaster doctor` to verify.

## Native MCP server

For Cursor, Claude Desktop, and any other MCP-aware LLM client, the wiki
is exposed as a native MCP server with typed tools. `query_wiki`,
`read_page`, `search_wiki`, `list_pages`, `get_neighbors`,
`ingest_source`, `lint_wiki`. The recommended install is the published
package on npm
([`portable-llm-wiki-mcp`](https://www.npmjs.com/package/portable-llm-wiki-mcp));
see **Connect from any LLM** above for the `npx`-based client config.

To hack on the MCP server itself, build locally and point your client at
the build artifact:

```bash
cd mcp
npm install
npm run build
# → use "command": "node", "args": ["<abs-path>/mcp/dist/server.js"]
#   in your ~/.cursor/mcp.json or claude_desktop_config.json
```

The MCP server proxies through the FastAPI backend, so it inherits all
the tier filtering and auth logic for free. **Without**
`WIKI_OWNER_TOKEN` set, the MCP server only sees public-tier pages:
exactly what you'd publish if you wanted to expose your wiki to someone
else's Claude Desktop install.

See `mcp/README.md` for tool-by-tool details and `mcp/smoke-test.mjs`
for an end-to-end example.

## Semantic lint swarm

The third pillar from the Karpathy concept doc: lint. The existing
`/owner/lint` is structural. Orphans, stale dates, broken provenance,
the regex-able stuff. The *semantic* version uses parallel Puppetmaster
Cursor agents that read the wiki's prose and find:

- **Contradictions** between pages (page A asserts X, page B asserts not-X)
- **Stale claims** that newer sources may have superseded
- **Missing pages**: concepts mentioned 3+ times that deserve their own page

One click in the Owner console spawns 3 Puppetmaster jobs in parallel
(plus a 4th public-leak worker. See **Audit before sharing** below).
Each writes a JSON findings file to `<WIKI_ROOT>/.lint/<swarm_id>/<worker>.json`.
The frontend polls and renders findings as actionable cards (with deep
links to the cited pages and side-by-side quote comparisons for
contradiction findings).

Endpoints:

| Method | Path | Description |
|---|---|---|
| POST | `/owner/lint/swarm` | spawn the swarm; returns swarm_id |
| GET | `/owner/lint/swarm` | list past swarms |
| GET | `/owner/lint/swarm/{id}` | live status + aggregated findings |

Wall-clock: 90-180s per worker; in parallel ~3 min total.
Cost: ~$0.30-0.90 per swarm at current Anthropic rates.

## Closed-loop self-maintenance

The lint → draft → ingest loop is closed. Each missing-page finding has
a **Draft this page** button that pipes the bootstrap summary +
evidence quotes into a fresh Puppetmaster Cursor agent which drafts the
actual page. Same for contradictions (**Draft reconciliation**) which
emits a new `wiki/queries/YYYY-MM-DD-reconcile-*.md` page that records
the tension and proposes a resolution without touching the source pages.

End-to-end loop:

1. Lint swarm identifies a gap → `wiki/.lint/<id>/missing-pages.json`
2. Owner clicks "Draft this page" on the finding
3. Drafter spawns `puppetmaster cursor` with a tight prompt that
   includes the bootstrap summary + evidence quotes
4. Cursor SDK agent reads the evidence pages in full, drafts the new
   page at `wiki/<section>/<slug>.md` with proper frontmatter, wikilinks
   cross-referencing every evidence/mentioned page, updates `index.md`,
   appends `log.md`
5. Backend index reloads on next request → new page joins the graph
6. Next lint swarm pass checks the new state

The wiki self-improves. The owner reviews each draft instead of letting
the agent write to disk silently. The draft lives at a real path the
owner can edit in their text editor.

Endpoints:

| Method | Path | Description |
|---|---|---|
| POST | `/owner/lint/draft/missing-page` | spawn a drafter for a missing-page finding |
| POST | `/owner/lint/draft/contradiction` | spawn a drafter for a contradiction finding |

Both return a TrackedJob payload; the new job appears in the
existing `/owner/jobs` panel for live log + Puppetmaster summary.

## Frictionless capture, in-browser editing, auto-reload

The lint→draft→ingest loop only compounds if ingest is *frictionless*.
This closes the human-in-the-loop side of it.

**Frictionless capture** (`/capture`):
- **Paste**: drop a Slack thread, article excerpt, transcript into a
  textarea. Saved to `raw/<subdir>/YYYY-MM-DD-<slug>.md` immediately.
- **Screenshot**: drag-and-drop, click to pick, or paste from clipboard
  (`⌘V` anywhere on the page). Sent to Claude/GPT vision for a faithful
  markdown transcription. The binary asset is preserved under
  `raw/assets/` for provenance.
- **Voice memo**: record in-browser via `MediaRecorder`, or upload an
  existing audio file. Sent to OpenAI Whisper for transcription. The
  transcript becomes the source-of-truth artifact.
- All three optionally chain into the existing Puppetmaster ingest
  pipeline via a single "Run full ingest" checkbox.

**Backend endpoints:**

| Method | Path | What it does |
|---|---|---|
| POST | `/owner/capture/paste` | save pasted text to `raw/<subdir>/` |
| POST | `/owner/capture/image` | vision-transcribe image, save asset + markdown |
| POST | `/owner/capture/audio` | Whisper-transcribe audio, save markdown |
| GET  | `/owner/capture/config` | tells the UI which backends are available |

**In-browser editing.** Owner can hit `✎ edit` on any page view to open a
markdown editor (frontmatter + body, side-by-side with a live preview)
that writes back via `PUT /owner/page/{slug}`. The editor speaks raw
markdown so drafted pages can be reviewed and tweaked in one place
without leaving the browser. Tier picker is right next to the edit
button.

**Auto-reload after Puppetmaster.** The orchestrator calls
`index.reload()` automatically when a job exits with code 0. Drafted
pages, ingest output, and lint-spawned content show up in the manifest
the second the agent finishes. No manual "Reload index" click.

## Audit, share tokens, and on-the-go capture

**Audit before sharing**:

- **Preview-as-anonymous**: the owner page now has a Preview-As selector
  (owner / friend / recruiter / public). Picks a viewer tier, sends an
  `X-Preview-As` header on every API call, and the rest of the app shows
  exactly what that tier would see. The header is owner-gated server-side
 . Non-owners can't grant themselves access by sending it.
- **Public-leak lint worker**: fourth Puppetmaster agent in the lint
  swarm. Reads every `tier: public` page, identifies proper nouns / IDs /
  dollar amounts / specific tokens, and flags any that also appear *only*
  in higher-tier pages. Catches the failure mode where a Status section
  on a public doc imports specifics from a private one.

**Tokenized share-link minting** (`/owner` → Share tokens panel):

- `POST /owner/share-tokens` mints a 256-bit url-safe token with a label,
  tier, and optional expiry. Plaintext is returned **once**; only the
  SHA-256 hash is persisted.
- `GET /owner/share-tokens` lists active and revoked tokens with hit
  counts and `last_used_at`.
- `DELETE /owner/share-tokens/{id}` revokes (soft-delete, kept for audit).
- Storage: `<WIKI_ROOT>/.share-tokens.json` (gitignored).
- Recipient flow: owner copies `https://wiki.example.com?share=ABC123` →
  hands to recipient → on load, `ShareTokenCatcher` stores the token and
  strips it from the URL.

**Apple Wallet pass generator** (`scripts/build-wallet-pass.py`):

Produces an unsigned `.pkpass` bundle with your name, title, bio, and a
QR code encoding the wiki URL. Includes NFC payload for tap-to-open on
paired iPhones. Signing requires an Apple Developer account ($99/yr) or
a third-party service like walletpasses.io. Instructions printed at the
end of every build.

**iPhone capture via Shortcuts**:

A 5-step Shortcut lets you highlight text in any iOS app → Share → "Save
to Wiki" → it POSTs to `/owner/capture/paste` and Puppetmaster drafts
pages from the source. Walkthrough lives at `/connect` → iPhone tab.
Recommended setup uses a friend-tier share token (mintable from the
owner console) so a lost phone doesn't compromise your owner credential.

## Leaving the hosted service

Your wiki is markdown in a GitHub repo *you* own. The hosted layer at
[portablellm.wiki](https://portablellm.wiki) is optional. Click
**Danger zone → Delete my hosted tenant** in `/owner` to wipe
everything on our side; your GitHub repo is untouched. Full handoff
to self-hosting in **[LEAVING.md](LEAVING.md)**.

## Deployment

The intended deployment is **two services**: backend on Render
(persistent compute), frontend on Vercel (CDN-served Next.js). Both
have one-click buttons at the top of this README.

The full step-by-step walkthrough. Render env vars, GitHub PAT
generation, CORS tightening, Vercel pre-fill links. Lives in
**[scripts/deploy.md](scripts/deploy.md)**. Quick summary:

1. `npx create-portable-llm-wiki my-wiki` → push to a private GitHub repo.
2. Click **Deploy to Render** on this README. Set `WIKI_GIT_REMOTE`
   to your content repo's clone URL with a PAT embedded.
3. Click **Deploy to Vercel** on this README. Set
   `NEXT_PUBLIC_BACKEND_URL` to your Render URL.
4. Back on Render, tighten `CORS_ORIGINS` + `PUBLIC_BASE_URL` to your
   Vercel URL.

The free tier cold-starts after 15 minutes of inactivity (~3-5 second
wake-up). For always-on, upgrade Render to the $7/mo Starter plan or
mount a `$1/mo` 1GB disk for faster cold-starts.

### When the prototype outgrows free tier

Move backend → ECS Fargate or Fly.io with a 5GB volume. Frontend stays
on Vercel (already production-grade). Add Postgres if you want
multi-tenant share-token storage. Estimated cost at 1 user: $0-15/mo.
Estimated cost at 100 users: $50-150/mo.

## Roadmap

The GitHub Issues tracker is the source of truth for what's still
missing and what's planned next. Feature requests and bug reports are
welcome there.

## Development

```bash
# backend only
./scripts/dev-backend.sh

# frontend only
./scripts/dev-frontend.sh

# both
./scripts/run.sh
```

The frontend proxies `/api/backend/*` → `http://localhost:8000/*` (configured
in `frontend/next.config.mjs`).

## Tests

100+ tests across backend (pytest), frontend unit (vitest), and E2E
(Playwright, headless Chromium):

```bash
# backend (pytest)
cd backend && .venv/bin/pytest

# frontend unit (vitest)
cd frontend && npm test

# frontend e2e (Playwright, headless Chromium)
cd frontend && npm run e2e
```

All three suites run on every PR. See `.github/workflows/ci.yml` and
[CONTRIBUTING.md](./CONTRIBUTING.md).

### Running E2E tests

A small Playwright smoke suite lives in `frontend/e2e/`. It exercises the real
browser → frontend → backend → wiki round-trip across the most-trafficked
pages (`/`, `/browse`, `/graph`, `/ask`, `/connect`). Chromium-only by design: these are smoke tests, not cross-browser coverage.

**Prerequisites** (one-time):

```bash
cd frontend
npm install                    # picks up @playwright/test
npx playwright install chromium
```

**Run the suite:**

```bash
# Backend must be running on :8000 (the /ask test needs it).
./scripts/dev-backend.sh   # in another terminal, if not already up

# Frontend dev server is auto-started by Playwright. One command:
cd frontend && npm run e2e
```

Useful flags:

- `npm run e2e -- --headed`: watch the browser drive itself
- `npm run e2e:ui`: Playwright's interactive test runner
- `CI=1 npm run e2e`: CI mode (no `reuseExistingServer`, retries, list+html reporters)

Reports land in `frontend/playwright-report/` (gitignored). On the first
retry of a flaky test the trace is captured for `npx playwright show-trace`.
