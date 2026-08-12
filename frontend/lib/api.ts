// Browser-side API client. All requests proxy through Next.js /api/backend/*
// (configured in next.config.mjs) so we don't fight CORS during local dev.

/**
 * Durability verdict the backend stamps on every content-create response so
 * the UI can warn when a write won't actually reach a git remote / hosted
 * site. See backend `persistence.describe_sync`.
 */
export type SyncVerdict = {
  will_sync: boolean;
  mode: "global" | "tenant" | "local_only";
  remote: string | null;
  branch?: string;
  reason?: string;
  detail: string;
};

export type PageSummary = {
  slug: string;
  title: string;
  section: string;
  type: string;
  tier: "public" | "recruiter" | "friend" | "private";
  created: string | null;
  updated: string | null;
  tags: string[];
  excerpt: string;
  word_count: number;
  rel_path: string;
};

export type PageFull = PageSummary & {
  body: string;
  rendered_body: string;
  sources: string[];
  links_out: string[];
  links_in: string[];
  links_out_resolved: { slug: string; title: string; section: string }[];
  links_in_resolved: { slug: string; title: string; section: string }[];
};

export type Manifest = {
  wiki_title: string;
  generated_at: string;
  viewer_tier: string;
  viewer_is_owner: boolean;
  page_count: number;
  sections: Record<string, number>;
  pages: PageSummary[];
};

export type QueryRetrievalDebug = {
  strategy: string;
  hops: number;
  anchors: { slug: string; title: string; score: number }[];
  expanded: { slug: string; title: string }[];
  total_pages_in_context: number;
  edge_count: number;
};

export type QueryResponse = {
  question: string;
  viewer_tier: string;
  answer: string;
  citations: { slug: string; title: string }[];
  backend: "anthropic" | "openai" | "keyword";
  model: string | null;
  used_pages: string[];
  retrieval?: QueryRetrievalDebug;
};

export type SearchResponse = {
  query: string;
  viewer_tier: string;
  results: (PageSummary & { score: number })[];
};

export type LintReport = {
  totals: {
    pages: number;
    by_section: Record<string, number>;
    by_tier: Record<string, number>;
  };
  orphans: { slug: string; title: string; section: string }[];
  stale: { slug: string; title: string; age_days: number; last_dated: string }[];
  missing_pages: { title: string; mentions: number }[];
  broken_provenance: { slug: string; title: string; missing_source: string }[];
  missing_index_entries: { slug?: string; title?: string; section?: string; reason?: string }[];
  generated_at: string;
};

const TOKEN_KEY = "llmwiki:ownerToken";

export function getOwnerToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setOwnerToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

const PREVIEW_KEY = "wiki.preview_as";

export type PreviewAs = "owner" | "friend" | "recruiter" | "public";

export function getPreviewAs(): PreviewAs {
  if (typeof window === "undefined") return "owner";
  const v = window.localStorage.getItem(PREVIEW_KEY);
  if (v === "public" || v === "recruiter" || v === "friend") return v;
  return "owner";
}

export function setPreviewAs(value: PreviewAs) {
  if (typeof window === "undefined") return;
  if (value === "owner") window.localStorage.removeItem(PREVIEW_KEY);
  else window.localStorage.setItem(PREVIEW_KEY, value);
  // Notify anything listening (ViewerBadge, page lists) to refresh.
  window.dispatchEvent(new Event("wiki:preview-as-change"));
}

// ---- Hosted / multi-tenant mode ----------------------------------------
//
// In single-tenant (OSS self-host) mode the backend serves the wiki at
// /wiki/* (proxied here as /api/backend/wiki/*). In the hosted multi-tenant
// product every wiki call is scoped under /t/<tenant>/. `isHostedMode()`
// reads a public env var baked at build time (see next.config.mjs) so the
// client can branch deterministically.

export function isHostedMode(): boolean {
  return process.env.NEXT_PUBLIC_HOSTED_MODE === "1";
}

/**
 * Base URL the browser uses for backend API calls.
 *
 * - **Single-tenant / dev**: relative ``${apiBase()}`` — Next.js rewrites
 *   this to ``NEXT_PUBLIC_BACKEND_URL`` (or ``http://localhost:8000``)
 *   server-side. No CORS, no cookies cross domains.
 * - **Hosted (multi-tenant)**: absolute URL to the backend, typically
 *   ``https://api.portablellm.wiki``. Session cookies set by the GitHub
 *   OAuth callback live on that subdomain; calling through the Vercel
 *   rewrite would drop them (the rewrite swaps the Host header, so the
 *   browser-set cookie for ``portablellm.wiki`` would never travel to
 *   ``api.portablellm.wiki``). Direct calls + CORS-with-credentials are
 *   the cleanest fix.
 *
 * If ``NEXT_PUBLIC_BACKEND_URL`` is unset in hosted mode we fall back to
 * the rewrite so dev/preview deploys can still smoke-test the UI.
 */
export function apiBase(): string {
  if (isHostedMode() && process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL.replace(/\/+$/, "");
  }
  return "/api/backend";
}

/**
 * Build the tenant URL segment for wiki-scoped routes.
 *
 * Non-hosted mode → always "" (routes look like /api/backend/wiki/...).
 * Hosted mode     → "/t/<tenantId>" (routes look like /api/backend/t/<id>/wiki/...).
 *
 * Throws in hosted mode if no tenantId is supplied — every wiki call in
 * the hosted product is tenant-scoped, so a missing id is a caller bug
 * that should surface loudly rather than silently 404.
 */
export function tenantPrefix(tenantId?: string): string {
  if (!isHostedMode()) return "";
  if (!tenantId) {
    throw new Error("tenantPrefix: tenantId is required in hosted mode");
  }
  return `/t/${tenantId}`;
}

/**
 * Full URL prefix for any wiki/owner-scoped API call.
 *
 * Use this instead of hardcoding ``${apiBase()}`` for ``/wiki/*`` and
 * ``/owner/*`` endpoints — that way every call automatically picks up
 * the tenant prefix in hosted mode and stays bare in single-tenant mode.
 *
 * Examples (single-tenant): ``${wikiBase()}/wiki/manifest.json``
 * Examples (hosted):        ``${wikiBase("cary")}/wiki/manifest.json``
 *                                 → ``${apiBase()}/t/cary/wiki/manifest.json``
 */
export function wikiBase(tenantId?: string): string {
  return `${apiBase()}${tenantPrefix(tenantId)}`;
}

/**
 * Owner-console / owner-route headers.
 *
 * Never attaches ``X-Preview-As``. Preview-as is a browse/audit lens;
 * sending it on owner bootstrap makes ``viewer_is_owner: false`` and
 * traps owners out of ``/owner`` (they can't reach the panel that
 * clears the preview). Writes and owner reads must see the real owner.
 */
function ownerHeaders(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const tok = getOwnerToken();
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return { ...h, ...(extra as Record<string, string> | undefined) };
}

/**
 * Browse/ask/graph headers — may include ``X-Preview-As`` from
 * ``wiki.preview_as`` so owners can audit the wiki as public /
 * recruiter / friend. Do not use for owner-console verify or
 * ``/owner/*`` endpoints.
 */
