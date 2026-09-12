// Client-side sealed-tier crypto. Pure module — no React.
// Contract: /tmp/wiki-bench/SEALING_CONTRACT.md (v1).
// The hosted server stores ciphertext only; passphrase never leaves this process.

export const DEK_STORAGE_KEY = "plw.sealed.dek";
export const KDF_ITERATIONS = 600_000;
export const KDF_NAME = "pbkdf2-sha256";
export const CHECK_PLAINTEXT = "portable-llm-wiki-seal-check";
export const WRAP_AAD = "plw-dek-v1";
export const CHECK_AAD = "plw-check-v1";

const ROOT_SLUGS = new Set(["index", "log", "overview"]);
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})-/;
const SEALABLE_TIERS = new Set(["recruiter", "friend", "private"]);

export class WrongPassphraseError extends Error {
  readonly name = "WrongPassphraseError";
  constructor(message = "Wrong passphrase") {
    super(message);
  }
}

export type SealingKeyring = {
  v: 1;
  tiers: string[];
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  wrapped_dek: string;
  check: string;
  created: string;
};

export type EnvelopePayload = {
  v: 1;
  title: string;
  tags: string[];
  sources: string[];
  body: string;
};

export type SealablePage = {
  slug: string;
  type: string;
  tier: string;
  created: string;
  updated: string;
  title: string;
  tags: string[];
  sources: string[];
  body: string;
};

export type UnsealedPage = SealablePage & {
  sealed: "v1";
};

export type FrontmatterFields = {
  sealed?: string;
  type?: string;
  tier?: string;
  created?: string;
  updated?: string;
  title?: string;
  tags: string[];
  sources: string[];
};

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("WebCrypto subtle is not available");
  }
  return c.subtle;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const compact = b64.replace(/\s+/g, "");
  const bin = atob(compact);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function wrap76(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) {
    lines.push(s.slice(i, i + 76));
  }
  return lines.join("\n");
}

