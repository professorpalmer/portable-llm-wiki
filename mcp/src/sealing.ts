/**
 * Client-side sealed-tier crypto. Pure: Node stdlib only, no MCP imports.
 *
 * The hosted server stores ciphertext. This process encrypts before write
 * and decrypts on read so the operator never sees plaintext for sealed tiers.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";

export const KEYRING_VERSION = 1;
export const KDF_NAME = "pbkdf2-sha256";
export const KDF_ITERATIONS = 600000;
export const DEK_WRAP_AAD = "plw-dek-v1";
export const CHECK_AAD = "plw-check-v1";
export const CHECK_PLAINTEXT = "portable-llm-wiki-seal-check";
export const ENVELOPE_WRAP_COLS = 76;
export const ROOT_PAGE_SLUGS = ["index", "log", "overview"] as const;

const GCM_NONCE_LEN = 12;
const GCM_TAG_LEN = 16;
const DEK_LEN = 32;
const SALT_LEN = 16;
const HASH_HEX_LEN = 16;

export const SECTION_TO_TYPE: Record<string, string> = {
  entities: "entity",
  concepts: "concept",
  decisions: "decision",
  projects: "project",
  queries: "query",
  sources: "source",
  root: "overview",
};

export const TYPE_TO_SECTION: Record<string, string> = {
  entity: "entities",
  concept: "concepts",
  decision: "decisions",
  project: "projects",
  query: "queries",
  source: "sources",
};

export interface Keyring {
  v: 1;
  tiers: string[];
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  wrapped_dek: string;
  check: string;
  created: string;
}

export type SealingState =
  | { kind: "not_enabled" }
  | { kind: "locked"; tiers: string[]; reason: string }
  | { kind: "unlocked"; tiers: string[]; dek: Buffer };

export interface EnvelopePayload {
  v: 1;
  title: string;
  tags: string[];
  sources: string[];
  body: string;
}

export interface PageFields {
  slug: string;
  type: string;
  tier: string;
  created: string;
  updated: string;
  title: string;
  tags: string[];
  sources: string[];
  body: string;
}

export interface UnsealedPage {
  title: string;
  tags: string[];
  sources: string[];
  body: string;
  tier: string;
  type: string;
  created: string;
  updated: string;
}

export interface PageFrontmatter {
  sealed: string;
  type: string;
  tier: string;
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
}

export interface ParsedPageDocument {
  fm: PageFrontmatter;
  body: string;
}

export interface LocalSearchHit {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

export class WrongPassphraseError extends Error {
  override readonly name = "WrongPassphraseError";
  constructor(message = "wrong passphrase") {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && i + 1 < inner.length) {
        cur += inner[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      const item = cur.trim();
      if (item) items.push(item);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const last = cur.trim();
  if (last) items.push(last);
  return items;
}

function emptyFrontmatter(): PageFrontmatter {
  return {
    sealed: "",
    type: "",
    tier: "",
    title: "",
    tags: [],
    sources: [],
    created: "",
    updated: "",
  };
}

export function parsePageDocument(markdown: string): ParsedPageDocument {
  const text = markdown.replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { fm: emptyFrontmatter(), body: text };
  }
  const fm = emptyFrontmatter();
  let listKey: "tags" | "sources" | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && listKey) {
      fm[listKey].push(unquote(listItem[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!kv) {
      listKey = null;
      continue;
    }
    const key = kv[1];
    const value = kv[2];
    if (key === "tags" || key === "sources") {
      if (value === "") {
        listKey = key;
        fm[key] = [];
        continue;
      }
      listKey = null;
      fm[key] = parseInlineList(value);
      continue;
    }
    listKey = null;
    const scalar = unquote(value);
    switch (key) {
      case "sealed":
      case "type":
      case "tier":
      case "title":
      case "created":
      case "updated":
        fm[key] = scalar;
        break;
      default:
        break;
    }
  }
  return { fm, body: text.slice(match[0].length) };
}

export function isSealedMarkdown(markdown: string): boolean {
  return parsePageDocument(markdown).fm.sealed === "v1";
}

export function frontmatterTier(markdown: string): string {
  return parsePageDocument(markdown).fm.tier;
}

export function parseKeyring(value: unknown): Keyring {
  if (!isRecord(value)) {
    throw new Error("keyring: expected an object");
  }
  if (value.v !== 1) {
    throw new Error("keyring: v must be 1");
  }
  if (!Array.isArray(value.tiers) || !value.tiers.every((t) => typeof t === "string")) {
    throw new Error("keyring: tiers must be an array of strings");
  }
  if (value.kdf !== KDF_NAME) {
    throw new Error(`keyring: kdf must be ${KDF_NAME}`);
  }
  if (typeof value.iterations !== "number" || !Number.isFinite(value.iterations)) {
    throw new Error("keyring: iterations must be a number");
  }
  if (value.iterations < 100000) {
    throw new Error("keyring: iterations must be >= 100000");
  }
  for (const field of ["salt", "wrapped_dek", "check", "created"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`keyring: ${field} must be a non-empty string`);
    }
  }
  return {
    v: 1,
    tiers: value.tiers as string[],
    kdf: KDF_NAME,
    iterations: value.iterations,
    salt: value.salt as string,
    wrapped_dek: value.wrapped_dek as string,
    check: value.check as string,
    created: value.created as string,
  };
}

export function deriveKek(
  passphrase: string,
  saltB64: string,
  iterations: number
): Buffer {
  const salt = Buffer.from(saltB64, "base64");
  if (salt.length === 0) {
    throw new Error("deriveKek: salt is empty");
  }
  return pbkdf2Sync(passphrase, salt, iterations, DEK_LEN, "sha256");
}

function encryptAesGcm(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  const nonce = randomBytes(GCM_NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

function decryptAesGcm(key: Buffer, envelopeB64: string, aad: Buffer): Buffer {
  const buf = Buffer.from(envelopeB64, "base64");
  if (buf.length < GCM_NONCE_LEN + GCM_TAG_LEN) {
    throw new Error("envelope too short");
  }
  const nonce = buf.subarray(0, GCM_NONCE_LEN);
  const tag = buf.subarray(buf.length - GCM_TAG_LEN);
  const ct = buf.subarray(GCM_NONCE_LEN, buf.length - GCM_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function unwrapDek(keyring: Keyring, passphrase: string): Buffer {
  const kek = deriveKek(passphrase, keyring.salt, keyring.iterations);
  let dek: Buffer;
  try {
    dek = decryptAesGcm(
      kek,
      keyring.wrapped_dek,
      Buffer.from(DEK_WRAP_AAD, "utf8")
    );
  } catch {
    throw new WrongPassphraseError();
  }
  if (dek.length !== DEK_LEN) {
    throw new WrongPassphraseError();
  }
  let check: Buffer;
  try {
    check = decryptAesGcm(dek, keyring.check, Buffer.from(CHECK_AAD, "utf8"));
  } catch {
    throw new WrongPassphraseError();
  }
  if (check.toString("utf8") !== CHECK_PLAINTEXT) {
    throw new WrongPassphraseError();
  }
  return dek;
}

export function generateKeyring(passphrase: string, tiers: string[]): Keyring {
  if (tiers.length === 0) {
    throw new Error("generateKeyring: tiers must be non-empty");
  }
  if (tiers.includes("public")) {
    throw new Error("generateKeyring: public can never be sealed");
  }
  const salt = randomBytes(SALT_LEN);
  const dek = randomBytes(DEK_LEN);
  const kek = pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, DEK_LEN, "sha256");
  const wrapped_dek = encryptAesGcm(
    kek,
    dek,
    Buffer.from(DEK_WRAP_AAD, "utf8")
  );
  const check = encryptAesGcm(
    dek,
    Buffer.from(CHECK_PLAINTEXT, "utf8"),
    Buffer.from(CHECK_AAD, "utf8")
  );
  return {
    v: 1,
    tiers: [...tiers],
    kdf: KDF_NAME,
    iterations: KDF_ITERATIONS,
    salt: salt.toString("base64"),
    wrapped_dek,
    check,
    created: new Date().toISOString(),
  };
}

export function encryptEnvelope(
  dek: Buffer,
  slug: string,
  plaintextJson: string
): string {
  return encryptAesGcm(
    dek,
    Buffer.from(plaintextJson, "utf8"),
    Buffer.from(slug, "utf8")
  );
}

export function decryptEnvelope(
  dek: Buffer,
  slug: string,
  envelopeB64: string
): string {
  try {
    return decryptAesGcm(
      dek,
      envelopeB64,
      Buffer.from(slug, "utf8")
    ).toString("utf8");
  } catch {
    throw new Error(
      "envelope decrypt failed (AAD/slug mismatch or corrupt ciphertext)"
    );
  }
}

export function utcDateStamp(date?: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    return date.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

export function isRootPageSlug(slug: string): boolean {
  return (ROOT_PAGE_SLUGS as readonly string[]).includes(slug);
}

export function opaqueSlug(
  dek: Buffer,
  title: string,
  section: string,
  date?: string
): string {
  const digest = createHmac("sha256", dek)
    .update(title.toLowerCase().trim(), "utf8")
    .digest("hex")
    .slice(0, HASH_HEX_LEN);
  const opaque = `s-${digest}`;
  if (section === "decisions") {
    return `${utcDateStamp(date)}-${opaque}`;
  }
  return opaque;
}

export function wrapAtColumns(text: string, columns: number): string {
  if (columns < 1 || text.length <= columns) return text;
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += columns) {
    lines.push(text.slice(i, i + columns));
  }
  return lines.join("\n");
}

export function parseEnvelopePayload(value: unknown): EnvelopePayload {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("envelope payload: invalid JSON");
    }
  }
  if (!isRecord(parsed) || parsed.v !== 1) {
    throw new Error("envelope payload: v must be 1");
  }
  if (typeof parsed.title !== "string") {
    throw new Error("envelope payload: title must be a string");
  }
  if (typeof parsed.body !== "string") {
    throw new Error("envelope payload: body must be a string");
  }
  if (!isStringArray(parsed.tags)) {
    throw new Error("envelope payload: tags must be an array of strings");
  }
  if (!isStringArray(parsed.sources)) {
    throw new Error("envelope payload: sources must be an array of strings");
  }
  return {
    v: 1,
    title: parsed.title,
    tags: parsed.tags,
    sources: parsed.sources,
    body: parsed.body,
  };
}

export function encodeEnvelopePayload(fields: {
  title: string;
  tags: string[];
  sources: string[];
  body: string;
}): string {
  const payload: EnvelopePayload = {
    v: 1,
    title: fields.title,
    tags: fields.tags,
    sources: fields.sources,
    body: fields.body,
  };
  return JSON.stringify(payload);
}

function formatYamlList(items: string[]): string {
  if (items.length === 0) return "[]";
  const escaped = items.map((item) => {
    if (/[:#\[\]{},]|^\s|\s$/.test(item)) {
      return JSON.stringify(item);
    }
    return item;
  });
  return `[${escaped.join(", ")}]`;
}

export function renderPlaintextPage(fields: {
  type: string;
  title: string;
  tier: string;
  created: string;
  updated: string;
  tags: string[];
  sources: string[];
  body: string;
}): string {
  const lines = [
    "---",
    `type: ${fields.type}`,
    `title: ${fields.title}`,
    `created: ${fields.created}`,
    `updated: ${fields.updated}`,
    `tier: ${fields.tier}`,
    `sources: ${formatYamlList(fields.sources)}`,
    `tags: ${formatYamlList(fields.tags)}`,
    "---",
    "",
    fields.body.replace(/\n+$/, ""),
    "",
  ];
  return lines.join("\n");
}

export function sealPage(dek: Buffer, page: PageFields): string {
  const plaintextJson = encodeEnvelopePayload({
    title: page.title,
    tags: page.tags,
    sources: page.sources,
    body: page.body,
  });
  const envelope = encryptEnvelope(dek, page.slug, plaintextJson);
  const wrapped = wrapAtColumns(envelope, ENVELOPE_WRAP_COLS);
  return [
    "---",
    "sealed: v1",
    `type: ${page.type}`,
    `tier: ${page.tier}`,
    `created: ${page.created}`,
    `updated: ${page.updated}`,
    "---",
    wrapped,
    "",
  ].join("\n");
}

export function unsealPage(
  dek: Buffer,
  slug: string,
  markdown: string
): UnsealedPage {
  const { fm, body } = parsePageDocument(markdown);
  if (fm.sealed !== "v1") {
    throw new Error("unsealPage: markdown is not a sealed v1 page");
  }
  const envelope = body.replace(/\s+/g, "");
  const payload = parseEnvelopePayload(decryptEnvelope(dek, slug, envelope));
  return {
    title: payload.title,
    tags: payload.tags,
    sources: payload.sources,
    body: payload.body,
    tier: fm.tier,
    type: fm.type,
    created: fm.created,
    updated: fm.updated,
  };
}

export function oneLineExcerpt(body: string, max = 160): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function snippetAround(body: string, queryWords: string[], max = 160): string {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const word of queryWords) {
    idx = lower.indexOf(word);
    if (idx >= 0) break;
  }
  if (idx < 0) return oneLineExcerpt(body, max);
  const start = Math.max(0, idx - Math.floor(max / 4));
  const slice = body.slice(start, start + max).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "..." : "";
  const suffix = start + max < body.length ? "..." : "";
  return `${prefix}${slice}${suffix}`;
}

export function localSearch(
  pages: Array<{ slug: string; title: string; body: string }>,
  query: string,
  limit: number
): LocalSearchHit[] {
  const q = query.toLowerCase().trim();
  const qWords = [...new Set(tokenize(q))];
  if (qWords.length === 0 || limit <= 0) return [];
  const hits: LocalSearchHit[] = [];
  for (const page of pages) {
    const titleLower = page.title.toLowerCase();
    const titleWords = new Set(tokenize(page.title));
    let score = 0;
    if (q && titleLower.includes(q)) score += 10;
    for (const word of qWords) {
      if (titleWords.has(word)) score += 3;
      else if (titleLower.includes(word)) score += 2;
      if (page.body.toLowerCase().includes(word)) score += 1;
    }
    if (score <= 0) continue;
    hits.push({
      slug: page.slug,
      title: page.title,
      snippet: snippetAround(page.body, qWords),
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit);
}

export function sealedTiersOf(state: SealingState): string[] {
  switch (state.kind) {
    case "not_enabled":
      return [];
    case "locked":
    case "unlocked":
      return state.tiers;
    default: {
      const _never: never = state;
      return _never;
    }
  }
}

export function isSealedTier(state: SealingState, tier: string): boolean {
  return sealedTiersOf(state).includes(tier);
}