function browseHeaders(extra?: HeadersInit): HeadersInit {
  const h = { ...(ownerHeaders(extra) as Record<string, string>) };
  const preview = getPreviewAs();
  if (preview !== "owner") h["X-Preview-As"] = preview;
  return h;
}

/**
 * Wrapper around ``fetch`` that always sends credentials.
 *
 * In hosted mode the frontend lives at portablellm.wiki and the API at
 * api.portablellm.wiki — cross-origin, so the default
 * ``credentials: "same-origin"`` would drop the session cookie. With
 * ``credentials: "include"`` the cookie travels, the backend resolves
 * the signed-in user, and ``require_owner`` / ``current_viewer``
 * recognize the user as the owner of their own tenant without needing
 * a bearer token in localStorage.
 *
 * In single-tenant (OSS) mode there's no cross-origin issue and no
 * session cookie to send — this is a no-op for those installs.
 *
 * Owner-route calls additionally include the legacy
 * ``Authorization: Bearer <OWNER_TOKEN>`` header via ``ownerHeaders()``
 * so OSS self-hosters using a localStorage token still work unchanged.
 */
async function apiFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, { credentials: "include", ...init });
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data?.detail) detail = data.detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch the wiki manifest.
 *
 * By default this is a browse call and may send ``X-Preview-As``.
 * Pass ``{ asOwner: true }`` for owner-console bootstrap / verify —
 * preview must not defeat ownership checks.
 */
export async function fetchManifest(
  tenant?: string,
  opts?: { asOwner?: boolean },
): Promise<Manifest> {
  return asJson<Manifest>(
    await apiFetch(`${wikiBase(tenant)}/wiki/manifest.json`, {
      headers: opts?.asOwner ? ownerHeaders() : browseHeaders(),
      cache: "no-store",
    })
  );
}

export async function fetchPage(slug: string, tenant?: string): Promise<PageFull> {
  return asJson<PageFull>(
    await apiFetch(
      `${wikiBase(tenant)}/wiki/page/${encodeURIComponent(slug)}`,
      { headers: browseHeaders(), cache: "no-store" }
    )
  );
}

export async function searchWiki(q: string, tenant?: string): Promise<SearchResponse> {
  return asJson<SearchResponse>(
    await apiFetch(
      `${wikiBase(tenant)}/wiki/search?q=${encodeURIComponent(q)}`,
      { headers: browseHeaders(), cache: "no-store" }
    )
  );
}

export async function askWiki(question: string, tenant?: string): Promise<QueryResponse> {
  return asJson<QueryResponse>(
    await apiFetch(`${wikiBase(tenant)}/wiki/query`, {
      method: "POST",
      headers: browseHeaders(),
      body: JSON.stringify({ question }),
    })
  );
}

export async function ownerReload(tenant?: string) {
  return asJson<{ ok: boolean; page_count: number }>(
    await apiFetch(`${wikiBase(tenant)}/owner/reload`, { method: "POST", headers: ownerHeaders() })
  );
}

export async function ownerLint(tenant?: string): Promise<LintReport> {
  return asJson<LintReport>(
    await apiFetch(`${wikiBase(tenant)}/owner/lint`, { method: "POST", headers: ownerHeaders() })
  );
}

export async function ownerSetTier(slug: string, tier: PageSummary["tier"], tenant?: string) {
  return asJson<{ ok: boolean; slug: string; tier: string; sync?: SyncVerdict }>(
    await apiFetch(`${wikiBase(tenant)}/owner/page/${encodeURIComponent(slug)}/tier`, {
      method: "PATCH",
      headers: ownerHeaders(),
      body: JSON.stringify({ tier }),
    })
  );
}

export type IngestResult = {
  ok: boolean;
  rel_path: string;
  size: number;
  orchestrator: {
    tracking_id?: string;
    status?: string;
    started_at?: string;
    error?: string;
  } | null;
  /** Durability verdict — present on all content-create responses. */
  sync?: SyncVerdict;
};

export async function ownerIngest(input: {
  slug: string;
  content: string;
  subdir?: "conversations" | "articles" | "meetings" | "assets";
  note?: string;
  run_orchestrator?: boolean;
}, tenant?: string): Promise<IngestResult> {
  return asJson<IngestResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/ingest`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        ...input,
        subdir: input.subdir ?? "conversations",
        run_orchestrator: !!input.run_orchestrator,
      }),
    })
  );
}

// ---- Import wizard (cold-start wiki bootstrap) ----

export type ImportKind = "resume" | "linkedin" | "bio" | "freeform";

export type ImportResult = {
  ok: boolean;
  rel_path: string;
  size: number;
  /** Slugs that already existed before the import job started. The wizard
   * polls the manifest after the job completes and shows the diff. */
  pages_before: string[];
  orchestrator: {
    tracking_id?: string;
    status?: string;
    started_at?: string;
    error?: string;
  };
  /** Hosted-mode synchronous fallback: when Puppetmaster isn't available
   * the backend invokes ``direct_drafter.draft_starter_pages`` instead
   * and returns the result inline. Either ``pages`` (success path) or
   * ``error`` + ``kind`` (failure path). The wizard checks this BEFORE
   * trying to poll a tracking_id, since the tracking_id will be absent
   * whenever drafted is present. */
  drafted?: {
    pages_created?: number;
    pages?: Array<{ slug: string; title: string; section: string; type: string }>;
    backend?: string;
    model?: string;
    warnings?: string[];
    error?: string;
    kind?: "no_llm_configured" | "draft_failed";
  } | null;
};

export type ExtractPdfResult = {
  ok: boolean;
  text: string;
  page_count: number;
  word_count: number;
  source_filename: string;
};

export async function ownerExtractPdf(file: File, tenant?: string): Promise<ExtractPdfResult> {
  const fd = new FormData();
  fd.append("file", file);
  const tok = getOwnerToken();
  const r = await apiFetch(`${wikiBase(tenant)}/owner/import/extract-pdf`, {
    method: "POST",
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    body: fd,
  });
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const j = await r.json();
      detail = (j as { detail?: string }).detail ?? detail;
    } catch {
      // fall through
    }
    throw new Error(`PDF extract failed: ${detail}`);
  }
  return (await r.json()) as ExtractPdfResult;
}

export async function ownerImport(input: {
  kind: ImportKind;
  content: string;
  label?: string;
}, tenant?: string): Promise<ImportResult> {
  return asJson<ImportResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/import`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify(input),
    }),
  );
}

// ---- Persistence (git-backed wiki sync) ----

export type PersistenceStatus = {
  enabled: boolean;
  remote: string | null;
  branch: string;
  push_delay_s: number;
  user_name: string;
  user_email: string;
  commits_made: number;
  pushes_made: number;
  /** Unix timestamps (seconds) — null if never */
  last_flush_attempt: number | null;
  last_flush_ok: number | null;
  last_error: string | null;
  pending_message_count: number;
  timer_scheduled: boolean;
};

export type PersistenceFlushResult = {
  committed: boolean;
  pushed: boolean;
  messages: string[];
  commit_summary?: string;
  skipped?: string;
  error?: string;
};

