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
import { WikiClient, startupAuthLabel } from "./wikiClient.js";

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
    version: "0.1.4",
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
5. Owner-only: \`ingest_source\` saves a raw file and may start an orchestrator job;
   it does NOT mean wiki graph pages are updated. Use \`ingest_job_status\` to verify.

Every page has a tier (\`public\`/\`recruiter\`/\`friend\`/\`private\`). Pages above
your tier are invisible — don't synthesize claims about them.`,
  }
);

// ----------------- TOOLS -----------------

server.registerTool(
  "connection_status",
  {
    title: "Diagnose MCP ↔ wiki connection and capabilities",
    description:
      "Non-secret diagnostic: probes the backend manifest and reports base URL, whether a bearer token is configured (never the token value), viewer tier, page count, auth_mode (public / share_read_only / owner / token_not_elevated), and read/write/lint capability. Call this before owner-only writes.",
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
      "Returns the manifest: every page the current viewer can see, with title, slug, section, tier, tags, and a one-line excerpt. Call this first to learn what's in the wiki before asking specific questions.",
    inputSchema: {},
  },
  async () => {
    try {
      const m = (await wiki.apiGet("/wiki/manifest.json")) as {
        page_count: number;
        sections: Record<string, number>;
        viewer_tier: string;
        viewer_is_owner: boolean;
        pages: Array<{
          slug: string;
          title: string;
          section: string;
          tier: string;
          tags: string[];
          excerpt: string;
          updated: string | null;
        }>;
      };
      const summary = `Wiki has ${m.page_count} page(s) visible at tier=${m.viewer_tier}${
        m.viewer_is_owner ? " (owner)" : ""
      }. Sections: ${Object.entries(m.sections)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}.`;
      const pages = m.pages
        .map(
          (p) =>
            `- ${p.title} [${p.section}/${p.tier}] (slug: ${p.slug})${
              p.updated ? ` — updated ${p.updated}` : ""
            }${p.excerpt ? `\n  ${p.excerpt}` : ""}`
        )
        .join("\n");
      return asText(`${summary}\n\n${pages}`);
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
      "Returns the full markdown body + frontmatter + cross-references for one page, identified by its slug. Use when you need to quote from a page or follow its `[[wikilinks]]` to other pages.",
    inputSchema: {
      slug: z
        .string()
        .min(1)
        .describe("Page slug — the filename stem, e.g. 'calibrated-honesty'."),
    },
  },
  async ({ slug }) => {
    try {
      const p = (await wiki.apiGet(`/wiki/page/${encodeURIComponent(slug)}`)) as {
        title: string;
        section: string;
        tier: string;
        created: string | null;
        updated: string | null;
        tags: string[];
        body: string;
        sources: string[];
        links_out_resolved: Array<{ slug: string; title: string }>;
        links_in_resolved: Array<{ slug: string; title: string }>;
      };
      const header =
        `# ${p.title}\n` +
        `_section: ${p.section} · tier: ${p.tier}` +
        `${p.created ? ` · created: ${p.created}` : ""}` +
        `${p.updated ? ` · updated: ${p.updated}` : ""}` +
        `${p.tags.length ? ` · tags: ${p.tags.join(", ")}` : ""}_\n\n`;
      const linksOut = p.links_out_resolved.length
        ? `\n\n---\n**Links out:** ${p.links_out_resolved
            .map((l) => `[[${l.title}]] (slug: ${l.slug})`)
            .join(", ")}`
        : "";
      const linksIn = p.links_in_resolved.length
        ? `\n**Links in:** ${p.links_in_resolved
            .map((l) => `[[${l.title}]] (slug: ${l.slug})`)
            .join(", ")}`
        : "";
      const sources = p.sources.length
        ? `\n**Sources:** ${p.sources.join(", ")}`
        : "";
      return asText(header + p.body + linksOut + linksIn + sources);
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
      "Fast keyword search across page titles, tags, and bodies. Returns ranked matches. Good for exploration. For natural-language questions with synthesis, use `query_wiki` instead.",
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
      const r = (await wiki.apiGet(
        `/wiki/search?q=${encodeURIComponent(query)}`
      )) as {
        results: Array<{
          slug: string;
          title: string;
          section: string;
          tier: string;
          excerpt: string;
          score: number;
        }>;
      };
      const top = r.results.slice(0, limit ?? 10);
      if (top.length === 0) return asText(`No matches for "${query}".`);
      const out = top
        .map(
          (m) =>
            `[score ${m.score}] ${m.title} (slug: ${m.slug}, ${m.section}/${m.tier})\n  ${m.excerpt}`
        )
        .join("\n\n");
      return asText(out);
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
      "The primary tool. Does graph-aware retrieval (keyword anchors + 1-hop wikilink expansion, Index/Log catalogs omitted) and returns a synthesized answer grounded in wiki pages, with citations. Prefer this over `search_wiki` + manual stitching.",
    inputSchema: {
      question: z
        .string()
        .min(2)
        .describe("The user's question in natural language."),
    },
  },
  async ({ question }) => {
    try {
      const r = (await wiki.apiPost("/wiki/query", { question })) as {
        answer: string;
        citations: Array<{ slug: string; title: string }>;
        backend: string;
        retrieval?: {
          strategy: string;
          anchors: Array<{ title: string; score: number }>;
          expanded: Array<{ title: string }>;
        };
      };
      const cites = r.citations.length
        ? `\n\n---\nCitations: ${r.citations.map((c) => `[[${c.title}]]`).join(", ")}`
        : "";
      const retrieval = r.retrieval
        ? `\n\n_Retrieval: ${r.retrieval.strategy}. Anchors: ${r.retrieval.anchors
            .map((a) => a.title)
            .join(", ")}. Expanded: ${
            r.retrieval.expanded.map((e) => e.title).join(", ") || "(none)"
          }._`
        : "";
      return asText(r.answer + cites + retrieval);
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
      "Owner-only. Probes owner capability BEFORE sending content (stdio has no browser cookies). Saves raw content under raw/<subdir>/YYYY-MM-DD-<slug>.md and optionally starts the ingest orchestrator. Reports raw_file vs orchestrator vs durable_sync separately — never claims graph pages are updated merely because a raw file was saved. Use ingest_job_status with the returned tracking_id to verify orchestrator progress.",
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
          "If true, kick off the ingest orchestrator (costs LLM tokens). Default false. Graph updates only happen if/when that job completes."
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

server.registerTool(
  "lint_wiki",
  {
    title: "Run the wiki lint (owner-only)",
    description:
      "Owner-only. Probes owner capability first, then reports structural issues: orphan pages, stale pages, broken provenance, missing pages mentioned 3+ times, pages absent from index.md.",
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
