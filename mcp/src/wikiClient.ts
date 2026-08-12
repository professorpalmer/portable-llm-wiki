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
        "Bearer token is owner-capable. Read, write (ingest), and lint are available."
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
      `Ingest/lint require an owner-capable token, but WIKI_OWNER_TOKEN is not set. ${OWNER_STDIO_HINT} ` +
      `Current auth_mode=${status.auth_mode}, viewer_tier=${status.viewer_tier}.`
    );
  }
  if (status.auth_mode === "share_read_only") {
    return (
      `Ingest/lint refused: configured token is share/read-only (tier=${status.viewer_tier}), not owner-capable. ` +
      `${OWNER_STDIO_HINT}`
    );
  }
  if (status.auth_mode === "token_not_elevated") {
    return (
      `Ingest/lint refused: a token is configured but the backend did not grant owner capability ` +
      `(viewer_tier=${status.viewer_tier}). ${OWNER_STDIO_HINT}`
    );
  }
  return (
    `Ingest/lint refused: auth_mode=${status.auth_mode} is not owner-capable. ${OWNER_STDIO_HINT}`
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

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: authHeaders(this.token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${detail.slice(0, 400)}`);
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
}
