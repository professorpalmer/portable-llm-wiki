/**
 * HTTP client + capability probing for the Portable LLM Wiki MCP connector.
 *
 * Stdio is transport only: auth is whatever bearer (if any) is in the
 * process env. Browser OAuth cookies never reach this process, so owner
 * capability must be proven via the backend manifest — never inferred
 * from the mere presence of WIKI_OWNER_TOKEN.
 */
import {
  type Keyring,
  type SealingState,
  WrongPassphraseError,
  decryptEnvelope,
  frontmatterTier,
  generateKeyring,
  isRootPageSlug,
  isSealedMarkdown,
  isSealedTier,
  localSearch,
  oneLineExcerpt,
  opaqueSlug,
  parseEnvelopePayload,
  parseKeyring,
  parsePageDocument,
  renderPlaintextPage,
  sealPage,
  unsealPage,
  unwrapDek,
  utcDateStamp,
  SECTION_TO_TYPE,
  TYPE_TO_SECTION,
} from "./sealing.js";

export type AuthMode =
  | "public"
  | "share_read_only"
  | "owner"
  | "token_not_elevated";

export interface SyncVerdict {
  will_sync: boolean;
  mode: "global" | "tenant" | "local_only";
  remote: string | null;
  branch?: string;
  reason?: string;
  detail: string;
}

export interface ManifestSealing {
  enabled: true;
  tiers: string[];
  keyring_url: string;
  bundle_url: string;
}

export interface ManifestPage {
  slug: string;
  title: string;
  section: string;
  tier: string;
  tags: string[];
  excerpt: string;
  updated: string | null;
  sealed?: boolean;
}

export interface ManifestSnapshot {
  page_count: number;
  sections: Record<string, number>;
  viewer_tier: string;
  viewer_is_owner: boolean;
  pages: ManifestPage[];
  sealing?: ManifestSealing;
}

export interface ConnectionSealing {
  enabled: boolean;
  tiers: string[];
  unlocked: boolean;
  reason?: string;
}

export interface ConnectionStatus {
  base_url: string;
  token_configured: boolean;
  auth_mode: AuthMode;
  viewer_tier: string;
  viewer_is_owner: boolean;
  page_count: number;
  capabilities: {
    read: boolean;
    write: boolean;
    lint: boolean;
  };
  notes: string[];
  sealing: ConnectionSealing;
}

export interface BundlePage {
  slug: string;
  title: string;
  tags: string[];
  sources: string[];
  body: string;
  tier: string;
  section: string;
  updated: string;
}

export interface PageView {
  slug: string;
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
  sealed: boolean;
  envelope?: string;
  decrypted_locally?: boolean;
  locked_reason?: string;
}

export interface SearchHit {
  slug: string;
  title: string;
  section: string;
  tier: string;
  excerpt: string;
  score: number;
  decrypted_locally?: boolean;
}

export interface QueryWikiResult {
  answer: string;
  citations: Array<{ slug: string; title: string }>;
  backend: string;
  retrieval?: {
    strategy: string;
    anchors: Array<{ title: string; score: number }>;
    expanded: Array<{ title: string }>;
  };
  sealed_excluded?: number;
  sealed_context: Array<{ title: string; snippet: string }>;
}

export interface IngestApiResult {
  ok: boolean;
  rel_path: string;
  size: number;
  orchestrator: {
    tracking_id?: string;
    status?: string;
    started_at?: string;
    error?: string;
  } | null;
  drafted?: {
    pages_created?: number;
    pages?: Array<{ slug: string; title: string; section: string }>;
    backend?: string;
    model?: string;
    warnings?: string[];
    error?: string;
    kind?: string;
  } | null;
  sync?: SyncVerdict;
}

export type WikiSection =
  | "entities"
  | "concepts"
  | "decisions"
  | "projects"
  | "queries";

export type WikiTier = "public" | "recruiter" | "friend" | "private";

export interface WritePageInput {
  slug: string;
  title: string;
  section: WikiSection;
  tags?: string[];
  body: string;
}

export interface WrittenPage {
  rel_path: string;
  title: string;
  section: string;
  slug?: string;
  tier?: string;
}

export interface WritePagesResult {
  ok: boolean;
  written: WrittenPage[];
  conflicts: Array<{ slug: string; wrote_as: string }>;
  errors: string[];
  session_label: string;
  page_count: number;
  sync?: SyncVerdict;
}

export interface VerbatimWritten {
  rel_path: string;
  title: string;
  section: string;
  slug: string;
  tier: string;
  page_type: string;
}

export interface WritePageVerbatimResult {
  ok: boolean;
  written: VerbatimWritten;
  conflict: { wrote_as: string } | null;
  sync?: SyncVerdict;
}

export interface PageRaw {
  slug: string;
  rel_path: string;
  title: string;
  section: string;
  tier: string;
  markdown: string;
  decrypted_locally?: boolean;
  locked_reason?: string;
}

export interface ReplacePageResult {
  ok: boolean;
  slug: string;
  rel_path: string;
  tier: string;
  title: string;
  size: number;
  sync?: SyncVerdict;
}

export interface AppendToPageResult {
  slug: string;
  old_size: number;
  new_size: number;
  rel_path: string;
  title: string;
  tier: string;
  sync?: SyncVerdict;
}

export interface SetPageTierResult {
  ok: boolean;
  slug: string;
  tier: string;
  sync?: SyncVerdict;
}

export interface DeletePageResult {
  ok: boolean;
  slug: string;
  rel_path: string;
  sync?: SyncVerdict;
}

export interface JobSnapshot {
  tracking_id: string;
  kind?: string;
  status: string;
  raw_path?: string;
  started_at?: string;
  ended_at?: string | null;
  exit_code?: number | null;
  summary?: string | null;
  error?: string;
}

export const OWNER_STDIO_HINT =
  "Browser OAuth session cookies are not available to this stdio MCP process. " +
  "Set WIKI_OWNER_TOKEN to a real owner-capable bearer (OSS OWNER_TOKEN from " +
  "backend/.env) or a hosted personal-LLM private share token. Share/read-only " +
  "tokens and invalid tokens cannot ingest.";

export function resolveApiBase(
  env: NodeJS.ProcessEnv = process.env
): string {
  return (
    env.WIKI_BASE_URL ??
    env.WIKI_API_BASE ??
    "http://localhost:8000"
  ).replace(/\/$/, "");
}

export function resolveToken(env: NodeJS.ProcessEnv = process.env): string {
  return (env.WIKI_OWNER_TOKEN ?? "").trim();
}

export function resolveSealPassphrase(
  env: NodeJS.ProcessEnv = process.env
): string {
  return (env.WIKI_SEAL_PASSPHRASE ?? "").trim();
}

export function connectionSealingFromState(
  state: SealingState
): ConnectionSealing {
  switch (state.kind) {
    case "not_enabled":
      return { enabled: false, tiers: [], unlocked: false };
    case "locked":
      return {
        enabled: true,
        tiers: state.tiers,
        unlocked: false,
        reason: state.reason,
      };
    case "unlocked":
      return { enabled: true, tiers: state.tiers, unlocked: true };
    default: {
      const _never: never = state;
      return _never;
    }
  }
}

export function classifyAuthMode(
  tokenConfigured: boolean,
  manifest: Pick<ManifestSnapshot, "viewer_tier" | "viewer_is_owner">
): AuthMode {
  if (manifest.viewer_is_owner) return "owner";
  if (!tokenConfigured) return "public";
  if (manifest.viewer_tier && manifest.viewer_tier !== "public") {
    return "share_read_only";
  }
  return "token_not_elevated";
}