export function todayDatePrefix(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sessionStore(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

export function storeDek(dek: Uint8Array): void {
  const s = sessionStore();
  if (!s) return;
  s.setItem(DEK_STORAGE_KEY, bytesToB64(dek));
}

export function loadDek(): Uint8Array | null {
  const s = sessionStore();
  if (!s) return null;
  const raw = s.getItem(DEK_STORAGE_KEY);
  if (!raw) return null;
  try {
    const bytes = b64ToBytes(raw);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function clearDek(): void {
  const s = sessionStore();
  if (!s) return;
  s.removeItem(DEK_STORAGE_KEY);
}

export async function deriveKek(
  passphrase: string,
  saltB64: string,
  iterations: number,
): Promise<CryptoKey> {
  const keyMaterial = await subtle().importKey(
    "raw",
    utf8(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    {
      name: "PBKDF2",
      salt: b64ToBytes(saltB64),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptWithKey(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string,
): Promise<string> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: utf8(aad), tagLength: 128 },
      key,
      plaintext,
    ),
  );
  const packed = new Uint8Array(12 + ct.length);
  packed.set(nonce, 0);
  packed.set(ct, 12);
  return bytesToB64(packed);
}

async function decryptWithKey(
  key: CryptoKey,
  envelopeB64: string,
  aad: string,
): Promise<Uint8Array> {
  const packed = b64ToBytes(envelopeB64);
  if (packed.length < 28) {
    throw new Error("envelope too short");
  }
  const nonce = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: utf8(aad), tagLength: 128 },
      key,
      ct,
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error("decrypt failed");
  }
}

async function encryptRaw(
  dek: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<string> {
  return encryptWithKey(await importAesKey(dek), plaintext, aad);
}

async function decryptRaw(
  dek: Uint8Array,
  envelopeB64: string,
  aad: string,
): Promise<Uint8Array> {
  return decryptWithKey(await importAesKey(dek), envelopeB64, aad);
}

export function parseKeyring(raw: unknown): SealingKeyring {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid keyring");
  }
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) throw new Error("invalid keyring version");
  if (o.kdf !== KDF_NAME) throw new Error("invalid keyring kdf");
  if (typeof o.iterations !== "number" || o.iterations < 100_000) {
    throw new Error("invalid keyring iterations");
  }
  if (typeof o.salt !== "string" || !o.salt) throw new Error("invalid keyring salt");
  if (typeof o.wrapped_dek !== "string" || !o.wrapped_dek) {
    throw new Error("invalid keyring wrapped_dek");
  }
  if (typeof o.check !== "string" || !o.check) throw new Error("invalid keyring check");
  if (typeof o.created !== "string" || !o.created) {
    throw new Error("invalid keyring created");
  }
  if (!Array.isArray(o.tiers) || o.tiers.length === 0) {
    throw new Error("invalid keyring tiers");
  }
  const tiers: string[] = [];
  for (const t of o.tiers) {
    if (typeof t !== "string" || t === "public" || !SEALABLE_TIERS.has(t)) {
      throw new Error("invalid keyring tier");
    }
    tiers.push(t);
  }
  return {
    v: 1,
    tiers,
    kdf: "pbkdf2-sha256",
    iterations: o.iterations,
    salt: o.salt,
    wrapped_dek: o.wrapped_dek,
    check: o.check,
    created: o.created,
  };
}

export async function verifyDek(
  dek: Uint8Array,
  keyring: SealingKeyring,
): Promise<void> {
  let plain: Uint8Array;
  try {
    plain = await decryptRaw(dek, keyring.check, CHECK_AAD);
  } catch {
    throw new WrongPassphraseError();
  }
  if (fromUtf8(plain) !== CHECK_PLAINTEXT) {
    throw new WrongPassphraseError();
  }
}

export async function unwrapDek(
  keyring: SealingKeyring,
  passphrase: string,
): Promise<Uint8Array> {
  const kek = await deriveKek(passphrase, keyring.salt, keyring.iterations);
  let dek: Uint8Array;
  try {
    dek = await decryptWithKey(kek, keyring.wrapped_dek, WRAP_AAD);
  } catch {
    throw new WrongPassphraseError();
  }
  if (dek.length !== 32) {
    throw new WrongPassphraseError();
  }
  await verifyDek(dek, keyring);
  return dek;
}

export async function encryptEnvelope(
  dek: Uint8Array,
  slug: string,
  plaintextJson: string,
): Promise<string> {
  return encryptRaw(dek, utf8(plaintextJson), slug);
}

export async function decryptEnvelope(
  dek: Uint8Array,
  slug: string,
  envelopeB64: string,
): Promise<string> {
  const pt = await decryptRaw(dek, envelopeB64, slug);
  return fromUtf8(pt);
}

export function parseEnvelopePayload(json: string): EnvelopePayload {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("invalid envelope json");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid envelope payload");
  }
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) throw new Error("invalid envelope version");
  if (typeof o.title !== "string") throw new Error("invalid envelope title");
  if (typeof o.body !== "string") throw new Error("invalid envelope body");
  if (!Array.isArray(o.tags) || !o.tags.every((t) => typeof t === "string")) {
    throw new Error("invalid envelope tags");
  }
  if (!Array.isArray(o.sources) || !o.sources.every((t) => typeof t === "string")) {
    throw new Error("invalid envelope sources");
  }
  return {
    v: 1,
    title: o.title,
    tags: o.tags as string[],
    sources: o.sources as string[],
    body: o.body,
  };
}

export async function opaqueSlug(
  dek: Uint8Array,
  title: string,
  section: string,
  sourceSlug?: string,
): Promise<string> {
  if (sourceSlug && ROOT_SLUGS.has(sourceSlug)) {
    return sourceSlug;
  }
  const key = await subtle().importKey(
    "raw",
    dek,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await subtle().sign("HMAC", key, utf8(title.toLowerCase().trim())),
  );
  const digest = `s-${toHex(mac.subarray(0, 8))}`;
  if (section === "decisions") {
    const kept = sourceSlug?.match(DATE_PREFIX_RE)?.[1];
    const date = kept ?? todayDatePrefix();
    return `${date}-${digest}`;
  }
  return digest;
}

