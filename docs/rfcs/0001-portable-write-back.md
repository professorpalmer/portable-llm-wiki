# RFC 0001 — Portable write-back (capture from any LLM, structure server-side)

Status: **Draft** · Author: @professorpalmer · Created: 2026-06-04

## TL;DR

Reads are already portable: any LLM fetches `portablellm.wiki/<user>/llm`.
**Writes are not.** Today, ingesting back into a wiki requires a local
FastAPI server on `localhost:8000` plus a long-running orchestrator the
caller has to babysit. That works only inside Cursor on the owner's
machine — it is a dead end for ChatGPT, the OpenAI browser, Claude,
Gemini, or any headless agent.

This RFC makes write-back portable and bulletproof by doing three things:

1. **Capability-scoped, revocable per-tenant API tokens** — the headless
   credential the hosted backend is currently missing (it is cookie-only).
2. **A durable capture inbox** (`POST /v1/capture`) that is instant,
   idempotent, append-only, and git-backed — decoupled from structuring.
3. **Server-side, deferred orchestration** — a worker drains the inbox and
   runs the existing direct-LLM drafter; the caller never holds a process
   open.

…all exposed through **one protocol surface** (a remote MCP server + a
published OpenAPI spec) so every LLM client gets write-back for free —
the same "build the protocol, not the integration" move that made reads
portable.

## Context: why the current flow is localhost-bound

| Symptom | Root cause | Load-bearing? |
| --- | --- | --- |
| Must run a local server | The owner's MCP (`~/.cursor/mcp.json`) sets `WIKI_API_BASE=http://localhost:8000`. The same app also runs at `api.portablellm.wiki`. | No — config accident |
| No headless write to hosted | In multi-tenant mode `OWNER_TOKEN` is unused; write routes are gated only by the per-tenant **session cookie** (browser-only). | **Yes — the real gap** |
| Had to babysit the orchestrator | `run_orchestrator: true` fires a Puppetmaster agent inline; the caller waits for it. | No — capture ≠ structuring |

The keystone gap is #2. Everything else is downstream of "there is no
non-cookie, scoped credential an agent can present."

## Goals

- Write durable context into a wiki from **any** LLM surface, with **no
  local server** and **no babysitting**.