export function buildConnectionStatus(
  baseUrl: string,
  tokenConfigured: boolean,
  manifest: ManifestSnapshot,
  sealing: SealingState = { kind: "not_enabled" }
): ConnectionStatus {
  const auth_mode = classifyAuthMode(tokenConfigured, manifest);
  const isOwner = auth_mode === "owner";
  const notes: string[] = [];
  const sealingStatus = connectionSealingFromState(sealing);

  switch (auth_mode) {
    case "public":
      notes.push(
        "No bearer token configured. Read access is limited to the public tier."
      );
      break;
    case "share_read_only":
      notes.push(
        `Bearer token elevates reads to tier=${manifest.viewer_tier} but is not owner-capable. Write/lint tools will fail closed.`
      );
      break;
    case "owner":
      notes.push(
        "Bearer token is owner-capable. Read, write tools (write_pages, replace_page, delete_page), and lint are available."
      );
      break;
    case "token_not_elevated":
      notes.push(
        "A bearer token is configured but the backend did not elevate the viewer (invalid, revoked, or wrong wiki). Treated as public reads; write/lint fail closed."
      );
      break;
  }

  notes.push(
    "Stdio MCP never receives browser OAuth cookies — owner elevation requires a headless-capable bearer token."
  );

  switch (sealing.kind) {
    case "not_enabled":
      break;
    case "locked":
      notes.push(
        `Sealed tiers enabled (${sealing.tiers.join(", ")}) but locked: ${sealing.reason}. Set WIKI_SEAL_PASSPHRASE in the MCP env to read and write sealed pages. The server operator cannot recover pages if the passphrase is lost.`
      );
      break;
    case "unlocked":
      notes.push(
        `Sealed tiers unlocked locally (${sealing.tiers.join(", ")}). Titles and bodies for those tiers are decrypted in this process; the server stores ciphertext only.`
      );
      break;
    default: {
      const _never: never = sealing;
      return _never;
    }
  }

  return {
    base_url: baseUrl,
    token_configured: tokenConfigured,
    auth_mode,
    viewer_tier: manifest.viewer_tier,
    viewer_is_owner: manifest.viewer_is_owner,
    page_count: manifest.page_count,
    capabilities: {
      read: true,
      write: isOwner,
      lint: isOwner,
    },
    notes,
    sealing: sealingStatus,
  };
}

export function ownerPreflightError(status: ConnectionStatus): string {
  if (!status.token_configured) {
    return (
      `Write/lint require an owner-capable token, but WIKI_OWNER_TOKEN is not set. ${OWNER_STDIO_HINT} ` +
      `Current auth_mode=${status.auth_mode}, viewer_tier=${status.viewer_tier}.`
    );
  }
  if (status.auth_mode === "share_read_only") {
    return (
      `Write/lint refused: configured token is share/read-only (tier=${status.viewer_tier}), not owner-capable. ` +
      `${OWNER_STDIO_HINT}`
    );
  }
  if (status.auth_mode === "token_not_elevated") {
    return (
      `Write/lint refused: a token is configured but the backend did not grant owner capability ` +
      `(viewer_tier=${status.viewer_tier}). ${OWNER_STDIO_HINT}`
    );
  }
  return (
    `Write/lint refused: auth_mode=${status.auth_mode} is not owner-capable. ${OWNER_STDIO_HINT}`
  );
}

export function formatSyncNote(sync?: SyncVerdict): string {
  if (!sync) return "";
  if (sync.will_sync) {
    return `\nDurable sync: ${sync.detail}`;
  }
  return `\n\nWARNING — NOT DURABLY SYNCED: ${sync.detail}`;
}

/** Map backend orchestrator job status to an honest MCP label. */
export function normalizeOrchestratorState(
  orchestrator: IngestApiResult["orchestrator"],
  runRequested: boolean
): {
  state: "not_requested" | "pending" | "running" | "completed" | "failed" | "skipped";
  detail: string;
  tracking_id?: string;
} {
  if (!runRequested) {
    return {
      state: "not_requested",
      detail:
        "Orchestrator was not requested (run_orchestrator=false). Raw file only — wiki graph pages were not updated.",
    };
  }
  if (!orchestrator) {
    return {
      state: "skipped",
      detail: "Orchestrator was requested but the backend returned no job info.",
    };
  }
  if (orchestrator.error) {
    return {
      state: "failed",
      detail: `Orchestrator failed to start: ${orchestrator.error}`,
    };
  }
  const tracking_id = orchestrator.tracking_id;
  const raw = (orchestrator.status ?? "pending").toLowerCase();
  if (raw === "done" || raw === "completed" || raw === "success") {
    return {
      state: "completed",
      detail: `Orchestrator completed${tracking_id ? ` (tracking_id=${tracking_id})` : ""}.`,
      tracking_id,
    };
  }
  if (raw === "error" || raw === "failed") {
    return {
      state: "failed",
      detail: `Orchestrator failed${tracking_id ? ` (tracking_id=${tracking_id})` : ""}.`,
      tracking_id,
    };
  }
  if (raw === "running") {
    return {
      state: "running",
      detail: `Orchestrator running${tracking_id ? ` (tracking_id=${tracking_id})` : ""}. Graph pages are not updated until the job completes.`,
      tracking_id,
    };
  }
  return {
    state: "pending",
    detail: `Orchestrator pending/started${tracking_id ? ` (tracking_id=${tracking_id})` : ""}. Graph pages are not updated until the job completes.`,
    tracking_id,
  };
}

export function formatIngestReport(
  result: IngestApiResult,
  runOrchestrator: boolean
): string {
  const orch = normalizeOrchestratorState(result.orchestrator, runOrchestrator);
  const draftedPages = result.drafted?.pages_created;
  const draftedSuccessfully =
    !result.drafted?.error && typeof draftedPages === "number";
  const lines = [
    "Ingest result (honest status):",
    `- raw_file: saved (${result.rel_path}, ${result.size} bytes)`,
    draftedSuccessfully && draftedPages > 0
      ? `- wiki_graph_pages: updated_by_direct_drafter (${draftedPages} pages)`
      : `- wiki_graph_pages: not_updated_by_raw_save`,
    `- orchestrator: ${orch.state} — ${orch.detail}`,
  ];
  if (result.drafted) {
    lines.push(
      result.drafted.error
        ? `- direct_drafter: failed (${result.drafted.kind ?? "draft_failed"}) — ${result.drafted.error}`
        : `- direct_drafter: completed (${draftedPages ?? 0} pages)`
    );
  }
  if (orch.tracking_id) {
    lines.push(
      `- tracking_id: ${orch.tracking_id} (use ingest_job_status to verify progress)`
    );
  }
  if (result.sync) {
    lines.push(
      `- durable_sync: ${result.sync.will_sync ? "will_sync" : "local_only"} — ${result.sync.detail}`
    );
  } else {
    lines.push("- durable_sync: unknown (backend did not return a sync verdict)");
  }
  lines.push(formatSyncNote(result.sync).trimEnd());
  return lines.filter(Boolean).join("\n");
}

export function mapJobStatusLabel(status: string): string {
  const raw = status.toLowerCase();
  if (raw === "done" || raw === "completed" || raw === "success") return "completed";
  if (raw === "error" || raw === "failed") return "failed";
  if (raw === "running") return "running";
  if (raw === "pending" || raw === "queued" || raw === "starting") return "pending";
  return raw || "unknown";
}

