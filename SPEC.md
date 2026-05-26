# llm-wiki spec v1.1.0

**Status:** Stable
**Version:** `1.1.0`
**Date:** 2026-05-24
**Reference implementation:** <https://github.com/professorpalmer/portable-llm-wiki>

## Overview

`llm-wiki` is an HTTP+JSON wire protocol that lets any LLM read, search, and
chat with a markdown-based personal wiki. The protocol's goal is *vendor
neutrality*: a wiki owner writes plain markdown files in a folder they own,
and any compliant client. A chat UI, a Cursor agent, a Claude Desktop MCP
shim, a custom Python script. Can speak to it the same way. The user owns
their data, the user owns the host, and no LLM vendor sits in the middle of
the trust path.

The protocol covers three things:

1. **Discovery**. A single `.well-known/llm-wiki.json` descriptor that
   advertises which operations a server implements, what auth it accepts,
   and which tiers exist.
2. **Read**. List pages (`/wiki/manifest.json`), fetch a single page
   (`/wiki/page/{slug}`), keyword-search (`/wiki/search`).
3. **Ask**. One-shot Q&A (`/wiki/query`), multi-turn chat (`/wiki/chat`),
   and a streaming Server-Sent Events variant (`/wiki/chat/stream`).

Across every operation, a **tier model** (`public ⊂ recruiter ⊂ friend ⊂
private`) keeps private content private. A bearer token carries the
viewer's identity; absence of a token means `public` tier. The same wiki
can serve a stranger, a recruiter, a friend, and the owner four different
filtered views from one set of source files.

Design goals: vendor-neutrality (no LLM-vendor-specific shape leaks into
the protocol), ownership (the wiki is markdown in a folder, not a SaaS
silo), and provenance (every answer carries citations that point back to
files the user can audit).

## Versioning

This document specifies version `1.1.0`. Servers advertise their
supported version via `.well-known/llm-wiki.json` → `spec_version`.
The `1.x` line is purely additive (servers MAY ignore new features and
remain conformant against `1.0`). Clients **SHOULD** refuse to make
assumptions about endpoints that are not listed in the manifest's
`operations` field; new operations introduced in future minor versions
will appear there.

**1.1.0 additions** (all backwards-compatible):

- `GET /llm`: self-describing markdown handshake. The killer
  paste-this-URL-into-any-LLM flow. Accepts a share token via either
  the `X-Share-Token` header or the `?t=<token>` query parameter so
  the same URL can be embedded in a QR code.
