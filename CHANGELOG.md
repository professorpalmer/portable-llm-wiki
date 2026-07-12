# Changelog

All notable changes to the reference implementation. The wire protocol
itself is versioned separately. See [SPEC.md](./SPEC.md).

Format roughly follows [Keep a Changelog](https://keepachangelog.com),
ordered newest-first.

## Unreleased

- **Share-token hit counters no longer block GitHub smart-pull.**
  `resolve()` used to rewrite tracked `.share-tokens.json` on every
  successful use (bumping `hits` / `last_used_at` without a flush),
  leaving permanent tracked dirt that forced the Force-reset modal
  whenever the tenant was behind remote. Hits now live in a gitignored
  `.share-token-stats.json` sidecar; mint/revoke identity still flushes
  to GitHub. Smart-pull also treats residual hits-only dirt on
  `.share-tokens.json` as disposable bookkeeping and fast-forwards
  instead of returning `action: "dirty"`. Patch bump to **0.2.2**.

## 2.2.0. Durability you can see — no more silent no-op

The "I created a note and it never showed up" trap, closed. Git-backed
sync has shipped for a while (`flush_async` / per-tenant push + login
pull), but a write that *couldn't* sync — self-host with no
`WIKI_GIT_REMOTE`, or a hosted tenant that never connected a repo —
still returned a cheerful `ok: true`. The write landed on disk and
quietly never went anywhere. This release makes durability observable
end to end.

- **`sync` verdict on every create/mutate response.** New
  `persistence.describe_sync()` returns a small, human-readable verdict
  (`will_sync`, `mode` = `global` / `tenant` / `local_only`, redacted
  `remote`, and an actionable `detail`). It's stamped onto every
  content surface — ingest, import, paste/verbatim/image/audio capture,
  structured writeback, and page create/edit — via a single `_with_sync`
  helper so the disclosure can never drift between endpoints.
- **MCP relays it (server v0.1.3).** `ingest_source` appends the verdict
  to its result: a one-line `Sync:` confirmation on the happy path, and
  a loud `WARNING — NOT SYNCED:` with the fix when a write is
  local-only. Agents now tell users the truth about durability instead
  of reporting a false success.
- **Web UI warns on the create surface.** New `SyncWarning` component
  renders nothing on the durable path and an amber, actionable banner
  (with a "connect a repo" link for hosted tenants) when a write won't
  sync. Wired into the capture flow.
- **Credentials never leak in a verdict** — the `remote` field is
  always credential-redacted (PAT/token stripped).
- **Docs**: corrected the stale "continuous GitHub sync — not included
  in v1.0" note in `HOSTED_DEPLOYMENT.md` (it shipped), and documented
  the local-only warning in `backend/.env.example`.
- Tests: backend `describe_sync` unit coverage + HTTP-level ingest
  disclosure; frontend `SyncWarning` suite. Full suites green
  (backend 313, frontend 154).

## 2.1.0. Verbatim capture + hosted-mode hardening

The hosted-mode shake-down release. 2.0.0 shipped the multi-tenant
substrate; this is the polish pass that turned it from "works for me"
into "works for a stranger who finds it on Hacker News." Trusted-input
capture, repo-binding safety nets, welcome-wizard fixes, and the
session-secret hard-error so a misconfigured hosted deploy refuses to
boot instead of silently leaking session cookies.

- **`verbatim` capture mode**. New
  `POST /owner/capture/verbatim` writes a user-authored markdown file
  (with YAML frontmatter) to `wiki/<section>/<slug>.md` byte-for-byte
  preserved. **Tier from frontmatter is respected** — the one capture
  path where the LLM-output `tier: private` floor doesn't apply,
  because the user authored the bytes directly. Conflict-safe by
  default (existing slug → `-verbatim-<today>.md` suffix); explicit
  `force_overwrite` for in-place iteration. New `verbatim` tab on
  `/capture` with live preview of resolved path, tier, and a
  prominent red warning for `tier: public`. Backend pytest + frontend
  vitest suites lock down the contract (frontmatter validation,
  conflict suffixing, tier respect, byte-exact preservation).
- **`from LLM` structured-JSON capture**. New
  `POST /owner/capture/structured` commits pre-structured pages
  produced by an external ChatGPT / Claude / Cursor session. Public
  spec at `GET /llm-writeback-spec` teaches the LLM the exact JSON
  shape. Tier force-clamped to `private` (LLM-generated, untrusted).
  New `from LLM` tab on `/capture` with prompt-template generator and
  preview-before-commit.
- **URL scrape reused post-onboarding**.
  `POST /onboarding/import-url` is now also surfaced as the `url` tab
  on `/capture` — paste any public URL, drafter produces wiki pages
  citing the raw scrape.
- **Direct-LLM drafter fallback**. Hosted mode (where Puppetmaster
  isn't on PATH) now falls back to a direct Anthropic/OpenAI call
  (`backend/app/direct_drafter.py`) instead of silently no-op'ing the
  ingest toggle. Anthropic primary with model fallback chain, OpenAI
  fallback, then a clear `no_llm_configured` error if neither key is
  set. Same on-disk page format as the Puppetmaster path so wiki
  consumers don't see a difference.
- **Welcome wizard polish**. `/welcome` now auto-detects fresh-signup
  vs. populated-repo vs. mid-migration and routes appropriately,
  with a dynamic step badge ("Step 1 of 2 — Connect GitHub", "One-time
  upgrade", "Step 2 of 2 — Seed your wiki", or no badge for the
  bouncer view). Post-connect `/auth/me` re-fetch refreshes
  `pageCount` so the "AlreadyOnboarded" bouncer triggers correctly
  when the user connects to a repo that's already populated.
- **Switch Wiki Repo modal**. New owner-console action: type-to-confirm
  rebinding of an existing tenant to a different GitHub repo. Built
  to recover the failure mode where a user accidentally bound their
  tenant to the product's source repo at onboarding (we now also
  guard against that at intake — see below). Clears stale sync
  errors after a successful rebind.
- **Product-source-repo guard**. The onboarding `/onboarding/connect-repo`
  endpoint now refuses to bind a tenant to a repo whose tree
  resembles the product's own source code (presence of `backend/`
  and `frontend/` dirs at the root). Catches the foot-gun where a
  user clones the product repo to play with it and then sees their
  hosted instance try to push wiki pages into it.
