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
| `ingest_source` | Save a new raw source + optionally kick off the ingest orchestrator. Fails closed if not owner-capable. | **yes** |
| `ingest_job_status` | Bounded polling of `GET /owner/jobs/{tracking_id}` (+ optional persistence). Verifies orchestrator outcome honestly. | **yes** |
| `lint_wiki` | Structural lint report (orphans, stale, broken provenance, etc.). | **yes** |

### `auth_mode` values from `connection_status`

| Mode | Meaning |
|---|---|
| `public` | No bearer configured. Public-tier reads. |
| `share_read_only` | Bearer elevates reads (e.g. recruiter/friend) but is not owner-capable. |
| `owner` | Backend granted `viewer_is_owner`. Write/lint available. |
| `token_not_elevated` | Bearer present but backend left the viewer on public (invalid/revoked/wrong wiki). |

### Honest ingest / status flow

1. Call `connection_status` — confirm `capabilities.write` is true.
2. Call `ingest_source` — response separates:
   - `raw_file: saved` (disk write only)
   - `wiki_graph_pages: not_updated_by_raw_save`
   - `orchestrator: not_requested | pending | running | failed | completed | skipped`
   - `durable_sync: will_sync | local_only` (from the backend sync verdict)
3. If you passed `run_orchestrator=true`, call `ingest_job_status` with the
   `tracking_id` and optional bounded `poll_attempts` / `poll_interval_ms`
   (caps: 20 attempts, 5000 ms). Do not treat a raw save as a graph update.

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
