"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DangerZonePanel } from "@/components/DangerZonePanel";
import { ForceResetModal } from "@/components/ForceResetModal";
import { PersistencePanel } from "@/components/PersistencePanel";
import { PersonalLlmUrlPanel } from "@/components/PersonalLlmUrlPanel";
import { ShareTokensPanel } from "@/components/ShareTokensPanel";
import {
  apiBase,
  authMe,
  fetchManifest,
  fetchPublicConfig,
  getOwnerToken,
  isHostedMode,
  setOwnerToken,
  getPreviewAs,
  setPreviewAs,
  ownerLint,
  ownerReload,
  ownerIngest,
  ownerListJobs,
  ownerGetJob,
  ownerStartLintSwarm,
  ownerGetLintSwarm,
  ownerDraftMissingPage,
  ownerDraftContradiction,
  ownerSyncNow,
  ownerSyncPull,
  ownerSyncStatus,
  wikiBase,
  type GitHubSyncStatus,
  type LintReport,
  type LintSwarmStatus,
  type LintWorkerState,
  type ContradictionFinding,
  type StaleFinding,
  type MissingPageFinding,
  type PublicLeakFinding,
  type Manifest,
  type PreviewAs,
  type SyncNowResponse,
  type SyncPullResponse,
  type TrackedJob,
} from "@/lib/api";
import { useTenant } from "@/lib/useTenant";
import { OwnerGate } from "@/components/OwnerGate";

// Public-facing link so the average viewer who's never heard the word
// "Puppetmaster" can click through and see what it actually is — a
// Cursor SDK CLI that runs LLM-driven multi-step agent workflows.
// First-time users see this in the ingest checkbox and the lint-swarm
// card; without context, both read as inscrutable jargon.
const PUPPETMASTER_URL = "https://github.com/professorpalmer/Puppetmaster";

export default function OwnerPage() {
  const tenant = useTenant();
  return (
    <OwnerGate tenant={tenant}>
      <OwnerPageInner tenant={tenant} />
    </OwnerGate>
  );
}

