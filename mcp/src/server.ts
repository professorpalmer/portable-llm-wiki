#!/usr/bin/env node
/**
 * Portable LLM Wiki — MCP server.
 *
 * Exposes typed tools so Cursor, Claude Desktop, and any MCP-aware LLM client
 * can interact with a Portable LLM Wiki without prompting tricks or URL pasting.
 *
 * Talks to the FastAPI backend over HTTP, passing the owner token from env on
 * every request so tier filtering and ownership decisions live in one place.
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
 * The OWNER_TOKEN is optional. Without it, the client only sees public-tier
 * pages — fine for sharing a read-only wiki with someone else's LLM.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Accept either env var name — WIKI_BASE_URL is what the Connect page and
// README document. WIKI_API_BASE is kept for back-compat with v0.1.0 configs.
const API_BASE = (
  process.env.WIKI_BASE_URL ??
  process.env.WIKI_API_BASE ??
  "http://localhost:8000"
).replace(/\/$/, "");
const OWNER_TOKEN = process.env.WIKI_OWNER_TOKEN ?? "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (OWNER_TOKEN) h["Authorization"] = `Bearer ${OWNER_TOKEN}`;
  return h;
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GET ${path} → ${res.status}: ${detail.slice(0, 400)}`);
  }
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${detail.slice(0, 400)}`);
  }
  return res.json();
}

function asText(data: unknown): { content: { type: "text"; text: string }[] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function asError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * The backend stamps every content-mutating response with a `sync` verdict
 * describing whether the write will actually reach a git remote (and the
 * hosted site). We surface it verbatim so an agent never reports a durable
 * success for a write that only landed on local disk.
 */
interface SyncVerdict {
  will_sync: boolean;
  mode: "global" | "tenant" | "local_only";
  remote: string | null;
  branch?: string;
  reason?: string;
  detail: string;
}

function syncNote(sync?: SyncVerdict): string {
  if (!sync) return "";
  if (sync.will_sync) {
    return `\nSync: ${sync.detail}`;
  }
  // Loud, actionable warning — this is the trap we never want users to hit.
  return `\n\nWARNING — NOT SYNCED: ${sync.detail}`;
}

const server = new McpServer(
  {
    name: "portable-llm-wiki",
    version: "0.1.3",
  },
  {
    instructions: `You are connected to a Portable LLM Wiki — a structured personal-context wiki for ${
      OWNER_TOKEN ? "the wiki owner" : "the public tier"
    } at ${API_BASE}.

When the user asks anything about themselves, their projects, decisions, or career: prefer wiki tools over guessing.

Typical flow:
1. Call \`list_pages\` once at the start of a session to learn what's there.
2. For specific questions, call \`query_wiki\` — it does graph-aware retrieval and returns a sourced answer.
3. For exploration, use \`search_wiki\` (keyword) or \`get_neighbors\` (graph walk).
4. \`read_page\` returns the full body of a single page when you need quotes.

Every page has a tier (\`public\`/\`recruiter\`/\`friend\`/\`private\`). Pages above your tier are invisible — don't synthesize claims about them.`,
  }
);