- `GET /llms.txt`: root-level [llmstxt.org](https://llmstxt.org)
  convention: a short markdown index of important paths, linking back
  to `/llm` as the primary agent entry point.
- `auth.share_token_query`: manifest field documenting that share
  tokens MAY travel in `?t=<token>`.
- `agent_entry`: manifest field exposing a URL template for the
  paste-into-LLM flow, so third-party clients can build their own
  share UIs.

Future minor versions (`1.x`) will be backwards-compatible: existing
fields keep their shape and semantics, new fields are additive. Breaking
changes ship as `2.0`.

## Discovery: `.well-known/llm-wiki.json`

The single entry point. A conformant client fetches this descriptor first
and uses it to find every other endpoint.

```json
{
  "name": "Portable LLM Wiki",
  "spec_version": "1.0",
  "spec_url": "https://github.com/professorpalmer/portable-llm-wiki/blob/main/SPEC.md",
  "operations": {
    "manifest": "/wiki/manifest.json",
    "page": "/wiki/page/{slug}",
    "search": "/wiki/search?q={query}",
    "query": "/wiki/query",
    "chat": "/wiki/chat",
    "chat_stream": "/wiki/chat/stream"
  },
  "streaming": {
    "transport": "sse",
    "endpoint": "/wiki/chat/stream",
    "event_types": ["start", "token", "error", "done"]
  },
  "auth": {
    "scheme": "bearer",
    "header": "Authorization",
    "anonymous_tier": "public"
  },
  "tiers": ["public", "recruiter", "friend", "private"]
}
```

### Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Human-readable wiki name. |
| `spec_version` | string | yes | Spec version this server implements (e.g. `"1.0"`). |
| `spec_url` | string | recommended | URL to the canonical spec document this server claims conformance with. |
| `operations` | object | yes | Map of operation name → URL template. See below. |
| `operations.manifest` | string (URL template) | yes | The list-pages endpoint. |
| `operations.page` | string (URL template) | yes | Fetch-one-page endpoint. `{slug}` is the placeholder. |
| `operations.search` | string (URL template) | yes | Keyword-search endpoint. `{query}` is the placeholder. |
| `operations.query` | string (URL template) | yes | One-shot Q&A endpoint. |
| `operations.chat` | string (URL template) | recommended | Multi-turn chat endpoint. |
| `operations.chat_stream` | string (URL template) | recommended | SSE chat endpoint. Required if `streaming` is present. |
| `streaming` | object | recommended | Streaming transport descriptor. Omit when no streaming endpoint is offered. |
| `streaming.transport` | string | yes (if present) | Transport identifier; currently always `"sse"`. |
| `streaming.endpoint` | string | yes (if present) | URL of the streaming endpoint. |
| `streaming.event_types` | array of string | yes (if present) | Event `type` values the server may emit. |
| `auth` | object | yes | Auth descriptor. |
| `auth.scheme` | string | yes | Auth scheme. Currently always `"bearer"`. |
| `auth.header` | string | yes | HTTP header carrying the token. Currently always `"Authorization"`. |
| `auth.anonymous_tier` | string | yes | Tier granted when no token is presented. Almost always `"public"`. |
| `tiers` | array of string | yes | All tiers this server recognises, ordered least- to most-privileged. |

URLs in `operations` MAY be absolute or relative. Relative URLs are
resolved against the URL the manifest was fetched from. This lets the
same JSON serve both `https://wiki.example.com` directly and a
reverse-proxied deployment at `https://example.com/api/backend`.

## Authentication & tiers

### Token transport

Bearer tokens are passed in the standard `Authorization: Bearer <token>`
header. There are three classes of token:

- **Owner token**: single, long-lived, set by the wiki owner. Grants
  `private` tier (sees everything) and is the only token that authorises
  write operations.
- **Share token**: minted by the owner, scoped to a single tier
  (`public`, `recruiter`, or `friend`). Read-only. Can be revoked. The
  intended user-flow is `https://wiki.example.com?share=<token>` →
  recipient's client stores the token and replays it on every request.
- **No token**: anonymous; effective tier is `auth.anonymous_tier`
  (usually `public`).

### Tier model

Tiers form a total order: `public < recruiter < friend < private`. A
viewer at tier *T* sees every page whose `tier` is `≤ T`. So:

- A `public` viewer sees `public` pages only.
- A `recruiter` viewer sees `public` and `recruiter` pages.
- A `friend` viewer sees `public`, `recruiter`, and `friend` pages.
- A `private` viewer (the owner) sees everything.

Tier filtering happens server-side on every request. A client cannot
elevate its tier by sending header tricks or by asserting prior chat
turns.

### Owner-only debug header: `X-Preview-As`

When the bearer token is the owner token, the owner MAY send
`X-Preview-As: <tier>` to receive responses filtered as if they were a
viewer at that lower tier. Non-owner requests with this header are
ignored. This is the "what does a stranger see?" debug knob.

### Alternative share-token channel: `X-Share-Token` *(added in 1.0.1)*

Clients MAY pass a share token via `X-Share-Token: <token>` instead of
`Authorization: Bearer <token>`. The two channels are equivalent
**except** that:

- `Authorization` always wins when both headers are present. The
  `X-Share-Token` value is consulted only if `Authorization` resolved
  to a public viewer (i.e. it was absent or invalid).
- `X-Share-Token` **MUST NOT** grant owner privileges, even if the
  caller passes the owner token through this channel. A server that
  honors `X-Share-Token` MUST clamp the resolved viewer to a non-owner
  tier.

This exists because some HTTP intermediaries (webhook proxies,
restrictive corporate gateways, a few embedded-CORS browser flows)
strip or rewrite the `Authorization` header. Share-link UX shouldn't
break behind those.

### Response status codes

| Status | Meaning |
|---|---|
| `200` | Success. |
| `401` | Invalid or revoked token. Anonymous requests do NOT get 401. They get `public` tier. |
| `404` | Page not found, OR page exists but is above the viewer's tier. Servers MUST NOT distinguish between these two cases (doing so leaks the existence of higher-tier pages). |
| `422` | Request body failed validation. |
| `429` | Rate-limited. Server SHOULD include `Retry-After`. May also set `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. |

## Page format

Pages are UTF-8 markdown files with YAML frontmatter. The reference
implementation reads them straight off disk.

```markdown
---
type: entity | concept | decision | source | project | query | overview
title: Page Title
tier: public | recruiter | friend | private
created: 2026-05-24
updated: 2026-05-24
sources:
  - http://example.com/some-source
  - raw/conversations/2026-05-24-source.md
tags: [tag1, tag2]
---

# Page Title

Body content. Cross-reference other pages with [[Page Title]] (wikilinks).
Wikilinks may include a display label: [[Page Title|the label shown]].
```

### Frontmatter fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `title` | string | recommended | Display name. Falls back to the filename stem if absent. |
| `type` | string | recommended | One of: `entity`, `concept`, `decision`, `source`, `project`, `query`, `overview`. Servers MAY accept additional types but SHOULD ignore unknown values rather than reject. |
| `tier` | string | recommended | One of the tiers declared in `.well-known.tiers`. Absent → server-default (the reference implementation defaults to `private` to fail closed). |
| `created` | ISO 8601 date | optional | First-authored date. |
| `updated` | ISO 8601 date | optional | Most-recent-edit date. |
| `sources` | array of string | optional | Provenance: URLs, paths to raw source files, citations. |
| `tags` | array of string | optional | Free-form keywords. |

### Wikilinks

`[[Title]]` (and `[[Title|label]]`) reference other pages. Resolution is
**case-insensitive title match**. A wikilink whose target title does not
match any visible page resolves to a plain italic span (and is reported
as a `missing_pages` finding by structural lint).

### Slugs

Each page has a `slug`. The lowercase, hyphen-joined filename stem
(`wiki/concepts/calibrated-honesty.md` → `calibrated-honesty`). Slugs
are the stable identifier in URLs; titles can change without breaking
links.

## Endpoints

URLs below are written relative to the wiki's base URL. Where the
descriptor uses placeholders (`{slug}`, `{query}`), clients substitute
them before fetching.

### `GET /wiki/manifest.json`

List of every page visible to the requesting viewer.

Response:

```json
{
  "wiki_title": "string",
  "generated_at": "2026-05-24T17:00:00+00:00",
  "viewer_tier": "public",
  "viewer_is_owner": false,
  "page_count": 16,
  "sections": { "entities": 4, "concepts": 6, "decisions": 3, "projects": 2, "sources": 1 },
  "pages": [
    {
      "slug": "string",
      "title": "string",
      "section": "entities | concepts | decisions | sources | queries | projects | root",
      "type": "entity | concept | decision | source | query | project | overview",
      "tier": "public | recruiter | friend | private",
      "created": "2026-05-24",
      "updated": "2026-05-24",
      "tags": ["..."],
      "excerpt": "first ~280 chars of body, plain text",
      "word_count": 312,
      "rel_path": "wiki/concepts/example.md",
      "url": "https://wiki.example.com/wiki/page/example"
    }
  ],
  "base_url": "https://wiki.example.com",
  "endpoints": { "page": "...", "search": "...", "query": "...", "spec": "..." },
  "instructions_for_llm": "string. Natural-language hint for LLM clients"
}
```

Required fields: `viewer_tier`, `page_count`, `pages`, and within each
page entry `slug`, `title`, `tier`, `section`. All other fields are
recommended but optional; clients SHOULD treat missing optional fields
gracefully.

### `GET /wiki/page/{slug}`

A single page in full.

Response:

```json
{
  "slug": "calibrated-honesty",
  "title": "Calibrated Honesty",
  "section": "concepts",
  "type": "concept",
  "tier": "public",
  "created": "2026-05-23",
  "updated": "2026-05-24",
  "tags": ["communication"],
  "sources": ["raw/conversations/2026-05-23-example.md"],
  "excerpt": "...",
  "word_count": 312,
  "rel_path": "wiki/concepts/calibrated-honesty.md",
  "url": "https://wiki.example.com/wiki/page/calibrated-honesty",
  "body": "<UTF-8 markdown, no frontmatter>",
  "links_out": ["other-slug-1", "other-slug-2"],
  "links_in": ["other-slug-3"]
}
```

`links_out` and `links_in` are slug arrays representing the resolved
wikilink graph for this page. Servers MAY also include `links_out_resolved`
/ `links_in_resolved` with embedded `{slug,title,section}` entries and a
`rendered_body` field (markdown with `[[wikilinks]]` rewritten to standard
markdown links).

`404` if the slug does not exist OR exists but is above the viewer's tier.

### `GET /wiki/search?q={query}&limit={n}`

Keyword search across visible pages. The reference implementation scores
title hits at 5×, tag hits at 2×, and body-occurrence hits at 1× (capped
at 5 per term). Servers MAY substitute a different ranker.

Query parameters:

| Name | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `q` | string | yes |. | The query. MUST be non-empty (servers MAY return `422` on empty). |
| `limit` | integer | no | `25` | *(added in 1.0.1)* Maximum results to return. Servers MUST clamp to a reasonable upper bound (the reference implementation accepts `[1, 100]`; larger values return `422`). |

Response:

```json
{
  "query": "honesty",
  "limit": 25,
  "viewer_tier": "public",
  "results": [
    {
      "slug": "calibrated-honesty",
      "title": "Calibrated Honesty",
      "section": "concepts",
      "tier": "public",
      "excerpt": "...",
      "score": 12.0,
      "url": "https://wiki.example.com/wiki/page/calibrated-honesty"
    }
  ]
}
```

The response echoes the effective `limit` so clients can detect whether
their requested value was honored or silently truncated.

`score` is a server-defined float (higher is better-matched). Clients
SHOULD NOT compare scores across different servers.

### `POST /wiki/query`

One-shot natural-language Q&A. The server is responsible for retrieval
(picking which pages to feed an upstream LLM) and synthesis (generating
the answer). Citations point back at the wiki pages used.

Request:

```json
{ "question": "string, 2-2000 chars" }
```

Response:

```json
{
  "question": "string (echoed)",
  "viewer_tier": "public",
  "answer": "string. The synthesised answer, markdown",
  "citations": [{ "slug": "string", "title": "string" }],
  "backend": "anthropic | openai | keyword | …",
  "model": "string. Provider-specific model id, or 'keyword' for fallback",
  "used_pages": ["slug-1", "slug-2"],
  "retrieval": {
    "strategy": "string",
    "anchors": [{ "title": "string", "score": 7.0 }],
    "expanded": [{ "title": "string" }],
    "total": 8,
    "hops": 1
  }
}
```

`backend` MUST identify the synthesis engine. Servers that have no LLM
configured MUST return `"backend": "keyword"` (or another clearly
non-LLM identifier) and SHOULD return a deterministic top-matching-pages
summary so clients receive a useful response even without an LLM
provider.

`citations` and `used_pages` are not necessarily identical: `citations`
is the subset the answer actually references; `used_pages` is the full
retrieval set the LLM was shown.

### `POST /wiki/chat`

Multi-turn chat. Same retrieval + tier semantics as `/wiki/query`, plus
conversation history.

Request:

```json
{
  "message": "string, 1-4000 chars",
  "history": [
    { "role": "user" | "assistant", "content": "string, 1-10000 chars" }
  ]
}
```

`history` is the conversation so far (oldest first); `message` is the
new user turn. Servers MUST treat `history` as untrusted input and
re-run retrieval against the latest message + recent user turns, so a
client cannot fabricate prior assistant turns to bypass tier filtering.

Response shape matches `/wiki/query`, with `message` echoed instead of
`question`.

### `POST /wiki/chat/stream`

Server-Sent Events variant of `/wiki/chat`. Request body is identical to
`/wiki/chat`.

The response is `Content-Type: text/event-stream`. Each event is encoded
as `data: <json>\n\n`. The protocol uses *only* the `data:` field. The
SSE `event:` field is not used; event type is carried inside the JSON
payload.

Event sequence:

```
data: {"type":"start","backend":"anthropic","model":"claude-sonnet-4-5","viewer_tier":"public","citations":[{"slug":"...","title":"..."}],"used_pages":["..."],"retrieval":{...}}

data: {"type":"token","text":"The "}

data: {"type":"token","text":"Portable "}

…

data: {"type":"done"}
```

- The stream MUST start with exactly one `start` event carrying the
  retrieval/citation metadata so a client can render the citation list
  before any tokens arrive.
- Zero or more `token` events follow, each with a `text` field
  containing one chunk of the assistant's reply (concatenate in order).
- The stream MUST end with exactly one `done` event.
- `error` events MAY appear between `start` and `done`. Clients SHOULD
  treat an `error` event as informational. The stream may still produce
  useful tokens after one. A server hitting an unrecoverable error MUST
  still emit `done` so the client knows to stop reading.

Servers SHOULD send `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no` to prevent buffering proxies from defeating the
streaming behaviour.

Note: standard EventSource cannot POST. Clients typically use
`fetch().body.getReader()` (browsers) or an HTTP streaming client
(server-side) to consume this endpoint.

## Conformance

A conformant `llm-wiki` v1 server **MUST**:

1. Serve `/.well-known/llm-wiki.json` with `spec_version: "1.0"` (or
   newer 1.x) and at minimum the `manifest`, `page`, `search`, and
   `query` keys under `operations`.
2. Implement every operation listed in its manifest's `operations`
   field at the documented URL.
3. Honour the `Authorization: Bearer <token>` header and apply
   tier-based filtering on every response. Including search results,
   manifest entries, page bodies, and synthesised answers.
4. Return UTF-8 markdown bodies for page content.
5. Use ISO 8601 dates (`YYYY-MM-DD`) in frontmatter `created` / `updated`.
6. Return `404` rather than `403` when a page exists but is above the
   viewer's tier (no enumeration via status codes).

A conformant `llm-wiki` v1 server **SHOULD**:

1. Advertise its spec URL via `spec_url` in `.well-known`.
2. Emit `Retry-After` and `X-RateLimit-*` headers on rate-limit responses.
3. Return a useful answer from `/wiki/query` even when no LLM provider
   is configured, by falling back to a keyword summary with
   `"backend": "keyword"`.
4. Treat `history` in `/wiki/chat` as untrusted and re-run retrieval
   per request.

A conformant `llm-wiki` v1 client **SHOULD**:

1. Fetch `/.well-known/llm-wiki.json` first to discover operations
   rather than hard-coding URLs.
2. Cache the manifest for at most 5 minutes.
3. Honour `Retry-After` on `429` responses.
4. Treat missing optional fields gracefully.
5. Render citations alongside any synthesised answer. The protocol's
   provenance guarantee is meaningless if the client hides them.

## Extensions

Servers MAY add additional endpoints under the `/wiki/` namespace (and,
for owner-only operations, the `/owner/` namespace). Any extension
endpoint that clients should be able to discover MUST be advertised in
`operations` in `.well-known/llm-wiki.json`. Clients SHOULD ignore
unknown keys in `operations` rather than reject the manifest.

Examples of common extensions in the reference implementation:

- `/wiki/graph`, `/wiki/graph/{slug}`: wikilink graph as nodes + edges.
- `/owner/*`: write-side surface (ingest, page CRUD, tier changes,
  share-token minting, lint). Authenticated with the owner token.

Extensions MUST NOT redefine the behaviour of operations listed in this
spec. A v1.0 server is free to add `/wiki/graph`, but it cannot change
what `/wiki/page/{slug}` returns.

## Reference implementation

The canonical reference implementation lives at
<https://github.com/professorpalmer/portable-llm-wiki>. It ships:

- A FastAPI backend that implements every operation in this spec.
- A Next.js frontend that consumes the protocol as a regular client
  (the browser is just another `llm-wiki` client).
- A native MCP server (`portable-llm-wiki-mcp` on npm) that wraps the
  HTTP surface as typed MCP tools so Cursor, Claude Desktop, and any
  MCP-aware LLM client can talk to any v1-conformant wiki.
- A keyword-only fallback for `/wiki/query` and `/wiki/chat` so the
  server is usable without configuring any LLM provider key.

A v1-conformant client tested against the reference implementation
should work against any other v1 server, and vice versa.