export async function ownerPersistenceStatus(tenant?: string): Promise<PersistenceStatus> {
  return asJson<PersistenceStatus>(
    await apiFetch(`${wikiBase(tenant)}/owner/persistence`, {
      headers: ownerHeaders(),
      cache: "no-store",
    }),
  );
}

export async function ownerPersistenceFlush(tenant?: string): Promise<PersistenceFlushResult> {
  return asJson<PersistenceFlushResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/persistence/flush`, {
      method: "POST",
      headers: ownerHeaders(),
    }),
  );
}

// ---- Capture (Frictionless ingest) ----

export type CaptureBackend =
  | "anthropic"
  | "openai-vision"
  | "openai-whisper"
  | "raw"
  | null;

export type CaptureConfig = {
  image: { available: boolean; backend: CaptureBackend; model: string | null };
  audio: { available: boolean; backend: CaptureBackend; model: string | null };
  paste: { available: boolean; backend: CaptureBackend; model: string | null };
};

export type CaptureResult = {
  ok: boolean;
  rel_path: string;
  asset_rel_path?: string | null;
  size: number;
  transcribed_by: CaptureBackend;
  text_preview: string;
  orchestrator:
    | null
    | {
        tracking_id?: string;
        status?: string;
        started_at?: string;
        error?: string;
      };
};

// ---- Share tokens (mintable, revocable) ----

// All four tiers are mintable. The owner-facing UI splits "share with
// others" (public/recruiter/friend — frontend/components/
// ShareTokensPanel.tsx) from the "personal LLM URL" flow (private —
// frontend/components/PersonalLlmUrlPanel.tsx), so different copy +
// warnings can sit on each. Backend-side both flows POST here.
export type ShareTokenTier = "public" | "recruiter" | "friend" | "private";

export type ShareTokenInfo = {
  id: string;
  label: string;
  tier: ShareTokenTier;
  created_at: string;
  expires_at: string | null;
  hits: number;
  last_used_at: string | null;
  revoked: boolean;
  revoked_at: string | null;
};

export type MintedShareToken = ShareTokenInfo & {
  token: string; // plaintext — shown ONCE, save it now
};

export async function ownerListShareTokens(tenant?: string): Promise<{ tokens: ShareTokenInfo[] }> {
  return asJson<{ tokens: ShareTokenInfo[] }>(
    await apiFetch(`${wikiBase(tenant)}/owner/share-tokens`, {
      headers: ownerHeaders(),
      cache: "no-store",
    })
  );
}

export async function ownerMintShareToken(input: {
  label: string;
  tier: ShareTokenTier;
  expires_at?: string | null;
}, tenant?: string): Promise<MintedShareToken> {
  return asJson<MintedShareToken>(
    await apiFetch(`${wikiBase(tenant)}/owner/share-tokens`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify(input),
    })
  );
}

export async function ownerRevokeShareToken(id: string, tenant?: string) {
  return asJson<{ ok: boolean; id: string }>(
    await apiFetch(`${wikiBase(tenant)}/owner/share-tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: ownerHeaders(),
    })
  );
}

export async function ownerCaptureConfig(tenant?: string): Promise<CaptureConfig> {
  return asJson<CaptureConfig>(
    await apiFetch(`${wikiBase(tenant)}/owner/capture/config`, {
      headers: ownerHeaders(),
      cache: "no-store",
    })
  );
}

export async function ownerCapturePaste(input: {
  content: string;
  label: string;
  subdir?: "conversations" | "articles" | "meetings" | "assets";
  run_orchestrator?: boolean;
}, tenant?: string): Promise<CaptureResult> {
  return asJson<CaptureResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/capture/paste`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        content: input.content,
        label: input.label,
        subdir: input.subdir ?? "conversations",
        run_orchestrator: !!input.run_orchestrator,
      }),
    })
  );
}

// ---- LLM writeback (structured capture) ----
//
// The writeback flow: user has a chat with ChatGPT/Claude that ends up
// producing useful structured content. The LLM is told to output JSON
// matching the spec at /llm-writeback-spec. The user pastes that JSON
// into the "from LLM" tab in /capture, which calls this endpoint.
//
// We do NOT run a second LLM pass server-side — the validation is
// deterministic and the LLM the user worked with already shaped the
// content. See backend/app/main.py::owner_capture_structured.

export type WritebackPageInput = {
  slug?: string;
  title: string;
  section: "entities" | "concepts" | "decisions" | "projects" | "queries";
  tags?: string[];
  tier?: "public" | "recruiter" | "friend" | "private"; // ignored — server forces private
  body: string;
};

export type WritebackWritten = {
  rel_path: string;
  title: string;
  section: string;
  slug: string;
  tier: "public" | "recruiter" | "friend" | "private";
};

export type WritebackConflict = {
  slug: string;
  wrote_as: string;
};

export type WritebackResult = {
  ok: boolean;
  written: WritebackWritten[];
  conflicts: WritebackConflict[];
  errors: string[];
  session_label: string;
  page_count: number;
};

export async function ownerCaptureStructured(
  input: {
    session_label: string;
    pages: WritebackPageInput[];
    force_overwrite?: boolean;
  },
  tenant?: string
): Promise<WritebackResult> {
  return asJson<WritebackResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/capture/structured`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        session_label: input.session_label,
        pages: input.pages,
        force_overwrite: !!input.force_overwrite,
      }),
    })
  );
}

/** Returns the absolute URL an LLM should fetch to learn the writeback
 *  schema. We expose this so the /capture UI can render a copy-able
 *  prompt that already contains the right URL. */
export function llmWritebackSpecUrl(): string {
  const base = (apiBase() || "").replace(/\/$/, "");
  return `${base}/llm-writeback-spec`;
}

// ---- Verbatim capture ----
//
// The trusted-input cousin of ownerCaptureStructured. User pastes a
// fully-formed markdown file (with YAML frontmatter) and the backend
// writes it to wiki/<section>/<slug>.md with the bytes preserved
// exactly. Critical differences from the other capture endpoints:
//
//   * No LLM in the loop — the user authored the content.
//   * Tier is RESPECTED (not force-clamped to private). The user gets
//     editorial control because they wrote the page themselves.
//   * Section is derived deterministically from `type:` frontmatter.
//   * Filename comes from explicit slug, frontmatter slug, or title
//     (in that priority order).
//
// Use case: user drafted a page in chat / their editor and wants to
// save it verbatim. The /capture page exposes this as the "verbatim"
// tab; ownerCapturePaste remains the right path for raw text dumps.

export type VerbatimWritten = {
  rel_path: string;
  title: string;
  section: "entities" | "concepts" | "decisions" | "projects" | "queries" | "sources";
  slug: string;
  tier: "public" | "recruiter" | "friend" | "private";
  page_type: "entity" | "concept" | "decision" | "project" | "query" | "source";
};

export type VerbatimConflict = {
  /** Filename the new page was written under because the canonical
   *  ``<slug>.md`` was already on disk. e.g. ``my-page-verbatim-2026-05-26.md``. */
  wrote_as: string;
};

