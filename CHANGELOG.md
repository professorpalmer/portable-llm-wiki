# Changelog

All notable changes to the reference implementation. The wire protocol
itself is versioned separately. See [SPEC.md](./SPEC.md).

Format roughly follows [Keep a Changelog](https://keepachangelog.com),
ordered newest-first.

## 2.0.0. Hosted multi-tenant launch

The pivot. Portable LLM Wiki ships as a hosted product at
**portablellm.wiki**, while the open protocol and self-host path stay
identical for OSS users. Anyone can sign in with GitHub, paste their
bio or a profile URL, and 60 seconds later their wiki is live at
`portablellm.wiki/<their-github-login>` — vendor-neutral, queryable by
any LLM via the `/llm` handshake.

- **Multi-tenant backend**. New `backend/app/tenants.py` introduces
  `Tenant`, `TenantManager`, and a per-request `current_tenant_var`
  ContextVar. `backend/app/wiki.py`'s module-level `index` and
  `backend/app/config.py`'s `settings.wiki_root|wiki_dir|raw_dir` are
  now thin proxies that resolve through the contextvar. Every existing
  call site (80+) keeps working unchanged in single-tenant mode.
- **`SINGLE_TENANT_MODE` flag** (default `1`). When `0`, a pure-ASGI
  `TenantPrefixMiddleware` strips `/t/<tenant_id>/` from incoming URLs
  and sets the contextvar before route dispatch. The OSS self-host
  path is byte-for-byte unchanged.
- **GitHub OAuth + sessions**. New `backend/app/hosted_routes.py` adds
  `/auth/github/login`, `/auth/github/callback`, `/auth/me`,
  `/auth/logout`. Backed by `backend/app/github_api.py` (typed client
  for the OAuth flow + Contents API). Starlette `SessionMiddleware`
  manages signed-cookie sessions; the actual OAuth token lives in the
  on-disk `tenant.json` (never in a cookie).
- **Onboarding endpoints**. `POST /onboarding/import-text` saves a
  pasted bio/resume/about blurb and kicks off the Puppetmaster
  orchestrator (now tenant-aware so it reloads the right wiki on job
  exit). `POST /onboarding/import-url` adds best-effort URL scraping
  (`backend/app/url_scrape.py`, BeautifulSoup-based, bounded at 1MB,
  graceful on JS-rendered SPAs like LinkedIn).
- **Tenant discovery**. `GET /tenants` lists public/unlisted tenants
  for the landing page; `GET /tenants/{id}` returns one tenant's
  public metadata for the `/<tenant>` page.
- **Avery auto-seed**. `backend/app/avery_seed.py` + standalone
  `scripts/seed_avery_tenant.py` populate `<TENANTS_ROOT>/avery/`
  from `wiki-demo/` on first cold-start, so the live demo always
  works at `portablellm.wiki/avery`. Idempotent + `--force` flag.
- **Hosted-mode frontend**. New `app/welcome/page.tsx` (3-tab
  onboarding wizard with live orchestrator polling + share-CTA),
  `app/me/page.tsx` (redirect to current user's wiki),
  `app/[tenant]/page.tsx` (public tenant landing with paste-into-LLM
  callout + inline ask form), `app/signup/page.tsx` (OAuth hand-off).
  Landing page forks: hosted-mode shows the new "Sign in with GitHub"
  hero with Avery as a demo link; OSS mode is unchanged.
- **Tenant-aware API client**. `lib/api.ts` adds `isHostedMode()`,
  `apiBase()`, `tenantPrefix(tenantId)` and new exports for
  `authMe`/`authLogout`/`listTenants`/`onboardingImport*`. Hosted
  mode points fetches at `NEXT_PUBLIC_BACKEND_URL` directly (so
  session cookies stay scoped to `api.portablellm.wiki`); single-
  tenant mode keeps using the `/api/backend` Vercel rewrite proxy.
- **Vanity URL routing**. `frontend/next.config.mjs` adds hosted-mode
  rewrites so `portablellm.wiki/<tenant>/llm` and `/<tenant>/llms.txt`
  resolve to the backend's `/t/<tenant>/llm`. Short + memorable share
  URLs for the "paste this into ChatGPT" pitch.
- **Deployment doc**. New `HOSTED_DEPLOYMENT.md` covers the GitHub
  OAuth app setup, DNS for `api.portablellm.wiki`, Render env vars,
  Vercel env vars, the cookie-domain rationale, and the verify
  checklist.

135 backend tests + 29 frontend tests pass. Single-tenant deploy
behavior is byte-for-byte unchanged.

## 1.1.0. The QR-into-LLM flow

The killer paste-this-URL share mechanism. Hand someone a single URL,
they paste it into ChatGPT / Claude / Cursor / Gemini, and the model
fetches a self-describing markdown briefing that teaches it how to
talk about you using your wiki. No plugin install, no MCP setup, no
auth dance. Works on phones (paste into the ChatGPT app from a QR
scan).

- **`GET /llm`**: dynamic markdown handshake endpoint. Returns a
  self-describing briefing that explains the protocol, lists the
  available endpoints (with the current host's base URL), shows the
  pages visible to the caller, and gives etiquette guidance. Accepts
  a share token via `X-Share-Token` header OR `?t=<token>` query
  parameter so the same URL can be embedded in a QR code. Owner
  bearer auth elevates to full access; share tokens cannot escalate.
- **`GET /llms.txt`**: emerging [llmstxt.org](https://llmstxt.org)
  convention. Short root-level markdown index pointing at `/llm`,
  the manifest, the spec, and the most important public pages. The
  llmstxt-aware crawlers (Mintlify, Anthropic, others) discover the
  site from here.
- **Spec bumped to 1.1.0.** Additive: clients targeting 1.0 remain
  conformant. Manifest now includes `agent_entry.url_template` so
  third-party clients can build their own paste-into-LLM share UIs,
  and `auth.share_token_query` documents the `?t=` channel.
- **`/share` page rebuilt** around the new URL. QR code now encodes
  `${base}/llm` instead of the bare host. New "Copy URL for any LLM"
  primary CTA. Collapsible preview of the actual markdown the
  recipient's LLM will see (builds owner trust before sharing).
  Legacy prompt templates and MCP install moved behind an "Advanced
  sharing options" toggle.
- **Landing page** adds a `PasteUrlCard` directly in the "Plug it
  into any LLM" section showing the live `https://portablellm.wiki/llm`
  URL with a one-click copy button.
- **Next.js rewrites** added for `/llm` and `/llms.txt` so they live
  at the clean apex (`https://portablellm.wiki/llm`), not the long
  `/api/backend/llm` proxy path.
- **16 new backend tests** in `test_llm_handshake.py` covering anon
  vs. share-token vs. owner briefings, the `?t=` security boundary,
  the `/llms.txt` shape, and the new manifest fields. Total 120
  backend tests pass.

## 1.0.1. Post-launch polish

- **Spec bumped to 1.0.1**: purely additive. Clients targeting 1.0
  remain conformant.
- **`/wiki/search` now honors `?limit=`** (1–100, default 25). Used to
  silently hardcode 25; the MCP wrapper was passing a value into the
  void. Response also echoes the effective `limit`.
- **`X-Share-Token` header** is now an alternative channel for share
  tokens, for HTTP intermediaries that strip `Authorization`. Cannot
  escalate to owner; `Authorization` always wins when both are set.
- **`OrchestratorUnavailable`** is now a real typed exception in
  `orchestrator.py` instead of an unimported name in `main.py`. The
  /owner/raw/bulk and /owner/raw/{p}/reingest endpoints now return a
  clean 503 with a helpful message when puppetmaster isn't installed,
  instead of raising NameError at request time.
- **Hero screenshots** in the README (`docs/hero.png`,
  `docs/hero-mobile.png`) generated via Playwright. New
  `e2e/screenshot.spec.ts` regenerates them locally with
  `PLAYWRIGHT_SCREENSHOT=1`.
- **README stale-content sweep**: version-tagged section headings
  dropped, test counts no longer pinned to stale numbers, "Known
  issues from the initial build" section retired, API deep-dive
  delegated to SPEC.md.
- **12 new backend tests** covering all three fixes. Total 104 backend
  tests pass.

## 1.0. Initial OSS release

- Protocol stabilised as **llm-wiki v1.0**; the wire format is now
  frozen in [SPEC.md](./SPEC.md) and advertised at
  `/.well-known/llm-wiki.json` with `spec_version: "1.0"`.
- `create-portable-llm-wiki` scaffolder published on npm: one
  command to bootstrap a fresh wiki content repo.
- `portable-llm-wiki-mcp` published on npm: the MCP server is now an
  `npx`-able install for Cursor / Claude Desktop instead of a build
  step.
- Render Blueprint (`render.yaml`) and Vercel deploy button: cloud
  deploy is now 60 seconds, no laptop required.
- `docker-compose.yml` for self-hosters; bundled `wiki-demo/` mounts
  out-of-the-box.
- Contributor docs: [CONTRIBUTING.md](./CONTRIBUTING.md),
  [SECURITY.md](./SECURITY.md), and this changelog.

## 0.99. Streaming chat

- `POST /wiki/chat/stream`: SSE variant of `/wiki/chat`, first token
  in ~500ms instead of waiting on the full completion.
- Anthropic model fallback chain: configured model → known-good chain
  → keyword fallback, so a deprecated model id doesn't 500.

## 0.8. Demo-ready, deployment-ready, audit-ready

- `scripts/init.sh` one-command setup (venv, deps, `OWNER_TOKEN`,
  wiki location prompt).
- `wiki-demo/`: 12-page Avery Chen sample wiki so first runs render a
  populated graph.
- **Preview-As** owner header (`X-Preview-As`): owner can see the
  wiki as a stranger / recruiter / friend would.
- **Public-leak lint worker**: fourth Puppetmaster agent that flags
  specifics on public pages that only appear in higher-tier pages.
- **Share tokens**: minted from `/owner`, scoped per tier,
  SHA-256-hashed at rest, revocable, with hit-count audit log.
- Dynamic Open Graph image at `/og`, Twitter Card metadata.
- `backend/Dockerfile`, `render.yaml`, `frontend/vercel.json` for
  production deploys.
- Apple Wallet pass generator (`scripts/build-wallet-pass.py`) and an
  iOS Shortcut for one-tap capture to `/owner/capture/paste`.

## 0.7. Frictionless capture, in-browser editing, auto-reload

- `/capture` UI: paste, screenshot (drag/click/⌘V), or voice-memo →
  saved to `raw/<subdir>/`, optionally chained into the Puppetmaster
  ingest pipeline.
- Vision-transcribe (Claude/GPT vision) for images, Whisper for audio.
- In-browser markdown editor on every page (frontmatter + body,
  side-by-side preview), writes back via `PUT /owner/page/{slug}`.
- Orchestrator auto-reloads the index on `exit_code == 0`: drafted
  pages appear in the manifest the second the agent finishes.

## 0.6. Closed-loop self-maintenance

- **Draft this page** button on missing-page lint findings spawns a
  Puppetmaster Cursor agent that drafts the new page with grounded
  content sourced from the evidence quotes.
- **Draft reconciliation** on contradiction findings emits a
  `wiki/queries/YYYY-MM-DD-reconcile-*.md` page that records the
  tension and proposes a resolution without touching source pages.
- The lint → draft → ingest loop is now closed: lint identifies gaps,
  drafter fills them, ingest reloads the index, next lint pass checks
  the new state.

## 0.5. Semantic lint swarm

- Three parallel Puppetmaster Cursor agents: contradictions, stale
  claims, missing pages. Write findings JSON to
  `<WIKI_ROOT>/.lint/<swarm_id>/<worker>.json`.
- Owner console renders findings as actionable cards with deep links
  and side-by-side quote comparisons.
- `POST /owner/lint/swarm`, `GET /owner/lint/swarm/{id}` endpoints.

## 0.4. Native MCP server

- TypeScript MCP server at `mcp/` exposes `query_wiki`, `read_page`,
  `search_wiki`, `list_pages`, `get_neighbors`, `ingest_source`,
  `lint_wiki` as first-class MCP tools.
- Proxies the FastAPI backend so tier filtering applies for free.

## 0.2. Puppetmaster orchestration

- `/owner/ingest` with `"run_orchestrator": true` shells out to
  `puppetmaster cursor` to run the full Karpathy ingest pipeline
  server-side.
- Job tracking in `backend/.jobs.json`, streaming logs at
  `backend/.job-logs/<tracking_id>.log`.
- `/owner/jobs` and `/owner/jobs/{tracking_id}` endpoints; the Owner
  console renders live status.

## 0.1. Initial build

- FastAPI backend reading markdown pages from a wiki folder.
- 4-tier auth model (`public ⊂ recruiter ⊂ friend ⊂ private`) with
  bearer-token filtering on every response.
- Owner-only endpoints for reload, lint, ingest, page CRUD, tier
  patches.
- Next.js + Tailwind frontend for browsing, querying, and tier
  management.
- LLM-backed `/wiki/query` with Anthropic / OpenAI / keyword-fallback
  resolution order.
