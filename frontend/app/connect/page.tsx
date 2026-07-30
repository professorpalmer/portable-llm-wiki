"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchPublicConfig, isHostedMode } from "@/lib/api";
import { useTenant } from "@/lib/useTenant";

type Tab = "claude" | "cursor" | "chatgpt" | "iphone" | "http" | "cli";

const TABS: { id: Tab; label: string; subtitle: string }[] = [
  { id: "claude", label: "Claude Desktop", subtitle: "MCP" },
  { id: "cursor", label: "Cursor", subtitle: "MCP" },
  { id: "chatgpt", label: "ChatGPT / GPT-5", subtitle: "URL fetch" },
  { id: "iphone", label: "iPhone", subtitle: "Shortcuts" },
  { id: "http", label: "Any LLM", subtitle: "HTTP / .well-known" },
  { id: "cli", label: "Terminal", subtitle: "curl / shell" },
];

export default function ConnectPage() {
  const tenant = useTenant();
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [tab, setTab] = useState<Tab>("claude");

  useEffect(() => {
    fetchPublicConfig()
      .then((c) => setBaseUrl(c.public_base_url || window.location.origin))
      .catch(() =>
        setBaseUrl(
          typeof window !== "undefined" ? window.location.origin : "",
        ),
      );
  }, []);

  // In hosted (multi-tenant) mode every user-facing URL on this docs page
  // needs a `/<tenant>` segment between the origin and the path so the
  // examples actually point at the viewer's wiki. Anonymous visitors (no
  // tenant in the URL) get the demo tenant `avery` so the snippets stay
  // copy-paste-able. Single-tenant mode keeps the bare origin.
  const baseOrigin = baseUrl || "https://your-wiki.example.com";
  const effectiveTenant = tenant ?? (isHostedMode() ? "avery" : undefined);
  const url = effectiveTenant ? `${baseOrigin}/${effectiveTenant}` : baseOrigin;

  return (
    <div className="max-w-4xl mx-auto px-5 py-10">
      <div className="text-xs uppercase tracking-wider text-ink-muted font-medium">
        Setup guide
      </div>
      <h1 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight text-ink">
        Connect any LLM to this wiki
      </h1>
      <p className="mt-3 text-ink-muted leading-relaxed max-w-2xl">
        The Portable LLM Wiki is vendor-neutral. The same backend can be
        reached over MCP (typed tool calls for Claude Desktop, Cursor) or plain
        HTTP (everything else). Pick your client below.
      </p>

      <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-paper-soft text-xs text-ink-muted">
        <span>this wiki:</span>
        <code className="font-mono text-ink">{url}</code>
      </div>

      {/* tabs */}
      <div className="mt-7 flex flex-wrap gap-2 border-b border-paper-soft pb-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 pb-2 -mb-px border-b-2 text-sm font-medium transition ${
              tab === t.id
                ? "border-accent text-ink"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
            <span className="ml-1 text-[10px] uppercase tracking-wider text-ink-muted">
              · {t.subtitle}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-7">
        {tab === "claude" && <ClaudeDesktopPanel url={url} />}
        {tab === "cursor" && <CursorPanel url={url} />}
        {tab === "chatgpt" && <ChatGPTPanel url={url} />}
        {tab === "iphone" && <IPhonePanel url={url} tenant={tenant} />}
        {tab === "http" && <HTTPPanel url={url} />}
        {tab === "cli" && <CLIPanel url={url} />}
      </div>

      {/* What you can do once connected */}
      <section className="mt-14 border-t border-paper-soft pt-8">
        <h2 className="text-xl font-semibold tracking-tight text-ink">
          What you can do once connected
        </h2>
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <FeatureRow
            title="Query"
            body="Natural-language Q&A grounded in the wiki. Every answer cites the markdown that produced it."
            example={`> What does Avery believe about boring tools?`}
          />
          <FeatureRow
            title="Browse"
            body="Read any page directly. Pages link to each other via wikilinks."
            example={`> Read [[Boring Stack First]]`}
          />
          <FeatureRow
            title="Search"
            body="Keyword search across titles + bodies + tags. Returns matches with snippets."
            example={`> Search for 'inventory'`}
          />
          <FeatureRow
            title="Graph"
            body="Neighbors of any page via wikilink traversal. 1-hop or 2-hop. Useful for context expansion."
            example={`> Show neighbors of Mia Patel`}
          />
        </div>
      </section>

      <section className="mt-12 border-t border-paper-soft pt-8 pb-6 text-sm text-ink-muted leading-relaxed">
        Built on the{" "}
        <a
          href="https://modelcontextprotocol.io/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Model Context Protocol
        </a>{" "}
        for the MCP path, and plain JSON-over-HTTP for everything else. Both
        speak to the same FastAPI backend at <code>/api/backend/*</code>.
        <div className="mt-3">
          <Link href={tenant ? `/${tenant}` : "/"} className="text-accent underline">
            ← back to the wiki
          </Link>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-client panels
// ---------------------------------------------------------------------------

function MCPInstallSteps({ clientName, url }: { clientName: string; url: string }) {
  // Hosted users never hold the platform OWNER_TOKEN. The credential they
  // paste is the Personal LLM URL token from Owner → Personal LLM URL
  // (…/llm?t=<token>). That private-tier token is the headless owner key.
  const config = `{
  "mcpServers": {
    "portable-llm-wiki": {
      "command": "npx",
      "args": ["-y", "portable-llm-wiki-mcp"],
      "env": {
        "WIKI_BASE_URL": "${url}",
        "WIKI_OWNER_TOKEN": "<paste token from Owner → Personal LLM URL>"
      }
    }
  }
}`;

  return (
    <>
      <Step
        n={1}
        title={`Open the ${clientName} MCP config file`}
        body={
          clientName === "Claude Desktop" ? (
            <>
              On macOS:{" "}
              <code className="font-mono text-[12px]">
                ~/Library/Application Support/Claude/claude_desktop_config.json
              </code>
              <br />
              On Windows:{" "}
              <code className="font-mono text-[12px]">
                %APPDATA%\Claude\claude_desktop_config.json
              </code>
            </>
          ) : (
            <>
              <code className="font-mono text-[12px]">Cmd+,</code> → search
              &ldquo;MCP&rdquo; → click &ldquo;Edit in{" "}
              <code>mcp.json</code>&rdquo;.
            </>
          )
        }
      />
      <Step
        n={2}
        title="Add the wiki to your mcpServers block"
        body={
          <>
            <CodeBlock code={config} />
            <div className="mt-2 text-xs">
              <code>npx</code> downloads the MCP server from npm on first run
              and caches it. No <code>npm install</code> needed. For{" "}
              <strong>private reads + ingest</strong>, mint a Personal LLM URL
              under Owner console and paste only the <code>?t=</code> token
              into <code>WIKI_OWNER_TOKEN</code> (not a recruiter/friend share
              link). Self-hosters can paste the backend{" "}
              <code>OWNER_TOKEN</code> env var instead.
            </div>
          </>
        }
      />
      <Step
        n={3}
        title={`Restart ${clientName}`}
        body={
          clientName === "Claude Desktop"
            ? "Quit and reopen Claude. You should see a small hammer icon in the input bar. Click it to confirm the wiki is connected."
            : "MCP servers are picked up at startup. New chat → ask the agent anything about the wiki."
        }
      />
      <Step
        n={4}
        title="Ask anything"
        body={
          <>
            Try:{" "}
            <em>
              &ldquo;Using the portable-llm-wiki tool, who is Avery Chen?&rdquo;
            </em>
            <br />
            The model will call <code>query_wiki</code> automatically. Other
            tools available:{" "}
            <code>read_page</code>, <code>search_wiki</code>,{" "}
            <code>list_pages</code>, <code>get_neighbors</code>.
          </>
        }
      />
      <BlueBlock>
        The MCP server is a small Node.js process, published on npm as{" "}
        <a
          href="https://www.npmjs.com/package/portable-llm-wiki-mcp"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          portable-llm-wiki-mcp
        </a>
        . It speaks the Model Context Protocol to your client and HTTP to this
        wiki. Source:{" "}
        <a
          href="https://github.com/professorpalmer/portable-llm-wiki/tree/main/mcp"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          mcp/
        </a>
        .
      </BlueBlock>
    </>
  );
}

function ClaudeDesktopPanel({ url }: { url: string }) {
  return (
    <div className="space-y-5">
      <MCPInstallSteps clientName="Claude Desktop" url={url} />
    </div>
  );
}

function CursorPanel({ url }: { url: string }) {
  return (
    <div className="space-y-5">
      <MCPInstallSteps clientName="Cursor" url={url} />
    </div>
  );
}

function ChatGPTPanel({ url }: { url: string }) {
  const wellKnown = `${url}/api/backend/.well-known/llm-wiki.json`;
  const prompt = `I have a personal LLM Wiki at ${url}. The full spec is at ${wellKnown}. Read that file first to discover the available endpoints, then answer my questions using only the wiki's content. Cite pages by title.`;
  return (
    <div className="space-y-5">
      <Step
        n={1}
        title="Open ChatGPT (or any chat with web access)"
        body="GPT-5, Claude.ai, Gemini, Perplexity, anything that can fetch URLs."
      />
      <Step
        n={2}
        title="Paste this one-shot prompt"
        body={<CodeBlock code={prompt} />}
      />
      <Step
        n={3}
        title="Ask your questions"
        body={
          <>
            The model will fetch the manifest, see what pages exist, and pull
            individual ones as needed.{" "}
            <em>&ldquo;What does Avery think about hiring?&rdquo;</em>{" "}
            should work without any further setup.
          </>
        }
      />
      <BlueBlock>
        No MCP support? No problem. The <code>.well-known/llm-wiki.json</code>{" "}
        endpoint is self-describing. It lists every available URL and the
        shape of every response, so any LLM that can read a JSON spec can
        figure out how to use this wiki.
      </BlueBlock>
    </div>
  );
}

function IPhonePanel({ url, tenant }: { url: string; tenant: string | undefined }) {
  const appPrefix = tenant ? `/${tenant}` : "";
  const curlExample = `curl -X POST '${url}/owner/capture/paste' \\\n  -H 'Authorization: Bearer YOUR_OWNER_TOKEN' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"content":"hello from my iPhone","label":"shortcut","subdir":"conversations"}'`;

  return (
    <div className="space-y-5">
      <div className="text-sm text-ink-muted leading-relaxed">
        Capture from anywhere on your iPhone. The Shortcut takes whatever
        you share (a paragraph from Safari, a Slack message, a Notes
        excerpt) and POSTs it to your wiki&apos;s capture endpoint. The{" "}
        <a
          href="https://github.com/professorpalmer/Puppetmaster"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-ink"
          title="Cursor SDK agent CLI — opens GitHub"
        >
          Puppetmaster
        </a>{" "}
        agent (or, on the hosted site, a direct LLM call) then drafts wiki
        pages from the source in the background.
      </div>

      <Step
        n={1}
        title="Mint a friend-tier share token"
        body={
          <>
            In the{" "}
            <a
              href={`${appPrefix}/owner`}
              className="underline"
            >
              owner console
            </a>
            , scroll to <strong>Share Tokens</strong>. Mint a token with
            tier <code>friend</code> labeled &ldquo;iPhone capture&rdquo;.
            Copy the plaintext token (it&apos;s shown once).
            <div className="mt-2 text-xs text-ink-muted">
              Don&apos;t use your owner token. The Shortcut config is
              stored on your phone, so if your phone is lost, you can revoke
              the share token without rotating your owner credential.
            </div>
          </>
        }
      />

      <Step
        n={2}
        title="Open Shortcuts.app on your iPhone, tap +"
        body={
          <>
            New blank shortcut. Add these actions in order (search for each
            by name):
            <ol className="mt-2 list-decimal pl-5 space-y-1 text-sm">
              <li>
                <strong>Get Contents of URL</strong>
                <div className="ml-2 mt-1 text-xs text-ink-muted leading-relaxed">
                  URL:{" "}
                  <code className="font-mono break-all">{url}/owner/capture/paste</code>
                  <br />
                  Method: <code>POST</code>
                  <br />
                  Headers:
                  <br />
                  &nbsp;&nbsp;<code>Authorization</code>:{" "}
                  <code>Bearer YOUR_SHARE_TOKEN_HERE</code>
                  <br />
                  &nbsp;&nbsp;<code>Content-Type</code>:{" "}
                  <code>application/json</code>
                  <br />
                  Request Body: <code>JSON</code>
                  <br />
                  &nbsp;&nbsp;<code>content</code>:{" "}
                  <strong>Shortcut Input</strong>
                  <br />
                  &nbsp;&nbsp;<code>label</code>: <code>iPhone</code>
                  <br />
                  &nbsp;&nbsp;<code>subdir</code>:{" "}
                  <code>conversations</code>
                </div>
              </li>
              <li>
                <strong>Show Notification</strong>, title{" "}
                <code>Saved to wiki</code>, body{" "}
                <strong>Contents of URL</strong> (the previous step&apos;s
                output) so you see the rel_path of the new raw file
              </li>
            </ol>
          </>
        }
      />

      <Step
        n={3}
        title="Set the shortcut to accept share-sheet input"
        body={
          <>
            Tap the share-sheet icon (top right of the shortcut editor).
            Under <strong>Shortcut Input</strong>, enable{" "}
            <strong>Text</strong>, <strong>Articles</strong>, and{" "}
            <strong>Safari web pages</strong>. Name the shortcut{" "}
            <code>Save to Wiki</code>.
          </>
        }
      />

      <Step
        n={4}
        title="Use it from anywhere"
        body={
          <>
            Highlight text in any app → Share → <strong>Save to Wiki</strong>
            . Banner notifies on success.
            <div className="mt-2 text-xs text-ink-muted">
              You can also pin the shortcut to your home screen, trigger it
              with Siri (&ldquo;Hey Siri, save to wiki&rdquo;), or wire it
              into a Personal Automation that runs on a schedule.
            </div>
          </>
        }
      />

      <Step
        n={5}
        title="Verify the wire (optional)"
        body={
          <>
            Before futzing with the Shortcuts UI, test the endpoint from
            the iPhone Terminal app (a-Shell, Blink, etc.) or from any
            other machine:
            <CodeBlock code={curlExample} />
            A 201 response with{" "}
            <code>&#123;&ldquo;ok&rdquo;: true, &ldquo;rel_path&rdquo;: ...&#125;</code>{" "}
            means the wire works.
          </>
        }
      />

      <BlueBlock>
        The same endpoint is what the in-browser{" "}
        <a href={`${appPrefix}/capture`} className="underline">
          /capture
        </a>{" "}
        page uses. iOS Shortcut + share token is just a thinner way to hit
        it from your phone when you don&apos;t want to open the wiki at
        all.
      </BlueBlock>
    </div>
  );
}

function HTTPPanel({ url }: { url: string }) {
  const endpoints = [
    {
      method: "GET",
      path: "/.well-known/llm-wiki.json",
      desc: "self-describing spec, start here",
    },
    {
      method: "GET",
      path: "/wiki/manifest.json",
      desc: "list every page (filtered by viewer tier)",
    },
    {
      method: "GET",
      path: "/wiki/page/{slug}",
      desc: "full markdown content of one page",
    },
    {
      method: "GET",
      path: "/wiki/search?q={query}",
      desc: "keyword search across titles + bodies",
    },
    {
      method: "POST",
      path: "/wiki/query",
      desc: "natural-language Q&A → sourced answer",
    },
    {
      method: "GET",
      path: "/wiki/graph/neighbors/{slug}",
      desc: "wikilink-connected pages, 1-hop or 2-hop",
    },
  ];
  return (
    <div className="space-y-5">
      <Step
        n={1}
        title="Fetch the spec"
        body={
          <CodeBlock
            code={`curl ${url}/api/backend/.well-known/llm-wiki.json`}
          />
        }
      />
      <Step
        n={2}
        title="Endpoints you can call"
        body={
          <div className="rounded border border-paper-soft bg-paper overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.path} className="border-b border-paper-soft last:border-0">
                    <td className="p-2 pr-3 font-mono text-ink-muted w-12 align-top">
                      {e.method}
                    </td>
                    <td className="p-2 pr-3 font-mono text-ink align-top">
                      {e.path}
                    </td>
                    <td className="p-2 text-ink-muted align-top">{e.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        }
      />
      <Step
        n={3}
        title="With an LLM client, prompt like:"
        body={
          <CodeBlock
            code={`I'm an LLM with a personal wiki at ${url}.
The spec is at /api/backend/.well-known/llm-wiki.json.
Read the spec, then use the wiki to answer my questions.
Every answer must cite the pages it came from.`}
          />
        }
      />
    </div>
  );
}

function CLIPanel({ url }: { url: string }) {
  return (
    <div className="space-y-5">
      <Step
        n={1}
        title="List all pages"
        body={
          <CodeBlock
            code={`curl -s ${url}/api/backend/wiki/manifest.json | jq '.pages[] | {slug, title, type}'`}
          />
        }
      />
      <Step
        n={2}
        title="Read one page"
        body={
          <CodeBlock
            code={`curl -s ${url}/api/backend/wiki/page/avery-chen | jq -r .body`}
          />
        }
      />
      <Step
        n={3}
        title="Ask a question"
        body={
          <CodeBlock
            code={`curl -s -X POST ${url}/api/backend/wiki/query \\
  -H "Content-Type: application/json" \\
  -d '{"question": "What does Avery believe?"}' \\
  | jq '{answer, citations: [.citations[] | {title, slug}]}'`}
          />
        }
      />
      <BlueBlock>
        With a share token (recruiter / friend tier), add the header{" "}
        <code>-H &quot;Authorization: Bearer YOUR_TOKEN&quot;</code>.
      </BlueBlock>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="shrink-0 w-7 h-7 rounded-full bg-ink text-paper text-xs font-semibold flex items-center justify-center">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="mt-1 text-sm text-ink-muted leading-relaxed">{body}</div>
      </div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative mt-1 group">
      <button
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute top-1.5 right-1.5 text-[10px] text-ink-muted hover:text-ink underline opacity-60 group-hover:opacity-100"
      >
        {copied ? "copied ✓" : "copy"}
      </button>
      <pre className="text-[12px] font-mono bg-paper-soft/60 border border-paper-soft p-3 rounded overflow-x-auto leading-snug">
        {code}
      </pre>
    </div>
  );
}

function BlueBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-3 rounded bg-blue-50 border border-blue-200 text-xs text-blue-900 leading-relaxed">
      {children}
    </div>
  );
}

function FeatureRow({
  title,
  body,
  example,
}: {
  title: string;
  body: string;
  example: string;
}) {
  return (
    <div className="border border-paper-soft rounded p-3 bg-white">
      <div className="text-sm font-semibold text-ink">{title}</div>
      <div className="mt-1 text-xs text-ink-muted leading-relaxed">{body}</div>
      <code className="block mt-2 text-[11px] font-mono text-ink-muted bg-paper-soft/60 px-2 py-1 rounded">
        {example}
      </code>
    </div>
  );
}