export type VerbatimCaptureResult = {
  ok: boolean;
  written: VerbatimWritten;
  /** Set when the canonical slug already existed and we wrote a
   *  suffixed sibling instead of clobbering. Null on the happy path. */
  conflict: VerbatimConflict | null;
  /** True iff ``force_overwrite=true`` was set AND there was an
   *  existing file to overwrite. Lets the UI render a "replaced
   *  previous version" notice that's distinct from "first write." */
  overwrote_existing: boolean;
  /** Durability verdict — present on all content-create responses. */
  sync?: SyncVerdict;
};

export async function ownerCaptureVerbatim(
  input: {
    content: string;
    /** Optional explicit slug override. Beats both the frontmatter
     *  ``slug:`` field and the title-derived default. */
    slug?: string;
    /** Default false. When true, an existing file at the target path
     *  is overwritten (no -verbatim-<date> suffix). Use sparingly —
     *  this destroys history that isn't yet committed. */
    force_overwrite?: boolean;
  },
  tenant?: string
): Promise<VerbatimCaptureResult> {
  return asJson<VerbatimCaptureResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/capture/verbatim`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        content: input.content,
        slug: input.slug,
        force_overwrite: !!input.force_overwrite,
      }),
    })
  );
}

// Multipart upload — file + form fields. Don't set Content-Type; the
// browser fills in the multipart boundary automatically. Capture is
// always owner-mode (preview-as doesn't apply to owner-only writes).
function multipartHeaders(): HeadersInit {
  const h: Record<string, string> = {};
  const tok = getOwnerToken();
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return h;
}

export async function ownerCaptureImage(input: {
  file: Blob;
  filename: string;
  label: string;
  subdir?: "conversations" | "articles" | "meetings" | "assets";
  run_orchestrator?: boolean;
}, tenant?: string): Promise<CaptureResult> {
  const fd = new FormData();
  fd.append("file", input.file, input.filename);
  fd.append("label", input.label);
  fd.append("subdir", input.subdir ?? "articles");
  fd.append("run_orchestrator", input.run_orchestrator ? "true" : "false");
  return asJson<CaptureResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/capture/image`, {
      method: "POST",
      headers: multipartHeaders(),
      body: fd,
    })
  );
}

export async function ownerCaptureAudio(input: {
  file: Blob;
  filename: string;
  label: string;
  subdir?: "conversations" | "articles" | "meetings" | "assets";
  run_orchestrator?: boolean;
}, tenant?: string): Promise<CaptureResult> {
  const fd = new FormData();
  fd.append("file", input.file, input.filename);
  fd.append("label", input.label);
  fd.append("subdir", input.subdir ?? "meetings");
  fd.append("run_orchestrator", input.run_orchestrator ? "true" : "false");
  return asJson<CaptureResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/capture/audio`, {
      method: "POST",
      headers: multipartHeaders(),
      body: fd,
    })
  );
}

export type TrackedJob = {
  tracking_id: string;
  kind: string;
  raw_path: string;
  note: string;
  started_at: string;
  cwd: string;
  log_path: string;
  status: "running" | "done" | "error";
  pid: number | null;
  puppetmaster_job_id: string | null;
  ended_at: string | null;
  exit_code: number | null;
  summary: string | null;
};

export async function ownerListJobs(tenant?: string) {
  return asJson<{ jobs: TrackedJob[] }>(
    await apiFetch(`${wikiBase(tenant)}/owner/jobs`, { headers: ownerHeaders(), cache: "no-store" })
  );
}

// ===== chat-style query =====

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatResponse = {
  message: string;
  viewer_tier: string;
  answer: string;
  citations: { slug: string; title: string }[];
  backend: "anthropic" | "openai" | "keyword";
  model: string | null;
  used_pages: string[];
  retrieval: {
    strategy: string;
    hops: number;
    anchors: { slug: string; title: string; score: number }[];
    expanded: { slug: string; title: string }[];
    total_pages_in_context: number;
    edge_count: number;
  } | null;
};

export async function chatWithWiki(
  message: string,
  history: ChatTurn[],
  tenant?: string,
): Promise<ChatResponse> {
  return asJson<ChatResponse>(
    await apiFetch(`${wikiBase(tenant)}/wiki/chat`, {
      method: "POST",
      headers: { ...browseHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    }),
  );
}

// ===== streaming chat =====

export type ChatStreamEvent =
  | {
      type: "start";
      backend: "anthropic" | "openai" | "keyword";
      model: string | null;
      viewer_tier: string;
      citations: { slug: string; title: string }[];
      used_pages: string[];
      retrieval: ChatResponse["retrieval"];
    }
  | { type: "token"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * Stream a chat turn from /wiki/chat/stream. Calls `onEvent` for each
 * parsed SSE event. Returns a Promise that resolves when the stream
 * ends (either a `done` event arrives or the connection closes).
 *
 * The signal supports user cancellation — e.g. a "stop" button on a
 * long generation aborts the underlying fetch.
 *
 * EventSource doesn't support POST, so we use fetch + a ReadableStream
 * reader and parse SSE frames manually. SSE frames are separated by
 * `\n\n`; each frame's `data:` payload is the JSON event.
 */
export async function streamChatWithWiki(
  message: string,
  history: ChatTurn[],
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  tenant?: string,
): Promise<void> {
  const r = await apiFetch(`${wikiBase(tenant)}/wiki/chat/stream`, {
    method: "POST",
    headers: {
      ...browseHeaders(),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message, history }),
    signal,
  });
  if (!r.ok || !r.body) {
    let detail = `HTTP ${r.status}`;
    try {
      const txt = await r.text();
      detail = txt.slice(0, 400) || detail;
    } catch {
      // fall through
    }
    throw new Error(`stream failed: ${detail}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process any complete frames in the buffer.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as ChatStreamEvent;
            onEvent(evt);
            if (evt.type === "done") return;
          } catch {
            // Best-effort: skip malformed frames rather than aborting
            // the whole stream. The next valid frame keeps the UI alive.
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released — ignore.
    }
  }
}

// ===== bulk capture actions =====

export type BulkRawResult = {
  action: "delete" | "reingest";
  total: number;
  ok_count: number;
  error_count: number;
  results: {
    rel_path: string;
    ok: boolean;
    action?: "delete" | "reingest";
    tracking_id?: string;
    error?: string;
  }[];
  /** Present only when the batch caused a git-tracked mutation (delete). */
  sync?: SyncVerdict;
};

export async function ownerRawBulk(
  action: "delete" | "reingest",
  relPaths: string[],
  tenant?: string,
): Promise<BulkRawResult> {
  return asJson<BulkRawResult>(
    await apiFetch(`${wikiBase(tenant)}/owner/raw/bulk`, {
      method: "POST",
      headers: { ...ownerHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ action, rel_paths: relPaths }),
    }),
  );
}

export type RawFile = {
  rel_path: string;
  kind: string;
  size: number;
  mtime: number;
  excerpt?: string;
};

