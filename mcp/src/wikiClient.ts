/**
 * HTTP client + capability probing for the Portable LLM Wiki MCP connector.
 *
 * Stdio is transport only: auth is whatever bearer (if any) is in the
 * process env. Browser OAuth cookies never reach this process, so owner
 * capability must be proven via the backend manifest — never inferred
 * from the mere presence of WIKI_OWNER_TOKEN.
 */

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

export interface ManifestSnapshot {
  page_count: number;
  sections: Record<string, number>;
  viewer_tier: string;
  viewer_is_owner: boolean;
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
  manifest: ManifestSnapshot
): ConnectionStatus {
  const auth_mode = classifyAuthMode(tokenConfigured, manifest);
  const isOwner = auth_mode === "owner";
  const notes: string[] = [];

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
  const lines = [
    "Ingest result (honest status):",
    `- raw_file: saved (${result.rel_path}, ${result.size} bytes)`,
    `- wiki_graph_pages: not_updated_by_raw_save`,
    `- orchestrator: ${orch.state} — ${orch.detail}`,
  ];
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
  constructor(
    public readonly baseUrl: string,
    public readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: FetchLike = fetch
  ): WikiClient {
    return new WikiClient(resolveApiBase(env), resolveToken(env), fetchImpl);
  }

  get tokenConfigured(): boolean {
    return Boolean(this.token);
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
    const m = (await this.apiGet("/wiki/manifest.json")) as ManifestSnapshot;
    return {
      page_count: m.page_count ?? 0,
      sections: m.sections ?? {},
      viewer_tier: m.viewer_tier ?? "public",
      viewer_is_owner: Boolean(m.viewer_is_owner),
    };
  }

  async connectionStatus(): Promise<ConnectionStatus> {
    const manifest = await this.fetchManifest();
    return buildConnectionStatus(this.baseUrl, this.tokenConfigured, manifest);
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
    return { report: formatWritePagesReport(result), result };
  }

  async writePageVerbatim(args: {
    content: string;
    slug?: string;
    force_overwrite?: boolean;
  }): Promise<{ report: string; result: WritePageVerbatimResult }> {
    await this.requireOwnerCapability();
    const body: Record<string, unknown> = { content: args.content };
    if (args.slug !== undefined) body.slug = args.slug;
    if (args.force_overwrite !== undefined) {
      body.force_overwrite = args.force_overwrite;
    }
    const result = parseWritePageVerbatimResult(
      await this.request("POST", "/owner/capture/verbatim", body)
    );
    return { report: formatWritePageVerbatimReport(result), result };
  }

  async readPageRaw(slug: string): Promise<PageRaw> {
    await this.requireOwnerCapability();
    return parsePageRaw(
      await this.request("GET", `/owner/page/${encodeURIComponent(slug)}/raw`)
    );
  }

  async replacePage(args: {
    slug: string;
    markdown: string;
  }): Promise<{ report: string; result: ReplacePageResult }> {
    await this.requireOwnerCapability();
    const result = parseReplacePageResult(
      await this.request("PUT", `/owner/page/${encodeURIComponent(args.slug)}`, {
        markdown: args.markdown,
      })
    );
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
    const composed = joinAppendedText(raw.markdown, args.text, args.separator);
    const replaced = parseReplacePageResult(
      await this.request("PUT", `/owner/page/${encodeURIComponent(args.slug)}`, {
        markdown: composed,
      })
    );
    const result: AppendToPageResult = {
      slug: args.slug,
      old_size: raw.markdown.length,
      new_size: replaced.size,
      rel_path: replaced.rel_path,
      title: replaced.title,
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
    return { report: formatSetPageTierReport(result), result };
  }

  async deletePage(
    slug: string
  ): Promise<{ report: string; result: DeletePageResult }> {
    await this.requireOwnerCapability();
    const result = parseDeletePageResult(
      await this.request("DELETE", `/owner/page/${encodeURIComponent(slug)}`)
    );
    return { report: formatDeletePageReport(result), result };
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