export function formatJobStatusReport(payload: {
  job: JobSnapshot;
  log_tail?: string;
  persistence?: unknown;
  polls?: number;
}): string {
  const label = mapJobStatusLabel(payload.job.status);
  const lines = [
    "Ingest job status:",
    `- tracking_id: ${payload.job.tracking_id}`,
    `- orchestrator: ${label} (backend status=${payload.job.status})`,
    `- wiki_graph_pages: ${
      label === "completed"
        ? "likely_updated_if_job_succeeded — confirm via list_pages/search if needed"
        : "not_confirmed_updated"
    }`,
  ];
  if (payload.job.raw_path) lines.push(`- raw_path: ${payload.job.raw_path}`);
  if (payload.job.summary) lines.push(`- summary: ${payload.job.summary}`);
  if (payload.job.exit_code != null) lines.push(`- exit_code: ${payload.job.exit_code}`);
  if (payload.polls != null) lines.push(`- polls_used: ${payload.polls}`);
  if (payload.persistence) {
    lines.push(
      `- persistence: ${JSON.stringify(payload.persistence).slice(0, 400)}`
    );
  }
  if (payload.log_tail) {
    const tail = payload.log_tail.trim();
    if (tail) {
      lines.push("\nLog tail (truncated):");
      lines.push(tail.slice(-1200));
    }
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseManifestSealing(value: unknown): ManifestSealing | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error("manifest.sealing: expected an object");
  }
  if (value.enabled !== true) {
    throw new Error("manifest.sealing: enabled must be true when present");
  }
  if (!Array.isArray(value.tiers) || !value.tiers.every((t) => typeof t === "string")) {
    throw new Error("manifest.sealing: tiers must be an array of strings");
  }
  if (typeof value.keyring_url !== "string" || value.keyring_url.length === 0) {
    throw new Error("manifest.sealing: keyring_url must be a non-empty string");
  }
  if (typeof value.bundle_url !== "string" || value.bundle_url.length === 0) {
    throw new Error("manifest.sealing: bundle_url must be a non-empty string");
  }
  if (value.tiers.length === 0) return undefined;
  return {
    enabled: true,
    tiers: value.tiers,
    keyring_url: value.keyring_url,
    bundle_url: value.bundle_url,
  };
}

function parseManifestPages(value: unknown): ManifestPage[] {
  if (!Array.isArray(value)) return [];
  const pages: ManifestPage[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.slug !== "string") continue;
    pages.push({
      slug: item.slug,
      title: typeof item.title === "string" ? item.title : "",
      section: typeof item.section === "string" ? item.section : "",
      tier: typeof item.tier === "string" ? item.tier : "",
      tags: asStringArray(item.tags),
      excerpt: typeof item.excerpt === "string" ? item.excerpt : "",
      updated: typeof item.updated === "string" ? item.updated : null,
      sealed: item.sealed === true ? true : undefined,
    });
  }
  return pages;
}

function parseSections(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === "number") out[key] = count;
  }
  return out;
}

export function parseManifest(value: unknown): ManifestSnapshot {
  if (!isRecord(value)) {
    throw new Error("manifest: expected an object");
  }
  return {
    page_count: typeof value.page_count === "number" ? value.page_count : 0,
    sections: parseSections(value.sections),
    viewer_tier: typeof value.viewer_tier === "string" ? value.viewer_tier : "public",
    viewer_is_owner: Boolean(value.viewer_is_owner),
    pages: parseManifestPages(value.pages),
    sealing: parseManifestSealing(value.sealing),
  };
}

function parseResolvedLinks(
  value: unknown
): Array<{ slug: string; title: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ slug: string; title: string }> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.slug !== "string") continue;
    out.push({
      slug: item.slug,
      title: typeof item.title === "string" ? item.title : "",
    });
  }
  return out;
}

function parsePageView(value: unknown, fallbackSlug: string): PageView {
  if (!isRecord(value)) {
    throw new Error("read_page: unexpected response");
  }
  return {
    slug: typeof value.slug === "string" ? value.slug : fallbackSlug,
    title: typeof value.title === "string" ? value.title : "",
    section: typeof value.section === "string" ? value.section : "",
    tier: typeof value.tier === "string" ? value.tier : "",
    created: typeof value.created === "string" ? value.created : null,
    updated: typeof value.updated === "string" ? value.updated : null,
    tags: asStringArray(value.tags),
    body: typeof value.body === "string" ? value.body : "",
    sources: asStringArray(value.sources),
    links_out_resolved: parseResolvedLinks(value.links_out_resolved),
    links_in_resolved: parseResolvedLinks(value.links_in_resolved),
    sealed: value.sealed === true || typeof value.envelope === "string",
    envelope: typeof value.envelope === "string" ? value.envelope : undefined,
  };
}

function parseSearchResults(value: unknown): SearchHit[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  const out: SearchHit[] = [];
  for (const item of value.results) {
    if (!isRecord(item) || typeof item.slug !== "string") continue;
    out.push({
      slug: item.slug,
      title: typeof item.title === "string" ? item.title : "",
      section: typeof item.section === "string" ? item.section : "",
      tier: typeof item.tier === "string" ? item.tier : "",
      excerpt: typeof item.excerpt === "string" ? item.excerpt : "",
      score: typeof item.score === "number" ? item.score : 0,
    });
  }
  return out;
}

function parseQueryWiki(value: unknown): QueryWikiResult {
  if (!isRecord(value) || typeof value.answer !== "string") {
    throw new Error("query_wiki: unexpected response");
  }
  let retrieval: QueryWikiResult["retrieval"];
  if (isRecord(value.retrieval) && typeof value.retrieval.strategy === "string") {
    const anchors: Array<{ title: string; score: number }> = [];
    if (Array.isArray(value.retrieval.anchors)) {
      for (const item of value.retrieval.anchors) {
        if (!isRecord(item) || typeof item.title !== "string") continue;
        anchors.push({
          title: item.title,
          score: typeof item.score === "number" ? item.score : 0,
        });
      }
    }
    const expanded: Array<{ title: string }> = [];
    if (Array.isArray(value.retrieval.expanded)) {
      for (const item of value.retrieval.expanded) {
        if (!isRecord(item) || typeof item.title !== "string") continue;
        expanded.push({ title: item.title });
      }
    }
    retrieval = { strategy: value.retrieval.strategy, anchors, expanded };
  }
  return {
    answer: value.answer,
    citations: parseResolvedLinks(value.citations),
    backend: typeof value.backend === "string" ? value.backend : "",
    retrieval,
    sealed_excluded:
      typeof value.sealed_excluded === "number" ? value.sealed_excluded : undefined,
    sealed_context: [],
  };
}

function parseBundlePages(value: unknown): Array<{
  slug: string;
  section: string;
  tier: string;
  updated: string;
  envelope: string;
}> {
  if (!isRecord(value) || !Array.isArray(value.pages)) return [];
  const out: Array<{
    slug: string;
    section: string;
    tier: string;
    updated: string;
    envelope: string;
  }> = [];
  for (const item of value.pages) {
    if (
      !isRecord(item) ||
      typeof item.slug !== "string" ||
      typeof item.envelope !== "string"
    ) {
      continue;
    }
    out.push({
      slug: item.slug,
      section: typeof item.section === "string" ? item.section : "",
      tier: typeof item.tier === "string" ? item.tier : "",
      updated: typeof item.updated === "string" ? item.updated : "",
      envelope: item.envelope,
    });
  }
  return out;
}

const SEALABLE_TIERS = new Set(["recruiter", "friend", "private"]);

export function formatQueryWikiReport(result: QueryWikiResult): string {
  let text = result.answer;
  if (result.citations.length) {
    text += `\n\n---\nCitations: ${result.citations
      .map((c) => `[[${c.title}]]`)
      .join(", ")}`;
  }
  if (result.retrieval) {
    text += `\n\n_Retrieval: ${result.retrieval.strategy}. Anchors: ${result.retrieval.anchors
      .map((a) => a.title)
      .join(", ")}. Expanded: ${
      result.retrieval.expanded.map((e) => e.title).join(", ") || "(none)"
    }._`;
  }
  if (result.sealed_excluded != null && result.sealed_excluded > 0) {
    text += `\n\nServer retrieval omitted ${result.sealed_excluded} sealed page(s) (sealed_excluded=${result.sealed_excluded}).`;
  }
  if (result.sealed_context.length > 0) {
    text += "\n\nSealed context (decrypted locally)";
    for (const passage of result.sealed_context) {
      text += `\n\n## ${passage.title}\n${passage.snippet}`;
    }
  }
  return text;
}

