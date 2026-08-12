#!/usr/bin/env node
/**
 * Smoke test: spawn the MCP server over stdio against a local mock backend
 * (no live credentials). Validates handshake, tools/list (including
 * connection_status / ingest_job_status), public connection_status, and
 * ingest preflight fail-closed.
 *
 * Optional live mode: SMOKE_LIVE=1 with WIKI_BASE_URL pointing at a real wiki
 * also calls query_wiki once.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, "dist/server.js");
const LIVE = process.env.SMOKE_LIVE === "1";

// Prefer WIKI_BASE_URL; keep WIKI_API_BASE as legacy fallback for callers.
const LIVE_BASE =
  process.env.WIKI_BASE_URL ?? process.env.WIKI_API_BASE ?? "http://localhost:8000";

async function startMockBackend() {
  let ingestHits = 0;
  const backend = createServer((req, res) => {
    const url = req.url ?? "/";
    const json = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url === "/healthz") {
      return json(200, { status: "ok", page_count: 2 });
    }
    if (url === "/wiki/manifest.json") {
      return json(200, {
        page_count: 2,
        sections: { entities: 2 },
        viewer_tier: "public",
        viewer_is_owner: false,
        pages: [
          {
            slug: "demo",
            title: "Demo",
            section: "entities",
            tier: "public",
            tags: [],
            excerpt: "demo",
            updated: null,
          },
        ],
      });
    }
    if (url.startsWith("/wiki/query") && req.method === "POST") {
      return json(200, {
        answer: "Mock answer.",
        citations: [{ slug: "demo", title: "Demo" }],
        backend: "keyword",
      });
    }
    if (url.startsWith("/wiki/graph/")) {
      return json(200, {
        nodes: [
          {
            slug: "demo",
            title: "Demo",
            section: "entities",
            tier: "public",
            is_anchor: true,
            degree: 0,
          },
        ],
        edges: [],
        anchors: ["demo"],
      });
    }
    if (url === "/owner/ingest" && req.method === "POST") {
      ingestHits += 1;
      return json(201, { ok: true, rel_path: "raw/x.md", size: 1, orchestrator: null });
    }
    return json(404, { detail: `no mock for ${req.method} ${url}` });
  });

  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const { port } = backend.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => backend.close(r)),
    get ingestHits() {
      return ingestHits;
    },
  };
}

function attachRpc(proc) {
  let id = 0;
  let buf = "";
  const pending = new Map();
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
        /* ignore non-JSON */
      }
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  function send(method, params) {
    const msg = { jsonrpc: "2.0", id: ++id, method, params };
    proc.stdin.write(JSON.stringify(msg) + "\n");
    return id;
  }
  function wait(reqId, ms = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${reqId}`)), ms);
      pending.set(reqId, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  }
  return { send, wait };
}

async function main() {
  const mock = LIVE ? null : await startMockBackend();
  const apiBase = LIVE ? LIVE_BASE.replace(/\/$/, "") : mock.base;
  const token = LIVE ? process.env.WIKI_OWNER_TOKEN ?? "" : "";

  const proc = spawn("node", [serverScript], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WIKI_BASE_URL: apiBase,
      // Keep legacy alias in sync so either name works for child processes.
      WIKI_API_BASE: apiBase,
      WIKI_OWNER_TOKEN: token,
    },
  });

  const { send, wait } = attachRpc(proc);

  try {
    const init = await wait(
      send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.1.4" },
      })
    );
    console.log("[init] server:", init.result?.serverInfo);

    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );

    const list = await wait(send("tools/list", {}));
    const tools = list.result?.tools ?? [];
    console.log(`[tools/list] ${tools.length} tools:`);
    for (const t of tools) {
      console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}…`);
    }
    const names = new Set(tools.map((t) => t.name));
    for (const required of ["connection_status", "ingest_job_status", "ingest_source"]) {
      if (!names.has(required)) {
        throw new Error(`missing required tool: ${required}`);
      }
    }

    const conn = await wait(
      send("tools/call", { name: "connection_status", arguments: {} })
    );
    const connText = conn.result?.content?.[0]?.text ?? "";
    console.log("\n[tools/call connection_status]");
    console.log(connText.slice(0, 800));
    const connJson = JSON.parse(connText);
    if (!LIVE) {
      if (connJson.auth_mode !== "public") {
        throw new Error(`expected public auth_mode, got ${connJson.auth_mode}`);
      }
      if (connJson.capabilities?.write) {
        throw new Error("public mode must not report write capability");
      }
    }

    if (!LIVE) {
      const ingest = await wait(
        send("tools/call", {
          name: "ingest_source",
          arguments: {
            slug: "should-fail",
            content: "must not reach backend",
            run_orchestrator: false,
          },
        })
      );
      const ingestText = ingest.result?.content?.[0]?.text ?? JSON.stringify(ingest);
      console.log("\n[tools/call ingest_source preflight]");
      console.log(ingestText.slice(0, 600));
      if (!ingest.result?.isError && !String(ingestText).includes("Error:")) {
        throw new Error("expected ingest preflight error without owner token");
      }
      if (mock.ingestHits !== 0) {
        throw new Error("ingest content was sent despite failed preflight");
      }
      console.log("[ok] preflight fail-closed; backend ingest hits=", mock.ingestHits);
    }

    if (LIVE) {
      const callResp = await wait(
        send("tools/call", {
          name: "query_wiki",
          arguments: {
            question: "Who is Avery Chen and what is their role? Be brief.",
          },
        })
      );
      const text = callResp.result?.content?.[0]?.text ?? JSON.stringify(callResp);
      console.log("\n[tools/call query_wiki]");
      console.log(text.slice(0, 800));
    }

    console.log("\n[smoke] passed");
    proc.kill();
    if (mock) await mock.close();
    process.exit(0);
  } catch (err) {
    console.error("smoke-test failed:", err);
    proc.kill();
    if (mock) await mock.close();
    process.exit(1);
  }
}

main();