- **Force-Reset modal with preview**. The "force pull" action in the
  GitHub sync panel now requires type-to-confirm (matches the danger-
  zone delete UX) AND first calls a new
  `GET /owner/sync/preview-force-reset` endpoint that returns the
  exact list of local files that would be lost. Modal renders the
  list inline so users see what they're about to nuke before
  confirming.
- **Personal LLM URL flow**. New owner-console panel mints a
  `private`-tier share token and constructs a single URL the owner
  pastes into ChatGPT / Claude / Cursor / Gemini. The LLM fetches
  the URL, gets a tenant-scoped briefing covering everything the
  owner sees. Companion "Copy full briefing" button inlines the
  wiki content for LLMs whose browse tool is unreliable (e.g.
  ChatGPT on freshly-minted URLs).
- **Capture history page**. New `/owner/captures` frontend route lists
  every raw capture file with kind / size / preview, plus delete and
  reingest actions. Backed by `GET /owner/raw`, `DELETE
  /owner/raw/{path}`, `POST /owner/raw/{path}/reingest`, and
  `POST /owner/raw/bulk` for multi-select operations.
- **Hosted-mode safety rails**:
  - `SESSION_SECRET` is now a hard requirement at startup in
    hosted mode — the server refuses to boot if it's unset (was
    previously a soft-default with a warning, which silently
    weakened session security).
  - `tenant.json` is now in `.gitignore` AND a startup hook re-
    ensures it's gitignored on every boot, so a user-supplied wiki
    repo can't accidentally commit OAuth tokens. Existing git
    history was scrubbed of any `tenant.json` blobs that landed
    before the fix via `git filter-repo`.
  - `render.yaml` now uses `sync: false` on `SINGLE_TENANT_MODE`
    instead of `value: "1"`. Previously the blueprint default was
    stomping dashboard overrides on redeploy, silently flipping
    the hosted multi-tenant service back to single-tenant mode.
- **Sign-out fix**. `/auth/logout` no longer renders an error toast on
  the way out; cleanly redirects to the landing page.
- **CI install fix**. `.github/workflows/ci.yml` now installs
  `requirements-dev.txt` alongside `requirements.txt`, so backend
  tests can find pytest without a `ModuleNotFoundError` on first
  CI run.

Test coverage expanded across all three suites (backend pytest,
frontend vitest, Playwright E2E) — every shipping behavior above
landed with regression tests. Single-tenant deploy behavior remains
byte-for-byte unchanged: existing OSS deploys upgrade in place
without touching env vars.

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
