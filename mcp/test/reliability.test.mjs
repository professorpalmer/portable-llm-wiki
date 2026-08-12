#!/usr/bin/env node
/**
 * Targeted MCP reliability tests — no live credentials required.
 *
 * Covers: WIKI_BASE_URL vs WIKI_API_BASE, auth_mode classification,
 * connection_status, owner preflight fail-closed (content never sent),
 * honest ingest/status reporting, and MCP handshake + tools/list.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distWiki = join(__dirname, "../dist/wikiClient.js");
const serverScript = join(__dirname, "../dist/server.js");

const {
  WikiClient,
  classifyAuthMode,
  buildConnectionStatus,
  formatIngestReport,
  ownerPreflightError,
  resolveApiBase,
  normalizeOrchestratorState,
  startupAuthLabel,
  OWNER_STDIO_HINT,
} = await import(pathToFileURL(distWiki).href);

function mockFetchRouter(routes) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${u.pathname}`;
    const handler = routes[key] ?? routes[`* ${u.pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({ detail: `no mock for ${key}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handler(u, init);
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("resolveApiBase prefers WIKI_BASE_URL over WIKI_API_BASE", () => {
  assert.equal(
    resolveApiBase({
      WIKI_BASE_URL: "https://preferred.example/",
      WIKI_API_BASE: "https://legacy.example",
    }),
    "https://preferred.example"
  );
  assert.equal(
    resolveApiBase({ WIKI_API_BASE: "https://legacy.example/" }),
    "https://legacy.example"
  );
  assert.equal(resolveApiBase({}), "http://localhost:8000");
  // Hosted tenant-scoped base must keep the path after trailing-slash trim.
  assert.equal(
    resolveApiBase({
      WIKI_BASE_URL: "https://portablellm.wiki/professorpalmer",
    }),
    "https://portablellm.wiki/professorpalmer"
  );
});

test("classifyAuthMode distinguishes public / share / owner / not-elevated", () => {
  assert.equal(
    classifyAuthMode(false, { viewer_tier: "public", viewer_is_owner: false }),
    "public"
  );
  assert.equal(
    classifyAuthMode(true, { viewer_tier: "recruiter", viewer_is_owner: false }),
    "share_read_only"
  );
  assert.equal(
    classifyAuthMode(true, { viewer_tier: "private", viewer_is_owner: true }),
    "owner"
  );
  assert.equal(
    classifyAuthMode(true, { viewer_tier: "public", viewer_is_owner: false }),
    "token_not_elevated"
  );
});

test("buildConnectionStatus never exposes token values", () => {
  const sampleToken = "super-secret-token-value-xyz";
  const status = buildConnectionStatus("http://wiki.test", true, {
    page_count: 3,
    sections: { entities: 3 },
    viewer_tier: "friend",
    viewer_is_owner: false,
  });
  assert.equal(status.auth_mode, "share_read_only");
  assert.equal(status.token_configured, true);
  assert.equal(status.capabilities.write, false);
  assert.equal(status.capabilities.lint, false);
  assert.equal(status.capabilities.read, true);
  const blob = JSON.stringify(status);
  // Diagnostic payload must never echo a bearer secret (only booleans / modes).
  assert.equal(blob.includes(sampleToken), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, "authorization"), false);
});

test("startupAuthLabel does not call share tokens owner", () => {
  const share = buildConnectionStatus("http://x", true, {
    page_count: 1,
    sections: {},
    viewer_tier: "recruiter",
    viewer_is_owner: false,
  });
  assert.equal(startupAuthLabel(share), "share/read-only tier=recruiter");

  const bad = buildConnectionStatus("http://x", true, {
    page_count: 1,
    sections: {},
    viewer_tier: "public",
    viewer_is_owner: false,
  });
  assert.equal(startupAuthLabel(bad), "token configured but not elevated");
});

test("connection_status via WikiClient (public / no token)", async () => {
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 2,
        sections: { entities: 2 },
        viewer_tier: "public",
        viewer_is_owner: false,
      }),
  });
  const client = new WikiClient("http://mock.wiki", "", fetchImpl);
  const status = await client.connectionStatus();
  assert.equal(status.auth_mode, "public");
  assert.equal(status.token_configured, false);
  assert.equal(status.page_count, 2);
  assert.equal(status.capabilities.write, false);
});

test("connectionStatus requests hosted tenant-scoped manifest URL", async () => {
  let requestedUrl = "";
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return jsonResponse({
      page_count: 1,
      sections: {},
      viewer_tier: "public",
      viewer_is_owner: false,
    });
  };
  const base = resolveApiBase({
    WIKI_BASE_URL: "https://portablellm.wiki/professorpalmer",
  });
  const client = new WikiClient(base, "", fetchImpl);
  const status = await client.connectionStatus();
  assert.equal(
    requestedUrl,
    "https://portablellm.wiki/professorpalmer/wiki/manifest.json"
  );
  assert.equal(status.auth_mode, "public");
  assert.equal(status.token_configured, false);
  assert.equal(status.base_url, "https://portablellm.wiki/professorpalmer");
});

test("connection_status owner-capable", async () => {
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 10,
        sections: {},
        viewer_tier: "private",
        viewer_is_owner: true,
      }),
  });
  const client = new WikiClient("http://mock.wiki", "owner-secret", fetchImpl);
  const status = await client.connectionStatus();
  assert.equal(status.auth_mode, "owner");
  assert.equal(status.capabilities.write, true);
  assert.equal(status.capabilities.lint, true);
  assert.equal(JSON.stringify(status).includes("owner-secret"), false);
});

test("ingest preflight rejects share/read-only before sending content", async () => {
  let ingestCalls = 0;
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 4,
        sections: {},
        viewer_tier: "recruiter",
        viewer_is_owner: false,
      }),
    "POST /owner/ingest": () => {
      ingestCalls += 1;
      return jsonResponse({ ok: true }, 201);
    },
  });
  const client = new WikiClient("http://mock.wiki", "share-token", fetchImpl);
  await assert.rejects(
    () =>
      client.ingestSource({
        slug: "should-not-send",
        content: "SENSITIVE SOURCE BODY",
        run_orchestrator: false,
      }),
    (err) => {
      assert.match(String(err.message), /share\/read-only|owner-capable|stdio/i);
      assert.match(String(err.message), /Browser OAuth/);
      return true;
    }
  );
  assert.equal(ingestCalls, 0, "must fail closed before POST /owner/ingest");
});

test("ingest preflight rejects missing token before sending content", async () => {
  let ingestCalls = 0;
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 1,
        sections: {},
        viewer_tier: "public",
        viewer_is_owner: false,
      }),
    "POST /owner/ingest": () => {
      ingestCalls += 1;
      return jsonResponse({ ok: true }, 201);
    },
  });
  const client = new WikiClient("http://mock.wiki", "", fetchImpl);
  await assert.rejects(() =>
    client.ingestSource({ slug: "nope", content: "body" })
  );
  assert.equal(ingestCalls, 0);
  const status = await client.connectionStatus();
  assert.match(ownerPreflightError(status), /WIKI_OWNER_TOKEN is not set/);
  assert.match(OWNER_STDIO_HINT, /stdio MCP process/);
});

test("ingest preflight rejects token_not_elevated before sending content", async () => {
  let ingestCalls = 0;
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 1,
        sections: {},
        viewer_tier: "public",
        viewer_is_owner: false,
      }),
    "POST /owner/ingest": () => {
      ingestCalls += 1;
      return jsonResponse({ ok: true }, 201);
    },
  });
  const client = new WikiClient("http://mock.wiki", "bogus-token", fetchImpl);
  await assert.rejects(() =>
    client.ingestSource({ slug: "nope", content: "body" })
  );
  assert.equal(ingestCalls, 0);
});

test("owner-capable ingest reports honest raw vs orchestrator vs sync", async () => {
  let sawBody = false;
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 5,
        sections: {},
        viewer_tier: "private",
        viewer_is_owner: true,
      }),
    "POST /owner/ingest": (_u, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.content, "hello source");
      sawBody = true;
      return jsonResponse(
        {
          ok: true,
          rel_path: "raw/conversations/2026-08-12-hello.md",
          size: 42,
          orchestrator: null,
          sync: {
            will_sync: false,
            mode: "local_only",
            remote: null,
            detail: "No git remote configured.",
          },
        },
        201
      );
    },
  });
  const client = new WikiClient("http://mock.wiki", "real-owner", fetchImpl);
  const { report } = await client.ingestSource({
    slug: "hello",
    content: "hello source",
    run_orchestrator: false,
  });
  assert.equal(sawBody, true);
  assert.match(report, /raw_file: saved/);
  assert.match(report, /wiki_graph_pages: not_updated_by_raw_save/);
  assert.match(report, /orchestrator: not_requested/);
  assert.match(report, /durable_sync: local_only/);
  assert.doesNotMatch(report, /graph pages (are|were) updated/i);
});

test("formatIngestReport distinguishes orchestrator running from raw save", () => {
  const report = formatIngestReport(
    {
      ok: true,
      rel_path: "raw/conversations/x.md",
      size: 10,
      orchestrator: { tracking_id: "abc123", status: "running" },
      sync: {
        will_sync: true,
        mode: "global",
        remote: "github.com/x/y",
        detail: "Auto-pushing.",
      },
    },
    true
  );
  assert.match(report, /orchestrator: running/);
  assert.match(report, /tracking_id: abc123/);
  assert.match(report, /not_updated_by_raw_save/);
  assert.match(report, /will_sync/);
});

test("normalizeOrchestratorState covers pending/failed/completed", () => {
  assert.equal(
    normalizeOrchestratorState({ tracking_id: "t1", status: "pending" }, true)
      .state,
    "pending"
  );
  assert.equal(
    normalizeOrchestratorState({ tracking_id: "t1", status: "done" }, true).state,
    "completed"
  );
  assert.equal(
    normalizeOrchestratorState({ error: "boom" }, true).state,
    "failed"
  );
  assert.equal(normalizeOrchestratorState(null, false).state, "not_requested");
});

test("ingest_job_status bounded polling stops on completed", async () => {
  let polls = 0;
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 1,
        sections: {},
        viewer_tier: "private",
        viewer_is_owner: true,
      }),
    "GET /owner/jobs/job1": () => {
      polls += 1;
      const status = polls < 2 ? "running" : "done";
      return jsonResponse({
        job: {
          tracking_id: "job1",
          status,
          raw_path: "raw/conversations/x.md",
          summary: status === "done" ? "ok" : null,
        },
        log_tail: "line\n",
      });
    },
  });
  const client = new WikiClient("http://mock.wiki", "owner", fetchImpl);
  const report = await client.ingestJobStatus({
    tracking_id: "job1",
    poll_attempts: 5,
    poll_interval_ms: 1,
  });
  assert.equal(polls, 2);
  assert.match(report, /orchestrator: completed/);
  assert.match(report, /polls_used: 2/);
});

test("MCP handshake + tools/list includes diagnostics (mock HTTP backend)", async () => {
  const backend = createServer((req, res) => {
    if (req.url === "/wiki/manifest.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          page_count: 1,
          sections: { entities: 1 },
          viewer_tier: "public",
          viewer_is_owner: false,
          pages: [],
        })
      );
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", page_count: 1 }));
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const { port } = backend.address();
  const base = `http://127.0.0.1:${port}`;

  const proc = spawn("node", [serverScript], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WIKI_BASE_URL: base,
      WIKI_OWNER_TOKEN: "",
    },
  });

  let buf = "";
  const pending = new Map();
  let id = 0;
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* ignore */
      }
    }
  });

  const stderrChunks = [];
  proc.stderr.on("data", (d) => stderrChunks.push(d.toString()));

  function send(method, params) {
    const msg = { jsonrpc: "2.0", id: ++id, method, params };
    proc.stdin.write(JSON.stringify(msg) + "\n");
    return id;
  }
  function wait(reqId) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting ${reqId}`)), 8000);
      pending.set(reqId, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  }

  try {
    const init = await wait(
      send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "reliability-test", version: "0.1.0" },
      })
    );
    assert.equal(init.result?.serverInfo?.name, "portable-llm-wiki");

    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );

    const list = await wait(send("tools/list", {}));
    const names = (list.result?.tools ?? []).map((t) => t.name);
    for (const required of [
      "connection_status",
      "ingest_job_status",
      "ingest_source",
      "list_pages",
      "query_wiki",
    ]) {
      assert.ok(names.includes(required), `missing tool ${required}`);
    }

    const conn = await wait(
      send("tools/call", { name: "connection_status", arguments: {} })
    );
    const text = conn.result?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    assert.equal(parsed.auth_mode, "public");
    assert.equal(parsed.token_configured, false);
    assert.equal(parsed.capabilities.write, false);

    // Startup stderr must not claim owner when no elevating token.
    const errText = stderrChunks.join("");
    assert.doesNotMatch(errText, /\(owner\)/);
    assert.match(errText, /public|token_configured=false/);
  } finally {
    proc.kill();
    await new Promise((r) => backend.close(r));
  }
});