export function formatSearchWikiReport(
  query: string,
  results: SearchHit[]
): string {
  if (results.length === 0) return `No matches for "${query}".`;
  return results
    .map((m) => {
      const local = m.decrypted_locally ? " [decrypted locally]" : "";
      return `[score ${m.score}] ${m.title} (slug: ${m.slug}, ${m.section}/${m.tier})${local}\n  ${m.excerpt}`;
    })
    .join("\n\n");
}

export function formatListPagesReport(manifest: ManifestSnapshot): string {
  const summary = `Wiki has ${manifest.page_count} page(s) visible at tier=${manifest.viewer_tier}${
    manifest.viewer_is_owner ? " (owner)" : ""
  }. Sections: ${Object.entries(manifest.sections)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")}.`;
  const pages = manifest.pages
    .map(
      (p) =>
        `- ${p.title} [${p.section}/${p.tier}] (slug: ${p.slug})${
          p.updated ? ` — updated ${p.updated}` : ""
        }${p.excerpt ? `\n  ${p.excerpt}` : ""}`
    )
    .join("\n");
  return `${summary}\n\n${pages}`;
}

export function formatReadPageReport(page: PageView): string {
  if (page.sealed && !page.decrypted_locally) {
    const reason = page.locked_reason
      ? ` Unlock to read (${page.locked_reason}).`
      : " Unlock to read.";
    return (
      `# Sealed page\n` +
      `_section: ${page.section} · tier: ${page.tier}_\n\n` +
      `Sealed page.${reason}`
    );
  }
  const header =
    `# ${page.title}\n` +
    `_section: ${page.section} · tier: ${page.tier}` +
    `${page.created ? ` · created: ${page.created}` : ""}` +
    `${page.updated ? ` · updated: ${page.updated}` : ""}` +
    `${page.tags.length ? ` · tags: ${page.tags.join(", ")}` : ""}_\n\n`;
  const linksOut = page.links_out_resolved.length
    ? `\n\n---\n**Links out:** ${page.links_out_resolved
        .map((l) => `[[${l.title}]] (slug: ${l.slug})`)
        .join(", ")}`
    : "";
  const linksIn = page.links_in_resolved.length
    ? `\n**Links in:** ${page.links_in_resolved
        .map((l) => `[[${l.title}]] (slug: ${l.slug})`)
        .join(", ")}`
    : "";
  const sources = page.sources.length
    ? `\n**Sources:** ${page.sources.join(", ")}`
    : "";
  const local = page.decrypted_locally ? "\n\ndecrypted_locally: true" : "";
  return header + page.body + linksOut + linksIn + sources + local;
}

function lockedSealedWriteError(reason: string, action: string): Error {
  return new Error(
    `Cannot ${action}: sealing is enabled but locked (${reason}). ` +
      `Set WIKI_SEAL_PASSPHRASE in the MCP env. Never sending plaintext to a sealed tier.`
  );
}

function parseSync(value: unknown): SyncVerdict | undefined {
  if (!isRecord(value)) return undefined;
  const mode = value.mode;
  if (mode !== "global" && mode !== "tenant" && mode !== "local_only") {
    return undefined;
  }
  if (typeof value.will_sync !== "boolean" || typeof value.detail !== "string") {
    return undefined;
  }
  const remote = value.remote;
  return {
    will_sync: value.will_sync,
    mode,
    remote: typeof remote === "string" ? remote : null,
    branch: typeof value.branch === "string" ? value.branch : undefined,
    reason: typeof value.reason === "string" ? value.reason : undefined,
    detail: value.detail,
  };
}

export function joinAppendedText(
  existing: string,
  appended: string,
  separator = "\n"
): string {
  return `${existing.replace(/\n+$/, "")}${separator}${appended}`;
}

export function formatWritePagesReport(result: WritePagesResult): string {
  const writtenList =
    result.written.length === 0
      ? "(none)"
      : result.written.map((p) => p.rel_path).join(", ");
  const conflictList =
    result.conflicts.length === 0
      ? "(none)"
      : result.conflicts.map((c) => `${c.slug} -> ${c.wrote_as}`).join(", ");
  const errorList =
    result.errors.length === 0 ? "(none)" : result.errors.join("; ");
  const lines = [
    "Write pages result:",
    `- written: ${writtenList}`,
    `- conflicts: ${conflictList}`,
    `- errors: ${errorList}`,
    `- page_count: ${result.written.length}`,
  ];
  if (result.sync) {
    lines.push(
      `- durable_sync: ${result.sync.will_sync ? "will_sync" : "local_only"} — ${result.sync.detail}`
    );
  }
  const note = formatSyncNote(result.sync).trimEnd();
  if (note) lines.push(note);
  return lines.join("\n");
}

export function formatWritePageVerbatimReport(
  result: WritePageVerbatimResult
): string {
  const w = result.written;
  const conflict = result.conflict
    ? `wrote_as=${result.conflict.wrote_as}`
    : "(none)";
  const lines = [
    "Verbatim write result:",
    `- written: ${w.rel_path} (title=${w.title}, section=${w.section}, slug=${w.slug}, tier=${w.tier}, page_type=${w.page_type})`,
    `- conflict: ${conflict}`,
  ];
  if (result.sync) {
    lines.push(
      `- durable_sync: ${result.sync.will_sync ? "will_sync" : "local_only"} — ${result.sync.detail}`
    );
  }
  const note = formatSyncNote(result.sync).trimEnd();
  if (note) lines.push(note);
  return lines.join("\n");
}

export function formatReplacePageReport(result: ReplacePageResult): string {
  const lines = [
    `Replaced page ${result.slug}:`,
    `- title: ${result.title}`,
    `- tier: ${result.tier}`,
    `- size: ${result.size}`,
    `- rel_path: ${result.rel_path}`,
  ];
  if (result.sync) {
    lines.push(
      `- durable_sync: ${result.sync.will_sync ? "will_sync" : "local_only"} — ${result.sync.detail}`
    );
  }
  const note = formatSyncNote(result.sync).trimEnd();
  if (note) lines.push(note);
  return lines.join("\n");
}

export function formatAppendToPageReport(result: AppendToPageResult): string {
  const lines = [
    `Appended to ${result.slug}:`,
    `- size: ${result.old_size} -> ${result.new_size}`,
    `- rel_path: ${result.rel_path}`,
    `- title: ${result.title}`,
    `- tier: ${result.tier}`,
  ];
  if (result.sync) {
    lines.push(
      `- durable_sync: ${result.sync.will_sync ? "will_sync" : "local_only"} — ${result.sync.detail}`
    );
  }
  const note = formatSyncNote(result.sync).trimEnd();
  if (note) lines.push(note);
  return lines.join("\n");
}

export function formatSetPageTierReport(result: SetPageTierResult): string {
  const lines = [`Set tier of ${result.slug} to ${result.tier}.`];
  if (result.sync) {
    lines.push(
      `- durable_sync: ${result.sync.will_sync ? "will_sync" : "local_only"} — ${result.sync.detail}`
    );
  }
  const note = formatSyncNote(result.sync).trimEnd();
  if (note) lines.push(note);
  return lines.join("\n");
}

export function formatDeletePageReport(result: DeletePageResult): string {
  const lines = [`Deleted page ${result.slug} (${result.rel_path}).`];
  if (result.sync) {
    lines.push(
      `- durable_sync: ${result.sync.will_sync ? "will_sync" : "local_only"} — ${result.sync.detail}`
    );
  }
  const note = formatSyncNote(result.sync).trimEnd();
  if (note) lines.push(note);
  return lines.join("\n");
}

