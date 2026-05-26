#!/usr/bin/env node
// Smoke test: spawn the MCP server over stdio, do a real MCP handshake +
// list_tools + call query_wiki, print the result. Validates that the MCP
// surface is wired to the wiki end-to-end.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, "dist/server.js");

const OWNER_TOKEN = process.env.WIKI_OWNER_TOKEN ?? "";
const API_BASE = process.env.WIKI_API_BASE ?? "http://localhost:8000";

const proc = spawn("node", [serverScript], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, WIKI_OWNER_TOKEN: OWNER_TOKEN, WIKI_API_BASE: API_BASE },
});

let id = 0;
function send(method, params) {
  const msg = { jsonrpc: "2.0", id: ++id, method, params };
  proc.stdin.write(JSON.stringify(msg) + "\n");
  return id;
}

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

function wait(reqId) {
  return new Promise((resolve) => pending.set(reqId, resolve));
}

async function main() {
  const initId = send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.1.0" },
  });
  const init = await wait(initId);
  console.log("[init] server:", init.result?.serverInfo);

  // Per spec, send initialized notification (no id, no response)
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );

  const listId = send("tools/list", {});
  const list = await wait(listId);
  console.log(`[tools/list] ${list.result?.tools?.length ?? 0} tools:`);
  for (const t of list.result?.tools ?? []) {
    console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}…`);
  }

  const callId = send("tools/call", {
    name: "query_wiki",
    arguments: { question: "Who is Avery Chen and what is their role? Be brief." },
  });
  const callResp = await wait(callId);
  const text = callResp.result?.content?.[0]?.text ?? JSON.stringify(callResp);
  console.log("\n[tools/call query_wiki]");
  console.log(text.slice(0, 800));

  const neighborsId = send("tools/call", {
    name: "get_neighbors",
    arguments: { slug: "calibrated-honesty", hops: 1 },
  });
  const nResp = await wait(neighborsId);
  console.log("\n[tools/call get_neighbors]");
  console.log(nResp.result?.content?.[0]?.text?.slice(0, 600) ?? JSON.stringify(nResp));

  proc.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke-test failed:", err);
  proc.kill();
  process.exit(1);
});