export async function ownerListRaw(excerptChars = 0, tenant?: string): Promise<RawFile[]> {
  const q = excerptChars > 0 ? `?excerpt_chars=${excerptChars}` : "";
  const r = await apiFetch(`${wikiBase(tenant)}/owner/raw${q}`, {
    headers: ownerHeaders(),
    cache: "no-store",
  });
  const data = await asJson<{ files: RawFile[] }>(r);
  return data.files;
}

export async function ownerReadRaw(relPath: string, tenant?: string): Promise<string> {
  const stripped = relPath.startsWith("raw/") ? relPath.slice(4) : relPath;
  const r = await apiFetch(
    `${wikiBase(tenant)}/owner/raw/${encodeRawPath(stripped)}`,
    { headers: ownerHeaders(), cache: "no-store" }
  );
  const data = await asJson<{ rel_path: string; content: string }>(r);
  return data.content;
}

export async function ownerDeleteRaw(
  relPath: string,
  tenant?: string,
): Promise<{ ok: boolean; rel_path: string; sync?: SyncVerdict }> {
  const stripped = relPath.startsWith("raw/") ? relPath.slice(4) : relPath;
  const r = await apiFetch(
    `${wikiBase(tenant)}/owner/raw/${encodeRawPath(stripped)}`,
    { method: "DELETE", headers: ownerHeaders() }
  );
  if (!r.ok) {
    let detail = `${r.status}`;
    try {
      const j = await r.json();
      detail = (j as { detail?: string }).detail ?? detail;
    } catch {
      // fall through
    }
    throw new Error(`delete failed: ${detail}`);
  }
  return r.json() as Promise<{ ok: boolean; rel_path: string; sync?: SyncVerdict }>;
}

export async function ownerReingestRaw(relPath: string, tenant?: string): Promise<{
  tracking_id: string;
  kind: string;
  started_at: string;
}> {
  const stripped = relPath.startsWith("raw/") ? relPath.slice(4) : relPath;
  const r = await apiFetch(
    `${wikiBase(tenant)}/owner/raw/${encodeRawPath(stripped)}/reingest`,
    { method: "POST", headers: ownerHeaders() }
  );
  return asJson(r);
}

// Encode path segments of a raw rel_path but preserve the slashes so the
// FastAPI catch-all router (`{rel_path:path}`) can match nested paths.
function encodeRawPath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export async function ownerGetJob(trackingId: string, tenant?: string) {
  return asJson<{
    job: TrackedJob;
    log_tail: string;
    puppetmaster_status?: unknown;
    puppetmaster_show?: { summary?: string; error?: string };
  }>(
    await apiFetch(`${wikiBase(tenant)}/owner/jobs/${encodeURIComponent(trackingId)}`, {
      headers: ownerHeaders(),
      cache: "no-store",
    })
  );
}

export type GraphNode = {
  slug: string;
  title: string;
  section: string;
  tier: PageSummary["tier"];
  is_anchor: boolean;
  degree: number;
};

export type GraphEdge = {
  source: string;
  target: string;
};

export type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  anchors: string[];
};

export async function fetchGraph(tenant?: string): Promise<GraphResponse> {
  return asJson<GraphResponse>(
    await apiFetch(`${wikiBase(tenant)}/wiki/graph`, { headers: browseHeaders(), cache: "no-store" })
  );
}

export async function fetchSubgraph(slug: string, hops = 1, tenant?: string): Promise<GraphResponse> {
  return asJson<GraphResponse>(
    await apiFetch(
      `${wikiBase(tenant)}/wiki/graph/${encodeURIComponent(slug)}?hops=${hops}`,
      { headers: browseHeaders(), cache: "no-store" }
    )
  );
}

export type PublicConfig = {
  public_base_url: string;
};

export async function fetchPublicConfig(): Promise<PublicConfig> {
  return asJson<PublicConfig>(
    await apiFetch(`${apiBase()}/public-config`, { cache: "no-store" })
  );
}

// ---------- Semantic lint swarm ----------

export type LintSwarmStartResponse = {
  swarm_id: string;
  started_at: string;
  workers: string[];
  worker_tracking_ids: string[];
  artifacts_dir: string;
};

export type ContradictionFinding = {
  page_a: string;
  page_b: string;
  title_a?: string;
  title_b?: string;
  claim_a: string;
  claim_b: string;
  conflict: string;
  severity?: "low" | "medium" | "high";
  suggested_resolution?: string;
};

export type StaleFinding = {
  page: string;
  title?: string;
  age_days: number;
  stale_claim: string;
  evidence: string[];
  suggested_action?: string;
  rationale?: string;
};

export type MissingPageFinding = {
  proposed_title: string;
  proposed_section: string;
  mentioned_in: string[];
  evidence: { page: string; quote: string }[];
  bootstrap_summary: string;
};

export type PublicLeakFinding = {
  public_page: string;
  public_page_title?: string;
  leaked_token: string;
  appears_in: string[];
  context_quote: string;
  severity?: "low" | "medium" | "high";
  suggested_action?: string;
};

export type LintWorkerState = {
  tracking_id: string;
  worker: string;
  job_status?: "running" | "done" | "error";
  exit_code?: number | null;
  started_at?: string;
  ended_at?: string | null;
  log_path?: string;
  artifact_status: "pending" | "ok" | "bad-json" | "empty" | "missing";
  artifact_error?: string;
  findings: Array<
    | ContradictionFinding
    | StaleFinding
    | MissingPageFinding
    | PublicLeakFinding
    | Record<string, unknown>
  >;
};

export type LintSwarmStatus = {
  swarm_id: string;
  started_at: string;
  ended_at: string | null;
  status: "running" | "done" | "error";
  artifacts_dir: string;
  workers: LintWorkerState[];
  total_findings: number;
};

export async function ownerStartLintSwarm(workers?: string[], tenant?: string) {
  return asJson<LintSwarmStartResponse>(
    await apiFetch(`${wikiBase(tenant)}/owner/lint/swarm`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ workers: workers ?? null }),
    })
  );
}

export async function ownerGetLintSwarm(swarmId: string, tenant?: string) {
  return asJson<LintSwarmStatus>(
    await apiFetch(
      `${wikiBase(tenant)}/owner/lint/swarm/${encodeURIComponent(swarmId)}`,
      { headers: ownerHeaders(), cache: "no-store" }
    )
  );
}

export type DraftJobResponse = {
  tracking_id: string;
  kind: string;
  target: string;
  started_at: string;
};

export async function ownerDraftMissingPage(input: {
  proposed_title: string;
  proposed_section: string;
  bootstrap_summary: string;
  evidence: { page: string; quote: string }[];
  mentioned_in: string[];
}, tenant?: string) {
  return asJson<DraftJobResponse>(
    await apiFetch(`${wikiBase(tenant)}/owner/lint/draft/missing-page`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify(input),
    })
  );
}

export async function ownerDraftContradiction(input: {
  page_a: string;
  page_b: string;
  title_a?: string;
  title_b?: string;
  claim_a: string;
  claim_b: string;
  conflict: string;
  suggested_resolution?: string;
}, tenant?: string) {
  return asJson<DraftJobResponse>(
    await apiFetch(`${wikiBase(tenant)}/owner/lint/draft/contradiction`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify(input),
    })
  );
}