function parseWritePagesResult(value: unknown): WritePagesResult {
  if (!isRecord(value)) {
    throw new Error("write_pages: unexpected response");
  }
  const written: WrittenPage[] = [];
  if (Array.isArray(value.written)) {
    for (const item of value.written) {
      if (!isRecord(item) || typeof item.rel_path !== "string") continue;
      written.push({
        rel_path: item.rel_path,
        title: typeof item.title === "string" ? item.title : "",
        section: typeof item.section === "string" ? item.section : "",
        slug: typeof item.slug === "string" ? item.slug : undefined,
        tier: typeof item.tier === "string" ? item.tier : undefined,
      });
    }
  }
  const conflicts: Array<{ slug: string; wrote_as: string }> = [];
  if (Array.isArray(value.conflicts)) {
    for (const item of value.conflicts) {
      if (
        isRecord(item) &&
        typeof item.slug === "string" &&
        typeof item.wrote_as === "string"
      ) {
        conflicts.push({ slug: item.slug, wrote_as: item.wrote_as });
      }
    }
  }
  const errors: string[] = [];
  if (Array.isArray(value.errors)) {
    for (const item of value.errors) {
      if (typeof item === "string") errors.push(item);
    }
  }
  return {
    ok: value.ok === true,
    written,
    conflicts,
    errors,
    session_label:
      typeof value.session_label === "string" ? value.session_label : "",
    page_count: written.length,
    sync: parseSync(value.sync),
  };
}

function parseWritePageVerbatimResult(value: unknown): WritePageVerbatimResult {
  if (!isRecord(value) || !isRecord(value.written)) {
    throw new Error("write_page_verbatim: unexpected response");
  }
  const w = value.written;
  if (typeof w.rel_path !== "string") {
    throw new Error("write_page_verbatim: written.rel_path missing");
  }
  let conflict: { wrote_as: string } | null = null;
  if (isRecord(value.conflict) && typeof value.conflict.wrote_as === "string") {
    conflict = { wrote_as: value.conflict.wrote_as };
  }
  return {
    ok: value.ok === true,
    written: {
      rel_path: w.rel_path,
      title: typeof w.title === "string" ? w.title : "",
      section: typeof w.section === "string" ? w.section : "",
      slug: typeof w.slug === "string" ? w.slug : "",
      tier: typeof w.tier === "string" ? w.tier : "",
      page_type: typeof w.page_type === "string" ? w.page_type : "",
    },
    conflict,
    sync: parseSync(value.sync),
  };
}

function parsePageRaw(value: unknown): PageRaw {
  if (!isRecord(value) || typeof value.markdown !== "string") {
    throw new Error("read_page_raw: unexpected response");
  }
  return {
    slug: typeof value.slug === "string" ? value.slug : "",
    rel_path: typeof value.rel_path === "string" ? value.rel_path : "",
    title: typeof value.title === "string" ? value.title : "",
    section: typeof value.section === "string" ? value.section : "",
    tier: typeof value.tier === "string" ? value.tier : "",
    markdown: value.markdown,
  };
}

function parseReplacePageResult(value: unknown): ReplacePageResult {
  if (!isRecord(value) || typeof value.size !== "number") {
    throw new Error("replace_page: unexpected response");
  }
  return {
    ok: value.ok === true,
    slug: typeof value.slug === "string" ? value.slug : "",
    rel_path: typeof value.rel_path === "string" ? value.rel_path : "",
    tier: typeof value.tier === "string" ? value.tier : "",
    title: typeof value.title === "string" ? value.title : "",
    size: value.size,
    sync: parseSync(value.sync),
  };
}

function parseSetPageTierResult(value: unknown): SetPageTierResult {
  if (!isRecord(value) || typeof value.tier !== "string") {
    throw new Error("set_page_tier: unexpected response");
  }
  return {
    ok: value.ok === true,
    slug: typeof value.slug === "string" ? value.slug : "",
    tier: value.tier,
    sync: parseSync(value.sync),
  };
}

function parseDeletePageResult(value: unknown): DeletePageResult {
  if (!isRecord(value) || typeof value.slug !== "string") {
    throw new Error("delete_page: unexpected response");
  }
  return {
    ok: value.ok === true,
    slug: value.slug,
    rel_path: typeof value.rel_path === "string" ? value.rel_path : "",
    sync: parseSync(value.sync),
  };
}

export function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export function startupAuthLabel(status: ConnectionStatus): string {
  switch (status.auth_mode) {
    case "owner":
      return "owner";
    case "share_read_only":
      return `share/read-only tier=${status.viewer_tier}`;
    case "token_not_elevated":
      return "token configured but not elevated";
    default:
      return "public";
  }
}

export type FetchLike = typeof fetch;

export class WikiClient {
  private cachedSealing: SealingState | null = null;
  private bundleBySlug: Map<string, BundlePage> | null = null;
  private decryptBySlugUpdated = new Map<string, BundlePage>();

  constructor(
    public readonly baseUrl: string,
    public readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: FetchLike = fetch
  ): WikiClient {
    return new WikiClient(resolveApiBase(env), resolveToken(env), fetchImpl, env);
  }

  get tokenConfigured(): boolean {
    return Boolean(this.token);
  }

  invalidateSealing(): void {
    this.cachedSealing = null;
    this.bundleBySlug = null;
    this.decryptBySlugUpdated.clear();
  }

