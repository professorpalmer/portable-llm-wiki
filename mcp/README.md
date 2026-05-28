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
        "WIKI_BASE_URL": "https://portablellm.wiki",
        "WIKI_OWNER_TOKEN": "<paste OWNER_TOKEN if you want write access>"
      }
    }
  }
}
```

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

## Environment variables

| Var | Purpose | Default |
|---|---|---|
| `WIKI_BASE_URL` | Base URL of your wiki's FastAPI backend. | `http://localhost:8000` |
| `WIKI_OWNER_TOKEN` | Optional. With it: owner tier + write tools. Without: public tier only. | (none) |
| `WIKI_API_BASE` | Legacy alias for `WIKI_BASE_URL`. Still works. | — |

When pointing at the hosted Vercel demo, use the full Vercel URL
(`https://portablellm.wiki`) — backend routes are proxied through
Next.js so MCP calls work without the `*.onrender.com` URL.

## Tools exposed

| Tool | Purpose | Owner-only |
|---|---|---|
| `list_pages` | Manifest of every visible page (slug, title, section, tier, excerpt). Call once at session start. | no |
| `read_page` | Full body + frontmatter + cross-references for one page. | no |
| `search_wiki` | Fast keyword search across visible pages. | no |
| `query_wiki` | The primary tool. Natural-language question → graph-aware retrieval → sourced answer with citations. | no |
| `get_neighbors` | All pages within N hops of a slug along the wikilink graph. | no |
| `ingest_source` | Save a new raw source + optionally kick off the Puppetmaster ingest agent. | **yes** |
| `lint_wiki` | Structural lint report (orphans, stale, broken provenance, etc.). | **yes** |

Without `WIKI_OWNER_TOKEN`, the server only surfaces public-tier pages and
the owner-only tools return errors. This is the safe default for sharing
your wiki with someone else's MCP client.

### Durability disclosure on `ingest_source`

`ingest_source` reports whether the write will actually persist. When the
backend has git sync configured, the result ends with a `Sync:`
confirmation. When it does not (self-host with no `WIKI_GIT_REMOTE`, or a
hosted tenant with no connected repo), the result ends with a loud
`WARNING — NOT SYNCED:` line plus the fix — so an agent never reports a
durable save for a write that only landed on local disk.

## Tier model

Every page in the wiki has a `tier:` frontmatter field (`public`,
`recruiter`, `friend`, `private`). The backend enforces tier-based
filtering on every request based on the bearer token, so the same MCP
server config can yield very different views depending on which token
you give it.

To mint a tier-scoped share token (e.g., recruiter-scoped) without
exposing the master `OWNER_TOKEN`, use the **Share Tokens** panel in the
owner console at `/owner`. The plaintext token is shown once at mint
time — paste it into the recipient's `WIKI_OWNER_TOKEN` env var.

## Smoke test

```bash
WIKI_BASE_URL=https://portablellm.wiki npx -y portable-llm-wiki-mcp@latest \
  <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'
```

The handshake should return a JSON-RPC response listing `protocolVersion`,
capabilities, and the server's `name`/`version`.

## Troubleshooting

- **"backend at … is not reachable"** in stderr → the configured `WIKI_BASE_URL`
  isn't responding. Verify with `curl $WIKI_BASE_URL/healthz`.
- **Tools return "owner-only"** → no `WIKI_OWNER_TOKEN` in your MCP env, or
  the token is wrong.
- **Cursor doesn't see the tools** → check the MCP server logs in Cursor
  (Cmd+Shift+P → "Output: Show Output Channels…" → look for MCP).

## License

MIT