export async function ownerListLintSwarms(tenant?: string) {
  return asJson<{
    swarms: Array<{
      swarm_id: string;
      started_at: string;
      ended_at: string | null;
      status: "running" | "done" | "error";
      artifacts_dir: string;
      worker_tracking_ids: string[];
      worker_kinds: Record<string, string>;
    }>;
  }>(
    await apiFetch(`${wikiBase(tenant)}/owner/lint/swarm`, {
      headers: ownerHeaders(),
      cache: "no-store",
    })
  );
}

export async function ownerWritePage(input: {
  title: string;
  section: "entities" | "concepts" | "decisions" | "sources" | "queries" | "projects";
  tier: PageSummary["tier"];
  tags: string[];
  body: string;
  sources?: string[];
}, tenant?: string) {
  return asJson<{ ok: boolean; slug: string; rel_path: string }>(
    await apiFetch(`${wikiBase(tenant)}/owner/page`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ ...input, sources: input.sources ?? [] }),
    })
  );
}

export type OwnerPageRaw = {
  slug: string;
  rel_path: string;
  title: string;
  section: string;
  tier: PageSummary["tier"];
  markdown: string;
};

export async function ownerGetPageRaw(slug: string, tenant?: string): Promise<OwnerPageRaw> {
  return asJson<OwnerPageRaw>(
    await apiFetch(`${wikiBase(tenant)}/owner/page/${encodeURIComponent(slug)}/raw`, {
      headers: ownerHeaders(),
      cache: "no-store",
    })
  );
}

