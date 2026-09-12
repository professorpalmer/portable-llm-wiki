# portable-llm-wiki-mcp

> **Speaks [llm-wiki spec v1](https://github.com/professorpalmer/portable-llm-wiki/blob/main/SPEC.md)** — the MCP wrapper for any server that speaks the spec.

A native MCP (Model Context Protocol) server that exposes the
[Portable LLM Wiki](https://github.com/professorpalmer/portable-llm-wiki)
as typed tool calls to Cursor, Claude Desktop, or any MCP-aware client.

Thin Node.js shim over the FastAPI backend at `WIKI_BASE_URL`. All wiki
state, tier filtering, and ownership decisions live in one place (the
backend) — the MCP server just provides the typed surface clients want.
Because the backend is just a vendor-neutral HTTP+JSON protocol
(`llm-wiki` spec v1), this same MCP wrapper works against any
conformant server, not just the reference implementation.

**Stdio is transport only.** This process never receives browser OAuth
session cookies. Read/write capability comes only from the optional
`WIKI_OWNER_TOKEN` bearer (or public reads with no token). Call
`connection_status` to see what the backend actually granted.

## Install

The fastest path is `npx`. You don't need to install anything explicitly;
your MCP client will fetch the package on first run and cache it.

If you want to install it globally for inspection:

```bash
npm install -g portable-llm-wiki-mcp
portable-llm-wiki-mcp --help
```

For development against a local copy of the source:

```bash
git clone https://github.com/professorpalmer/portable-llm-wiki
cd portable-llm-wiki/mcp
npm install && npm run build
```

## Configure your LLM client

### Cursor

Add to `~/.cursor/mcp.json` (or your workspace's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "portable-llm-wiki": {
      "command": "npx",
      "args": ["-y", "portable-llm-wiki-mcp"],
      "env": {
        "WIKI_BASE_URL": "https://portablellm.wiki/professorpalmer",
        "WIKI_OWNER_TOKEN": "<paste OWNER_TOKEN if you want write access>"
      }
    }
  }
}
```

`WIKI_BASE_URL` must be the path prefix before `/wiki` and `/owner` (hosted:
`https://portablellm.wiki/<tenant>`; local single-tenant backend:
`http://localhost:8000`).

Restart Cursor (Cmd+Shift+P → "Reload Window"). The wiki tools appear in any
chat — they show up as available functions for the model.

### Claude Desktop (macOS / Windows)

Edit the Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Use the same `mcpServers` block as the Cursor example. Then fully quit
and relaunch Claude Desktop.

### Other clients

Any MCP-aware client. The server uses stdio transport — point the client at
`npx -y portable-llm-wiki-mcp` (or the absolute path to `dist/server.js`
if running from source).

## Browser session vs stdio token authentication

| Context | How auth works |
|---|---|
| Browser / owner console | GitHub OAuth (hosted) or a pasted owner token in localStorage. Session cookies work. |
| Stdio MCP (this package) | No cookies. Optional `WIKI_OWNER_TOKEN` bearer on every HTTP call. |

Important consequences for stdio:

- Merely setting `WIKI_OWNER_TOKEN` does **not** mean you are owner. The
  server probes `GET /wiki/manifest.json` and reports the real
  `auth_mode`.
- A share/read-only token elevates reads only; write tools fail closed
  **before** sending source content.
- An invalid token is treated as `token_not_elevated` (public reads), not owner.
- Hosted personal-LLM private share tokens can be owner-capable headless
  credentials; recruiter/friend share tokens cannot.

Recommended first call in any agent session: `connection_status`.

## Environment variables

| Var | Purpose | Default |
|---|---|---|
| `WIKI_BASE_URL` | Path prefix before `/wiki` and `/owner` (preferred). Hosted: `https://portablellm.wiki/<tenant>`. Local single-tenant: `http://localhost:8000`. | `http://localhost:8000` |
| `WIKI_OWNER_TOKEN` | Optional bearer. May be owner-capable, share/read-only, or invalid — always verified via the manifest. Never logged. | (none) |
| `WIKI_SEAL_PASSPHRASE` | Passphrase that unwraps the sealed-tier keyring in this process. Required to read or write sealed tiers. Never logged, never sent to the server. | (none) |
| `WIKI_API_BASE` | Legacy alias for `WIKI_BASE_URL`. Still works if `WIKI_BASE_URL` is unset. | — |

When pointing at the hosted Vercel demo, use the tenant-scoped base URL
(`https://portablellm.wiki/<tenant>`, e.g. `https://portablellm.wiki/professorpalmer`) —
backend routes are proxied through Next.js so MCP calls work without the
`*.onrender.com` URL. A root URL like `https://portablellm.wiki` has no wiki
API (`/wiki/manifest.json` returns 404).

## Tools exposed