export async function generateKeyring(
  passphrase: string,
  tiers: string[],
): Promise<SealingKeyring> {
  const cleaned = tiers.filter((t) => t !== "public" && SEALABLE_TIERS.has(t));
  if (cleaned.length === 0) {
    throw new Error("at least one non-public tier is required");
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const dek = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const saltB64 = bytesToB64(salt);
  const kek = await deriveKek(passphrase, saltB64, KDF_ITERATIONS);
  const wrapped_dek = await encryptWithKey(kek, dek, WRAP_AAD);
  const check = await encryptRaw(dek, utf8(CHECK_PLAINTEXT), CHECK_AAD);
  return {
    v: 1,
    tiers: cleaned,
    kdf: "pbkdf2-sha256",
    iterations: KDF_ITERATIONS,
    salt: saltB64,
    wrapped_dek,
    check,
    created: new Date().toISOString(),
  };
}

function parseScalarList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") return [];
  let inner = trimmed;
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  }
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function unquote(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseWikiFrontmatter(markdown: string): {
  fields: FrontmatterFields;
  body: string;
} {
  const fields: FrontmatterFields = { tags: [], sources: [] };
  const text = markdown.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { fields, body: text };
  }
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { fields, body: text };
  }
  const fm = lines.slice(1, end);
  for (const line of fm) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2] ?? "";
    switch (key) {
      case "sealed":
        fields.sealed = unquote(value);
        break;
      case "type":
        fields.type = unquote(value);
        break;
      case "tier":
        fields.tier = unquote(value);
        break;
      case "created":
        fields.created = unquote(value);
        break;
      case "updated":
        fields.updated = unquote(value);
        break;
      case "title":
        fields.title = unquote(value);
        break;
      case "tags":
        fields.tags = parseScalarList(value);
        break;
      case "sources":
        fields.sources = parseScalarList(value);
        break;
      default:
        break;
    }
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

export async function sealMarkdown(
  dek: Uint8Array,
  page: SealablePage,
): Promise<string> {
  const payload: EnvelopePayload = {
    v: 1,
    title: page.title,
    tags: page.tags,
    sources: page.sources,
    body: page.body,
  };
  const envelope = await encryptEnvelope(
    dek,
    page.slug,
    JSON.stringify(payload),
  );
  const fm = [
    "---",
    "sealed: v1",
    `type: ${page.type}`,
    `tier: ${page.tier}`,
    `created: ${page.created}`,
    `updated: ${page.updated}`,
    "---",
    wrap76(envelope),
    "",
  ];
  return fm.join("\n");
}

export async function unsealMarkdown(
  dek: Uint8Array,
  slug: string,
  markdown: string,
): Promise<UnsealedPage> {
  const { fields, body } = parseWikiFrontmatter(markdown);
  if (fields.sealed !== "v1") {
    throw new Error("not a sealed document");
  }
  const envelope = body.replace(/\s+/g, "");
  const json = await decryptEnvelope(dek, slug, envelope);
  const payload = parseEnvelopePayload(json);
  return {
    slug,
    type: fields.type ?? "",
    tier: fields.tier ?? "",
    created: fields.created ?? "",
    updated: fields.updated ?? "",
    title: payload.title,
    tags: payload.tags,
    sources: payload.sources,
    body: payload.body,
    sealed: "v1",
  };
}

export type LocalSearchHit = {
  slug: string;
  title: string;
  section: string;
  tier: string;
  updated: string;
  score: number;
  excerpt: string;
};

export function scoreSealedSearch(
  query: string,
  title: string,
  body: string,
): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const words = q.split(/\s+/).filter(Boolean);
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  if (t === q) score += 10;
  else if (t.includes(q)) score += 6;
  if (b.includes(q)) score += 2;
  for (const w of words) {
    if (t.includes(w)) score += 3;
    if (b.includes(w)) score += 1;
  }
  return score;
}

export function excerptAround(body: string, query: string, width = 140): string {
  const q = query.trim();
  if (!q) return body.slice(0, width);
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return body.slice(0, width);
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + q.length + width - 40);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return `${prefix}${body.slice(start, end)}${suffix}`;
}

export function invertTitles(
  titles: Map<string, string> | null,
): Map<string, string> | undefined {
  if (!titles) return undefined;
  const out = new Map<string, string>();
  for (const [slug, title] of titles) {
    out.set(title.toLowerCase().trim(), slug);
  }
  return out;
}

export function displayPageTitle(
  slug: string,
  fallback: string,
  titles: Map<string, string> | null,
): string {
  return titles?.get(slug) ?? fallback;
}