// ----------------- TOOLS -----------------

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
      const m = (await apiGet("/wiki/manifest.json")) as {
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
      }. Sections: ${Object.entries(m.sections).map(([k, v]) => `${k}=${v}`).join(", ")}.`;
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
      slug: z.string().min(1).describe("Page slug — the filename stem, e.g. 'calibrated-honesty'."),
    },
  },
  async ({ slug }) => {
    try {
      const p = (await apiGet(`/wiki/page/${encodeURIComponent(slug)}`)) as {
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
        ? `\n\n---\n**Links out:** ${p.links_out_resolved.map((l) => `[[${l.title}]] (slug: ${l.slug})`).join(", ")}`
        : "";
      const linksIn = p.links_in_resolved.length
        ? `\n**Links in:** ${p.links_in_resolved.map((l) => `[[${l.title}]] (slug: ${l.slug})`).join(", ")}`
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
      limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10)."),
    },
  },
  async ({ query, limit }) => {
    try {
      const r = (await apiGet(
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
      "The primary tool. Does graph-aware retrieval (keyword anchors + 1-hop wikilink expansion) and returns a synthesized answer grounded in wiki pages, with citations. Prefer this over `search_wiki` + manual stitching.",
    inputSchema: {
      question: z.string().min(2).describe("The user's question in natural language."),
    },
  },
  async ({ question }) => {
    try {
      const r = (await apiPost("/wiki/query", { question })) as {
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
            .join(", ")}. Expanded: ${r.retrieval.expanded.map((e) => e.title).join(", ") || "(none)"}._`
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
      hops: z.number().int().min(0).max(4).optional().describe("Number of hops to expand (default 1)."),
    },
  },
  async ({ slug, hops }) => {
    try {
      const r = (await apiGet(
        `/wiki/graph/${encodeURIComponent(slug)}?hops=${hops ?? 1}`
      )) as {
        nodes: Array<{ slug: string; title: string; section: string; tier: string; is_anchor: boolean; degree: number }>;
        edges: Array<{ source: string; target: string }>;
        anchors: string[];
      };
      const nodes = r.nodes
        .map(
          (n) =>
            `${n.is_anchor ? "★" : "·"} ${n.title} (slug: ${n.slug}, ${n.section}/${n.tier}, degree ${n.degree})`
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
      "Saves raw content under raw/<subdir>/YYYY-MM-DD-<slug>.md and (optionally) fires the Puppetmaster Cursor agent to perform the full ingest pass — entity/concept/decision pages, cross-references, index + log updates. Requires WIKI_OWNER_TOKEN.",
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
        .describe("If true, kick off the Puppetmaster ingest agent (costs LLM tokens). Default false."),
    },
  },
  async (args) => {
    try {
      if (!OWNER_TOKEN) {
        return asError(
          "No WIKI_OWNER_TOKEN configured for this MCP server. Ingest is owner-only."
        );
      }
      const r = (await apiPost("/owner/ingest", {
        slug: args.slug,
        content: args.content,
        subdir: args.subdir ?? "conversations",
        note: args.note ?? null,
        run_orchestrator: args.run_orchestrator ?? false,
      })) as {
        ok: boolean;
        rel_path: string;
        size: number;
        orchestrator: { tracking_id?: string; status?: string; error?: string } | null;
        sync?: SyncVerdict;
      };
      const orch = r.orchestrator?.tracking_id
        ? `\nPuppetmaster ingest job started: tracking_id=${r.orchestrator.tracking_id}.`
        : r.orchestrator?.error
        ? `\nOrchestrator skipped: ${r.orchestrator.error}`
        : "";
      return asText(`Saved ${r.rel_path} (${r.size} bytes).${orch}${syncNote(r.sync)}`);
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
      "Reports structural issues: orphan pages, stale pages, broken provenance, missing pages mentioned 3+ times, pages absent from index.md. Requires WIKI_OWNER_TOKEN.",
    inputSchema: {},
  },
  async () => {
    try {
      if (!OWNER_TOKEN) {
        return asError("Lint is owner-only. Set WIKI_OWNER_TOKEN.");
      }
      const r = (await apiPost("/owner/lint", {})) as {
        totals: { pages: number; by_section: Record<string, number>; by_tier: Record<string, number> };
        orphans: Array<{ title: string; section: string }>;
        stale: Array<{ title: string; age_days: number }>;
        missing_pages: Array<{ title: string; mentions: number }>;
        broken_provenance: Array<{ title: string; missing_source: string }>;
        missing_index_entries: Array<{ title?: string; reason?: string }>;
      };
      const lines: string[] = [];
      lines.push(`# Lint report — ${r.totals.pages} pages`);
      lines.push(
        `Sections: ${Object.entries(r.totals.by_section).map(([k, v]) => `${k}=${v}`).join(", ")}`
      );
      lines.push(
        `Tiers: ${Object.entries(r.totals.by_tier).map(([k, v]) => `${k}=${v}`).join(", ")}`
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
        lines.push(`\n## Missing pages (referenced ≥3 times, not present): ${r.missing_pages.length}`);
        lines.push(r.missing_pages.map((m) => `- ${m.title} (${m.mentions} mentions)`).join("\n"));
      }
      if (r.broken_provenance.length) {
        lines.push(`\n## Broken provenance: ${r.broken_provenance.length}`);
        lines.push(
          r.broken_provenance.map((b) => `- ${b.title} → missing ${b.missing_source}`).join("\n")
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
  // Sanity check: can we reach the backend at all?
  try {
    const health = (await apiGet("/healthz")) as { status: string; page_count: number };
    process.stderr.write(
      `[portable-llm-wiki-mcp] connected to ${API_BASE} — ${health.page_count} pages indexed${
        OWNER_TOKEN ? " (owner)" : " (public)"
      }\n`
    );
  } catch (err) {
    // Truncate noisy upstream errors (e.g. HTML 404 bodies from a Vercel
    // proxy when the URL is wrong) so the warning is one readable line.
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    process.stderr.write(
      `[portable-llm-wiki-mcp] WARNING: backend at ${API_BASE} is not reachable (${message}).\n` +
        `[portable-llm-wiki-mcp] Hint: verify with 'curl ${API_BASE}/healthz'. Tools will fail until the backend responds.\n`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[portable-llm-wiki-mcp] fatal: ${err}\n`);
  process.exit(1);
});