| Tool | Purpose | Owner-only |
|---|---|---|
| `connection_status` | Non-secret diagnostic: base URL, token-configured (boolean), `auth_mode`, viewer tier, page count, read/write/lint capability. | no |
| `list_pages` | Manifest of every visible page (slug, title, section, tier, excerpt). | no |
| `read_page` | Full body + frontmatter + cross-references for one page. | no |
| `search_wiki` | Fast keyword search across visible pages. | no |
| `query_wiki` | The primary tool. Natural-language question → graph-aware retrieval → sourced answer with citations. | no |
| `get_neighbors` | All pages within N hops of a slug along the wikilink graph. | no |
| `ingest_source` | Save a new raw source. Default does not run the server-side LLM. With `run_orchestrator=true` it starts the orchestrator or the hosted direct drafter (legacy). Prefer `write_pages` for graph updates. Fails closed if not owner-capable. | **yes** |
| `ingest_job_status` | Bounded polling of `GET /owner/jobs/{tracking_id}` (+ optional persistence). Verifies orchestrator outcome honestly. | **yes** |
| `write_pages` | Structured multi-page writeback. Forces tier private. | **yes** |
| `write_page_verbatim` | Write one authored markdown page; frontmatter tier is respected. | **yes** |
| `read_page_raw` | Full markdown including frontmatter. | **yes** |
| `replace_page` | Full-file replace including frontmatter. | **yes** |
| `append_to_page` | Read raw + PUT with exactly one newline before the appended text. | **yes** |
| `set_page_tier` | Change a page's visibility tier. | **yes** |
| `delete_page` | Delete a page file and reload the index. | **yes** |
| `writeback_spec` | Public schema text for `write_pages`. | no |
| `lint_wiki` | Structural lint report (orphans, stale, broken provenance, etc.). Refused by the server when sealing is enabled. | **yes** |
| `seal_status` | Whether sealing is enabled, which tiers, and whether this process is unlocked. | no |
| `seal_init` | Generate a keyring from `WIKI_SEAL_PASSPHRASE` and enable sealed tiers. | **yes** |
| `seal_disable` | Clear keyring tiers (already-sealed pages stay encrypted). | **yes** |
| `seal_page` | Encrypt an existing plaintext page in place (same slug). | **yes** |
| `unseal_page` | Decrypt a sealed page to a non-sealed tier in one PUT. | **yes** |

## Write tools

| Tool | Backend route | Notes |
|---|---|---|
| `write_pages` | `POST /owner/capture/structured` | Multi-page writeback. Forces tier private. Conflicts get a `-from-llm-<date>` suffix unless `force_overwrite`. Report lists only `written` rel_paths, plus conflicts, validation errors, and the durable sync verdict. |
| `write_page_verbatim` | `POST /owner/capture/verbatim` | Full markdown with YAML frontmatter. Tier in frontmatter is respected. Decisions need a date-prefixed slug. |
| `read_page_raw` | `GET /owner/page/{slug}/raw` | Full markdown including frontmatter. Owner-only. |
| `replace_page` | `PUT /owner/page/{slug}` | Full-file replace including frontmatter. Works for root pages (`index`, `log`, `overview`). |
| `append_to_page` | `GET /owner/page/{slug}/raw` then `PUT /owner/page/{slug}` | Client-side compose. Default separator is one newline between existing content and appended text. Primary use: dated line on `log`, new titles on `index`. |
| `set_page_tier` | `PATCH /owner/page/{slug}/tier` | `public` / `recruiter` / `friend` / `private`. |
| `delete_page` | `DELETE /owner/page/{slug}` | Removes the file, reloads the index, returns the durable sync verdict. |
| `writeback_spec` | `GET /llm-writeback-spec` | Public. Schema for `write_pages`. No auth required. |

### Ingest without a server-side LLM

Preferred path when the client can draft pages itself:

1. Optionally file the raw with `ingest_source` and `run_orchestrator=false` (the default) for provenance.
2. Read the source you already have and draft pages following `writeback_spec` — specific, dated, `[[Wikilinks]]` to existing titles from `list_pages`, 150-400 words.
3. Call `write_pages`.
4. `append_to_page` slug `log` with one dated line summarising what was added, and `append_to_page` slug `index` listing the new page titles under their section.
5. Verify with `list_pages` / `read_page`.

`run_orchestrator=true` is the legacy path that runs the operator's server-side LLM over the content. Use it only when the client cannot draft pages itself.

### `auth_mode` values from `connection_status`

| Mode | Meaning |
|---|---|
| `public` | No bearer configured. Public-tier reads. |
| `share_read_only` | Bearer elevates reads (e.g. recruiter/friend) but is not owner-capable. |
| `owner` | Backend granted `viewer_is_owner`. Write tools (`write_pages`, `replace_page`, `delete_page`, …) and lint available. |
| `token_not_elevated` | Bearer present but backend left the viewer on public (invalid/revoked/wrong wiki). |

