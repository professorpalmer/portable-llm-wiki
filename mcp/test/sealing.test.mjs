#!/usr/bin/env node
/**
 * Sealed-tier crypto + WikiClient behaviour. HTTP is mocked.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distWiki = join(__dirname, "../dist/wikiClient.js");
const distSeal = join(__dirname, "../dist/sealing.js");

const { WikiClient } = await import(pathToFileURL(distWiki).href);
const {
  WrongPassphraseError,
  decryptEnvelope,
  encryptEnvelope,
  generateKeyring,
  isSealedMarkdown,
  localSearch,
  opaqueSlug,
  parseKeyring,
  parsePageDocument,
  sealPage,
  unsealPage,
  unwrapDek,
} = await import(pathToFileURL(distSeal).href);

function envelopeOf(markdown) {
  return parsePageDocument(markdown).body.replace(/\s+/g, "");
}

const PASSPHRASE = "correct-horse-battery";
const WRONG = "incorrect-horse";
const keyring = generateKeyring(PASSPHRASE, ["private"]);
const dek = unwrapDek(keyring, PASSPHRASE);

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

function sealingManifest(extra = {}) {
  return {
    page_count: 5,
    sections: { concepts: 2 },
    viewer_tier: "private",
    viewer_is_owner: true,
    pages: extra.pages ?? [],
    sealing: {
      enabled: true,
      tiers: extra.tiers ?? ["private"],
      keyring_url: "/wiki/sealing",
      bundle_url: "/wiki/sealed/bundle",
    },
  };
}

function ownerUnlockedClient(routes, passphrase = PASSPHRASE) {
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () => jsonResponse(sealingManifest()),
    "GET /wiki/sealing": () => jsonResponse(keyring),
    ...routes,
  });
  return new WikiClient("http://mock.wiki", "owner", fetchImpl, {
    WIKI_SEAL_PASSPHRASE: passphrase,
  });
}

const localOnlySync = {
  will_sync: false,
  mode: "local_only",
  remote: null,
  detail: "No git remote configured.",
};

test("crypto envelope round trip", () => {
  const json = JSON.stringify({
    v: 1,
    title: "T",
    tags: ["a"],
    sources: [],
    body: "hello [[Wiki]]",
  });
  const env = encryptEnvelope(dek, "my-slug", json);
  assert.equal(decryptEnvelope(dek, "my-slug", env), json);
});

test("wrong passphrase throws WrongPassphraseError", () => {
  assert.throws(() => unwrapDek(keyring, WRONG), (err) => {
    assert.ok(err instanceof WrongPassphraseError);
    return true;
  });
});

test("AAD binding: decrypt under another slug fails", () => {
  const json = '{"v":1,"title":"T","tags":[],"sources":[],"body":"x"}';
  const env = encryptEnvelope(dek, "slug-a", json);
  assert.throws(() => decryptEnvelope(dek, "slug-b", env));
});

test("opaque slug is deterministic and decisions get a date prefix", () => {
  const a = opaqueSlug(dek, "My Decision", "decisions", "2026-09-12");
  const b = opaqueSlug(dek, "My Decision", "decisions", "2026-09-12");
  assert.equal(a, b);
  assert.match(a, /^2026-09-12-s-[0-9a-f]{16}$/);
  const c = opaqueSlug(dek, "My Concept", "concepts");
  const d = opaqueSlug(dek, "  My Concept ", "concepts");
  assert.equal(c, d);
  assert.match(c, /^s-[0-9a-f]{16}$/);
});

test("sealPage / unsealPage round trip", () => {
  const md = sealPage(dek, {
    slug: "s-abc",
    type: "concept",
    tier: "private",
    created: "2026-09-12",
    updated: "2026-09-12",
    title: "Hidden Title",
    tags: ["secret"],
    sources: ["session-1"],
    body: "Body with [[Link]]",
  });
  assert.equal(isSealedMarkdown(md), true);
  assert.match(md, /sealed: v1/);
  assert.doesNotMatch(md, /Hidden Title/);
  const open = unsealPage(dek, "s-abc", md);
  assert.equal(open.title, "Hidden Title");
  assert.deepEqual(open.tags, ["secret"]);
  assert.deepEqual(open.sources, ["session-1"]);
  assert.equal(open.body, "Body with [[Link]]");
  assert.equal(open.tier, "private");
  assert.equal(open.type, "concept");
});

test("generateKeyring then unwrapDek", () => {
  const kr = parseKeyring(keyring);
  assert.equal(kr.v, 1);
  assert.deepEqual(kr.tiers, ["private"]);
  assert.equal(kr.kdf, "pbkdf2-sha256");
  assert.equal(kr.iterations, 600000);
  assert.equal(unwrapDek(kr, PASSPHRASE).length, 32);
  assert.throws(() => parseKeyring({}), /keyring/);
  assert.throws(() => generateKeyring(PASSPHRASE, ["public"]), /public/);
});

test("localSearch scores title substring and word overlap", () => {
  const hits = localSearch(
    [
      { slug: "a", title: "Secret Plan", body: "details about launch window" },
      { slug: "b", title: "Public Note", body: "nothing relevant" },
    ],
    "secret launch",
    10
  );
  assert.equal(hits[0].slug, "a");
  assert.ok(hits[0].score > 0);
  assert.match(hits[0].snippet, /launch|details/i);
});

test("sealingState not_enabled when manifest has no sealing key", async () => {
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () =>
      jsonResponse({
        page_count: 1,
        sections: {},
        viewer_tier: "public",
        viewer_is_owner: false,
      }),
  });
  const client = new WikiClient("http://mock.wiki", "", fetchImpl, {});
  const state = await client.sealingState();
  assert.equal(state.kind, "not_enabled");
  const status = await client.connectionStatus();
  assert.equal(status.sealing.enabled, false);
  assert.equal(status.sealing.unlocked, false);
});

test("sealingState locked when WIKI_SEAL_PASSPHRASE is not set", async () => {
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () => jsonResponse(sealingManifest()),
    "GET /wiki/sealing": () => jsonResponse(keyring),
  });
  const client = new WikiClient("http://mock.wiki", "owner", fetchImpl, {});
  const state = await client.sealingState();
  assert.equal(state.kind, "locked");
  assert.equal(state.reason, "WIKI_SEAL_PASSPHRASE not set");
  const status = await client.connectionStatus();
  assert.equal(status.sealing.enabled, true);
  assert.equal(status.sealing.unlocked, false);
  assert.match(status.notes.join(" "), /WIKI_SEAL_PASSPHRASE/);
});

test("sealingState locked on wrong passphrase", async () => {
  const client = ownerUnlockedClient({}, WRONG);
  const state = await client.sealingState();
  assert.equal(state.kind, "locked");
  assert.equal(state.reason, "wrong passphrase");
});

test("sealingState unlocked with correct passphrase", async () => {
  const client = ownerUnlockedClient();
  const state = await client.sealingState();
  assert.equal(state.kind, "unlocked");
  assert.deepEqual(state.tiers, ["private"]);
  assert.equal(state.dek.length, 32);
  const status = await client.connectionStatus();
  assert.equal(status.sealing.unlocked, true);
});

test("writePages routes to verbatim with sealed content when unlocked", async () => {
  const title = "Secret Title";
  const bodyText = "hidden body text that must not be posted";
  let structuredCalls = 0;
  let captured;
  const expectedSlug = opaqueSlug(dek, title, "concepts");
  const client = ownerUnlockedClient({
    "POST /owner/capture/structured": () => {
      structuredCalls += 1;
      return jsonResponse({ ok: true }, 201);
    },
    "POST /owner/capture/verbatim": (_u, init) => {
      captured = JSON.parse(init.body);
      return jsonResponse(
        {
          ok: true,
          written: {
            rel_path: `wiki/concepts/${expectedSlug}.md`,
            title: "Sealed page",
            section: "concepts",
            slug: expectedSlug,
            tier: "private",
            page_type: "concept",
          },
          conflict: null,
          sync: localOnlySync,
        },
        201
      );
    },
  });
  const { result } = await client.writePages({
    session_label: "chatgpt-2026-09-12",
    pages: [
      {
        slug: "secret-title",
        title,
        section: "concepts",
        body: bodyText,
      },
    ],
    force_overwrite: true,
  });
  assert.equal(structuredCalls, 0);
  assert.ok(captured);
  assert.equal(captured.slug, expectedSlug);
  assert.equal(captured.force_overwrite, true);
  assert.match(captured.content, /sealed: v1/);
  assert.equal(captured.content.includes(title), false);
  assert.equal(captured.content.includes(bodyText), false);
  assert.deepEqual(result.written.map((p) => p.rel_path), [
    `wiki/concepts/${expectedSlug}.md`,
  ]);
  assert.equal(result.written[0].title, title);
});

test("writePages refuses when locked without sending", async () => {
  let sent = 0;
  const fetchImpl = mockFetchRouter({
    "GET /wiki/manifest.json": () => jsonResponse(sealingManifest()),
    "GET /wiki/sealing": () => jsonResponse(keyring),
    "POST /owner/capture/structured": () => {
      sent += 1;
      return jsonResponse({ ok: true }, 201);
    },
    "POST /owner/capture/verbatim": () => {
      sent += 1;
      return jsonResponse({ ok: true }, 201);
    },
  });
  const client = new WikiClient("http://mock.wiki", "owner", fetchImpl, {});
  await assert.rejects(
    () =>
      client.writePages({
        session_label: "chatgpt-2026-09-12",
        pages: [
          {
            slug: "x",
            title: "X",
            section: "concepts",
            body: "SENSITIVE",
          },
        ],
      }),
    (err) => {
      assert.match(String(err.message), /locked|WIKI_SEAL_PASSPHRASE/i);
      return true;
    }
  );
  assert.equal(sent, 0);
});

test("appendToPage on a sealed page re-seals", async () => {
  const slug = "log";
  const sealedMd = sealPage(dek, {
    slug,
    type: "overview",
    tier: "private",
    created: "2026-09-01",
    updated: "2026-09-01",
    title: "Log",
    tags: [],
    sources: [],
    body: "# Log\n",
  });
  let putBody;
  const client = ownerUnlockedClient({
    "GET /owner/page/log/raw": () =>
      jsonResponse({
        slug,
        rel_path: "wiki/log.md",
        title: "Sealed page",
        section: "root",
        tier: "private",
        markdown: sealedMd,
      }),
    "PUT /owner/page/log": (_u, init) => {
      putBody = JSON.parse(init.body);
      return jsonResponse({
        ok: true,
        slug,
        rel_path: "wiki/log.md",
        tier: "private",
        title: "Sealed page",
        size: putBody.markdown.length,
        sync: localOnlySync,
      });
    },
  });
  await client.appendToPage({ slug, text: "- 2026-09-12 added [[Real]]" });
  assert.ok(putBody);
  assert.equal(isSealedMarkdown(putBody.markdown), true);
  const open = unsealPage(dek, slug, putBody.markdown);
  assert.match(open.body, /# Log/);
  assert.match(open.body, /2026-09-12 added \[\[Real\]\]/);
  assert.doesNotMatch(putBody.markdown, /added \[\[Real\]\]/);
});

test("readPageRaw decrypts sealed markdown", async () => {
  const slug = "s-hidden";
  const sealedMd = sealPage(dek, {
    slug,
    type: "concept",
    tier: "private",
    created: "2026-09-12",
    updated: "2026-09-12",
    title: "Hidden Title",
    tags: ["t"],
    sources: ["src"],
    body: "classified body",
  });
  const client = ownerUnlockedClient({
    [`GET /owner/page/${slug}/raw`]: () =>
      jsonResponse({
        slug,
        rel_path: `wiki/concepts/${slug}.md`,
        title: "Sealed page",
        section: "concepts",
        tier: "private",
        markdown: sealedMd,
      }),
  });
  const page = await client.readPageRaw(slug);
  assert.equal(page.decrypted_locally, true);
  assert.match(page.markdown, /title: Hidden Title/);
  assert.match(page.markdown, /classified body/);
  assert.doesNotMatch(page.markdown, /sealed: v1/);
});

test("searchWiki merges local decrypted hits", async () => {
  const slug = opaqueSlug(dek, "Hidden Launch", "concepts");
  const sealedMd = sealPage(dek, {
    slug,
    type: "concept",
    tier: "private",
    created: "2026-09-12",
    updated: "2026-09-12",
    title: "Hidden Launch",
    tags: [],
    sources: [],
    body: "details about the sealed launch window",
  });
  const envelope = envelopeOf(sealedMd);
  const client = ownerUnlockedClient({
    "GET /wiki/search": () =>
      jsonResponse({
        results: [
          {
            slug: "public-note",
            title: "Public Note",
            section: "concepts",
            tier: "public",
            excerpt: "visible",
            score: 1,
          },
        ],
      }),
    "GET /wiki/sealed/bundle": () =>
      jsonResponse({
        count: 1,
        pages: [
          {
            slug,
            section: "concepts",
            tier: "private",
            updated: "2026-09-12",
            envelope,
          },
        ],
      }),
  });
  const { results } = await client.searchWiki("launch", 10);
  const local = results.find((r) => r.decrypted_locally);
  assert.ok(local);
  assert.equal(local.title, "Hidden Launch");
  assert.equal(local.slug, slug);
});

test("queryWiki appends sealed context and mentions sealed_excluded", async () => {
  const slug = opaqueSlug(dek, "Hidden Launch", "concepts");
  const sealedMd = sealPage(dek, {
    slug,
    type: "concept",
    tier: "private",
    created: "2026-09-12",
    updated: "2026-09-12",
    title: "Hidden Launch",
    tags: [],
    sources: [],
    body: "details about the sealed launch window",
  });
  const envelope = envelopeOf(sealedMd);
  const client = ownerUnlockedClient({
    "POST /wiki/query": () =>
      jsonResponse({
        answer: "Server answer from public pages.",
        citations: [{ slug: "public-note", title: "Public Note" }],
        backend: "keyword",
        sealed_excluded: 2,
      }),
    "GET /wiki/sealed/bundle": () =>
      jsonResponse({
        count: 1,
        pages: [
          {
            slug,
            section: "concepts",
            tier: "private",
            updated: "2026-09-12",
            envelope,
          },
        ],
      }),
  });
  const { formatQueryWikiReport } = await import(pathToFileURL(distWiki).href);
  const result = await client.queryWiki("launch window");
  assert.equal(result.sealed_excluded, 2);
  assert.equal(result.sealed_context[0]?.title, "Hidden Launch");
  const report = formatQueryWikiReport(result);
  assert.match(report, /Sealed context \(decrypted locally\)/);
  assert.match(report, /sealed_excluded=2/);
});