- Capture is **instant** (sub-second, append-only) and **durable on
  accept** (lands in the user's git repo).
- Structuring is **server-side, retryable, idempotent**, and observable.
- **Bulletproof multi-tenancy**: leaked-credential containment, tenant
  isolation, rate limits, no silent no-ops.
- **One surface, many adapters**: remote MCP + OpenAPI, not N bespoke
  integrations.

## Non-goals (this RFC)

- Replacing Puppetmaster. It remains the self-host / power path and the
  heavy "re-stitch the whole graph" job. The per-capture hot path uses
  the cheap direct-LLM drafter.
- BYO-LLM-keys (tracked separately).
- Real-time collaborative editing.

## Architecture

```
  Any LLM surface                      Hosted (api.portablellm.wiki)
  ───────────────                      ─────────────────────────────
  Cursor / Claude  ─┐                  ┌───────────────────────────┐
   (remote MCP)     │   Bearer token   │ POST /v1/capture          │
  ChatGPT Action  ──┼──────────────────▶  (capture:write)          │
   (OpenAPI)        │   plw_live_…      │   → raw/inbox/<id>.md     │
  Agentic browser ─┘                   │   → git commit + push     │
   (or /capture UI)                    │   → enqueue(capture_id)   │
                                       └────────────┬──────────────┘
                                                    │ (durable queue)
                                       ┌────────────▼──────────────┐
                                       │ Structuring worker        │
                                       │  drain inbox → direct      │
                                       │  drafter → pages/ → push   │
                                       │  state: pending→done/dead  │
                                       └───────────────────────────┘
```

### 1. Auth — capability-scoped per-tenant tokens

Industry-standard PAT model (GitHub / Stripe restricted keys):

- **Format**: `plw_live_<base62>` (and `plw_test_…`). The prefix is
  greppable for secret scanners; the body is high-entropy.
- **Storage**: only a **hash** (sha256, peppered) is persisted on the
  tenant record. Plaintext is shown **once** at mint time, never again.
- **Scopes** (least privilege):
  - `capture:write` — append to `raw/inbox/` only. **This is all a
    ChatGPT Action token needs.** Blast radius if leaked = junk in an
    inbox the owner reviews; cannot delete or restructure.
  - `pages:read`, `pages:write`, `admin` — escalating, opt-in.
- **Lifecycle**: list / mint / revoke in the owner console; `last_used_at`,
  optional `expires_at`. Revocation is immediate (hash dropped).
- **Transport**: `Authorization: Bearer plw_live_…`. TLS only.

### 2. Capture — durable, idempotent inbox

`POST /v1/capture` (scope `capture:write`):

- Body: `{ content, slug?, subdir?, note?, source? }` (mirrors today's
  `ingest_source`).
- **Idempotency-Key** header (Stripe model): the server records the key →
  result; a retry from a flaky client returns the original result instead
  of double-writing.
- Writes `raw/inbox/<YYYY-MM-DD>-<id>-<slug>.md`, commits + debounced-push
  to the tenant's GitHub repo, returns `{ capture_id, sync }` immediately.
- The response carries the existing **`describe_sync` verdict** — the
  caller is told whether the write actually reached durable storage. No
  silent no-op (this is a hard product rule).
- Hard caps: payload size, per-token + per-tenant rate limits (token
  bucket), inbox depth.

### 3. Orchestration — server-side, deferred, retryable

- A worker (separate process, or in-process background task) drains the
  inbox. Each capture has a state machine:
  `pending → structuring → done | failed(retryable) | dead`.
- Structuring uses the **direct-LLM drafter** (already shipped — it is the
  hosted onboarding path), not an agent. Cheap, fast, no babysitting.
- **At-least-once + idempotent**: re-processing a capture is safe
  (deterministic slug/dedupe). Failures retry with backoff; poison
  messages park in `dead` and surface in the owner console.
- **Triggering** is belt-and-suspenders:
  1. enqueue signal on capture (fast path), plus
  2. a periodic sweep as a safety net.
  Render free-tier sleep is handled by sweep-on-next-request + an external
  keep-warm ping; the **GitHub-Action variant** (below) sidesteps Render
  entirely.
- Owner console gets a **"Structure N pending"** button for manual flush
  and a dead-letter view.

### 4. Protocol surface — one endpoint, many adapters

- **Remote MCP server** (Streamable-HTTP transport) at
  `mcp.portablellm.wiki`, token-authed. This is the portable write-back:
  the MCP follows the user across Cursor, Claude Desktop, and ChatGPT
  connectors. The local stdio MCP becomes a thin shim that points at
  either `localhost` or the hosted API by swapping `WIKI_API_BASE` +
  token.
- **OpenAPI 3.1** published at a well-known URL → drop-in ChatGPT Action /
  custom GPT, plus generated clients for everything else.

### Alternative trigger: GitHub-Action-native structuring

Because the wiki *is* a git repo, an equally valid (and fully serverless)
path: the agent commits raw to `raw/inbox/**` (via the GitHub API or a
connector), and a **GitHub Action on push** runs the direct drafter and
commits structured pages back. Pros: no Render dependency, audit trail is
git itself. Cons: needs LLM keys as Action secrets, ~1–2 min latency.
Recommend supporting **both** the hosted worker and the Action — same
drafter code, different trigger.

## Threat model (highlights)

- **Leaked token** → contained by scope (`capture:write` can only append
  to an inbox the owner reviews) + revocation + rate limits + `expires_at`.
- **Tenant escape** → all writes resolve through the existing
  tenant-scoped, symlink-guarded path layer; tokens are bound to one
  tenant.
- **Write amplification / DoS** → per-token and per-tenant token-bucket
  limits, payload + inbox-depth caps.
- **Replay / double-write** → Idempotency-Key dedupe.
- **Secret-in-repo** → tokens are hashed at rest; never written to disk in
  plaintext; secret-scanner-friendly prefix.

## Rollout — reviewable slices

1. **Tokens** (keystone): token module (mint/verify/revoke, hashed
   storage), `tenant.json` schema bump + migration, `Depends`-based
   bearer auth with scope enforcement, owner-console UI, tests. *Repoint
   the owner's MCP off `localhost` — write-back from Cursor/Claude
   anywhere, no local server.*
2. **Capture inbox**: `POST /v1/capture` with idempotency + sync verdict,
   caps + rate limits, tests.
3. **Structuring worker**: state machine, retries, dead-letter, owner-
   console flush button + GitHub-Action variant, tests.
4. **Protocol surface**: remote MCP server + published OpenAPI; ChatGPT
   Action walkthrough in `HOSTED_DEPLOYMENT.md`.

Each slice ships behind tests and is independently reviewable; nothing
touches `main`/deploy without review, because this is multi-tenant auth.

## Open questions

- Token scope granularity — is `capture:write` / `pages:write` / `admin`
  enough, or do we want per-section scopes day one?
- Worker placement — in-process background task vs a dedicated Render
  worker vs GitHub-Action-only for v1.
- Do we expose `pages:write` to ChatGPT at all, or keep the browser
  surface strictly `capture:write` (inbox-only) for safety?

## Decision

Proceed with Slice 1 (tokens) as the keystone, since every surface depends
on it. Build server-side and review the auth design before anything
deploys.