### Honest ingest / status flow

1. Call `connection_status` — confirm `capabilities.write` is true.
2. Call `ingest_source` — response separates:
   - `raw_file: saved` (disk write only)
   - `wiki_graph_pages: not_updated_by_raw_save | updated_by_direct_drafter`
   - `orchestrator: not_requested | pending | running | failed | completed | skipped`
   - `direct_drafter: completed | failed` when the hosted fallback runs
   - `durable_sync: will_sync | local_only` (from the backend sync verdict)
3. When the response includes a `tracking_id`, call `ingest_job_status` with
   optional bounded `poll_attempts` / `poll_interval_ms` (caps: 20 attempts,
   5000 ms). A successful synchronous direct-drafter result needs no polling.
   Do not treat a raw save by itself as a graph update.

Without an owner-capable token, owner-only tools return an actionable error
explaining that browser OAuth cookies are unavailable to stdio and that a
real owner bearer (or supported headless personal-owner token) is required.

## Tier model

Every page in the wiki has a `tier:` frontmatter field (`public`,
`recruiter`, `friend`, `private`). The backend enforces tier-based
filtering on every request based on the bearer token, so the same MCP
server config can yield very different views depending on which token
you give it.

To mint a tier-scoped share token (e.g., recruiter-scoped) without
exposing the master `OWNER_TOKEN`, use the **Share Tokens** panel in the
owner console at `/owner`. The plaintext token is shown once at mint
time — paste it into the recipient's `WIKI_OWNER_TOKEN` env var. That
recipient should expect `auth_mode=share_read_only`, not owner writes.

## Sealed tiers

Sealing is opt-in. When the owner runs `seal_init`, chosen tiers
(typically `private`; optionally `friend` / `recruiter`) are stored on
the hosted server as ciphertext. Encryption and decryption happen in
this MCP process on the user's machine — or in the browser. `public`
can never be sealed.

Set `WIKI_SEAL_PASSPHRASE` in the MCP env (the same `env` block as
`WIKI_OWNER_TOKEN`). Call `connection_status` or `seal_status` to see
`sealing: {enabled, tiers, unlocked}`. If the passphrase is missing or
wrong, the process is locked: reads of sealed pages return a
placeholder, and writes that would send plaintext to a sealed tier are
refused before anything is posted.

When `private` is sealed and the process is unlocked, `write_pages`
seals each page locally (opaque slug, `sealed: v1` frontmatter) and
writes through `/owner/capture/verbatim` instead of posting plaintext
to `/owner/capture/structured`. `append_to_page` decrypts, appends,
and re-seals. `search_wiki` / `query_wiki` merge local hits over the
decrypted bundle (labelled "decrypted locally"); the MCP does not call
an LLM. The server-side orchestrator is disabled on sealed wikis.

What the server operator can see: tier, section, dates, page count,
and ciphertext. Titles, tags, sources, and bodies are encrypted.
Slugs are opaque (`s-<hmac>`) except root pages `index`, `log`, and
`overview`.

If you lose the passphrase, nobody can recover the pages — not you,
not the server operator.

Sealing does not rewrite git history: pages that were plaintext before
`seal_page` remain plaintext in earlier commits until that history is
rotated. `seal_page` keeps the existing file name; only pages created
through `write_pages` after sealing get opaque slugs. `raw/` captures
are not sealed. After `seal_disable` the keyring stays on the server so
leftover sealed pages can still be read and `unseal_page`d.

## Smoke test / unit tests

No live credentials required (uses an embedded mock backend):

```bash
cd mcp
npm install && npm run build
npm test
npm run smoke
```

Optional live smoke against a running wiki:

```bash
SMOKE_LIVE=1 WIKI_BASE_URL=https://portablellm.wiki/professorpalmer npm run smoke
```

Handshake-only one-liner:

```bash
WIKI_BASE_URL=https://portablellm.wiki/professorpalmer npx -y portable-llm-wiki-mcp@latest \
  <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'
```

The handshake should return a JSON-RPC response listing `protocolVersion`,
capabilities, and the server's `name`/`version`.

## Troubleshooting

- **"backend at … is not reachable"** in stderr → the configured `WIKI_BASE_URL`
  isn't responding. Verify with `curl $WIKI_BASE_URL/healthz`.
- **Startup says share/read-only or token not elevated** → a bearer is set but
  is not owner-capable. Use `connection_status` for details. This is not
  logged as owner.
- **Tools return owner-capability errors** → missing/invalid/share token for
  stdio. Browser login does not carry over. Set a real owner-capable
  `WIKI_OWNER_TOKEN`.
- **Cursor doesn't see the tools** → check the MCP server logs in Cursor
  (Cmd+Shift+P → "Output: Show Output Channels…" → look for MCP).

## License

MIT