function OwnerPageInner({ tenant }: { tenant?: string }) {
  const [token, setToken] = useState<string>("");
  const [authed, setAuthed] = useState<boolean>(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState<string>(
    typeof window !== "undefined" ? window.location.origin : ""
  );
  const [lint, setLint] = useState<LintReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // In hosted mode the session cookie is the auth (the OwnerGate above
  // already verified the user owns this tenant). We show the login
  // identity instead of a token-paste UI.
  const hosted = isHostedMode();
  const [hostedLogin, setHostedLogin] = useState<string | null>(null);

  useEffect(() => {
    fetchPublicConfig()
      .then((c) => {
        if (!c?.public_base_url) return;
        // Apex/www twin guard.
        //
        // If the backend's PUBLIC_BASE_URL is the apex variant
        // (``portablellm.wiki``) but the user is browsing the www
        // variant (``www.portablellm.wiki``) — or vice versa — using
        // the backend's value verbatim would make every URL we mint
        // here cross-host redirect at fetch time. OpenAI's browse
        // tool flags cross-host redirects as unsafe and silently
        // falls back to web search, so the personal-LLM URL the
        // owner pastes into ChatGPT returns "I can't access that
        // URL" (or worse, fabricated search-result garbage).
        //
        // When the backend value and the current page origin are
        // apex/www twins of the same registrable domain, prefer the
        // current page's origin — by definition that's the host the
        // user is actually reachable on right now, and minting URLs
        // for that host means LLMs fetch with no redirect to follow.
        //
        // When the hosts differ in any other way (tunnels, custom
        // domains, OSS self-hosters), the backend value is the
        // authoritative canonical URL and we use it verbatim — as
        // before.
        if (typeof window !== "undefined") {
          try {
            const backend = new URL(c.public_base_url);
            const here = new URL(window.location.origin);
            const sameScheme = backend.protocol === here.protocol;
            const isTwin = (a: string, b: string) =>
              a === b ||
              a === `www.${b}` ||
              b === `www.${a}`;
            if (sameScheme && isTwin(backend.hostname, here.hostname)) {
              setPublicBaseUrl(window.location.origin);
              return;
            }
          } catch {
            /* malformed URL — fall through to verbatim use */
          }
        }
        setPublicBaseUrl(c.public_base_url);
      })
      .catch(() => {
        /* fall back to window.location.origin */
      });
  }, []);

  // ingest form
  const [ingSlug, setIngSlug] = useState("");
  const [ingContent, setIngContent] = useState("");
  const [ingSubdir, setIngSubdir] = useState<"conversations" | "articles" | "meetings" | "assets">(
    "conversations"
  );
  const [ingNote, setIngNote] = useState("");
  const [ingRunOrch, setIngRunOrch] = useState(false);

  // job tracking
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [activeJobDetail, setActiveJobDetail] = useState<Awaited<
    ReturnType<typeof ownerGetJob>
  > | null>(null);

  // semantic lint swarm
  const [swarmId, setSwarmId] = useState<string | null>(null);
  const [swarm, setSwarm] = useState<LintSwarmStatus | null>(null);
  const [swarmLaunching, setSwarmLaunching] = useState(false);

  useEffect(() => {
    // Hosted mode: OwnerGate has already verified the user is signed in
    // AND owns this tenant. The backend recognizes the session cookie
    // as owner auth — no bearer token needed. We unconditionally call
    // verify() so the manifest loads at owner tier (viewer_is_owner
    // resolves via the session-cookie path on the backend), and we
    // fetch /auth/me to surface "Signed in as @<login>".
    if (hosted) {
      verify();
      authMe()
        .then((me) => {
          if (me.authenticated && me.user) {
            setHostedLogin(me.user.login);
          }
        })
        .catch(() => {
          /* OwnerGate already handled the not-signed-in case */
        });
      return;
    }
    // OSS / single-tenant: legacy bearer-token path. Auto-verify only
    // if we already have a token in localStorage.
    const existing = getOwnerToken();
    if (existing) {
      setToken(existing);
      verify();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosted, tenant]);

  async function verify() {
    setError(null);
    try {
      const m = await fetchManifest(tenant);
      setManifest(m);
      setAuthed(m.viewer_is_owner);
      if (!m.viewer_is_owner) {
        setError(
          hosted
            ? "We couldn't verify your sign-in for this tenant. Try refreshing the page."
            : "Token did not authenticate as owner. Check OWNER_TOKEN in backend/.env.",
        );
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function save() {
    setOwnerToken(token.trim() || null);
    verify();
  }

  function clear() {
    setOwnerToken(null);
    setToken("");
    setAuthed(false);
    setManifest(null);
    setLint(null);
    setStatus("Logged out.");
  }

  async function runLint() {
    setStatus(null);
    try {
      const r = await ownerLint(tenant);
      setLint(r);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reload() {
    setStatus(null);
    try {
      const r = await ownerReload(tenant);
      setStatus(`Reloaded. ${r.page_count} pages indexed.`);
      verify();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submitIngest(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    if (!ingSlug.trim() || !ingContent.trim()) {
      setError("Slug and content are required.");
      return;
    }
    try {
      const r = await ownerIngest(
        {
          slug: ingSlug,
          content: ingContent,
          subdir: ingSubdir,
          note: ingNote || undefined,
          run_orchestrator: ingRunOrch,
        },
        tenant,
      );
      let msg = `Saved ${r.rel_path} (${r.size} bytes).`;
      if (r.orchestrator?.tracking_id) {
        msg += ` Puppetmaster job ${r.orchestrator.tracking_id} started.`;
        setActiveJob(r.orchestrator.tracking_id);
        loadJobs();
      } else if (r.orchestrator?.error) {
        msg += ` Orchestrator skipped: ${r.orchestrator.error}.`;
      }
      setStatus(msg);
      setIngSlug("");
      setIngContent("");
      setIngNote("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadJobs() {
    try {
      const r = await ownerListJobs(tenant);
      setJobs(r.jobs);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!authed) return;
    loadJobs();
    const interval = setInterval(loadJobs, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, tenant]);

  async function runSwarm() {
    setError(null);
    setStatus(null);
    setSwarmLaunching(true);
    try {
      const r = await ownerStartLintSwarm(undefined, tenant);
      setSwarmId(r.swarm_id);
      setStatus(
        `Lint swarm ${r.swarm_id} started with ${r.workers.length} workers: ${r.workers.join(", ")}. Expect ~90-180s per worker.`
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwarmLaunching(false);
    }
  }

  useEffect(() => {
    if (!authed || !swarmId) {
      setSwarm(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const r = await ownerGetLintSwarm(swarmId!, tenant);
        if (!cancelled) setSwarm(r);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [swarmId, authed, tenant]);

  useEffect(() => {
    if (!authed || !activeJob) {
      setActiveJobDetail(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const r = await ownerGetJob(activeJob!, tenant);
        if (!cancelled) setActiveJobDetail(r);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }
    load();
    const interval = setInterval(load, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeJob, authed, tenant]);

  return (
    <div className="max-w-3xl mx-auto px-5 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Owner console</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Authenticated operations: ingest sources, set tiers, reload the index, run lint.
      </p>
      {authed && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <Link
            href={`${tenant ? `/${tenant}` : ""}/capture`}
            className="px-3 py-1.5 rounded bg-accent/10 text-accent border border-accent/30 hover:bg-accent/15"
          >
            frictionless capture →
          </Link>
          <Link
            href={`${tenant ? `/${tenant}` : ""}/owner/import`}
            className="px-3 py-1.5 rounded bg-accent/10 text-accent border border-accent/30 hover:bg-accent/15"
          >
            import wizard →
          </Link>
          <Link
            href={`${tenant ? `/${tenant}` : ""}/owner/captures`}
            className="px-3 py-1.5 rounded bg-accent/10 text-accent border border-accent/30 hover:bg-accent/15"
          >
            capture history →
          </Link>
          <span className="text-xs text-ink-muted self-center">
            New wiki? Start with import. Existing wiki? Use capture.
          </span>
        </div>
      )}

      {/* OSS / single-tenant mode shows the legacy "what's behind the
          gate" preview + bearer-token paste UI. In hosted mode the
          OwnerGate above has already established ownership via the
          session cookie, so we skip both and just show a small
          "signed in as @<login>" badge. */}
      {!hosted && !authed && <OwnerDemoPreview />}

      {!hosted && (
        <section className="mt-6 bg-white border border-paper-soft rounded-xl p-5">
          <h2 className="text-sm uppercase tracking-wider text-ink-muted mb-3">
            Bearer token
          </h2>
          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="OWNER_TOKEN from backend/.env"
              className="flex-1 border border-paper-soft rounded px-3 py-2 text-sm bg-paper focus:border-accent focus:outline-none"
            />
            <button
              onClick={save}
              className="px-3 py-2 rounded bg-ink text-paper text-sm font-medium hover:bg-ink-soft"
            >
              Save
            </button>
            {authed && (
              <button
                onClick={clear}
                className="px-3 py-2 rounded border border-paper-soft text-sm text-ink-muted hover:border-ink hover:text-ink"
              >
                Log out
              </button>
            )}
          </div>
          <div className="mt-2 text-xs text-ink-muted">
            Stored only in your browser&apos;s <code>localStorage</code>. Cleared when you
            click Log out.
          </div>
          <div className="mt-3 text-sm">
            {authed ? (
              <span className="text-emerald-700">
                Authenticated as owner. {manifest && `Seeing ${manifest.page_count} pages.`}
              </span>
            ) : (
              <span className="text-ink-muted">Not authenticated.</span>
            )}
          </div>
        </section>
      )}

      {hosted && (
        <section className="mt-6 bg-white border border-paper-soft rounded-xl p-4 sm:p-5 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
            <div>
              <div className="text-sm font-medium text-ink">
                Signed in as{" "}
                <span className="font-mono">
                  @{hostedLogin ?? tenant ?? "you"}
                </span>
              </div>
              <div className="text-xs text-ink-muted">
                You own{" "}
                <code className="font-mono">
                  portablellm.wiki/{tenant ?? hostedLogin ?? ""}
                </code>
                . GitHub sign-in is your auth — no token to copy.
              </div>
            </div>
          </div>
          {manifest && (
            <span className="text-xs text-ink-muted ml-auto">
              {manifest.page_count} page{manifest.page_count === 1 ? "" : "s"} indexed
            </span>
          )}
          <a
            href={`${apiBase()}/auth/logout?return_to=${encodeURIComponent(
              typeof window !== "undefined" ? window.location.origin : "/",
            )}`}
            className="text-xs text-ink-muted hover:text-ink underline ml-auto sm:ml-3"
          >
            Sign out
          </a>
        </section>
      )}

      {authed && (
        <PreviewAsPanel
          manifest={manifest}
          onChange={() =>
            fetchManifest(tenant)
              .then(setManifest)
              .catch(() => {})
          }
        />
      )}

      {/* Persistence panel is OSS-only.
       *
       * Why hidden in hosted mode: the panel's remediation steps tell
       * the user to set ``WIKI_GIT_REMOTE`` in *their* Render dashboard
       * — but on portablellm.wiki the dashboard belongs to us, not the
       * user. Showing a yellow "your writes won't survive a restart"
       * warning the user can't act on erodes confidence in the product.
       * The hosted deployment owns its own persistent storage; the
       * tenant's data is our operational concern, not theirs.
       *
       * The OSS self-host path (where the user controls deployment env
       * vars and runs on Render free tier with ephemeral disk) still
       * needs this panel — it's the only safety rail against silent
       * data loss in that case.
       *
       * Future opportunity: replace this gate with an opt-in
       * "sync my wiki to my own GitHub repo" feature using the tenant's
       * stored OAuth token. Same persistence machinery, keyed to the
       * user's repo instead of an ops-owned one. Tracked, not built. */}
      {authed && !hosted && <PersistencePanel tenant={tenant} />}
      {authed && hosted && <GitHubSyncPanel tenantId={tenant} />}

      {/* PersonalLlmUrlPanel sits ABOVE ShareTokensPanel because it
       *  answers a different question. "How do I get my OWN LLMs
       *  (ChatGPT, Claude, Cursor) to see my full wiki?" comes up
       *  immediately after onboarding — it's the portability story
       *  the project's pitched on. "How do I let a recruiter see a
       *  curated slice?" is downstream. Top-to-bottom information
       *  density matches user mental model order. */}
      {authed && (
        <PersonalLlmUrlPanel
          publicBaseUrl={publicBaseUrl}
          tenant={tenant}
        />
      )}
      {authed && (
        <ShareTokensPanel
          publicBaseUrl={publicBaseUrl}
          tenant={tenant}
        />
      )}

      {error && (
        <div className="mt-6 p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}
      {status && (
        <div className="mt-6 p-3 rounded border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm">
          {status}
        </div>
      )}

      {authed && (
        <>
          <section className="mt-6 grid sm:grid-cols-4 gap-3">
            <button
              onClick={reload}
              className="px-4 py-3 rounded bg-white border border-paper-soft hover:border-accent text-left"
            >
              <div className="text-sm font-semibold">Reload index</div>
              <div className="text-xs text-ink-muted">Rescan the wiki folder.</div>
            </button>
            <button
              onClick={runLint}
              className="px-4 py-3 rounded bg-white border border-paper-soft hover:border-accent text-left"
            >
              <div className="text-sm font-semibold">Structural lint</div>
              <div className="text-xs text-ink-muted">Orphans, stale dates, broken provenance.</div>
            </button>
            <button
              onClick={runSwarm}
              disabled={swarmLaunching || (swarm?.status === "running")}
              className="px-4 py-3 rounded bg-white border border-paper-soft hover:border-accent text-left disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="text-sm font-semibold flex items-center gap-2">
                Semantic lint
                <span className="text-[10px] uppercase tracking-wider font-semibold bg-accent text-white px-1.5 py-0.5 rounded">
                  swarm
                </span>
              </div>
              <div className="text-xs text-ink-muted">
                4{" "}
                <a
                  href={PUPPETMASTER_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted underline-offset-2 hover:text-ink"
                  onClick={(e) => e.stopPropagation()}
                  title="Cursor SDK agent CLI — opens GitHub"
                >
                  Puppetmaster
                </a>{" "}
                agents in parallel: contradictions, stale claims, missing pages,
                public-leaks.
              </div>
            </button>
            <a
              href={`${wikiBase(tenant)}/wiki/manifest.json`}
              target="_blank"
              rel="noreferrer"
              className="px-4 py-3 rounded bg-white border border-paper-soft hover:border-accent"
            >
              <div className="text-sm font-semibold">Inspect manifest</div>
              <div className="text-xs text-ink-muted">Raw JSON for LLMs.</div>
            </a>
          </section>

          {swarm && (
            <LintSwarmPanel
              swarm={swarm}
              tenant={tenant}
              onClose={() => {
                setSwarmId(null);
                setSwarm(null);
              }}
              onDrafted={(trackingId, kind, target) => {
                setStatus(
                  `Drafter job ${trackingId} (${kind}) writing to ${target}. Watch it in the Puppetmaster jobs panel below.`
                );
                setActiveJob(trackingId);
                loadJobs();
              }}
              onError={(msg) => setError(msg)}
            />
          )}

          <section className="mt-8 bg-white border border-paper-soft rounded-xl p-5">
            <h2 className="text-sm uppercase tracking-wider text-ink-muted mb-3">
              Ingest a source
            </h2>
            <form onSubmit={submitIngest} className="space-y-3">
              <div className="flex gap-3 flex-wrap">
                <input
                  value={ingSlug}
                  onChange={(e) => setIngSlug(e.target.value)}
                  placeholder="slug (e.g. interview-prep)"
                  className="flex-1 min-w-[200px] border border-paper-soft rounded px-3 py-2 text-sm bg-paper focus:border-accent focus:outline-none"
                />
                <select
                  value={ingSubdir}
                  onChange={(e) => setIngSubdir(e.target.value as typeof ingSubdir)}
                  className="border border-paper-soft rounded px-3 py-2 text-sm bg-paper"
                >
                  <option value="conversations">conversations</option>
                  <option value="articles">articles</option>
                  <option value="meetings">meetings</option>
                  <option value="assets">assets</option>
                </select>
              </div>
              <input
                value={ingNote}
                onChange={(e) => setIngNote(e.target.value)}
                placeholder="optional one-line note about this source"
                className="w-full border border-paper-soft rounded px-3 py-2 text-sm bg-paper focus:border-accent focus:outline-none"
              />
              <textarea
                value={ingContent}
                onChange={(e) => setIngContent(e.target.value)}
                rows={8}
                placeholder="Paste the source content (a conversation log, an article, meeting notes…)"
                className="w-full border border-paper-soft rounded px-3 py-2 text-sm bg-paper font-mono focus:border-accent focus:outline-none"
              />
              <label className="flex items-start gap-2 text-sm text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={ingRunOrch && !hosted}
                  onChange={(e) => setIngRunOrch(e.target.checked)}
                  disabled={hosted}
                  title={
                    hosted
                      ? "Puppetmaster (Cursor SDK CLI) only runs on self-hosted installs. The hosted site uses direct LLM calls automatically."
                      : undefined
                  }
                  className="mt-1 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <span>
                  <span className="font-medium">
                    Run{" "}
                    <a
                      href={PUPPETMASTER_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-dotted underline-offset-2 hover:text-ink"
                      onClick={(e) => e.stopPropagation()}
                      title="Cursor SDK agent CLI — opens GitHub"
                    >
                      Puppetmaster
                    </a>{" "}
                    ingest pipeline
                  </span>
                  <span className="block text-xs text-ink-muted leading-relaxed">
                    Spawns a Cursor SDK agent (via{" "}
                    <a
                      href={PUPPETMASTER_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-dotted underline-offset-2 hover:text-ink"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Puppetmaster
                    </a>
                    ) inside your wiki root that
                    performs the full Karpathy ingest sequence: drafts source digest,
                    entity/concept/decision pages, cross-references, index + log
                    entries. Costs LLM tokens. Watch progress below.{" "}
                    <span className="text-amber-700">
                      Self-host only — on the hosted site we use a direct LLM call
                      instead (no Cursor binary required).
                    </span>
                  </span>
                </span>
              </label>
              <div className="text-xs text-ink-muted">
                Saved to <code>raw/&lt;subdir&gt;/YYYY-MM-DD-&lt;slug&gt;.md</code>. With the
                checkbox off you can still ingest manually from your wiki workspace.
              </div>
              <button
                type="submit"
                className="px-4 py-2 rounded bg-ink text-paper text-sm font-medium hover:bg-ink-soft"
              >
                {ingRunOrch ? "Save + run pipeline" : "Save raw source"}
              </button>
            </form>
          </section>

          <section className="mt-8 bg-white border border-paper-soft rounded-xl p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm uppercase tracking-wider text-ink-muted">
                <a
                  href={PUPPETMASTER_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-ink"
                  title="Cursor SDK agent CLI — opens GitHub"
                >
                  Puppetmaster
                </a>{" "}
                jobs
              </h2>
              <button
                onClick={loadJobs}
                className="text-xs text-ink-muted hover:text-ink"
              >
                ↻ refresh
              </button>
            </div>
            {jobs.length === 0 ? (
              <div className="mt-3 text-sm text-ink-muted">
                No jobs yet. Toggle the checkbox above and ingest something.
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-paper-soft">
                {jobs.map((j) => (
                  <li
                    key={j.tracking_id}
                    className={`py-2 text-sm flex flex-wrap items-baseline gap-3 cursor-pointer ${
                      activeJob === j.tracking_id ? "bg-paper-soft -mx-2 px-2 rounded" : ""
                    }`}
                    onClick={() => setActiveJob(j.tracking_id)}
                  >
                    <span
                      className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${
                        j.status === "done"
                          ? "bg-emerald-100 text-emerald-700"
                          : j.status === "error"
                          ? "bg-red-100 text-red-700"
                          : "bg-amber-100 text-amber-800 animate-pulse"
                      }`}
                    >
                      {j.status}
                    </span>
                    <code className="font-mono text-xs">{j.tracking_id}</code>
                    <span className="text-ink-muted">{j.kind}</span>
                    <span className="text-ink-muted">{j.raw_path}</span>
                    <span className="text-ink-muted text-xs">
                      {new Date(j.started_at).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {activeJobDetail && (
              <div className="mt-5 border-t border-paper-soft pt-4">
                <div className="flex items-baseline gap-3 mb-2">
                  <h3 className="text-sm font-semibold">
                    Job {activeJobDetail.job.tracking_id}
                  </h3>
                  <span className="text-xs text-ink-muted">
                    status {activeJobDetail.job.status}
                    {activeJobDetail.job.exit_code !== null &&
                      ` · exit ${activeJobDetail.job.exit_code}`}
                  </span>
                  <button
                    onClick={() => setActiveJob(null)}
                    className="ml-auto text-xs text-ink-muted hover:text-ink"
                  >
                    close
                  </button>
                </div>
                {activeJobDetail.puppetmaster_show?.summary && (
                  <div className="mb-3">
                    <h4 className="text-xs uppercase tracking-wider text-ink-muted mb-1">
                      <a
                        href={PUPPETMASTER_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-ink"
                        title="Cursor SDK agent CLI — opens GitHub"
                      >
                        Puppetmaster
                      </a>{" "}
                      summary
                    </h4>
                    <pre className="bg-paper-soft text-xs font-mono whitespace-pre-wrap rounded p-3 max-h-64 overflow-y-auto">
                      {activeJobDetail.puppetmaster_show.summary}
                    </pre>
                  </div>
                )}
                <h4 className="text-xs uppercase tracking-wider text-ink-muted mb-1">
                  Live log
                </h4>
                <pre className="bg-ink text-paper text-[11px] font-mono whitespace-pre-wrap rounded p-3 max-h-96 overflow-y-auto">
                  {activeJobDetail.log_tail || "(no output yet)"}
                </pre>
              </div>
            )}
          </section>

          {lint && (
            <section className="mt-8 bg-white border border-paper-soft rounded-xl p-5">
              <h2 className="text-sm uppercase tracking-wider text-ink-muted mb-3">
                Lint report
              </h2>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="font-semibold">{lint.totals.pages}</div>
                  <div className="text-xs text-ink-muted">pages</div>
                </div>
                <div>
                  <div className="font-semibold">{lint.orphans.length}</div>
                  <div className="text-xs text-ink-muted">orphans</div>
                </div>
                <div>
                  <div className="font-semibold">{lint.stale.length}</div>
                  <div className="text-xs text-ink-muted">stale</div>
                </div>
                <div>
                  <div className="font-semibold">{lint.missing_pages.length}</div>
                  <div className="text-xs text-ink-muted">missing</div>
                </div>
                <div>
                  <div className="font-semibold">{lint.broken_provenance.length}</div>
                  <div className="text-xs text-ink-muted">broken provenance</div>
                </div>
                <div>
                  <div className="font-semibold">{lint.missing_index_entries.length}</div>
                  <div className="text-xs text-ink-muted">missing in index</div>
                </div>
              </div>

              <LintGroup title="Orphans (no inbound wikilinks)" items={lint.orphans.map((o) => `${o.title} · ${o.section}`)} />
              <LintGroup
                title="Stale (>30d since updated/created)"
                items={lint.stale.map((s) => `${s.title} · ${s.age_days}d (${s.last_dated})`)}
              />
              <LintGroup
                title="Missing pages (≥3 mentions, no page)"
                items={lint.missing_pages.map((m) => `${m.title} · ${m.mentions}×`)}
              />
              <LintGroup
                title="Broken provenance (source file missing)"
                items={lint.broken_provenance.map((b) => `${b.title} → ${b.missing_source}`)}
              />
              <LintGroup
                title="Missing index entries"
                items={lint.missing_index_entries.map((m) =>
                  m.title ? `${m.title} · ${m.section}` : m.reason || "(unknown)"
                )}
              />
            </section>
          )}

          {/* Danger zone sits at the absolute bottom of the owner
           *  console. It's collapsed by default and only renders in
           *  hosted mode — OSS self-host users own their tenant
           *  directly, there's no "hosted service" to leave. */}
          <DangerZonePanel tenant={tenant} hosted={hosted} />
        </>
      )}
    </div>
  );
}

function LintGroup({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details className="mt-4 border-t border-paper-soft pt-3">
      <summary className="cursor-pointer text-sm font-medium text-ink hover:text-accent">
        {title} ({items.length})
      </summary>
      <ul className="mt-2 text-sm text-ink-muted space-y-1 max-h-64 overflow-y-auto">
        {items.map((s, i) => (
          <li key={i} className="font-mono text-xs">
            · {s}
          </li>
        ))}
      </ul>
    </details>
  );
}

function statusColor(s: string | undefined) {
  if (s === "done" || s === "ok") return "bg-emerald-100 text-emerald-700";
  if (s === "error" || s === "bad-json") return "bg-red-100 text-red-700";
  if (s === "running" || s === "pending") return "bg-amber-100 text-amber-800 animate-pulse";
  return "bg-paper-soft text-ink-muted";
}

type DraftHandler = (trackingId: string, kind: string, target: string) => void;

function LintSwarmPanel({
  swarm,
  tenant,
  onClose,
  onDrafted,
  onError,
}: {
  swarm: LintSwarmStatus;
  tenant?: string;
  onClose: () => void;
  onDrafted: DraftHandler;
  onError: (msg: string) => void;
}) {
  return (
    <section className="mt-8 bg-white border border-paper-soft rounded-xl p-5">
      <div className="flex items-baseline gap-3 mb-4 flex-wrap">
        <h2 className="text-sm uppercase tracking-wider text-ink-muted">
          Semantic lint swarm
        </h2>
        <code className="text-xs font-mono text-ink-muted">{swarm.swarm_id}</code>
        <span
          className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${statusColor(
            swarm.status
          )}`}
        >
          {swarm.status}
        </span>
        <span className="text-xs text-ink-muted">
          {swarm.total_findings} findings across {swarm.workers.length} workers
        </span>
        <button
          onClick={onClose}
          className="ml-auto text-xs text-ink-muted hover:text-ink"
        >
          dismiss
        </button>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        {swarm.workers.map((w) => (
          <div
            key={w.tracking_id}
            className="border border-paper-soft rounded p-3 text-sm"
          >
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <span className="font-semibold">{w.worker}</span>
              <span
                className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${statusColor(
                  w.job_status
                )}`}
              >
                {w.job_status ?? "?"}
              </span>
            </div>
            <div className="text-xs text-ink-muted">
              artifact:{" "}
              <span className={statusColor(w.artifact_status).split(" ")[1]}>
                {w.artifact_status}
              </span>
              {w.exit_code !== null && w.exit_code !== undefined && (
                <> · exit {w.exit_code}</>
              )}
            </div>
            <div className="mt-2 text-xs font-mono">
              {w.findings.length} finding{w.findings.length === 1 ? "" : "s"}
            </div>
            {w.artifact_error && (
              <div className="mt-1 text-xs text-red-700 font-mono break-all">
                {w.artifact_error}
              </div>
            )}
          </div>
        ))}
      </div>

      <FindingsList
        workers={swarm.workers}
        tenant={tenant}
        onDrafted={onDrafted}
        onError={onError}
      />
    </section>
  );
}

function FindingsList({
  workers,
  tenant,
  onDrafted,
  onError,
}: {
  workers: LintWorkerState[];
  tenant?: string;
  onDrafted: DraftHandler;
  onError: (msg: string) => void;
}) {
  const groups = workers.filter((w) => w.findings.length > 0);
  if (groups.length === 0) {
    const anyRunning = workers.some((w) => w.job_status === "running");
    return (
      <div className="mt-6 text-sm text-ink-muted">
        {anyRunning
          ? "Workers still running. Findings will appear here as they complete."
          : "No findings reported. Your wiki is internally consistent (or the workers were too conservative; see logs in the Puppetmaster jobs panel)."}
      </div>
    );
  }
  return (
    <div className="mt-6 space-y-6">
      {groups.map((w) => (
        <div key={w.tracking_id}>
          <h3 className="text-sm font-semibold text-ink mb-2">
            {w.worker} ({w.findings.length})
          </h3>
          <div className="space-y-2">
            {w.findings.map((f, i) => (
              <FindingCard
                key={i}
                worker={w.worker}
                finding={f as Record<string, unknown>}
                tenant={tenant}
                onDrafted={onDrafted}
                onError={onError}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FindingCard({
  worker,
  finding,
  tenant,
  onDrafted,
  onError,
}: {
  worker: string;
  finding: Record<string, unknown>;
  tenant?: string;
  onDrafted: DraftHandler;
  onError: (msg: string) => void;
}) {
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState<string | null>(null);

  if (worker === "contradictions") {
    const f = finding as unknown as ContradictionFinding;
    const sevColor =
      f.severity === "high"
        ? "bg-red-100 text-red-800"
        : f.severity === "medium"
        ? "bg-amber-100 text-amber-800"
        : "bg-paper-soft text-ink-muted";

    async function draftReconciliation() {
      setDrafting(true);
      try {
        const r = await ownerDraftContradiction(
          {
            page_a: f.page_a,
            page_b: f.page_b,
            title_a: f.title_a,
            title_b: f.title_b,
            claim_a: f.claim_a,
            claim_b: f.claim_b,
            conflict: f.conflict,
            suggested_resolution: f.suggested_resolution,
          },
          tenant,
        );
        setDrafted(r.tracking_id);
        onDrafted(r.tracking_id, r.kind, r.target);
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setDrafting(false);
      }
    }

    return (
      <div className="border border-paper-soft rounded p-3 bg-paper">
        <div className="flex items-baseline gap-2 flex-wrap mb-2">
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${sevColor}`}
          >
            {f.severity ?? "—"}
          </span>
          <span className="text-sm font-semibold flex-1">{f.conflict}</span>
          <button
            onClick={draftReconciliation}
            disabled={drafting || !!drafted}
            className="text-xs px-2 py-1 rounded bg-ink text-paper hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {drafted ? `drafting job ${drafted.slice(0, 6)}…` : drafting ? "spawning…" : "draft reconciliation →"}
          </button>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 text-xs">
          <PageQuote path={f.page_a} title={f.title_a} quote={f.claim_a} tenant={tenant} />
          <PageQuote path={f.page_b} title={f.title_b} quote={f.claim_b} tenant={tenant} />
        </div>
        {f.suggested_resolution && (
          <div className="mt-2 text-xs text-ink-muted">
            <span className="font-semibold">Suggested:</span> {f.suggested_resolution}
          </div>
        )}
      </div>
    );
  }
  if (worker === "stale") {
    const f = finding as unknown as StaleFinding;
    return (
      <div className="border border-paper-soft rounded p-3 bg-paper">
        <div className="flex items-baseline gap-2 flex-wrap mb-2">
          <span className="text-[10px] uppercase tracking-wider font-semibold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
            {f.age_days}d
          </span>
          <span className="text-sm font-semibold">{f.title ?? f.page}</span>
        </div>
        <div className="text-xs italic text-ink-muted">&ldquo;{f.stale_claim}&rdquo;</div>
        {f.evidence?.length > 0 && (
          <div className="mt-2 text-xs">
            <span className="font-semibold">Possibly superseded by:</span>{" "}
            {f.evidence.map((e) => (
              <code key={e} className="font-mono text-[11px] mr-1">{e}</code>
            ))}
          </div>
        )}
        {f.suggested_action && (
          <div className="mt-1 text-xs text-ink-muted">
            <span className="font-semibold">Suggested:</span> {f.suggested_action}
            {f.rationale && ` · ${f.rationale}`}
          </div>
        )}
      </div>
    );
  }
  if (worker === "public-leak") {
    const f = finding as unknown as PublicLeakFinding;
    const sevColor =
      f.severity === "high"
        ? "bg-red-100 text-red-800"
        : f.severity === "medium"
        ? "bg-amber-100 text-amber-800"
        : "bg-paper-soft text-ink-muted";
    return (
      <div className="border-2 border-amber-300 rounded p-3 bg-amber-50">
        <div className="flex items-baseline gap-2 flex-wrap mb-2">
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${sevColor}`}
          >
            {f.severity ?? "—"}
          </span>
          <span className="text-sm font-semibold flex-1">
            Public page leaks &ldquo;{f.leaked_token}&rdquo;
          </span>
        </div>
        <PageQuote
          path={f.public_page}
          title={f.public_page_title}
          quote={f.context_quote}
          tenant={tenant}
        />
        <div className="mt-2 text-xs text-ink-muted">
          <span className="font-semibold">Also appears in:</span>{" "}
          {f.appears_in.map((p) => (
            <code key={p} className="font-mono text-[11px] mr-1">
              {p}
            </code>
          ))}
        </div>
        {f.suggested_action && (
          <div className="mt-1 text-xs text-amber-900">
            <span className="font-semibold">Suggested:</span> {f.suggested_action}
          </div>
        )}
      </div>
    );
  }
  if (worker === "missing-pages") {
    const f = finding as unknown as MissingPageFinding;

    async function draftPage() {
      setDrafting(true);
      try {
        const r = await ownerDraftMissingPage(
          {
            proposed_title: f.proposed_title,
            proposed_section: f.proposed_section,
            bootstrap_summary: f.bootstrap_summary,
            evidence: f.evidence ?? [],
            mentioned_in: f.mentioned_in ?? [],
          },
          tenant,
        );
        setDrafted(r.tracking_id);
        onDrafted(r.tracking_id, r.kind, r.target);
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setDrafting(false);
      }
    }

    return (
      <div className="border border-paper-soft rounded p-3 bg-paper">
        <div className="flex items-baseline gap-2 mb-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-semibold bg-accent text-white px-1.5 py-0.5 rounded">
            {f.proposed_section}
          </span>
          <span className="text-sm font-semibold flex-1">{f.proposed_title}</span>
          <button
            onClick={draftPage}
            disabled={drafting || !!drafted}
            className="text-xs px-2 py-1 rounded bg-ink text-paper hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {drafted
              ? `drafting job ${drafted.slice(0, 6)}…`
              : drafting
              ? "spawning…"
              : "draft this page →"}
          </button>
        </div>
        <div className="text-xs text-ink-muted">{f.bootstrap_summary}</div>
        {f.evidence?.length > 0 && (
          <details className="mt-2">
            <summary className="text-xs cursor-pointer hover:text-ink">
              {f.evidence.length} evidence quote{f.evidence.length === 1 ? "" : "s"} · mentioned in {f.mentioned_in?.length ?? 0}
            </summary>
            <ul className="mt-1 space-y-1">
              {f.evidence.map((e, i) => (
                <li key={i} className="text-xs">
                  <code className="font-mono text-[11px]">{e.page}</code>
                  <span className="italic text-ink-muted"> · &ldquo;{e.quote}&rdquo;</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }
  return (
    <pre className="border border-paper-soft rounded p-3 bg-paper text-xs font-mono whitespace-pre-wrap">
      {JSON.stringify(finding, null, 2)}
    </pre>
  );
}

function PageQuote({
  path,
  title,
  quote,
  tenant,
}: {
  path: string;
  title?: string;
  quote: string;
  tenant?: string;
}) {
  // wiki/<section>/<slug>.md → slug
  const slug = path.replace(/^wiki\//, "").replace(/\.md$/, "").split("/").pop() ?? "";
  return (
    <div>
      <a
        href={`${tenant ? `/${tenant}` : ""}/page/${encodeURIComponent(slug)}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-[11px] text-accent hover:underline"
      >
        {title ?? path}
      </a>
      <div className="mt-1 italic text-ink-muted">&ldquo;{quote}&rdquo;</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview-as panel — owner-only audit lens
// ---------------------------------------------------------------------------

function PreviewAsPanel({
  manifest,
  onChange,
}: {
  manifest: Manifest | null;
  onChange: () => void;
}) {
  const [current, setCurrent] = useState<PreviewAs>("owner");

  useEffect(() => {
    setCurrent(getPreviewAs());
  }, []);

  function pick(next: PreviewAs) {
    setPreviewAs(next);
    setCurrent(next);
    onChange();
  }

  const tiers: { id: PreviewAs; label: string; desc: string }[] = [
    {
      id: "owner",
      label: "owner",
      desc: "Full access. The real you.",
    },
    {
      id: "friend",
      label: "friend",
      desc: "Pages tagged friend or lower. Personal but not sensitive.",
    },
    {
      id: "recruiter",
      label: "recruiter",
      desc: "Career-facing pages. What a hiring manager would see.",
    },
    {
      id: "public",
      label: "public",
      desc: "Anyone with the URL. Audit this before sharing.",
    },
  ];

  return (
    <section
      className={`mt-6 rounded-xl p-5 border ${
        current === "owner"
          ? "bg-white border-paper-soft"
          : "bg-amber-50 border-amber-300"
      }`}
    >
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm uppercase tracking-wider text-ink-muted">
          Preview as
        </h2>
        {current !== "owner" && (
          <span className="text-xs text-amber-800 font-medium">
            Preview mode: seeing {manifest?.page_count ?? "?"} pages as {current}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Browse the wiki through a downgraded viewer tier. Manifest, query, and
        page-fetch endpoints all respect this: exactly what a stranger or a
        recruiter would see. Audit before you share. Writes still work
        normally; the owner token is unaffected.
      </p>
      <div className="mt-3 grid sm:grid-cols-2 gap-2">
        {tiers.map((t) => (
          <button
            key={t.id}
            onClick={() => pick(t.id)}
            className={`text-left px-3 py-2 rounded border transition ${
              current === t.id
                ? "border-accent bg-accent/5"
                : "border-paper-soft hover:border-ink-muted"
            }`}
          >
            <div className="text-sm font-medium text-ink">{t.label}</div>
            <div className="text-xs text-ink-muted">{t.desc}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Hosted-mode GitHub sync panel.
 *
 * This is the owner-facing surface of the per-tenant push-back feature.
 * Three states it has to render cleanly:
 *
 *   1. Not connected — the tenant predates the connect-repo step or has
 *      lost their connection. We show a banner with a "Connect now" CTA
 *      that links back to /welcome, where the picker lives.
 *
 *   2. Connected, healthy — show the repo (clickable to GitHub), last
 *      synced ago, total pushes since boot, a "Sync now" button to
 *      flush the debounce window manually. This is the steady state
 *      after a successful connect.
 *
 *   3. Connected, errored — same as healthy plus a red "Last error"
 *      block so the user knows the last debounced flush failed. Most
 *      common cause is a revoked OAuth token (re-auth fixes it) or a
 *      branch-protection rule on the user's repo (push to a feature
 *      branch and PR instead).
 *
 * The /owner/sync/status endpoint returns the live snapshot — we poll
 * lightly (every 30s) so users see new pushes show up without manual
 * refresh, but not so aggressively that we waste API budget. */
export function GitHubSyncPanel({ tenantId }: { tenantId?: string }) {
  const [status, setStatus] = useState<GitHubSyncStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncNowResponse | null>(null);
  // Pull state is separate from push state — both buttons can show
  // independent feedback. We clear the old result on a new attempt.
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<SyncPullResponse | null>(null);
  // Force-reset modal visibility. Decoupled from `pulling` so the modal
  // can stay open while the force-reset is in flight (its inputs go
  // disabled, but the user still sees the preview block).
  const [forceModalOpen, setForceModalOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await ownerSyncStatus();
      setStatus(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "unknown error");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const doSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await ownerSyncNow();
      setSyncResult(result);
      setStatus(result.status);
    } catch (e) {
      setSyncResult({
        ok: false,
        result: { committed: false, pushed: false, messages: [], error: e instanceof Error ? e.message : "unknown" },
        status: status ?? {
          connected: false, repo: "", branch: "main", html_url: "",
          last_synced_at: 0, last_error: "", pushes_made: 0,
        },
      });
    } finally {
      setSyncing(false);
    }
  }, [status]);

  const doPull = useCallback(
    async (opts: { force?: boolean } = {}) => {
      setPulling(true);
      setPullResult(null);
      try {
        const result = await ownerSyncPull(opts);
        setPullResult(result);
        setStatus(result.status);
      } catch (e) {
        setPullResult({
          ok: false,
          result: {
            ok: false,
            action: "noop",
            behind: 0,
            ahead: 0,
            dirty: false,
            error: e instanceof Error ? e.message : "unknown",
          },
          status: status ?? {
            connected: false, repo: "", branch: "main", html_url: "",
            last_synced_at: 0, last_error: "", pushes_made: 0,
          },
        });
      } finally {
        setPulling(false);
      }
    },
    [status],
  );

  const onPullClick = useCallback(() => {
    void doPull();
  }, [doPull]);

  // Force-pull is destructive. The type-to-confirm modal (with a
  // preview of which local files + commits will be discarded) replaces
  // the bare `window.confirm()` we used to show — a previous user
  // already lost data clicking through that blind confirm. See
  // ``components/ForceResetModal.tsx``.
  const onForcePullClick = useCallback(() => {
    setForceModalOpen(true);
  }, []);
  const onForcePullConfirmed = useCallback(() => {
    setForceModalOpen(false);
    void doPull({ force: true });
  }, [doPull]);

  // Not connected — render the connect CTA.
  if (status && !status.connected) {
    return (
      <section className="mt-6 bg-amber-50 border border-amber-300 rounded-xl p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h2 className="text-sm uppercase tracking-wider text-amber-900 font-semibold">
            GitHub sync · not connected
          </h2>
        </div>
        <p className="mt-2 text-sm text-amber-900 leading-relaxed">
          Your wiki is currently on our ephemeral disk only. It can be wiped
          on the next cold start. Connect a GitHub repo to push every edit
          to your own account.
        </p>
        <div className="mt-4">
          <Link
            href={tenantId ? `/welcome` : `/welcome`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft"
          >
            Connect a GitHub repo <span aria-hidden>→</span>
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-6 bg-white border border-paper-soft rounded-xl p-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-sm uppercase tracking-wider text-ink-muted font-semibold">
          GitHub sync{" "}
          {status?.connected && (
            <span
              className={`ml-1 normal-case font-medium ${
                status.last_error ? "text-red-700" : "text-emerald-700"
              }`}
            >
              · {status.last_error ? "errored" : "connected"}
            </span>
          )}
        </h2>
        <button
          onClick={refresh}
          className="text-xs text-ink-muted underline hover:text-ink"
        >
          refresh
        </button>
      </div>

      {!status && !loadError && (
        <p className="mt-2 text-sm text-ink-muted">Loading sync status…</p>
      )}
      {loadError && (
        <p className="mt-2 text-sm text-red-700">
          Couldn&apos;t load sync status: {loadError}
        </p>
      )}

      {status?.connected && (
        <>
          <div className="mt-3 text-sm">
            <span className="text-ink-muted">Repo: </span>
            <a
              href={status.html_url}
              target="_blank"
              rel="noreferrer"
              className="text-ink font-mono underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              {status.repo}
            </a>
            <span className="text-ink-muted"> · branch </span>
            <span className="text-ink font-mono">{status.branch}</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <dt className="text-ink-muted uppercase tracking-wider">
                Last synced
              </dt>
              <dd className="mt-0.5 text-ink">
                {status.last_synced_at
                  ? new Date(status.last_synced_at * 1000).toLocaleString()
                  : "never"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted uppercase tracking-wider">
                Pushes
              </dt>
              <dd className="mt-0.5 text-ink">{status.pushes_made}</dd>
            </div>
            <div>
              <dt className="text-ink-muted uppercase tracking-wider">
                Pending
              </dt>
              <dd className="mt-0.5 text-ink">
                {status.pending_message_count ?? 0}
                {status.timer_scheduled && (
                  <span className="ml-1 text-amber-700">
                    · timer scheduled
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {status.last_error && (
            <div className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800">
              <div className="font-semibold uppercase tracking-wider">
                Last sync error
              </div>
              <pre className="mt-1 whitespace-pre-wrap font-mono leading-snug">
                {status.last_error}
              </pre>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={doSync}
              disabled={syncing || pulling}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-ink text-paper text-xs font-medium hover:bg-ink-soft disabled:opacity-60"
              title="Push local edits up to GitHub now"
            >
              {syncing ? "Pushing…" : "Sync now (push)"}
            </button>
            <button
              onClick={onPullClick}
              disabled={syncing || pulling}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-ink text-ink text-xs font-medium hover:bg-paper-soft disabled:opacity-60"
              title="Fetch any edits made directly on GitHub (or another device) and apply them here"
            >
              {pulling ? "Pulling…" : "Pull from GitHub"}
            </button>
            {syncResult && syncResult.ok && (
              <span className="text-xs text-emerald-700">
                {syncResult.result.pushed
                  ? `pushed: ${syncResult.result.commit_summary ?? "(committed)"}`
                  : syncResult.result.skipped
                    ? `skipped: ${syncResult.result.skipped}`
                    : "synced"}
              </span>
            )}
            {syncResult && !syncResult.ok && (
              <span className="text-xs text-red-700">
                error: {syncResult.result.error}
              </span>
            )}
            {pullResult && pullResult.ok && (
              <span className="text-xs text-emerald-700">
                {pullResult.result.action === "pulled" &&
                  `pulled ${pullResult.result.behind} commit${pullResult.result.behind === 1 ? "" : "s"} from GitHub`}
                {pullResult.result.action === "forced" &&
                  `force-reset to origin/${status.branch}`}
                {pullResult.result.action === "up_to_date" &&
                  "already up to date"}
                {pullResult.result.action === "ahead_only" &&
                  `nothing to pull · ${pullResult.result.ahead} local commit${pullResult.result.ahead === 1 ? "" : "s"} waiting to push`}
              </span>
            )}
            {pullResult && !pullResult.ok && (
              <div className="basis-full">
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                  <div className="font-semibold uppercase tracking-wider">
                    Pull blocked
                    {pullResult.result.action !== "noop" && (
                      <span className="ml-1 normal-case font-mono">
                        · {pullResult.result.action}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 leading-snug">{pullResult.result.error}</p>
                  {(pullResult.result.action === "diverged" ||
                    pullResult.result.action === "dirty") && (
                    <button
                      onClick={onForcePullClick}
                      className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-700 text-amber-900 text-[10px] font-medium hover:bg-amber-100"
                    >
                      Force pull (discard local)
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <p className="mt-4 text-xs text-ink-muted leading-relaxed">
            Local edits auto-push to{" "}
            <a
              href={status.html_url}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2"
            >
              {status.repo}
            </a>{" "}
            within a few seconds (debounced). Edits you make directly on
            GitHub (web editor, local clone, another device) pull down
            automatically when you log in, or anytime you hit{" "}
            <span className="font-mono">Pull from GitHub</span>. You own
            the repo — clone it, fork it, take your wiki anywhere.
          </p>
        </>
      )}

      <ForceResetModal
        open={forceModalOpen}
        onClose={() => setForceModalOpen(false)}
        onConfirm={onForcePullConfirmed}
        isRunning={pulling}
      />
    </section>
  );
}

const RENDER_DEPLOY_URL =
  "https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fprofessorpalmer%2Fportable-llm-wiki";

function OwnerDemoPreview() {
  const features: { label: string; desc: string; path?: string }[] = [
    {
      label: "Frictionless capture",
      desc: "Paste, screenshot, or voice memo. Anything becomes a raw source the wiki can grow from.",
      path: "/capture",
    },
    {
      label: "Bulk import wizard",
      desc: "Drop a resume, LinkedIn export, or PDF stack. Drafts 6-12 starter wiki pages with cross-references.",
    },
    {
      label: "Share tokens",
      desc: "Mint URLs scoped to a tier (recruiter, friend) with optional expiry. One link per audience.",
    },
    {
      label: "Lint swarm",
      desc: "Four Puppetmaster agents audit in parallel: contradictions, stale claims, missing pages, public-tier leaks. Self-host only.",
    },
    {
      label: "Preview-as-tier",
      desc: "View the wiki through a downgraded viewer. Audit exactly what a recruiter or anonymous visitor sees.",
    },
    {
      label: "In-browser page editor",
      desc: "Edit any wiki page from the browser. Writes commit straight to your markdown folder.",
    },
  ];

  return (
    <section className="mt-6 rounded-2xl border border-ink bg-ink text-paper p-6 sm:p-7">
      <div className="text-[11px] uppercase tracking-[0.18em] text-accent font-semibold">
        Demo preview
      </div>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight">
        What&apos;s behind this gate.
      </h2>
      <p className="mt-2 text-sm text-paper/70 leading-relaxed max-w-2xl">
        This deployment is the public Avery Chen demo, so write access is
        token-gated. On your own instance, the owner token unlocks every
        operation below. Spin one up free in ~60 seconds.
      </p>

      <ul className="mt-5 grid sm:grid-cols-2 gap-3">
        {features.map((f) => (
          <li
            key={f.label}
            className="rounded-lg bg-paper/5 border border-paper/10 p-3"
          >
            <div className="text-sm font-semibold text-paper">{f.label}</div>
            <div className="mt-1 text-xs text-paper/70 leading-relaxed">
              {f.desc}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap gap-3 items-center">
        <a
          href={RENDER_DEPLOY_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-paper text-ink text-sm font-medium hover:bg-paper-soft"
        >
          Deploy to Render <span aria-hidden>→</span>
        </a>
        <span className="text-xs text-paper/60">
          Or paste your <code className="font-mono">OWNER_TOKEN</code> below
          if you&apos;re already running locally.
        </span>
      </div>
    </section>
  );
}