  invalidateBundle(): void {
    this.bundleBySlug = null;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options?: { responseType?: "json" | "text" }
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: authHeaders(this.token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${detail.slice(0, 400)}`);
    }
    if (options?.responseType === "text") {
      return res.text();
    }
    return res.json();
  }

  apiGet(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  apiPost(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  async fetchManifest(): Promise<ManifestSnapshot> {
    return parseManifest(await this.apiGet("/wiki/manifest.json"));
  }

  async sealingState(): Promise<SealingState> {
    if (this.cachedSealing) return this.cachedSealing;
    const manifest = await this.fetchManifest();
    this.cachedSealing = await this.sealingFromManifest(manifest);
    return this.cachedSealing;
  }

  private async sealingFromManifest(
    manifest: ManifestSnapshot
  ): Promise<SealingState> {
    if (!manifest.sealing || manifest.sealing.tiers.length === 0) {
      return { kind: "not_enabled" };
    }
    const tiers = manifest.sealing.tiers;
    let keyring: Keyring;
    try {
      keyring = parseKeyring(await this.apiGet(manifest.sealing.keyring_url));
    } catch (err) {
      return {
        kind: "locked",
        tiers,
        reason:
          err instanceof Error
            ? `keyring unavailable: ${err.message}`
            : "keyring unavailable",
      };
    }
    const passphrase = resolveSealPassphrase(this.env);
    if (!passphrase) {
      return { kind: "locked", tiers, reason: "WIKI_SEAL_PASSPHRASE not set" };
    }
    try {
      const dek = unwrapDek(keyring, passphrase);
      return { kind: "unlocked", tiers, dek };
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        return { kind: "locked", tiers, reason: "wrong passphrase" };
      }
      return {
        kind: "locked",
        tiers,
        reason: err instanceof Error ? err.message : "wrong passphrase",
      };
    }
  }

  async sealStatus(): Promise<{
    kind: SealingState["kind"];
    enabled: boolean;
    tiers: string[];
    unlocked: boolean;
    reason?: string;
  }> {
    const state = await this.sealingState();
    const publicStatus = connectionSealingFromState(state);
    return {
      kind: state.kind,
      enabled: publicStatus.enabled,
      tiers: publicStatus.tiers,
      unlocked: publicStatus.unlocked,
      reason: publicStatus.reason,
    };
  }

  async sealedBundle(): Promise<Map<string, BundlePage>> {
    const state = await this.sealingState();
    if (state.kind !== "unlocked") {
      return new Map();
    }
    if (this.bundleBySlug) return this.bundleBySlug;
    const manifest = await this.fetchManifest();
    const url = manifest.sealing?.bundle_url ?? "/wiki/sealed/bundle";
    const pages = parseBundlePages(await this.apiGet(url));
    const result = new Map<string, BundlePage>();
    for (const page of pages) {
      const cacheKey = `${page.slug}\0${page.updated}`;
      const cached = this.decryptBySlugUpdated.get(cacheKey);
      if (cached) {
        result.set(page.slug, cached);
        continue;
      }
      try {
        const payload = parseEnvelopePayload(
          decryptEnvelope(state.dek, page.slug, page.envelope)
        );
        const entry: BundlePage = {
          slug: page.slug,
          title: payload.title,
          tags: payload.tags,
          sources: payload.sources,
          body: payload.body,
          tier: page.tier,
          section: page.section,
          updated: page.updated,
        };
        this.decryptBySlugUpdated.set(cacheKey, entry);
        result.set(page.slug, entry);
      } catch {
        // Skip pages that cannot be decrypted with this DEK.
      }
    }
    this.bundleBySlug = result;
    return result;
  }

  async connectionStatus(): Promise<ConnectionStatus> {
    const manifest = await this.fetchManifest();
    const sealing =
      this.cachedSealing ??
      (this.cachedSealing = await this.sealingFromManifest(manifest));
    return buildConnectionStatus(
      this.baseUrl,
      this.tokenConfigured,
      manifest,
      sealing
    );
  }

  /** Fail closed before any owner mutation. Never sends content on failure. */
  async requireOwnerCapability(): Promise<ConnectionStatus> {
    const status = await this.connectionStatus();
    if (!status.capabilities.write) {
      throw new Error(ownerPreflightError(status));
    }
    return status;
  }

  async ingestSource(args: {
    slug: string;
    content: string;
    subdir?: string;
    note?: string | null;
    run_orchestrator?: boolean;
  }): Promise<{ report: string; result: IngestApiResult }> {
    await this.requireOwnerCapability();
    const runOrchestrator = Boolean(args.run_orchestrator);
    const result = (await this.apiPost("/owner/ingest", {
      slug: args.slug,
      content: args.content,
      subdir: args.subdir ?? "conversations",
      note: args.note ?? null,
      run_orchestrator: runOrchestrator,
    })) as IngestApiResult;
    return { report: formatIngestReport(result, runOrchestrator), result };
  }

  async getJob(trackingId: string): Promise<{
    job: JobSnapshot;
    log_tail?: string;
    puppetmaster_status?: unknown;
  }> {
    const raw = (await this.apiGet(
      `/owner/jobs/${encodeURIComponent(trackingId)}`
    )) as {
      job: JobSnapshot;
      log_tail?: string;
      puppetmaster_status?: unknown;
    };
    return raw;
  }

  async persistenceStatus(): Promise<unknown> {
    return this.apiGet("/owner/persistence");
  }

  /**
   * Read-only job verification with bounded polling.
   * Stops early on completed/failed; never blocks indefinitely.
   */
  async ingestJobStatus(args: {
    tracking_id: string;
    poll_attempts?: number;
    poll_interval_ms?: number;
    include_persistence?: boolean;
  }): Promise<string> {
    await this.requireOwnerCapability();
    const maxAttempts = Math.max(1, Math.min(args.poll_attempts ?? 1, 20));
    const intervalMs = Math.max(0, Math.min(args.poll_interval_ms ?? 500, 5000));
    let last:
      | {
          job: JobSnapshot;
          log_tail?: string;
        }
      | undefined;
    let polls = 0;

    for (let i = 0; i < maxAttempts; i++) {
      polls += 1;
      last = await this.getJob(args.tracking_id);
      const label = mapJobStatusLabel(last.job.status);
      if (label === "completed" || label === "failed") break;
      if (i + 1 < maxAttempts && intervalMs > 0) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }

    if (!last) {
      throw new Error(`No job status returned for tracking_id=${args.tracking_id}`);
    }

    let persistence: unknown;
    if (args.include_persistence) {
      try {
        persistence = await this.persistenceStatus();
      } catch (err) {
        persistence = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return formatJobStatusReport({
      job: { ...last.job, tracking_id: last.job.tracking_id || args.tracking_id },
      log_tail: last.log_tail,
      persistence,
      polls,
    });
  }

  async writePages(args: {
    session_label: string;
    pages: WritePageInput[];
    force_overwrite?: boolean;
  }): Promise<{ report: string; result: WritePagesResult }> {
    await this.requireOwnerCapability();
    const state = await this.sealingState();
    if (state.kind === "locked" && isSealedTier(state, "private")) {
      throw lockedSealedWriteError(state.reason, "write_pages");
    }
    if (state.kind === "unlocked" && isSealedTier(state, "private")) {
      const result = await this.writePagesSealed(state, args);
      this.invalidateBundle();
      return { report: formatWritePagesReport(result), result };
    }
    const body: Record<string, unknown> = {
      session_label: args.session_label,
      pages: args.pages,
    };
    if (args.force_overwrite !== undefined) {
      body.force_overwrite = args.force_overwrite;
    }
    const result = parseWritePagesResult(
      await this.request("POST", "/owner/capture/structured", body)
    );
    this.invalidateBundle();
    return { report: formatWritePagesReport(result), result };
  }

  private async writePagesSealed(
    state: Extract<SealingState, { kind: "unlocked" }>,
    args: {
      session_label: string;
      pages: WritePageInput[];
      force_overwrite?: boolean;
    }
  ): Promise<WritePagesResult> {
    const written: WrittenPage[] = [];
    const conflicts: Array<{ slug: string; wrote_as: string }> = [];
    const errors: string[] = [];
    let sync: WritePagesResult["sync"];
    const today = utcDateStamp();
    for (const page of args.pages) {
      try {
        const type = SECTION_TO_TYPE[page.section] ?? "concept";
        const slug = isRootPageSlug(page.slug)
          ? page.slug
          : opaqueSlug(state.dek, page.title, page.section);
        const markdown = sealPage(state.dek, {
          slug,
          type,
          tier: "private",
          created: today,
          updated: today,
          title: page.title,
          tags: page.tags ?? [],
          sources: [args.session_label],
          body: page.body,
        });
        const body: Record<string, unknown> = {
          content: markdown,
          slug,
        };
        if (args.force_overwrite !== undefined) {
          body.force_overwrite = args.force_overwrite;
        }
        const verbatim = parseWritePageVerbatimResult(
          await this.request("POST", "/owner/capture/verbatim", body)
        );
        written.push({
          rel_path: verbatim.written.rel_path,
          title: page.title,
          section: verbatim.written.section || page.section,
          slug: verbatim.written.slug || slug,
          tier: verbatim.written.tier || "private",
        });
        if (verbatim.conflict) {
          conflicts.push({ slug, wrote_as: verbatim.conflict.wrote_as });
        }
        if (verbatim.sync) sync = verbatim.sync;
      } catch (err) {
        errors.push(
          `${page.slug}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return {
      ok: errors.length === 0 && written.length > 0,
      written,
      conflicts,
      errors,
      session_label: args.session_label,
      page_count: written.length,
      sync,
    };
  }

  private maybeSealOutgoing(
    state: SealingState,
    markdown: string,
    slug: string | undefined,
    action: string
  ): { content: string; slug?: string } {
    if (state.kind === "not_enabled" || isSealedMarkdown(markdown)) {
      return { content: markdown, slug };
    }
    const { fm, body } = parsePageDocument(markdown);
    const tier = fm.tier;
    if (!tier || !isSealedTier(state, tier)) {
      return { content: markdown, slug };
    }
    if (state.kind !== "unlocked") {
      throw lockedSealedWriteError(
        state.kind === "locked" ? state.reason : "WIKI_SEAL_PASSPHRASE not set",
        action
      );
    }
    const type = fm.type || "concept";
    const title = fm.title || slug || "untitled";
    const section = TYPE_TO_SECTION[type] ?? "concepts";
    const resolvedSlug =
      slug ??
      (isRootPageSlug(title.toLowerCase())
        ? title.toLowerCase()
        : opaqueSlug(state.dek, title, section));
    const today = utcDateStamp();
    return {
      content: sealPage(state.dek, {
        slug: resolvedSlug,
        type,
        tier,
        created: fm.created || today,
        updated: today,
        title,
        tags: fm.tags,
        sources: fm.sources,
        body,
      }),
      slug: resolvedSlug,
    };
  }

  async writePageVerbatim(args: {
    content: string;
    slug?: string;
    force_overwrite?: boolean;
  }): Promise<{ report: string; result: WritePageVerbatimResult }> {
    await this.requireOwnerCapability();
    const state = await this.sealingState();
    const sealed = this.maybeSealOutgoing(
      state,
      args.content,
      args.slug,
      "write_page_verbatim"
    );
    const body: Record<string, unknown> = { content: sealed.content };
    if (sealed.slug !== undefined) body.slug = sealed.slug;
    if (args.force_overwrite !== undefined) {
      body.force_overwrite = args.force_overwrite;
    }
    const result = parseWritePageVerbatimResult(
      await this.request("POST", "/owner/capture/verbatim", body)
    );
    this.invalidateBundle();
    return { report: formatWritePageVerbatimReport(result), result };
  }

  async readPageRaw(slug: string): Promise<PageRaw> {
    await this.requireOwnerCapability();
    const page = parsePageRaw(
      await this.request("GET", `/owner/page/${encodeURIComponent(slug)}/raw`)
    );
    if (!isSealedMarkdown(page.markdown)) {
      return page;
    }
    const state = await this.sealingState();
    if (state.kind === "unlocked") {
      const open = unsealPage(state.dek, slug, page.markdown);
      return {
        ...page,
        title: open.title,
        tier: open.tier || page.tier,
        markdown: renderPlaintextPage({
          type: open.type,
          title: open.title,
          tier: open.tier,
          created: open.created,
          updated: open.updated,
          tags: open.tags,
          sources: open.sources,
          body: open.body,
        }),
        decrypted_locally: true,
      };
    }
    const reason =
      state.kind === "locked"
        ? state.reason
        : "WIKI_SEAL_PASSPHRASE not set";
    return { ...page, locked_reason: reason };
  }

  async readPage(slug: string): Promise<PageView> {
    const page = parsePageView(
      await this.apiGet(`/wiki/page/${encodeURIComponent(slug)}`),
      slug
    );
    if (!page.sealed) return page;
    const state = await this.sealingState();
    if (state.kind === "unlocked") {
      try {
        if (page.envelope) {
          const payload = parseEnvelopePayload(
            decryptEnvelope(state.dek, slug, page.envelope)
          );
          return {
            ...page,
            title: payload.title,
            tags: payload.tags,
            sources: payload.sources,
            body: payload.body,
            decrypted_locally: true,
          };
        }
        const bundle = await this.sealedBundle();
        const hit = bundle.get(slug);
        if (hit) {
          return {
            ...page,
            title: hit.title,
            tags: hit.tags,
            sources: hit.sources,
            body: hit.body,
            decrypted_locally: true,
          };
        }
      } catch {
        // Fall through to locked placeholder if decrypt fails.
      }
    }
    const reason =
      state.kind === "locked"
        ? state.reason
        : "WIKI_SEAL_PASSPHRASE not set";
    return {
      ...page,
      title: "Sealed page",
      body: "",
      tags: [],
      sources: [],
      locked_reason: reason,
    };
  }

  async replacePage(args: {
    slug: string;
    markdown: string;
  }): Promise<{ report: string; result: ReplacePageResult }> {
    await this.requireOwnerCapability();
    const state = await this.sealingState();
    const sealed = this.maybeSealOutgoing(
      state,
      args.markdown,
      args.slug,
      "replace_page"
    );
    const result = parseReplacePageResult(
      await this.request("PUT", `/owner/page/${encodeURIComponent(args.slug)}`, {
        markdown: sealed.content,
      })
    );
    this.invalidateBundle();
    return { report: formatReplacePageReport(result), result };
  }

  async appendToPage(args: {
    slug: string;
    text: string;
    separator?: string;
  }): Promise<{ report: string; result: AppendToPageResult }> {
    await this.requireOwnerCapability();
    const raw = parsePageRaw(
      await this.request(
        "GET",
        `/owner/page/${encodeURIComponent(args.slug)}/raw`
      )
    );
    const state = await this.sealingState();
    let outgoing = joinAppendedText(raw.markdown, args.text, args.separator);
    let resultTitle = raw.title;
    if (isSealedMarkdown(raw.markdown)) {
      if (state.kind === "locked") {
        throw lockedSealedWriteError(state.reason, "append_to_page");
      }
      if (state.kind === "not_enabled") {
        throw new Error(
          "Cannot append_to_page: page is sealed but sealing is not enabled on the manifest."
        );
      }
      const open = unsealPage(state.dek, args.slug, raw.markdown);
      const newBody = joinAppendedText(open.body, args.text, args.separator);
      const today = utcDateStamp();
      outgoing = sealPage(state.dek, {
        slug: args.slug,
        type: open.type || "overview",
        tier: open.tier || raw.tier,
        created: open.created || today,
        updated: today,
        title: open.title,
        tags: open.tags,
        sources: open.sources,
        body: newBody,
      });
      resultTitle = open.title;
    } else if (isSealedTier(state, raw.tier || frontmatterTier(raw.markdown))) {
      if (state.kind === "locked") {
        throw lockedSealedWriteError(state.reason, "append_to_page");
      }
      if (state.kind === "unlocked") {
        const { fm, body } = parsePageDocument(raw.markdown);
        const newBody = joinAppendedText(body, args.text, args.separator);
        const today = utcDateStamp();
        const type = fm.type || SECTION_TO_TYPE[raw.section] || "overview";
        outgoing = sealPage(state.dek, {
          slug: args.slug,
          type,
          tier: fm.tier || raw.tier,
          created: fm.created || today,
          updated: today,
          title: fm.title || raw.title,
          tags: fm.tags,
          sources: fm.sources,
          body: newBody,
        });
        resultTitle = fm.title || raw.title;
      }
    }
    const replaced = parseReplacePageResult(
      await this.request("PUT", `/owner/page/${encodeURIComponent(args.slug)}`, {
        markdown: outgoing,
      })
    );
    this.invalidateBundle();
    const result: AppendToPageResult = {
      slug: args.slug,
      old_size: raw.markdown.length,
      new_size: replaced.size,
      rel_path: replaced.rel_path,
      title: resultTitle || replaced.title,
      tier: replaced.tier,
      sync: replaced.sync,
    };
    return { report: formatAppendToPageReport(result), result };
  }

  async setPageTier(args: {
    slug: string;
    tier: WikiTier;
  }): Promise<{ report: string; result: SetPageTierResult }> {
    await this.requireOwnerCapability();
    const result = parseSetPageTierResult(
      await this.request(
        "PATCH",
        `/owner/page/${encodeURIComponent(args.slug)}/tier`,
        { tier: args.tier }
      )
    );
    this.invalidateBundle();
    return { report: formatSetPageTierReport(result), result };
  }

  async deletePage(
    slug: string
  ): Promise<{ report: string; result: DeletePageResult }> {
    await this.requireOwnerCapability();
    const result = parseDeletePageResult(
      await this.request("DELETE", `/owner/page/${encodeURIComponent(slug)}`)
    );
    this.invalidateBundle();
    return { report: formatDeletePageReport(result), result };
  }

  async listPages(): Promise<ManifestSnapshot> {
    const manifest = await this.fetchManifest();
    const state = await this.sealingState();
    if (state.kind !== "unlocked") return manifest;
    const bundle = await this.sealedBundle();
    const pages = manifest.pages.map((page) => {
      if (page.title !== "Sealed page" && page.sealed !== true) return page;
      const hit = bundle.get(page.slug);
      if (!hit) return page;
      return {
        ...page,
        title: hit.title,
        tags: hit.tags,
        excerpt: oneLineExcerpt(hit.body),
      };
    });
    return { ...manifest, pages };
  }

  async searchWiki(
    query: string,
    limit = 10
  ): Promise<{ results: SearchHit[] }> {
    const serverResults = parseSearchResults(
      await this.apiGet(`/wiki/search?q=${encodeURIComponent(query)}`)
    );
    const state = await this.sealingState();
    if (state.kind !== "unlocked") {
      return { results: serverResults.slice(0, limit) };
    }
    const bundle = await this.sealedBundle();
    const localPages = [...bundle.values()].map((p) => ({
      slug: p.slug,
      title: p.title,
      body: p.body,
    }));
    const localHits = localSearch(localPages, query, limit);
    const localMapped: SearchHit[] = localHits.map((hit) => {
      const meta = bundle.get(hit.slug);
      return {
        slug: hit.slug,
        title: hit.title,
        section: meta?.section ?? "",
        tier: meta?.tier ?? "",
        excerpt: hit.snippet,
        score: hit.score,
        decrypted_locally: true,
      };
    });
    const seen = new Set<string>();
    const merged: SearchHit[] = [];
    const combined = [...localMapped, ...serverResults].sort(
      (a, b) => b.score - a.score
    );
    for (const hit of combined) {
      if (seen.has(hit.slug)) continue;
      seen.add(hit.slug);
      merged.push(hit);
      if (merged.length >= limit) break;
    }
    return { results: merged };
  }

  async queryWiki(question: string): Promise<QueryWikiResult> {
    const result = parseQueryWiki(
      await this.apiPost("/wiki/query", { question })
    );
    const state = await this.sealingState();
    if (state.kind !== "unlocked") return result;
    const bundle = await this.sealedBundle();
    const localPages = [...bundle.values()].map((p) => ({
      slug: p.slug,
      title: p.title,
      body: p.body,
    }));
    const localHits = localSearch(localPages, question, 3);
    result.sealed_context = localHits.map((hit) => {
      const body = bundle.get(hit.slug)?.body ?? hit.snippet;
      return {
        title: hit.title,
        snippet: oneLineExcerpt(body, 400),
      };
    });
    return result;
  }

  async sealInit(args: {
    tiers?: string[];
    force?: boolean;
  }): Promise<{ report: string; keyring: Keyring }> {
    await this.requireOwnerCapability();
    const passphrase = resolveSealPassphrase(this.env);
    if (!passphrase) {
      throw new Error(
        "seal_init requires WIKI_SEAL_PASSPHRASE in the MCP env. The passphrase never leaves this process; losing it means sealed pages cannot be recovered."
      );
    }
    const tiers = args.tiers && args.tiers.length > 0 ? args.tiers : ["private"];
    for (const tier of tiers) {
      if (!SEALABLE_TIERS.has(tier)) {
        throw new Error(
          `seal_init: tier "${tier}" cannot be sealed (allowed: recruiter, friend, private)`
        );
      }
    }
    const keyring = generateKeyring(passphrase, tiers);
    await this.request("PUT", "/owner/sealing", {
      keyring,
      force: Boolean(args.force),
    });
    this.invalidateSealing();
    return {
      report: `Sealing initialized for tiers: ${tiers.join(", ")}. Keyring stored on the server. Set WIKI_SEAL_PASSPHRASE in the MCP env to unlock. The server operator cannot recover pages if the passphrase is lost. Server-side orchestrator is disabled on sealed wikis.`,
      keyring,
    };
  }

  async sealDisable(): Promise<{ report: string }> {
    await this.requireOwnerCapability();
    await this.request("DELETE", "/owner/sealing");
    this.invalidateSealing();
    return {
      report:
        "Sealing disabled (keyring tiers cleared). Already-sealed pages stay encrypted and can still be opened with the passphrase. New writes to those tiers are no longer forced through sealing until seal_init is run again.",
    };
  }

  async sealPageBySlug(slug: string): Promise<{ report: string; result: ReplacePageResult }> {
    await this.requireOwnerCapability();
    const state = await this.sealingState();
    if (state.kind === "not_enabled") {
      throw new Error("seal_page: sealing is not enabled. Call seal_init first.");
    }
    if (state.kind === "locked") {
      throw lockedSealedWriteError(state.reason, "seal_page");
    }
    const raw = parsePageRaw(
      await this.request("GET", `/owner/page/${encodeURIComponent(slug)}/raw`)
    );
    if (isSealedMarkdown(raw.markdown)) {
      const result: ReplacePageResult = {
        ok: true,
        slug,
        rel_path: raw.rel_path,
        tier: raw.tier,
        title: raw.title,
        size: raw.markdown.length,
      };
      return { report: `Page ${slug} is already sealed.`, result };
    }
    const { fm, body } = parsePageDocument(raw.markdown);
    const tier = fm.tier || raw.tier;
    if (!isSealedTier(state, tier)) {
      throw new Error(
        `seal_page: page ${slug} is at tier=${tier}, which is not a sealed tier (${state.tiers.join(", ")}).`
      );
    }
    const today = utcDateStamp();
    const markdown = sealPage(state.dek, {
      slug,
      type: fm.type || SECTION_TO_TYPE[raw.section] || "overview",
      tier,
      created: fm.created || today,
      updated: today,
      title: fm.title || raw.title || slug,
      tags: fm.tags,
      sources: fm.sources,
      body,
    });
    const result = parseReplacePageResult(
      await this.request("PUT", `/owner/page/${encodeURIComponent(slug)}`, {
        markdown,
      })
    );
    this.invalidateBundle();
    return {
      report: `Sealed page ${slug} locally (slug unchanged) and PUT ciphertext.`,
      result,
    };
  }

  async unsealPageBySlug(
    slug: string,
    tier: WikiTier
  ): Promise<{ report: string; result: ReplacePageResult }> {
    await this.requireOwnerCapability();
    const state = await this.sealingState();
    if (state.kind === "not_enabled") {
      throw new Error("unseal_page: sealing is not enabled.");
    }
    if (state.kind === "locked") {
      throw lockedSealedWriteError(state.reason, "unseal_page");
    }
    if (isSealedTier(state, tier)) {
      throw new Error(
        `unseal_page: target tier ${tier} is still sealed. Choose a non-sealed tier.`
      );
    }
    const raw = parsePageRaw(
      await this.request("GET", `/owner/page/${encodeURIComponent(slug)}/raw`)
    );
    if (!isSealedMarkdown(raw.markdown)) {
      throw new Error(`unseal_page: page ${slug} is not sealed.`);
    }
    const open = unsealPage(state.dek, slug, raw.markdown);
    const markdown = renderPlaintextPage({
      type: open.type,
      title: open.title,
      tier,
      created: open.created,
      updated: utcDateStamp(),
      tags: open.tags,
      sources: open.sources,
      body: open.body,
    });
    const result = parseReplacePageResult(
      await this.request("PUT", `/owner/page/${encodeURIComponent(slug)}`, {
        markdown,
      })
    );
    this.invalidateBundle();
    return {
      report: `Unsealed page ${slug} to tier=${tier} as plaintext.`,
      result,
    };
  }

  async writebackSpec(): Promise<string> {
    const text = await this.request("GET", "/llm-writeback-spec", undefined, {
      responseType: "text",
    });
    if (typeof text !== "string") {
      throw new Error("writeback_spec: response was not text");
    }
    return text;
  }
}
