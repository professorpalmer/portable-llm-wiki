import { describe, it, expect } from "vitest";
import {
  WrongPassphraseError,
  decryptEnvelope,
  encryptEnvelope,
  generateKeyring,
  opaqueSlug,
  sealMarkdown,
  unsealMarkdown,
  unwrapDek,
} from "@/lib/sealing";

const PAGE = {
  slug: "secret-notes",
  type: "concept",
  tier: "private",
  created: "2026-09-01",
  updated: "2026-09-12",
  title: "Secret Notes",
  tags: ["alpha", "beta"],
  sources: ["raw/conversations/x.md"],
  body: "Keep [[Other Page]] private.\n\nMore body.",
};

describe("sealing crypto", () => {
  it(
    "generateKeyring unwraps with the passphrase and rejects a wrong one",
    async () => {
      const keyring = await generateKeyring("correct horse", ["private"]);
      expect(keyring.v).toBe(1);
      expect(keyring.kdf).toBe("pbkdf2-sha256");
      expect(keyring.iterations).toBe(600000);
      expect(keyring.tiers).toEqual(["private"]);

      const dek = await unwrapDek(keyring, "correct horse");
      expect(dek).toBeInstanceOf(Uint8Array);
      expect(dek.length).toBe(32);

      await expect(unwrapDek(keyring, "wrong phrase")).rejects.toBeInstanceOf(
        WrongPassphraseError,
      );
    },
    30_000,
  );

  it("round-trips envelope encrypt/decrypt", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const json = JSON.stringify({
      v: 1,
      title: PAGE.title,
      tags: PAGE.tags,
      sources: PAGE.sources,
      body: PAGE.body,
    });
    const env = await encryptEnvelope(dek, PAGE.slug, json);
    const back = await decryptEnvelope(dek, PAGE.slug, env);
    expect(JSON.parse(back)).toEqual(JSON.parse(json));
  });

  it("binds the envelope to the slug AAD", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const env = await encryptEnvelope(dek, "slug-a", '{"v":1}');
    await expect(decryptEnvelope(dek, "slug-b", env)).rejects.toThrow(
      /decrypt failed/,
    );
  });

  it("opaqueSlug is deterministic and prefixes decisions", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const a = await opaqueSlug(dek, "  Secret Notes ", "concepts");
    const b = await opaqueSlug(dek, "secret notes", "concepts");
    expect(a).toBe(b);
    expect(a).toMatch(/^s-[0-9a-f]{16}$/);

    const other = await opaqueSlug(dek, "Different", "concepts");
    expect(other).not.toBe(a);

    const dated = await opaqueSlug(
      dek,
      "Ship it",
      "decisions",
      "2024-03-15-old-name",
    );
    expect(dated).toMatch(/^2024-03-15-s-[0-9a-f]{16}$/);

    const fresh = await opaqueSlug(dek, "Ship it", "decisions");
    expect(fresh).toMatch(/^\d{4}-\d{2}-\d{2}-s-[0-9a-f]{16}$/);

    expect(await opaqueSlug(dek, "Home", "root", "index")).toBe("index");
    expect(await opaqueSlug(dek, "Log", "root", "log")).toBe("log");
    expect(await opaqueSlug(dek, "Overview", "root", "overview")).toBe(
      "overview",
    );
  });

  it("sealMarkdown / unsealMarkdown preserves title, tags, sources, body", async () => {
    const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const md = await sealMarkdown(dek, PAGE);
    expect(md).toMatch(/^---\nsealed: v1\n/);
    expect(md).toContain("type: concept");
    expect(md).not.toContain("title: Secret Notes");
    expect(md).not.toContain("Keep [[Other Page]]");

    const plain = await unsealMarkdown(dek, PAGE.slug, md);
    expect(plain.title).toBe(PAGE.title);
    expect(plain.tags).toEqual(PAGE.tags);
    expect(plain.sources).toEqual(PAGE.sources);
    expect(plain.body).toBe(PAGE.body);
    expect(plain.type).toBe("concept");
    expect(plain.tier).toBe("private");
    expect(plain.sealed).toBe("v1");
  });
});
