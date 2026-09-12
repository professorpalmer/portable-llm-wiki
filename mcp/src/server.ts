#!/usr/bin/env node
/**
 * Portable LLM Wiki — MCP server.
 *
 * Exposes typed tools so Cursor, Claude Desktop, and any MCP-aware LLM client
 * can interact with a Portable LLM Wiki without prompting tricks or URL pasting.
 *
 * Stdio is transport only. Talks to the FastAPI backend over HTTP, passing
 * an optional bearer from env. Ownership is never inferred from token
 * presence alone — tools probe `/wiki/manifest.json` for real capability.
 *
 * Configure in Cursor (~/.cursor/mcp.json) or Claude Desktop:
 *
 *   {
 *     "mcpServers": {
 *       "portable-llm-wiki": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/portable-llm-wiki/mcp/dist/server.js"],
 *         "env": {
 *           "WIKI_BASE_URL": "http://localhost:8000",
 *           "WIKI_OWNER_TOKEN": "<paste from backend/.env>"
 *         }
 *       }
 *     }
 *   }
 *
 * The bearer is optional. Without it, the client only sees public-tier
 * pages — fine for sharing a read-only wiki with someone else's LLM.
 * Browser OAuth cookies never reach this process.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  WikiClient,
  formatListPagesReport,
  formatQueryWikiReport,
  formatReadPageReport,
  formatSearchWikiReport,
  startupAuthLabel,
} from "./wikiClient.js";

const wiki = WikiClient.fromEnv();

function asText(data: unknown): { content: { type: "text"; text: string }[] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function asError(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const server = new McpServer(
  {
    name: "portable-llm-wiki",
    version: "0.3.0",
  },
  {
    instructions: `You are connected to a Portable LLM Wiki via stdio MCP at ${wiki.baseUrl}.

Stdio is transport only: browser OAuth cookies are not available here. Capability
depends on the optional WIKI_OWNER_TOKEN bearer (or public reads with no token).

At session start, call \`connection_status\` to learn auth_mode (public /
share_read_only / owner / token_not_elevated), page_count, and read/write/lint
capability. Never assume write access from a configured token alone.

Typical flow:
1. Call \`connection_status\` (or \`list_pages\`) once at the start of a session.
2. For specific questions, call \`query_wiki\` — graph-aware retrieval with sources.
3. For exploration, use \`search_wiki\` (keyword) or \`get_neighbors\` (graph walk).
4. \`read_page\` returns the full body of a single page when you need quotes.
5. Owner-only writes: prefer \`write_pages\` (then \`append_to_page\` on \`log\` and
   \`index\`) so you draft pages yourself. See the preferred ingest section below.
6. \`ingest_source\` only files a raw source. It does NOT update wiki graph pages
   unless you set \`run_orchestrator=true\` (legacy). Use \`ingest_job_status\` to
   verify that job if you take that path.

Ingest without a server-side LLM (preferred)
(a) Optionally file the raw with \`ingest_source\` and \`run_orchestrator=false\`
    (default) for provenance.
(b) YOU (the session LLM) read the source you already have and draft pages
    following \`writeback_spec\` (specific, dated, [[Wikilinks]] to existing
    titles from \`list_pages\`, 150-400 words).
(c) Call \`write_pages\`.
(d) \`append_to_page\` slug \`log\` with one dated line summarising what was
    added, and \`append_to_page\` slug \`index\` listing the new page titles
    under their section.
(e) Verify with \`list_pages\` / \`read_page\`.

\`run_orchestrator=true\` is the legacy path that runs the operator's
server-side LLM over the content and should only be used when the client
cannot draft pages itself.

Every page has a tier (\`public\`/\`recruiter\`/\`friend\`/\`private\`). Pages above
your tier are invisible — don't synthesize claims about them.

Sealed tiers
The owner can enable sealing so chosen tiers (typically private) are stored
as ciphertext on the hosted server. Encryption and decryption happen in this
MCP process. The server operator never sees titles, tags, or bodies for
sealed pages — only tier, section, dates, and ciphertext.

WIKI_SEAL_PASSPHRASE must be set in the MCP env to read or write sealed
tiers. If sealing is enabled and the passphrase is missing or wrong, writes
that would send plaintext to a sealed tier are refused. Losing the
passphrase means nobody can recover those pages.

The server-side orchestrator is disabled on sealed wikis. Do not use
\`run_orchestrator=true\`; draft locally and call \`write_pages\`. When private
is a sealed tier, \`write_pages\` automatically seals each page (opaque slug,
ciphertext via verbatim capture) instead of posting plaintext structured
pages.

Call \`seal_status\` / \`connection_status\` to see whether sealing is enabled
and unlocked. Owner tools: \`seal_init\`, \`seal_disable\`, \`seal_page\`,
\`unseal_page\`.`,
  }
);

// ----------------- TOOLS -----------------

server.registerTool(
  "connection_status",
  {
    title: "Diagnose MCP ↔ wiki connection and capabilities",
    description:
      "Non-secret diagnostic: probes the backend manifest and reports base URL, whether a bearer token is configured (never the token value), viewer tier, page count, auth_mode (public / share_read_only / owner / token_not_elevated), read/write/lint capability, and sealing {enabled, tiers, unlocked, reason}. Call this before owner-only writes.",
    inputSchema: {},
  },
  async () => {
    try {
      const status = await wiki.connectionStatus();
      return asText(status);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "list_pages",
  {
    title: "List all visible wiki pages",
    description:
      "Returns the manifest: every page the current viewer can see, with title, slug, section, tier, tags, and a one-line excerpt. When sealed tiers are unlocked, placeholder 'Sealed page' titles are replaced from the locally decrypted bundle. Call this first to learn what's in the wiki before asking specific questions.",
    inputSchema: {},
  },
  async () => {
    try {
      const m = await wiki.listPages();
      return asText(formatListPagesReport(m));
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "read_page",
  {
    title: "Read a wiki page in full",
    description:
      "Returns the full markdown body + frontmatter + cross-references for one page, identified by its slug. Sealed pages are decrypted locally when WIKI_SEAL_PASSPHRASE unlocks the keyring (report includes decrypted_locally: true). If sealing is locked, returns the sealed placeholder and the locked reason. Use when you need to quote from a page or follow its `[[wikilinks]]` to other pages.",
    inputSchema: {
      slug: z
        .string()
        .min(1)
        .describe("Page slug — the filename stem, e.g. 'calibrated-honesty'."),
    },
  },
  async ({ slug }) => {
    try {
      const page = await wiki.readPage(slug);
      return asText(formatReadPageReport(page));
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "search_wiki",
  {
    title: "Keyword search across visible pages",
    description:
      "Fast keyword search across page titles, tags, and bodies. Returns ranked matches. When sealed tiers are unlocked, merges a local keyword search over the decrypted bundle and labels those hits 'decrypted locally'. Good for exploration. For natural-language questions with synthesis, use `query_wiki` instead.",
    inputSchema: {
      query: z.string().min(1).describe("Keyword(s) to search for."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)."),
    },
  },
  async ({ query, limit }) => {
    try {
      const r = await wiki.searchWiki(query, limit ?? 10);
      return asText(formatSearchWikiReport(query, r.results));
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "query_wiki",
  {
    title: "Ask a natural-language question, get a sourced answer",
    description:
      "The primary tool. Does graph-aware retrieval (keyword anchors + 1-hop wikilink expansion, Index/Log catalogs omitted) and returns a synthesized answer grounded in wiki pages, with citations. Sealed pages are excluded from server retrieval; when unlocked this tool appends a 'Sealed context (decrypted locally)' section with the top local passages. Mentions sealed_excluded when the server reports it. No LLM call inside the MCP. Prefer this over `search_wiki` + manual stitching.",
    inputSchema: {
      question: z
        .string()
        .min(2)
        .describe("The user's question in natural language."),
    },
  },
  async ({ question }) => {
    try {
      const r = await wiki.queryWiki(question);
      return asText(formatQueryWikiReport(r));
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "get_neighbors",
  {
    title: "Get the wikilink neighborhood of a page",
    description:
      "Returns all pages within N hops of a given slug along the `[[wikilink]]` graph. Use to discover what's related to a page without reading the full body.",
    inputSchema: {
      slug: z.string().min(1),
      hops: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe("Number of hops to expand (default 1)."),
    },
  },
  async ({ slug, hops }) => {
    try {
      const r = (await wiki.apiGet(
        `/wiki/graph/${encodeURIComponent(slug)}?hops=${hops ?? 1}`
      )) as {
        nodes: Array<{
          slug: string;
          title: string;
          section: string;
          tier: string;
          is_anchor: boolean;
          degree: number;
        }>;
        edges: Array<{ source: string; target: string }>;
        anchors: string[];
      };
      const nodes = r.nodes
        .map(
          (n) =>
            `${n.is_anchor ? "*" : "-"} ${n.title} (slug: ${n.slug}, ${n.section}/${n.tier}, degree ${n.degree})`
        )
        .join("\n");
      return asText(
        `${hops ?? 1}-hop neighborhood of ${slug}: ${r.nodes.length} pages, ${r.edges.length} edges.\n\n${nodes}`
      );
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "ingest_source",
  {
    title: "Ingest a new source into the wiki (owner-only)",
    description:
      "Owner-only. Probes owner capability BEFORE sending content (stdio has no browser cookies). Saves raw content under raw/<subdir>/YYYY-MM-DD-<slug>.md. Prefer the no-server-LLM flow: file with run_orchestrator=false (default) for provenance, draft pages from writeback_spec, then write_pages and append_to_page on log/index. run_orchestrator=true is the legacy path that runs the operator's server-side LLM and should only be used when the client cannot draft pages itself. On sealed wikis the server-side orchestrator is disabled (409). Reports raw_file vs orchestrator vs durable_sync separately — never claims graph pages are updated merely because a raw file was saved.",
    inputSchema: {
      slug: z
        .string()
        .min(2)
        .max(120)
        .describe("Short slug for the source filename (lowercase, hyphens)."),
      content: z.string().min(1).describe("The full source content to file."),
      subdir: z
        .enum(["conversations", "articles", "meetings", "assets"])
        .optional()
        .describe("Which raw/ subdir to file under (default 'conversations')."),
      note: z.string().optional().describe("One-line note about the source."),
      run_orchestrator: z
        .boolean()
        .optional()
        .describe(
          "Legacy. If true, kick off the operator's server-side ingest orchestrator (costs their LLM tokens). Default false. Prefer write_pages after drafting locally. Graph updates from this flag only happen if/when that job completes."
        ),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.ingestSource(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "ingest_job_status",
  {
    title: "Verify an ingest orchestrator job (owner-only, read-only)",
    description:
      "Owner-only status/verification for a prior ingest_source orchestrator job. Reuses GET /owner/jobs/{tracking_id} (and optionally /owner/persistence). Supports bounded polling (poll_attempts ≤ 20, poll_interval_ms ≤ 5000) — never blocks indefinitely. Distinguishes pending/running/failed/completed; does not invent graph-page updates.",
    inputSchema: {
      tracking_id: z
        .string()
        .min(1)
        .describe("tracking_id returned by ingest_source when run_orchestrator=true."),
      poll_attempts: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many times to poll (default 1 = single check)."),
      poll_interval_ms: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe("Delay between polls in ms (default 500, max 5000)."),
      include_persistence: z
        .boolean()
        .optional()
        .describe("If true, also fetch GET /owner/persistence for durable sync state."),
    },
  },
  async (args) => {
    try {
      const report = await wiki.ingestJobStatus(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

const writePageSchema = z.object({
  slug: z.string().min(1).describe("Page slug (filename stem)."),
  title: z.string().min(1).describe("Page title."),
  section: z
    .enum(["entities", "concepts", "decisions", "projects", "queries"])
    .describe("Wiki section."),
  tags: z.array(z.string()).optional().describe("Optional tags."),
  body: z.string().describe("Markdown body (no frontmatter)."),
});

server.registerTool(
  "write_pages",
  {
    title: "Write structured wiki pages (owner-only)",
    description:
      "Owner-only. Probes owner capability BEFORE sending content. When sealing is not enabled, commits drafted pages via POST /owner/capture/structured (forces tier private). When private is a sealed tier and this process is unlocked, each page is sealed locally (opaque slug, ciphertext) and written via POST /owner/capture/verbatim — the request never contains plaintext title/body. If sealing is enabled but locked, the tool refuses before sending anything. Conflicts get a -from-llm-<date> suffix unless force_overwrite. The report lists only pages in `written`, plus conflicts, validation errors, and the durable sync verdict. Never claims a page was written unless it appears in `written`.",
    inputSchema: {
      session_label: z
        .string()
        .min(3)
        .describe(
          "Provenance label stored in each page's sources (e.g. 'chatgpt-2026-09-12-pricing')."
        ),
      pages: z
        .array(writePageSchema)
        .min(1)
        .describe("Drafted pages matching writeback_spec."),
      force_overwrite: z
        .boolean()
        .optional()
        .describe("If true, overwrite an existing slug instead of suffixing."),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.writePages(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "write_page_verbatim",
  {
    title: "Write one authored markdown page (owner-only)",
    description:
      "Owner-only. Probes owner capability BEFORE sending content. POST /owner/capture/verbatim. Input is a complete markdown file with YAML frontmatter; tier in frontmatter is respected. If the document's tier is sealed and the markdown is plaintext, it is sealed client-side before sending (provided slug, or an opaque slug). If sealing is locked, the write is refused. Reports the written page, any conflict suffix, and the durable sync verdict.",
    inputSchema: {
      content: z
        .string()
        .min(1)
        .describe("Full markdown including YAML frontmatter."),
      slug: z.string().min(1).optional().describe("Optional slug override."),
      force_overwrite: z
        .boolean()
        .optional()
        .describe("If true, overwrite an existing file instead of suffixing."),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.writePageVerbatim(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "read_page_raw",
  {
    title: "Read a page's raw markdown including frontmatter (owner-only)",
    description:
      "Owner-only. Probes owner capability first. GET /owner/page/{slug}/raw. Returns the full markdown file including YAML frontmatter. Sealed pages are decrypted locally when unlocked (decrypted_locally: true) into plaintext frontmatter (title/tags/sources). If locked, returns the sealed file plus the locked reason.",
    inputSchema: {
      slug: z.string().min(1).describe("Page slug."),
    },
  },
  async ({ slug }) => {
    try {
      const page = await wiki.readPageRaw(slug);
      if (page.decrypted_locally) {
        return asText(`decrypted_locally: true\n\n${page.markdown}`);
      }
      if (page.locked_reason) {
        return asText(
          `sealed: locked (${page.locked_reason})\n\n${page.markdown}`
        );
      }
      return asText(page.markdown);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "replace_page",
  {
    title: "Replace a page's full markdown (owner-only)",
    description:
      "Owner-only. Probes owner capability BEFORE sending content. PUT /owner/page/{slug}. Full-file replace including frontmatter. Works for root pages (slugs index, log, overview). If the document's tier is sealed and the markdown is plaintext, it is sealed client-side before sending (slug kept). If sealing is locked, the write is refused. Reports tier, title, size, and the durable sync verdict.",
    inputSchema: {
      slug: z.string().min(1).describe("Page slug."),
      markdown: z
        .string()
        .min(1)
        .describe("Full replacement markdown including YAML frontmatter."),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.replacePage(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "append_to_page",
  {
    title: "Append text to a page (owner-only)",
    description:
      "Owner-only. Probes owner capability BEFORE sending content. Reads GET /owner/page/{slug}/raw, then PUT with the appended text. Default separator is a single newline; existing trailing newlines are collapsed so there is exactly one newline between the prior content and the appended text. On sealed pages: decrypt, append to the body with the same one-newline rule, re-seal, PUT. If the page is still plaintext but its tier is sealed (not yet migrated), it is sealed on write. Primary use: append a dated line to slug `log`, or list new titles on slug `index`. Reports old size -> new size.",
    inputSchema: {
      slug: z.string().min(1).describe("Page slug (often `log` or `index`)."),
      text: z.string().min(1).describe("Text to append."),
      separator: z
        .string()
        .optional()
        .describe("Join string; default a single newline."),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.appendToPage(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "set_page_tier",
  {
    title: "Change a page's visibility tier (owner-only)",
    description:
      "Owner-only. Probes owner capability BEFORE sending content. PATCH /owner/page/{slug}/tier. Cannot cross the seal boundary (sealed page to an unsealed tier, or plaintext to a sealed tier); use seal_page / unseal_page for those moves.",
    inputSchema: {
      slug: z.string().min(1).describe("Page slug."),
      tier: z
        .enum(["public", "recruiter", "friend", "private"])
        .describe("New visibility tier."),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.setPageTier(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "delete_page",
  {
    title: "Delete a wiki page (owner-only)",
    description:
      "Owner-only. Probes owner capability first. DELETE /owner/page/{slug}. Removes the page file and reloads the index. Reports the deleted slug, rel_path, and durable sync verdict.",
    inputSchema: {
      slug: z.string().min(1).describe("Page slug to delete."),
    },
  },
  async ({ slug }) => {
    try {
      const { report } = await wiki.deletePage(slug);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "writeback_spec",
  {
    title: "Fetch the structured writeback schema",
    description:
      "Public. GET /llm-writeback-spec (no auth). Returns the markdown schema a session LLM should follow when drafting pages for write_pages.",
    inputSchema: {},
  },
  async () => {
    try {
      const spec = await wiki.writebackSpec();
      return asText(spec);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "seal_init",
  {
    title: "Enable sealed tiers (owner-only)",
    description:
      "Owner-only. Generates a keyring from WIKI_SEAL_PASSPHRASE and PUT /owner/sealing. Default tiers: [private]. public can never be sealed. force=true overwrites an existing keyring. Losing the passphrase means sealed pages cannot be recovered. Server-side orchestrator is disabled once sealing is enabled.",
    inputSchema: {
      tiers: z
        .array(z.enum(["recruiter", "friend", "private"]))
        .optional()
        .describe("Tiers to seal (default [private]). public is never allowed."),
      force: z
        .boolean()
        .optional()
        .describe("If true, replace an existing keyring (409 otherwise)."),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.sealInit(args);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "seal_disable",
  {
    title: "Disable sealed-tier gating (owner-only)",
    description:
      "Owner-only. DELETE /owner/sealing. Clears keyring tiers so new writes are no longer forced through sealing. Already-sealed pages stay encrypted and can still be opened with the passphrase.",
    inputSchema: {},
  },
  async () => {
    try {
      const { report } = await wiki.sealDisable();
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "seal_status",
  {
    title: "Report sealed-tier unlock state",
    description:
      "Reports whether sealing is enabled, which tiers are sealed, and whether this process is unlocked. Never returns the passphrase or DEK. Call connection_status for the same sealing block plus auth diagnostics.",
    inputSchema: {},
  },
  async () => {
    try {
      const status = await wiki.sealStatus();
      return asText(status);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "seal_page",
  {
    title: "Encrypt an existing plaintext page in place (owner-only)",
    description:
      "Owner-only. Reads a plaintext page, seals it client-side, and PUTs ciphertext at the same slug. The page's current tier must already be a sealed tier.",
    inputSchema: {
      slug: z.string().min(1).describe("Page slug to seal in place."),
    },
  },
  async ({ slug }) => {
    try {
      const { report } = await wiki.sealPageBySlug(slug);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "unseal_page",
  {
    title: "Decrypt a sealed page to a non-sealed tier (owner-only)",
    description:
      "Owner-only. Decrypts a sealed page locally and PUTs plaintext at a non-sealed tier (content and tier change together). Target tier must not be in the sealed set.",
    inputSchema: {
      slug: z.string().min(1).describe("Sealed page slug."),
      tier: z
        .enum(["public", "recruiter", "friend", "private"])
        .describe("Destination tier (must not be a sealed tier)."),
    },
  },
  async (args) => {
    try {
      const { report } = await wiki.unsealPageBySlug(args.slug, args.tier);
      return asText(report);
    } catch (err) {
      return asError(err);
    }
  }
);

server.registerTool(
  "lint_wiki",
  {
    title: "Run the wiki lint (owner-only)",
    description:
      "Owner-only. Probes owner capability first, then reports structural issues: orphan pages, stale pages, broken provenance, missing pages mentioned 3+ times, pages absent from index.md. The server refuses lint (409) when sealing is enabled.",
    inputSchema: {},
  },
  async () => {
    try {
      await wiki.requireOwnerCapability();
      const r = (await wiki.apiPost("/owner/lint", {})) as {
        totals: {
          pages: number;
          by_section: Record<string, number>;
          by_tier: Record<string, number>;
        };
        orphans: Array<{ title: string; section: string }>;
        stale: Array<{ title: string; age_days: number }>;
        missing_pages: Array<{ title: string; mentions: number }>;
        broken_provenance: Array<{ title: string; missing_source: string }>;
        missing_index_entries: Array<{ title?: string; reason?: string }>;
      };
      const lines: string[] = [];
      lines.push(`# Lint report — ${r.totals.pages} pages`);
      lines.push(
        `Sections: ${Object.entries(r.totals.by_section)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`
      );
      lines.push(
        `Tiers: ${Object.entries(r.totals.by_tier)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`
      );
      if (r.orphans.length) {
        lines.push(`\n## Orphans (no inbound wikilinks): ${r.orphans.length}`);
        lines.push(r.orphans.map((o) => `- ${o.title} (${o.section})`).join("\n"));
      }
      if (r.stale.length) {
        lines.push(`\n## Stale (>30 days since update): ${r.stale.length}`);
        lines.push(r.stale.map((s) => `- ${s.title} — ${s.age_days}d`).join("\n"));
      }
      if (r.missing_pages.length) {
        lines.push(
          `\n## Missing pages (referenced ≥3 times, not present): ${r.missing_pages.length}`
        );
        lines.push(
          r.missing_pages.map((m) => `- ${m.title} (${m.mentions} mentions)`).join("\n")
        );
      }
      if (r.broken_provenance.length) {
        lines.push(`\n## Broken provenance: ${r.broken_provenance.length}`);
        lines.push(
          r.broken_provenance
            .map((b) => `- ${b.title} → missing ${b.missing_source}`)
            .join("\n")
        );
      }
      if (r.missing_index_entries.length) {
        lines.push(`\n## Missing from index.md: ${r.missing_index_entries.length}`);
        lines.push(
          r.missing_index_entries
            .map((m) => (m.title ? `- ${m.title}` : `- ${m.reason}`))
            .join("\n")
        );
      }
      return asText(lines.join("\n"));
    } catch (err) {
      return asError(err);
    }
  }
);

// ----------------- BOOT -----------------

async function main() {
  // Sanity check: reach backend and classify auth from the manifest — never
  // log "owner" merely because WIKI_OWNER_TOKEN is set.
  try {
    const status = await wiki.connectionStatus();
    process.stderr.write(
      `[portable-llm-wiki-mcp] connected to ${status.base_url} — ${status.page_count} pages indexed (${startupAuthLabel(status)}; token_configured=${status.token_configured})\n`
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    process.stderr.write(
      `[portable-llm-wiki-mcp] WARNING: backend at ${wiki.baseUrl} is not reachable (${message}).\n` +
        `[portable-llm-wiki-mcp] Hint: verify with 'curl ${wiki.baseUrl}/healthz'. Tools will fail until the backend responds.\n`
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isExecutedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    // Fallback: compare filesystem paths (handles some symlink/argv shapes).
    try {
      return fileURLToPath(import.meta.url) === resolve(entry);
    } catch {
      return false;
    }
  }
}

if (isExecutedAsMain()) {
  main().catch((err) => {
    process.stderr.write(`[portable-llm-wiki-mcp] fatal: ${err}\n`);
    process.exit(1);
  });
}

// Re-export client helpers for tests / programmatic use.
export { wiki, server, main };
export {
  WikiClient,
  classifyAuthMode,
  buildConnectionStatus,
  formatIngestReport,
  ownerPreflightError,
  resolveApiBase,
} from "./wikiClient.js";