export async function ownerReplacePage(slug: string, markdown: string, tenant?: string) {
  return asJson<{
    ok: boolean;
    slug: string;
    rel_path: string;
    tier: PageSummary["tier"];
    title: string;
    size: number;
  }>(
    await apiFetch(`${wikiBase(tenant)}/owner/page/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: ownerHeaders(),
      body: JSON.stringify({ markdown }),
    })
  );
}

// ====================================================================
// Hosted-only API surface
// ====================================================================
//
// These endpoints live on the unprefixed /api/backend/{auth,tenants,
// onboarding}/* paths. They are NOT under /t/<tenant>/ because they
// are cross-tenant (listing tenants, sign-in, etc.) or session-driven
// (the backend resolves the tenant from the session cookie).
//
// All requests use `credentials: "include"` so the session cookie set
// by the GitHub OAuth callback is sent back to the backend.

export type AuthTenant = {
  id: string;
  github_login: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
  is_public: boolean;
};

export type AuthUser = {
  tenant_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
};

export type AuthMeResponse = {
  authenticated: boolean;
  user: AuthUser | null;
  tenant: AuthTenant | null;
  /** True only on the very first /auth/me after the OAuth callback so the
   * onboarding flow can show a one-time "welcome" experience. */
  fresh_signup: boolean;
  /** Live count of markdown pages in the tenant's wiki, derived from
   * the filesystem. /welcome reads this to decide whether to show the
   * import wizard or the "already onboarded" bouncer. */
  page_count?: number;
  /** Count of *-imported*.md files left over from accidental re-imports.
   * Surfaced in the welcome bouncer as a "Clean up duplicates" CTA. */
  duplicate_imports_count?: number;
  /** GitHub-sync connection status for the tenant. Controls the welcome
   * "connect a repo" step and the owner-console sync panel. */
  github_sync?: GitHubSyncStatus;
};

export type GitHubSyncStatus = {
  /** True if tenant has both gh_repo and gh_token set. */
  connected: boolean;
  /** "<owner>/<repo>" when connected, otherwise empty string. */
  repo: string;
  /** Default branch of the connected repo. */
  branch: string;
  /** Public HTML URL of the connected repo (empty if not connected). */
  html_url: string;
  /** Unix timestamp of last successful push. 0 if never synced. */
  last_synced_at: number;
  /** Human-readable last sync failure (empty when last attempt succeeded). */
  last_error: string;
  /** Total successful pushes since last process boot. */
  pushes_made: number;
  /** Number of pending mutations waiting on the debounce timer (only set
   * by /owner/sync/status — not present on /auth/me). */
  pending_message_count?: number;
  /** Is a debounce timer currently scheduled? */
  timer_scheduled?: boolean;
};

async function backendFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await apiFetch(`${apiBase()}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return asJson<T>(r);
}

export async function authMe(): Promise<AuthMeResponse> {
  return backendFetch<AuthMeResponse>("/auth/me");
}

export async function authLogout(): Promise<{ ok: boolean }> {
  return backendFetch<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

export async function listTenants(): Promise<{ tenants: AuthTenant[] }> {
  return backendFetch<{ tenants: AuthTenant[] }>("/tenants");
}

export async function getTenant(id: string): Promise<AuthTenant> {
  return backendFetch<AuthTenant>(`/tenants/${encodeURIComponent(id)}`);
}

export type OnboardingImportResponse = {
  ok: boolean;
  raw_path: string;
  orchestrator_started: boolean;
  tracking_id: string | null;
  tenant_id: string;
  scraped?: {
    url: string;
    title?: string;
    word_count?: number;
    [k: string]: unknown;
  };
  // Direct-LLM drafter outputs. Populated on the hosted path (no
  // Puppetmaster binary) where `_draft_from_raw_with_fallback` drafts
  // pages synchronously instead of kicking off an orchestrator job.
  // The UI MUST read these: a successful direct draft sets
  // `orchestrator_started: false` AND `pages_created > 0`, so treating
  // "orchestrator didn't start" as failure wrongly reports "unavailable"
  // when N pages were in fact created.
  pages_created?: number;
  pages?: Array<{ slug: string; title: string; section: string }>;
  draft_backend?: string;
  draft_model?: string;
  draft_warnings?: string[];
  draft_error?: string;
  orchestrator_error?: string;
};

export async function onboardingImportText(body: {
  content: string;
  label?: string;
  kind?: "bio" | "resume" | "freeform" | "linkedin";
}): Promise<OnboardingImportResponse> {
  return backendFetch<OnboardingImportResponse>("/onboarding/import-text", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function onboardingImportUrl(body: {
  url: string;
  label?: string;
  /** If true (default), the scraped markdown gets ingested into
   * structured wiki pages (entities / concepts / decisions) by
   * Puppetmaster — or, on hosted without the CLI, by the
   * direct_drafter LLM fallback. If false, we just save the raw
   * scrape under raw/imports/ and stop. The /capture page exposes
   * this toggle so users can grab content without auto-generating
   * new pages from it. */
  run_orchestrator?: boolean;
}): Promise<OnboardingImportResponse> {
  return backendFetch<OnboardingImportResponse>("/onboarding/import-url", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Guided onboarding assembly
// ---------------------------------------------------------------------------
//
// First-signup primary path. The /welcome wizard collects interview answers
// + pasted text + URLs, and posts the whole bundle to /onboarding/assemble.
// The backend scrapes the URLs, concatenates everything into one labeled
// dossier under raw/imports/, then runs the starter drafter ONCE — so the
// resulting 6–12 pages reflect the full picture instead of N redundant
// per-source drafts.

export type AssembleAnswerInput = {
  /** The literal prompt text from the wizard. Posted with the answer so
   * the backend doesn't need to know the question catalog. */
  question: string;
  answer: string;
};

export type AssembleTextSourceInput = {
  /** bio | resume | linkedin | about | github-readme | notes | freeform —
   * a label the LLM drafter uses when attributing pages back to the
   * source. Matches /onboarding/import-text's `kind` field. */
  kind?: string;
  label?: string;
  content: string;
};

export type AssembleUrlSourceInput = {
  url: string;
  label?: string;
};

export type AssembleUrlStatus = "ok" | "partial" | "failed";

/** Per-URL outcome from the assembly call. Surfaces partial failures so
 * the UI can show "we couldn't read your blog but did read your portfolio". */
export type AssembleUrlResult = {
  url: string;
  label: string;
  status: AssembleUrlStatus;
  scraped: {
    url: string;
    final_url?: string;
    title?: string;
    word_count?: number;
    errors?: string[];
    [k: string]: unknown;
  };
};

export type OnboardingAssembleResponse = {
  ok: boolean;
  tenant_id: string;
  /** Echoed counts so the UI can display "we received N answers / M
   * pastes / K URLs" without re-tracking its own form state. */
  answers_count: number;
  text_count: number;
  /** Per-URL scrape outcomes. Always present (may be empty). */
  urls: AssembleUrlResult[];
  /** URLs whose scrape produced *any* usable content (status != failed).
   * Drives the "we read X of Y URLs" copy. */
  usable_url_count: number;
  /** Echoed from `_draft_from_raw_with_fallback`. */
  raw_path: string;
  orchestrator_started?: boolean;
  orchestrator_error?: string;
  tracking_id?: string | null;
  pages_created?: number;
  pages?: Array<{ slug: string; title: string; section: string }>;
  draft_backend?: string;
  draft_model?: string;
  draft_warnings?: string[];
  draft_error?: string;
};

/**
 * Submit the guided-onboarding bundle.
 *
 * Validation is server-side: at least one non-empty answer / text source
 * / URL must be present, otherwise the backend 422s and the wizard keeps
 * its "add a source" prompt up. Individual URL failures are reported in
 * `urls[]` rather than failing the whole call, so the user gets a draft
 * even if one of their links was offline.
 */
export async function onboardingAssemble(body: {
  answers?: AssembleAnswerInput[];
  text_sources?: AssembleTextSourceInput[];
  urls?: AssembleUrlSourceInput[];
  /** Mirrors the existing import-text / import-url flag. Defaults to
   * true server-side; only pass false if the caller deliberately wants
   * to stash the raw dossier without drafting pages. */
  run_orchestrator?: boolean;
}): Promise<OnboardingAssembleResponse> {
  return backendFetch<OnboardingAssembleResponse>("/onboarding/assemble", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type ImportWikiResponse = {
  ok: boolean;
  imported_count: number;
  /** Always present on verbatim imports; empty list on standardize. */
  conflicts?: string[];
  /** Always present on verbatim imports; empty list on standardize. */
  skipped?: string[];
  tenant_id: string;
  source_url: string;
  branch: string | null;
  /** "verbatim" or "standardize" — echoed so the UI can pick the
   * right success-state copy. Older backends may omit this; treat
   * missing as "verbatim". */
  mode?: "verbatim" | "standardize";
  /** Standardize mode: the list of repo-relative *.md paths the
   * backend walked (so the user sees "we read these 12 notes"). */
  files_walked?: string[];
  /** Standardize mode: pages the LLM drafter produced. */
  pages?: Array<{ slug: string; title: string; section: string }>;
  pages_created?: number;
  draft_backend?: string;
  draft_model?: string;
  draft_warnings?: string[];
  draft_error?: string;
  raw_path?: string;
};

/**
 * Clone a (public or private) GitHub portable-llm-wiki repo into the
 * signed-in caller's tenant. Used by the "Import existing wiki"
 * onboarding tab.
 *
 * The backend uses the OAuth access token we stored at sign-in for
 * authentication — no PAT required from the user. Private repos work
 * as long as the user's token has the ``repo`` scope (which is the
 * default for new sign-ins; users from the older ``public_repo``-only
 * era must re-authorize once).
 *
 * Merge semantics: pages whose slug already exists in the target tenant
 * are written with a ``-imported`` suffix and reported in ``conflicts``.
 */
export async function onboardingImportWiki(body: {
  github_url: string;
  branch?: string;
  // When true, allows the import to merge into a tenant that already
  // contains pages. The backend rejects with HTTP 409 by default to
  // prevent accidental double-imports — see the
  // "tenant_not_empty" code on the 409 body. The /welcome bouncer
  // sets this to true after the user explicitly clicks "Import
  // additional content anyway".
  force_overwrite?: boolean;
  // "verbatim" (default) requires a top-level wiki/ directory and
  // copies pages as-is. "standardize" walks any markdown layout
  // (Obsidian, Logseq, notes/, root-level *.md, …) and runs the
  // content through the LLM drafter to produce a Karpathy-schema
  // wiki. The /welcome import tab exposes a radio for this.
  mode?: "verbatim" | "standardize";
}): Promise<ImportWikiResponse> {
  return backendFetch<ImportWikiResponse>("/onboarding/import-wiki", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type DeleteAccountResponse = {
  ok: boolean;
  tenant_id: string;
  github_token_revoked: boolean;
  tenant_deleted_on_disk: boolean;
  /** The user's GitHub repo (which is NOT touched by us). The /owner
   * danger-zone redirect surfaces this so they know exactly where
   * their portable content lives after the hosted tenant is gone. */
  github_repo: string;
};

/**
 * Self-service tenant deletion. Wipes the on-disk tenant directory
 * (working tree + the stored OAuth token + share tokens + index),
 * best-effort invalidates the GitHub OAuth token via GitHub's API,
 * and clears the session cookie.
 *
 * **Does NOT** delete the user's GitHub repository. Their content
 * lives there and stays there. They can self-host the OSS build,
 * point ``WIKI_GIT_REMOTE`` at it, and keep working — that's the
 * whole portability promise.
 */
export async function ownerDeleteAccount(): Promise<DeleteAccountResponse> {
  return backendFetch<DeleteAccountResponse>("/owner/account", {
    method: "DELETE",
  });
}

/**
 * Delete every ``*-imported*.md`` file under the signed-in caller's
 * tenant wiki. Self-heal for the duplicate-re-import case. Backend
 * resolves the tenant root real-path and refuses deletions outside it,
 * so this is safe to call even if the user has symlinks inside their
 * wiki.
 */
export type CleanupImportsResponse = {
  ok: boolean;
  deleted: string[];
  deleted_count: number;
  tenant_id: string;
  warning?: string;
};

export async function onboardingCleanupImports(): Promise<CleanupImportsResponse> {
  return backendFetch<CleanupImportsResponse>("/onboarding/cleanup-imports", {
    method: "POST",
  });
}

export type GitHubRepoSummary = {
  id: number;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  pushed_at: string;
  fork: boolean;
  archived: boolean;
};

export type MyReposResponse = {
  ok: boolean;
  /** True iff the stored OAuth token can't list private repos (either
   * it's missing, was rejected, or was minted under a narrower scope
   * than the current ``repo`` scope). The picker should surface a
   * "Re-authorize for private repos" CTA in this case. */
  needs_reauth: boolean;
  reason: string;
  repos: GitHubRepoSummary[];
  scopes: string[];
  has_repo_scope: boolean;
};

/**
 * List the signed-in user's GitHub repos (owner-affiliation only) so
 * the "Import existing wiki" wizard can show a clickable dropdown
 * instead of asking the user to paste a URL.
 */
export async function onboardingListMyRepos(): Promise<MyReposResponse> {
  return backendFetch<MyReposResponse>("/onboarding/my-repos");
}

// ---------------------------------------------------------------------------
// Connect-repo + sync — hosted multi-tenant GitHub push-back
// ---------------------------------------------------------------------------
//
// The wiki you write on portablellm.wiki only lives in your GitHub repo
// long-term. These wrappers are the bridge:
//
//   onboardingConnectRepo    pick or create the target repo, do initial
//                            bootstrap (clone if existing, seed-push if new).
//   ownerSyncStatus          read the connection + last-sync state for the
//                            owner-console panel.
//   ownerSyncNow             force-flush pending writes to GitHub.

export type ConnectRepoRequest =
  | { create_new: true; name?: string; private?: boolean; repo?: never }
  | { create_new: false; repo: string; name?: never; private?: never };

export type ConnectRepoResponse = {
  ok: boolean;
  connected: boolean;
  repo: string;
  branch: string;
  html_url?: string;
  bootstrap?: {
    ok: boolean;
    action?: string;
    error?: string;
    preexisting_moved_to?: string;
  };
  status?: GitHubSyncStatus;
  message?: string;
};

export async function onboardingConnectRepo(
  body: ConnectRepoRequest,
): Promise<ConnectRepoResponse> {
  return backendFetch<ConnectRepoResponse>("/onboarding/connect-repo", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function ownerSyncStatus(): Promise<GitHubSyncStatus> {
  return backendFetch<GitHubSyncStatus>("/owner/sync/status");
}

export type SyncNowResponse = {
  ok: boolean;
  result: {
    committed: boolean;
    pushed: boolean;
    messages: string[];
    commit_summary?: string;
    skipped?: string;
    error?: string;
  };
  status: GitHubSyncStatus;
};

export async function ownerSyncNow(): Promise<SyncNowResponse> {
  return backendFetch<SyncNowResponse>("/owner/sync/now", { method: "POST" });
}

export type SyncPullAction =
  | "pulled"           // remote was ahead, fast-forwarded
  | "up_to_date"       // local == remote
  | "ahead_only"       // local has unpushed commits, nothing to pull
  | "diverged"         // both sides moved — needs force or Sync now first
  | "dirty"            // local has uncommitted changes
  | "forced"           // force=true reset --hard origin/<branch>
  | "noop";            // bailed before doing anything

export type SyncPullResult = {
  ok: boolean;
  action: SyncPullAction;
  behind: number;
  ahead: number;
  dirty: boolean;
  // Smart-pull classification: tracked-modified files block a fast-forward
  // (real authored edits), untracked files don't (disposable mirror cruft).
  tracked_modified?: string[];
  untracked?: string[];
  error?: string;
  fetch_note?: string;
  reload_warning?: string;
  stashed_untracked?: boolean;
};

export type SyncPullResponse = {
  ok: boolean;
  result: SyncPullResult;
  status: GitHubSyncStatus;
};

/**
 * Pull the user's wiki down from GitHub. The complement to
 * ``ownerSyncNow`` (which only pushes). Use this when the user has
 * edited their wiki directly on github.com, from a local clone, from
 * another device, or via a webhook from elsewhere.
 *
 * ``force=true`` does a ``git reset --hard origin/<branch>`` — wipes
 * local-uncommitted and any unpushed local commits. The UI is
 * responsible for confirming with the user before sending it.
 */
export async function ownerSyncPull(
  opts: { force?: boolean } = {},
): Promise<SyncPullResponse> {
  return backendFetch<SyncPullResponse>("/owner/sync/pull", {
    method: "POST",
    body: JSON.stringify({ force: !!opts.force }),
  });
}

/** Smart-pull safety classification. Returned by `/owner/sync/check`,
 * which fetches the remote and reports how local relates to it WITHOUT
 * mutating anything. Drives the honest staleness copy ("Synced N days
 * ago — behind by M commits") and decides whether the UI shows a plain
 * "Pull from GitHub" (auto_ff true → safe) or the destructive force
 * button (genuine divergence). */
export type PullSafety = {
  ok: boolean;
  auto_ff: boolean;
  reason: string;
  branch: string;
  behind: number;
  ahead: number;
  dirty: boolean;
  tracked_modified: string[];
  untracked: string[];
  error: string | null;
};

export type SyncCheckResponse = {
  ok: boolean;
  classification: PullSafety;
  last_synced_at: number;
  status: GitHubSyncStatus;
};

/** Fetch the live remote-vs-local verdict for the connected tenant. One
 * network round-trip (git fetch), so call on demand (panel mount /
 * explicit refresh), not on every render. */
export async function ownerSyncCheck(): Promise<SyncCheckResponse> {
  return backendFetch<SyncCheckResponse>("/owner/sync/check");
}

/** Force-reset preview. Returned by the read-only endpoint
 * `/owner/sync/preview-force-reset`, which inspects what
 * `git reset --hard origin/<branch>` would discard WITHOUT actually
 * running it. Used by the type-to-confirm modal in the owner panel
 * to show the user EXACTLY which local files and commits are about
 * to be lost before they click the destructive button.
 *
 * Important field semantics:
 *  * dirty_files — tracked files that WILL be discarded by reset --hard.
 *  * untracked_files — untracked files that will SURVIVE the reset
 *    (reset --hard doesn't touch untracked content). Surface separately
 *    so the user knows nothing else gets silently nuked.
 *  * commits_to_lose / commits_to_gain — capped sample (~20 entries);
 *    the full count lives in `commits_to_lose_total` / `commits_to_gain_total`.
 *  * `error` set with `ok: true` means we got partial info (e.g. fetch
 *    failed, so remote state may be stale) — the UI should surface a
 *    soft warning rather than blocking.
 */
export type ForceResetPreview = {
  ok: boolean;
  error: string | null;
  branch: string;
  behind: number;
  ahead: number;
  dirty_files: { status: string; path: string; kind: string }[];
  untracked_files: string[];
  commits_to_lose: { sha: string; subject: string }[];
  commits_to_lose_total: number;
  commits_to_gain: { sha: string; subject: string }[];
  commits_to_gain_total: number;
};

export type ForceResetPreviewResponse = {
  ok: boolean;
  preview: ForceResetPreview;
  status: GitHubSyncStatus;
};

export async function ownerSyncPreviewForceReset(): Promise<ForceResetPreviewResponse> {
  return backendFetch<ForceResetPreviewResponse>(
    "/owner/sync/preview-force-reset",
  );
}
