"use client";

// Post-signup onboarding wizard.
//
// Flow:
//   1. /api/backend/auth/me confirms the GitHub session and gives us the
//      caller's tenant_id, login, display name, and avatar.
//   2. The user picks a seeding source — paste a bio / scrape a URL /
//      (later) pick a persona — and submits.
//   3. We POST to /api/backend/onboarding/import-{text,url}. On a self-
//      hosted install with the Puppetmaster CLI available, this kicks
//      off an agentic orchestrator job. On the hosted site (no
//      Puppetmaster binary), the backend falls through to a direct LLM
//      call that drafts the first pages synchronously.
//   4. We poll /api/backend/owner/jobs/{tracking_id} for the agentic
//      path, OR read pages_created directly off the response for the
//      direct path. Then we show the share CTAs.
//
// Style aligns with app/page.tsx tokens: paper/ink/accent.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiBase,
  onboardingAssemble,
  onboardingCleanupImports,
  onboardingConnectRepo,
  onboardingImportWiki,
  onboardingListMyRepos,
  ownerSyncCheck,
  ownerSyncPull,
  type PullSafety,
  type SyncPullResult,
  type AssembleAnswerInput,
  type AssembleTextSourceInput,
  type AssembleUrlResult,
  type AssembleUrlSourceInput,
  type ConnectRepoResponse,
  type GitHubRepoSummary,
  type GitHubSyncStatus,
  type ImportWikiResponse,
  type MyReposResponse,
  type OnboardingAssembleResponse,
} from "@/lib/api";
import { ConnectMarionetteButton } from "@/components/ConnectMarionetteButton";
import {
  buildOwnerConnectPath,
  isMarionetteClient,
  rememberMarionetteClientFromLocation,
} from "@/lib/marionetteConnect";

// ---------- API shapes ----------------------------------------------------

type AuthUser = {
  tenant_id: string;
  login: string;
  name: string;
  avatar_url: string;
};

type AuthMeResponse = {
  authenticated: boolean;
  user?: AuthUser;
  tenant?: { id: string; display_name?: string };
  fresh_signup?: boolean;
  // Live count of markdown pages in the signed-in user's tenant. The
  // page uses this (not the historical ``fresh_signup`` flag) to decide
  // whether to render the import wizard or the "already onboarded"
  // bouncer — see commit thread on the "I already had a wiki and now
  // it imported it duped" bug. ``fresh_signup`` is kept for back-compat
  // but should equal ``page_count === 0`` on a current backend.
  page_count?: number;
  // Count of files matching ``*-imported*.md`` under the tenant's wiki.
  // Surfaces the "Clean up duplicates" CTA when > 0.
  duplicate_imports_count?: number;
  // GitHub sync connection state. The welcome page reads this BEFORE
  // the import wizard — if the tenant isn't connected to a repo yet,
  // we render the connect-repo step first. This is the gatekeeper
  // that turns "ephemeral storage on our box" into "your data, your
  // GitHub repo, portable forever".
  github_sync?: GitHubSyncStatus;
};

type ImportResponse = {
  ok: boolean;
  raw_path: string;
  orchestrator_started: boolean;
  tracking_id?: string;
  tenant_id: string;
  orchestrator_error?: string;
  // Direct-LLM drafter result (hosted path, no Puppetmaster). When the
  // orchestrator didn't start but pages_created > 0, the draft actually
  // succeeded synchronously — the UI must treat that as success, not as
  // "orchestrator unavailable".
  pages_created?: number;
  draft_error?: string;
  scraped?: {
    url: string;
    title?: string;
    description?: string;
    content_excerpt?: string;
    word_count?: number;
    errors?: string[];
  };
};

type JobStatus = {
  tracking_id: string;
  kind?: string;
  status: "running" | "done" | "error";
  started_at?: string;
  ended_at?: string | null;
  summary?: string | null;
  log_tail?: string;
};

// The primary onboarding path is "assemble" — a guided checklist that
// collects a few interview answers, pasted high-signal documents (resume,
// LinkedIn About), and optional URLs, then submits the bundle as one
// starter-wiki draft. "wiki" remains as the secondary "I already have a
// markdown wiki to import" path. The old standalone paste / scrape tabs
// are folded into the assemble flow so users aren't asked to pick ONE
// source — a single source produces a thin, padded starter wiki.
type Tab = "assemble" | "wiki";

// ---- Interview prompts -----------------------------------------------
//
// 4 prompts, all optional. The frontend posts the literal `prompt` text
// alongside the answer so the catalog stays editable here without a
// backend deploy. Keep these focused on signal the LLM drafter can
// actually attribute claims to — "what are you working on" beats "what
// inspires you" because the former produces named project pages.
type InterviewPrompt = {
  id: string;
  prompt: string;
  placeholder: string;
  hint: string;
};

const INTERVIEW_PROMPTS: InterviewPrompt[] = [
  {
    id: "identity",
    prompt: "Who are you? (role, what you do, where)",
    placeholder:
      "e.g. Staff engineer at a small biotech. Mostly Python + TypeScript. Based in Toronto.",
    hint: "One or two sentences is fine. The wiki uses this to build the page about you.",
  },
  {
    id: "current",
    prompt: "What are you working on right now?",
    placeholder:
      "e.g. Building portablellm.wiki (a portable personal LLM wiki). Also helping ship a clinical trial dashboard at $DAY_JOB.",
    hint: "Named projects beat vague themes — the drafter spins these into project pages.",
  },
  {
    id: "preferences",
    prompt: "What should LLMs know about how you think and work?",
    placeholder:
      "e.g. Prefer concise, verbatim answers. Skeptical of magic abstractions. Big on testing before refactoring.",
    hint: "Operating principles, strong opinions, working style — anything that would change how an LLM should respond to you.",
  },
  {
    id: "links",
    prompt: "Anything else you want me to know about you?",
    placeholder:
      "e.g. Background in synthetic biology. Read Karpathy's nanoGPT essays a lot. Talked at PyCon 2024 about ergonomics in scientific Python.",
    hint: "Loose context — past work, interests, formative things. Skip if nothing comes to mind.",
  },
];

// ---- Paste source presets --------------------------------------------
//
// Three named text-source slots + one freeform. Each maps to an
// `AssembleTextSourceInput` with `kind` set so the backend drafter can
// attribute pages back to the right source ("from the resume…",
// "from the LinkedIn About…").
type TextSlotId = "resume" | "linkedin" | "github_readme" | "freeform";

type TextSlotConfig = {
  id: TextSlotId;
  // Backend `kind` value sent in the assembly payload.
  kind: string;
  title: string;
  hint: string;
  placeholder: string;
};

const TEXT_SLOTS: TextSlotConfig[] = [
  {
    id: "resume",
    kind: "resume",
    title: "Resume or CV",
    hint: "Paste the text of your most up-to-date resume.",
    placeholder:
      "Paste your resume here — work history, education, skills. Plain text is fine.",
  },
  {
    id: "linkedin",
    kind: "linkedin",
    title: "LinkedIn About / bio",
    hint: "Open your LinkedIn profile and copy the About section.",
    placeholder:
      "Paste your LinkedIn About section, Twitter bio, or any short profile blurb.",
  },
  {
    id: "github_readme",
    kind: "github-readme",
    title: "GitHub profile README",
    hint: "github.com/<your-username> — copy the markdown.",
    placeholder:
      "Paste your GitHub profile README markdown — or any project README that represents your work.",
  },
  {
    id: "freeform",
    kind: "freeform",
    title: "Anything else",
    hint: "A brain dump works. Notes, decisions, current goals.",
    placeholder:
      "Anything else you want LLMs to know — current goals, things you decided recently, context that doesn't fit above.",
  },
];

const POLL_INTERVAL_MS = 3000;

// ---- Wizard state machine --------------------------------------------

type WizardPhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "running";
      trackingId: string | null;
      rawPath: string;
      orchestratorStarted: boolean;
      orchestratorError?: string;
      // Pages the direct-LLM drafter produced synchronously (hosted
      // path). When set > 0 with no orchestrator job, the "running"
      // phase is a momentary pass-through to a successful "done".
      pagesCreated?: number;
      draftError?: string;
      startedAt: number;
      lastStatus?: JobStatus;
      // Populated when the running phase was reached via the guided
      // assembly path — drives the "we read N of M URLs" pill on the
      // progress panel.
      assembleSummary?: AssembleSummary;
    }
  | {
      kind: "done";
      trackingId: string | null;
      rawPath: string;
      summary: string | null;
      orchestratorStarted: boolean;
      // Pages drafted synchronously by the direct-LLM fallback (hosted
      // path). Drives the done-view footer so we say "Drafted N pages"
      // instead of the misleading "Orchestrator was unavailable" when
      // the draft actually succeeded without an orchestrator job.
      pagesCreated?: number;
      draftError?: string;
      // When the user completes via the "Import wiki" tab the seeding
      // is synchronous (no orchestrator job) and we land here straight
      // away with the counts populated.
      wikiImport?: {
        importedCount: number;
        conflicts: string[];
        skipped: string[];
        sourceUrl: string;
      };
      // When the user completes via the guided-assembly path.
      assembleSummary?: AssembleSummary;
    }
  | {
      kind: "error";
      message: string;
      rawPath?: string;
      orchestratorStarted?: boolean;
    };

// Snapshot of how the assembled bundle was received server-side. Carried
// through the "running" and "done" phases so the progress / share UIs
// can show partial-URL failures and the "we received N answers / M
// pastes" pill.
type AssembleSummary = {
  answersCount: number;
  textCount: number;
  urls: AssembleUrlResult[];
  usableUrlCount: number;
  pagesCreated?: number;
};

// Stable-ish unique id for dynamic URL rows. We don't need crypto here —
// the id just needs to be unique within a single mount so React keys
// don't collide when the user adds/removes rows quickly.
function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- Page ----------------------------------------------------------

export default function WelcomePage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  // Page count of the signed-in user's tenant — set during the auth
  // check. ``null`` while the auth call is in flight, then a real
  // number (0 for fresh signups, > 0 for returning users).
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [duplicateCount, setDuplicateCount] = useState<number>(0);
  // GitHub sync connection state. Null until the auth check resolves.
  // Drives the connect-repo step: if !syncStatus?.connected we render
  // the picker BEFORE letting the user import anything, since import
  // would otherwise drop content into ephemeral storage that gets
  // wiped on every Render cold start.
  const [syncStatus, setSyncStatus] = useState<GitHubSyncStatus | null>(null);
  // User-facing override: returning users see an "already onboarded"
  // bouncer by default. If they click "Import anyway" we flip this to
  // true and render the import wizard with force_overwrite enabled.
  const [forceImport, setForceImport] = useState(false);
  // After connect-repo seeds a private starter wiki, page_count > 0
  // but the user has not added a first source yet. Keep them on the
  // assemble step instead of the AlreadyOnboarded bouncer (which would
  // send them to a wiki they have not authored).
  const [needsFirstSource, setNeedsFirstSource] = useState(false);

  const [tab, setTab] = useState<Tab>("assemble");
  // Interview answers, keyed by INTERVIEW_PROMPTS[].id.
  const [assembleAnswers, setAssembleAnswers] = useState<Record<string, string>>(
    {},
  );
  // Pasted text sources, keyed by TEXT_SLOTS[].id. Values are the raw
  // content — empty string means "skip this slot".
  const [assembleText, setAssembleText] = useState<Record<TextSlotId, string>>({
    resume: "",
    linkedin: "",
    github_readme: "",
    freeform: "",
  });
  // Dynamic URL list. Starts with one empty row so the form looks
  // populated and the user can paste a URL without clicking "Add".
  const [assembleUrls, setAssembleUrls] = useState<
    Array<{ id: string; url: string; label: string }>
  >(() => [{ id: makeId(), url: "", label: "" }]);

  const [wikiUrlValue, setWikiUrlValue] = useState("");
  // "verbatim" expects a portable-llm-wiki layout (top-level wiki/);
  // "standardize" walks any markdown and runs it through the LLM
  // drafter so an Obsidian / Logseq / notes/ user lands on a real
  // Karpathy-schema wiki even though their source layout doesn't match.
  const [wikiMode, setWikiMode] = useState<"verbatim" | "standardize">(
    "verbatim",
  );

  const [phase, setPhase] = useState<WizardPhase>({ kind: "idle" });

  // Marionette opens /welcome?client=marionette — remember across wizard steps
  // so DoneView can auto-handoff the owner personal LLM URL.
  useEffect(() => {
    rememberMarionetteClientFromLocation();
  }, []);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ---- Auth + state fetcher ---------------------------------------------
  //
  // Extracted from the mount effect so callers downstream (the connect-repo
  // step, in particular) can re-run it after a server-side state change.
  // Without re-running, a successful connect against a populated repo
  // would leave ``pageCount`` stale at 0 — the value captured at mount
  // before the clone happened — and the welcome flow would bounce the
  // user into the import wizard instead of the AlreadyOnboarded panel.
  // That's how a user with an already-populated wiki repo ended up
  // looking at "Paste your LinkedIn bio" right after a successful
  // connect.
  //
  // Returns the parsed body so callers can also read the freshly-fetched
  // values directly (e.g. to decide whether to redirect) without
  // depending on state propagation in the same render.
  //
  // We deliberately DO NOT silently redirect to ``/signup`` on auth
  // failure. That used to create an infinite OAuth loop if the session
  // cookie couldn't make it back to the API host (cross-host cookie
  // issues, third-party cookie blocking, etc.).

  const fetchAuthMe = useCallback(
    async (opts: { signal?: AbortSignal } = {}): Promise<AuthMeResponse | null> => {
      const r = await fetch(`${apiBase()}/auth/me`, {
        credentials: "include",
        cache: "no-store",
        signal: opts.signal,
      });
      if (!r.ok) {
        setAuthError(
          `Could not verify your sign-in (HTTP ${r.status}). Try refreshing, or sign in again.`,
        );
        return null;
      }
      const data = (await r.json()) as AuthMeResponse;
      if (!data.authenticated || !data.user) {
        setAuthError(
          "We finished signing you in with GitHub, but the session cookie didn't make it back. This usually means third-party cookies are blocked. Try a different browser or unblock cookies for portablellm.wiki.",
        );
        return data;
      }
      setUser(data.user);
      setPageCount(data.page_count ?? 0);
      setDuplicateCount(data.duplicate_imports_count ?? 0);
      setSyncStatus(
        data.github_sync ?? {
          connected: false,
          repo: "",
          branch: "main",
          html_url: "",
          last_synced_at: 0,
          last_error: "",
          pushes_made: 0,
        },
      );
      return data;
    },
    [],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        await fetchAuthMe({ signal: ctrl.signal });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setAuthError(
          `Network error while checking your sign-in: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      } finally {
        if (!ctrl.signal.aborted) setLoadingAuth(false);
      }
    })();
    return () => {
      ctrl.abort();
    };
  }, [fetchAuthMe]);

  // ---- Submit handlers ----------------------------------------------------

  const handleAuthError = useCallback(() => {
    router.replace("/signup");
  }, [router]);

  const beginJob = useCallback(
    (resp: ImportResponse, assembleSummary?: AssembleSummary) => {
      setPhase({
        kind: "running",
        trackingId: resp.tracking_id ?? null,
        rawPath: resp.raw_path,
        orchestratorStarted: resp.orchestrator_started,
        orchestratorError: resp.orchestrator_error,
        // Carry the direct-drafter outcome so the "no orchestrator job"
        // pass-through to "done" can report real success/failure rather
        // than defaulting to "Orchestrator was unavailable".
        pagesCreated: resp.pages_created ?? assembleSummary?.pagesCreated,
        draftError: resp.draft_error,
        startedAt: Date.now(),
        assembleSummary,
      });
    },
    [],
  );

  // ---- Guided assembly: bundle answers + pastes + URLs into one draft ----
  //
  // Builds the payload from the assembly state, sends it to
  // /onboarding/assemble, and either jumps straight to the "done" phase
  // (synchronous direct-LLM drafter path) or hands off to the job
  // polling loop (Puppetmaster orchestrator path). Mirrors the
  // text/URL import flows so the existing ProgressSection works for
  // assembly too — the only difference is we also stash an
  // AssembleSummary so DoneView / RunningView can show partial-URL
  // outcomes.
  const submitAssemble = useCallback(async () => {
    // Mirror the backend's "must have at least one non-empty input"
    // guard so we never even fire the request on an empty bundle.
    const answers: AssembleAnswerInput[] = INTERVIEW_PROMPTS
      .map((p) => ({ question: p.prompt, answer: (assembleAnswers[p.id] ?? "").trim() }))
      .filter((a) => a.answer.length > 0);
    const textSources: AssembleTextSourceInput[] = TEXT_SLOTS
      .map((slot) => ({
        kind: slot.kind,
        label: slot.title,
        content: (assembleText[slot.id] ?? "").trim(),
      }))
      .filter((s) => s.content.length > 0);
    const urls: AssembleUrlSourceInput[] = assembleUrls
      .map((row) => ({ url: row.url.trim(), label: row.label.trim() }))
      .filter((u) => u.url.length > 0);

    if (answers.length === 0 && textSources.length === 0 && urls.length === 0) {
      setSubmitError(
        "Answer at least one question, paste something, or add a URL before drafting.",
      );
      return;
    }

    setSubmitError(null);
    setPhase({ kind: "submitting" });
    try {
      let data: OnboardingAssembleResponse;
      try {
        data = await onboardingAssemble({
          answers,
          text_sources: textSources,
          urls,
          run_orchestrator: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        // backendFetch surfaces "<status> <body>" — surface 401s as
        // the session-recovery flow so a stale cookie doesn't trap
        // the user on /welcome.
        if (msg.startsWith("401 ")) {
          handleAuthError();
          return;
        }
        throw new Error(msg);
      }

      const assembleSummary: AssembleSummary = {
        answersCount: data.answers_count,
        textCount: data.text_count,
        urls: data.urls,
        usableUrlCount: data.usable_url_count,
        pagesCreated: data.pages_created,
      };

      // The assemble response is a superset of the ImportResponse, so
      // beginJob (which handles orchestrator-running vs synchronous
      // draft) does the right thing in both adapter modes.
      const importShape: ImportResponse = {
        ok: data.ok,
        raw_path: data.raw_path,
        orchestrator_started: data.orchestrator_started ?? false,
        tracking_id: data.tracking_id ?? undefined,
        tenant_id: data.tenant_id,
        orchestrator_error: data.orchestrator_error,
        pages_created: data.pages_created,
        draft_error: data.draft_error,
      };
      beginJob(importShape, assembleSummary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setSubmitError(msg);
      setPhase({ kind: "idle" });
    }
  }, [
    assembleAnswers,
    assembleText,
    assembleUrls,
    beginJob,
    handleAuthError,
  ]);

  // ---- Bring-your-own-wiki: clone a GitHub portable-llm-wiki repo ---------
  //
  // Unlike text/URL imports, this is fully synchronous on the backend
  // (we git-clone, copy markdown, reload the index, return) so there's
  // no Puppetmaster job to poll. We jump straight from "submitting" to
  // "done" with the import counts attached.

  const submitWiki = useCallback(async () => {
    const trimmed = wikiUrlValue.trim();
    if (!trimmed) return;
    setSubmitError(null);
    setPhase({ kind: "submitting" });
    try {
      const data: ImportWikiResponse = await onboardingImportWiki({
        github_url: trimmed,
        // Mirror the user's explicit "Import additional content anyway"
        // override from the AlreadyOnboarded bouncer. When false (fresh
        // signup case), the backend still happily imports — the guard
        // only fires when there's existing content to protect.
        force_overwrite: forceImport,
        mode: wikiMode,
      });
      const echoedMode = data.mode ?? wikiMode;
      // Summary copy diverges by mode: verbatim is "we copied N pages",
      // standardize is "we drafted N new pages from M notes".
      const summary =
        echoedMode === "standardize"
          ? `Drafted ${data.pages_created ?? data.imported_count} page${
              (data.pages_created ?? data.imported_count) === 1 ? "" : "s"
            } from ${data.files_walked?.length ?? 0} markdown file${
              (data.files_walked?.length ?? 0) === 1 ? "" : "s"
            } in ${data.source_url}`
          : `Imported ${data.imported_count} page${
              data.imported_count === 1 ? "" : "s"
            } from ${data.source_url}`;
      setPhase({
        kind: "done",
        trackingId: null,
        rawPath: data.raw_path ?? "",
        summary,
        orchestratorStarted: false,
        wikiImport: {
          importedCount: data.imported_count,
          // Verbatim mode populates these; standardize mode leaves them
          // empty (its conflicts are slug-suffix handled inside the
          // drafter's _write_pages helper, which already returns OK).
          conflicts: data.conflicts ?? [],
          skipped: data.skipped ?? [],
          sourceUrl: data.source_url,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      // Network failures look like "401 …" from backendFetch — surface
      // the auth-error redirect if that's what happened.
      if (msg.startsWith("401 ")) {
        handleAuthError();
        return;
      }
      setSubmitError(msg);
      setPhase({ kind: "idle" });
    }
  }, [wikiUrlValue, handleAuthError, forceImport, wikiMode]);

  // ---- Poll job status ----------------------------------------------------

  useEffect(() => {
    if (phase.kind !== "running") return;
    if (!phase.trackingId) {
      // No orchestrator job at all — treat as finished-with-warning so
      // the user still sees the share CTAs (their raw file landed).
      setPhase({
        kind: "done",
        trackingId: null,
        rawPath: phase.rawPath,
        summary: null,
        orchestratorStarted: false,
        // Carry the direct-drafter result forward so the done view
        // reports "Drafted N pages" instead of "Orchestrator was
        // unavailable" when the synchronous LLM path actually produced
        // pages (the common hosted case).
        pagesCreated: phase.pagesCreated,
        draftError: phase.draftError,
        // Preserve the assembly summary so the done view can still
        // show "received N answers / M pastes / read X of Y URLs"
        // when the synchronous direct-LLM path short-circuited the
        // orchestrator job.
        assembleSummary: phase.assembleSummary,
      });
      return;
    }

    let cancelled = false;
    const trackingId = phase.trackingId;

    const tick = async () => {
      try {
        const r = await fetch(
          `${apiBase()}/owner/jobs/${encodeURIComponent(trackingId)}`,
          { credentials: "include", cache: "no-store" },
        );
        if (cancelled) return;
        if (!r.ok) {
          // 401 means session evaporated; otherwise transient — keep polling.
          if (r.status === 401) {
            handleAuthError();
            return;
          }
          return;
        }
        const data = await r.json();
        const job: JobStatus =
          data && typeof data === "object" && "job" in data && data.job
            ? { ...(data.job as JobStatus), log_tail: data.log_tail }
            : (data as JobStatus);
        setPhase((p) =>
          p.kind === "running" ? { ...p, lastStatus: job } : p,
        );
        if (job.status === "done") {
          setPhase((p) =>
            p.kind === "running"
              ? {
                  kind: "done",
                  trackingId,
                  rawPath: p.rawPath,
                  summary: job.summary ?? null,
                  orchestratorStarted: p.orchestratorStarted,
                  // Carry the assembly recap into the done view so
                  // partial-URL failures don't silently vanish once
                  // the orchestrator finishes.
                  assembleSummary: p.assembleSummary,
                }
              : p,
          );
        } else if (job.status === "error") {
          setPhase((p) =>
            p.kind === "running"
              ? {
                  kind: "error",
                  message: job.summary || "Orchestrator reported an error.",
                  rawPath: p.rawPath,
                  orchestratorStarted: p.orchestratorStarted,
                }
              : p,
          );
        }
      } catch {
        // Network blip — let the next interval try again.
      }
    };

    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase.kind, phase.kind === "running" ? phase.trackingId : null, handleAuthError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Render --------------------------------------------------------------

  if (loadingAuth) {
    return (
      <div className="max-w-3xl mx-auto px-5 py-20 text-ink-muted text-sm">
        Checking your session…
      </div>
    );
  }
  if (authError) {
    return (
      <div className="max-w-2xl mx-auto px-5 py-16 sm:py-20">
        <p className="text-xs uppercase tracking-[0.2em] text-accent font-medium">
          Sign-in problem
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-ink">
          We can&apos;t finish signing you in
        </h1>
        <p className="mt-4 text-ink-muted leading-relaxed">{authError}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/signup"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Try signing in again
          </Link>
          <Link
            href="/"
            className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:border-ink-muted"
          >
            Back to home
          </Link>
        </div>
      </div>
    );
  }
  if (!user) return null;

  // Compute the step badge ONCE in the parent so the outer Header and
  // the inner card stop disagreeing. Previously Header always rendered
  // "Step 1 of 1" while ConnectRepoStep rendered its own "Step 1 of 2"
  // — two badges on the same screen, two different totals. Single
  // source of truth here based on the actual render branch below.
  //
  // Branch              | stepBadge
  // ------------------- | -----------------------------------------
  // Not connected, fresh| "Step 1 of 2 — Connect GitHub"
  // Not connected, mig  | "One-time upgrade"
  // Connected, no pages | "Step 2 of 2 — Seed your wiki"
  // Connected, has pages| null (bouncer panel — not a step)
  const isFreshSignup = (pageCount ?? 0) === 0;
  let stepBadge: string | null;
  if (syncStatus !== null && !syncStatus.connected) {
    stepBadge = isFreshSignup
      ? "Step 1 of 2 — Connect GitHub"
      : "One-time upgrade";
  } else if (
    pageCount !== null &&
    pageCount > 0 &&
    !forceImport &&
    !needsFirstSource
  ) {
    stepBadge = null;
  } else {
    stepBadge = "Step 2 of 2 — Seed your wiki";
  }

  // Step 0: Connect to GitHub. Without a connected repo the wiki lives
  // only on our ephemeral Render disk and gets wiped on every cold
  // start. We gate the rest of the onboarding behind this step so no
  // one ever loses data to a redeploy. Existing tenants who pre-date
  // this feature also flow through here on next visit (one-time
  // migration to per-user GitHub sync).
  if (phase.kind === "idle" && syncStatus !== null && !syncStatus.connected) {
    return (
      <div className="max-w-3xl mx-auto px-5 py-10 sm:py-14">
        <Header user={user} stepBadge={stepBadge} />
        <ConnectRepoStep
          user={user}
          pageCount={pageCount ?? 0}
          // Re-fetch full auth state on a successful connect so the
          // parent's pageCount + syncStatus reflect what bootstrap_tenant
          // just put on disk. Without this re-fetch, a connect against
          // a populated repo (e.g. switching to an existing cary-wiki)
          // would leave pageCount stale at 0 and bounce the user into
          // the import wizard instead of the AlreadyOnboarded panel.
          onConnected={async (status, meta) => {
            // Optimistic update first so the connect step disappears
            // immediately — re-fetch lands a moment later with the
            // authoritative counts.
            setSyncStatus(status);
            if (meta?.keepOnFirstSource) {
              setNeedsFirstSource(true);
            }
            try {
              const me = await fetchAuthMe();
              // Seed failed or not yet visible: still empty → stay on
              // the assemble step instead of an empty tenant home.
              if ((me?.page_count ?? 0) === 0) {
                setNeedsFirstSource(true);
              }
            } catch {
              // Best-effort. If the re-fetch fails, keep the user on
              // the first-source form rather than dumping them home.
              setNeedsFirstSource(true);
            }
          }}
        />
      </div>
    );
  }

  // Returning-user bouncer. If the signed-in user's wiki already has
  // content (page_count > 0), render an "already onboarded" panel
  // instead of the import wizard. This is the fix for the bug where a
  // user signs in a second time, lands back on /welcome, and re-runs
  // the wiki import — which previously created a duplicate copy of
  // every page suffixed with -imported.
  //
  // Override path: ``forceImport`` flips on when the user explicitly
  // clicks "Import additional content" from the bouncer. We pass
  // ``force_overwrite=true`` to the backend in that case so the
  // matching server-side guard also lets the call through.
  if (
    phase.kind === "idle" &&
    pageCount !== null &&
    pageCount > 0 &&
    !forceImport &&
    !needsFirstSource
  ) {
    return (
      <div className="max-w-3xl mx-auto px-5 py-10 sm:py-14">
        <Header user={user} stepBadge={stepBadge} />
        <AlreadyOnboarded
          user={user}
          pageCount={pageCount}
          duplicateCount={duplicateCount}
          onForceImport={() => setForceImport(true)}
          onCleaned={(remaining) => setDuplicateCount(remaining)}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-5 py-10 sm:py-14">
      <Header user={user} stepBadge={stepBadge} />

      {phase.kind === "idle" || phase.kind === "submitting" ? (
        <FormSection
          tab={tab}
          setTab={setTab}
          assembleAnswers={assembleAnswers}
          setAssembleAnswers={setAssembleAnswers}
          assembleText={assembleText}
          setAssembleText={setAssembleText}
          assembleUrls={assembleUrls}
          setAssembleUrls={setAssembleUrls}
          wikiUrlValue={wikiUrlValue}
          setWikiUrlValue={setWikiUrlValue}
          wikiMode={wikiMode}
          setWikiMode={setWikiMode}
          submitAssemble={submitAssemble}
          submitWiki={submitWiki}
          submitting={phase.kind === "submitting"}
          submitError={submitError}
          forceImport={forceImport}
          needsFirstSource={needsFirstSource}
        />
      ) : (
        <ProgressSection phase={phase} user={user} />
      )}
    </div>
  );
}

// ---------- ConnectRepoStep — gate the wizard behind a GitHub repo --------
//
// This step is mandatory: without a connected repo, anything the user
// writes lives only on our ephemeral Render disk and gets wiped on the
// next cold start. By gating onboarding here we guarantee that every
// page they ever create lands in their own GitHub repo, and we hand
// over the keys: if our service goes dark tomorrow they still have the
// markdown.
//
// Two paths inside the picker:
//   * "Create new repo" — POST /user/repos creates ``<login>/portable-
//     llm-wiki`` (private by default). One click. This is the recommended
//     happy-path for fresh signups.
//   * "Use an existing repo" — dropdown of the user's GitHub repos.
//     Useful for users who already have a wiki repo, or who want to
//     name it themselves. The dropdown reuses the same data source
//     ``/onboarding/my-repos`` as the import wizard.
//
// On success we update parent state via ``onConnected`` so the welcome
// page proceeds to the AlreadyOnboarded bouncer (if pageCount > 0) or
// the import wizard (if pageCount === 0).

/** Detect the backend's 400-refusal when the user tries to bind their
 * wiki to the portable-llm-wiki product source repo (a repo with both
 * `backend/` and `frontend/` at root). The backend response is a plain
 * text detail string; we sniff for the unambiguous phrasing the guard
 * emits so we can swap the generic red error banner for a richer
 * callout that explains the situation and offers a one-click fix.
 *
 * Defensive: matches multiple phrases the backend uses so a future
 * wording tweak doesn't silently fall back to the generic banner.
 */
function isProductSourceRefusal(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (!lower.startsWith("400")) return false;
  return (
    lower.includes("product source") ||
    (lower.includes("backend") && lower.includes("frontend"))
  );
}

function ConnectRepoStep({
  user,
  pageCount,
  onConnected,
}: {
  user: AuthUser;
  pageCount: number;
  onConnected: (
    status: GitHubSyncStatus,
    meta?: { keepOnFirstSource?: boolean },
  ) => void;
}) {
  type Mode = "create" | "existing";
  const [mode, setMode] = useState<Mode>("create");
  // Default to ``my-portable-llm-wiki`` — DELIBERATELY distinct from the
  // product source repo name (``portable-llm-wiki``). GitHub's POST
  // /user/repos is idempotent, so if the user has a fork of the product
  // source at ``<login>/portable-llm-wiki`` and we used that as the
  // default, clicking "Create repo" would silently return the existing
  // fork and bind the wiki to it — which is exactly how the
  // tenant.json + OAuth token leak happened. See commit 879f45b.
  const [newRepoName, setNewRepoName] = useState("my-portable-llm-wiki");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repo picker state — only loaded if the user switches to "existing"
  // mode. We defer the API call to keep the initial render snappy and
  // to avoid hitting the GitHub rate limit on every page load.
  const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>("");

  const loadRepos = useCallback(async () => {
    setLoadingRepos(true);
    setReposError(null);
    try {
      const data: MyReposResponse = await onboardingListMyRepos();
      setRepos(data.repos);
      setNeedsReauth(!data.has_repo_scope);
      if (data.repos.length > 0 && !selectedRepo) {
        setSelectedRepo(data.repos[0].full_name);
      }
    } catch (e) {
      setReposError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setLoadingRepos(false);
    }
  }, [selectedRepo]);

  // Lazy-load the repo list the first time the user picks "existing".
  useEffect(() => {
    if (mode === "existing" && repos === null && !loadingRepos) {
      loadRepos();
    }
  }, [mode, repos, loadingRepos, loadRepos]);

  const submit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      let res: ConnectRepoResponse;
      if (mode === "create") {
        const name = newRepoName.trim();
        if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
          throw new Error(
            "Repo name can only contain letters, numbers, dots, dashes, and underscores.",
          );
        }
        res = await onboardingConnectRepo({
          create_new: true,
          name,
          private: newRepoPrivate,
        });
      } else {
        if (!selectedRepo) {
          throw new Error("Pick a repo from the dropdown first.");
        }
        res = await onboardingConnectRepo({
          create_new: false,
          repo: selectedRepo,
        });
      }
      if (!res.connected) {
        throw new Error(res.message || "Connect failed for an unknown reason.");
      }
      const starter = (
        res as { starter_seed?: { action?: string } }
      ).starter_seed;
      onConnected(
        res.status ?? {
          connected: true,
          repo: res.repo,
          branch: res.branch,
          html_url: res.html_url ?? `https://github.com/${res.repo}`,
          last_synced_at: 0,
          last_error: res.bootstrap?.error ?? "",
          pushes_made: 0,
        },
        { keepOnFirstSource: starter?.action === "seeded" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSubmitting(false);
    }
  }, [mode, newRepoName, newRepoPrivate, selectedRepo, onConnected]);

  const isMigration = pageCount > 0; // existing tenant getting upgraded

  return (
    <div
      data-testid="connect-repo-step"
      className="border border-paper-soft rounded-2xl bg-white p-6 sm:p-8"
    >
      {/* Step badge lives in the outer ``Header`` now — single source of
       * truth so a fresh signup's "Step 1 of 2" and a migration's
       * "One-time upgrade" copy can't disagree with whatever the
       * outer page header decided. */}
      <h2 className="text-2xl sm:text-3xl font-semibold text-ink leading-tight">
        {isMigration
          ? "Lock your wiki into your own GitHub."
          : "Pick a GitHub repo to hold your wiki."}
      </h2>
      <p className="mt-3 text-ink-muted leading-relaxed">
        {isMigration ? (
          <>
            Your <span className="text-ink font-medium">{pageCount}</span>{" "}
            existing {pageCount === 1 ? "page lives" : "pages live"} on our
            server right now. Connect a repo and we&apos;ll push them straight to{" "}
            <span className="text-ink font-medium">your</span> GitHub — every
            future edit syncs there automatically. If we ever go dark, you
            keep everything.
          </>
        ) : (
          <>
            Every page you create here gets pushed to{" "}
            <span className="text-ink font-medium">your</span> GitHub repo as
            plain markdown. You own the data, you can clone it locally any
            time, and if we ever go dark you keep everything. We never store a
            second copy you don&apos;t control.
          </>
        )}
      </p>

      <div className="mt-6 grid sm:grid-cols-2 gap-3">
        <ModeCard
          active={mode === "create"}
          onClick={() => setMode("create")}
          title="Create a new repo"
          body="Recommended. We make a private repo on your account and push your wiki to it."
        />
        <ModeCard
          active={mode === "existing"}
          onClick={() => setMode("existing")}
          title="Use an existing repo"
          body="Pick a repo you already own. We push your wiki to it (existing content is preserved)."
        />
      </div>

      <div className="mt-6">
        {mode === "create" ? (
          <div className="space-y-4">
            <label className="block">
              <span className="text-xs text-ink-muted uppercase tracking-wider font-semibold">
                Repo name
              </span>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-sm font-mono text-ink-muted">
                  github.com/{user.login}/
                </span>
                <input
                  value={newRepoName}
                  onChange={(e) => setNewRepoName(e.target.value)}
                  placeholder="my-portable-llm-wiki"
                  className="flex-1 border border-paper-soft rounded px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
                  disabled={submitting}
                />
              </div>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={newRepoPrivate}
                onChange={(e) => setNewRepoPrivate(e.target.checked)}
                className="mt-1"
                disabled={submitting}
              />
              <span>
                Make this repo private.{" "}
                <span className="text-ink-muted">
                  Recommended — your wiki probably contains personal context
                  you don&apos;t want indexed by Google.
                </span>
              </span>
            </label>
          </div>
        ) : (
          <div className="space-y-3">
            {loadingRepos && (
              <div className="text-sm text-ink-muted">
                Loading your GitHub repos…
              </div>
            )}
            {needsReauth && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                Your GitHub token can&apos;t see a private wiki. We ask
                for the <code>repo</code> scope so we can create/push one
                wiki repo and import yours. Re-authorize to continue. A
                GitHub App on just that one repo is the narrower path
                once it is live.
              </div>
            )}
            {reposError && (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                Couldn&apos;t load your repos: {reposError}
              </div>
            )}
            {repos && repos.length === 0 && (
              <div className="text-sm text-ink-muted">
                You have no repos to pick from. Switch to &quot;Create a new
                repo&quot; above.
              </div>
            )}
            {repos && repos.length > 0 && (
              <label className="block">
                <span className="text-xs text-ink-muted uppercase tracking-wider font-semibold">
                  Pick a repo
                </span>
                <select
                  value={selectedRepo}
                  onChange={(e) => setSelectedRepo(e.target.value)}
                  className="mt-1 w-full border border-paper-soft rounded px-3 py-2 text-sm font-mono focus:border-accent focus:outline-none"
                  disabled={submitting}
                >
                  {repos.map((r) => (
                    <option key={r.full_name} value={r.full_name}>
                      {r.full_name}
                      {r.private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </div>

      {error &&
        (isProductSourceRefusal(error) ? (
          <div
            className="mt-5 rounded-lg border-2 border-red-400 bg-red-50 p-4 text-sm text-red-900"
            data-testid="connect-repo-product-source-refusal"
          >
            <div className="font-semibold uppercase tracking-wider text-[11px] text-red-700">
              That repo isn&apos;t a wiki — it&apos;s our app source code
            </div>
            <p className="mt-2 leading-relaxed">
              You picked a repo that has both a{" "}
              <code className="font-mono bg-red-100 px-1 rounded">backend/</code>{" "}
              and a{" "}
              <code className="font-mono bg-red-100 px-1 rounded">frontend/</code>{" "}
              directory at the root — that&apos;s the shape of the{" "}
              <span className="font-medium">portable-llm-wiki</span> product
              source code, not a personal wiki. If we let you connect, every
              wiki edit would land as a commit in a repo full of TypeScript and
              Python, and a force-reset would overwrite your wiki with the app
              code.
            </p>
            <p className="mt-2 leading-relaxed">
              <span className="font-medium">Pick a different repo</span>, or
              create a fresh one — your wiki should live on its own.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setMode("create");
                  setError(null);
                }}
                className="px-3 py-1.5 rounded bg-red-700 text-white text-xs font-medium hover:bg-red-800"
              >
                Create a fresh repo instead
              </button>
              {mode === "existing" && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedRepo("");
                    setError(null);
                  }}
                  className="px-3 py-1.5 rounded border border-red-700 text-red-800 text-xs font-medium hover:bg-red-100"
                >
                  Pick a different existing repo
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        ))}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={submit}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-ink text-paper text-sm font-semibold hover:bg-ink-soft disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting
            ? "Connecting…"
            : mode === "create"
              ? "Create repo + connect"
              : "Connect this repo"}
        </button>
        <span className="text-xs text-ink-muted leading-relaxed">
          We ask GitHub for the <code>repo</code> scope so we can create
          and push one wiki repo on your account, and import a private
          wiki you already have. We do not need your other repositories.
          A GitHub App you install on just that one repo is the narrower
          path; we will switch to it once the App is live. No PAT to
          paste.
        </span>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-4 rounded-xl border transition ${
        active
          ? "border-ink bg-ink/[0.03]"
          : "border-paper-soft hover:border-ink/40"
      }`}
    >
      <div className="text-sm font-semibold text-ink">{title}</div>
      <div className="mt-1 text-xs text-ink-muted leading-relaxed">{body}</div>
    </button>
  );
}

// ---------- Sync freshness panel -------------------------------------------
//
// Honest staleness copy. The old AlreadyOnboarded bouncer told every
// returning user "no need to re-import" unconditionally — even when the
// hosted mirror had silently drifted behind the GitHub repo (the owner
// authored locally for 10 days, hosted stayed at 67 pages while GitHub
// had 132). This panel fetches the live remote verdict on mount and, when
// the mirror is behind, surfaces "Synced N days ago — behind by M commits"
// plus a one-click Sync now (smart pull: a safe auto fast-forward, no
// scary force button unless the history genuinely diverged).

function relativeTimeFromUnix(unixSeconds: number): string {
  if (!unixSeconds) return "never";
  const deltaMs = Date.now() - unixSeconds * 1000;
  if (deltaMs < 0) return "just now";
  const mins = Math.floor(deltaMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function SyncFreshnessPanel() {
  const [check, setCheck] = useState<{
    classification: PullSafety;
    lastSyncedAt: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<SyncPullResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ownerSyncCheck();
      // Defensive: only show the panel when the backend actually returned
      // a usable classification. A non-hosted build, an unconnected repo,
      // or a transient shape mismatch should hide the panel, not crash the
      // bouncer.
      if (data && data.ok && data.classification) {
        setCheck({
          classification: data.classification,
          lastSyncedAt: data.last_synced_at,
        });
      } else {
        setCheck(null);
      }
    } catch (e) {
      // A 409 (no repo connected) or transient error shouldn't break the
      // bouncer — just hide the panel.
      setError(e instanceof Error ? e.message : "unknown error");
      setCheck(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doSync = useCallback(async () => {
    setPulling(true);
    setPullResult(null);
    try {
      const res = await ownerSyncPull(); // smart pull, no force
      setPullResult(res.result);
      // Re-check so the behind count and last-synced refresh.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setPulling(false);
    }
  }, [refresh]);

  if (loading) {
    return (
      <div className="mt-5 text-xs text-ink-muted">Checking GitHub sync…</div>
    );
  }
  // No connected repo / transient error → stay quiet (the bouncer still works).
  if (error || !check) return null;

  const c = check.classification;
  const behind = c.behind ?? 0;
  const syncedAgo = relativeTimeFromUnix(check.lastSyncedAt);

  // In sync (or local is ahead / even) → a small reassurance line.
  if (behind <= 0) {
    return (
      <div
        data-testid="sync-fresh"
        className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
      >
        Up to date with{" "}
        <code className="font-mono text-[12px]">github</code>
        {check.lastSyncedAt ? ` · last synced ${syncedAgo}` : ""}.
      </div>
    );
  }

  // Behind → honest staleness + a Sync now button. Genuine divergence
  // (tracked edits / diverged history → !auto_ff) keeps the user out of
  // a silent overwrite; we tell them to resolve in the owner console.
  return (
    <div
      data-testid="sync-stale"
      className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4"
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-amber-800 font-semibold">
        Out of sync with GitHub
      </div>
      <div className="mt-1.5 text-sm text-ink leading-relaxed">
        {check.lastSyncedAt ? `Synced ${syncedAgo} — ` : ""}behind by{" "}
        <span className="font-semibold">{behind}</span> commit
        {behind === 1 ? "" : "s"} on{" "}
        <code className="font-mono text-[12px]">{c.branch}</code>. Your GitHub
        repo has edits this hosted copy hasn&apos;t pulled yet.
      </div>

      {pullResult && pullResult.action === "pulled" && (
        <div className="mt-2 text-xs text-emerald-800 font-medium">
          Pulled {pullResult.behind} commit
          {pullResult.behind === 1 ? "" : "s"}. Your wiki is current — refresh
          to see the new pages.
        </div>
      )}
      {pullResult &&
        (pullResult.action === "dirty" || pullResult.action === "diverged") && (
          <div className="mt-2 text-xs text-red-700">
            Couldn&apos;t auto-sync: {pullResult.error}. Resolve it from the{" "}
            owner console.
          </div>
        )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {c.auto_ff ? (
          <button
            type="button"
            data-testid="sync-now"
            onClick={doSync}
            disabled={pulling}
            className="px-3 py-1.5 rounded-md bg-ink text-paper text-xs font-medium hover:bg-ink-soft disabled:opacity-60"
          >
            {pulling
              ? "Syncing…"
              : `Sync now — pull ${behind} commit${behind === 1 ? "" : "s"}`}
          </button>
        ) : (
          <span className="text-xs text-amber-900">
            Local edits diverge from GitHub — resolve in the owner console to
            avoid losing work.
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- AlreadyOnboarded bouncer ---------------------------------------

function AlreadyOnboarded({
  user,
  pageCount,
  duplicateCount,
  onForceImport,
  onCleaned,
}: {
  user: AuthUser;
  pageCount: number;
  duplicateCount: number;
  onForceImport: () => void;
  onCleaned: (remaining: number) => void;
}) {
  const router = useRouter();
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<
    | { ok: true; deletedCount: number; deleted: string[] }
    | { ok: false; error: string }
    | null
  >(null);

  // Marionette opened welcome after login: skip the scavenger hunt and land
  // on Owner console scrolled to Connect to Marionette.
  useEffect(() => {
    rememberMarionetteClientFromLocation();
    if (!isMarionetteClient()) return;
    router.replace(buildOwnerConnectPath(user.tenant_id));
  }, [router, user.tenant_id]);

  const handleCleanup = useCallback(async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const data = await onboardingCleanupImports();
      setCleanResult({
        ok: true,
        deletedCount: data.deleted_count,
        deleted: data.deleted,
      });
      onCleaned(0);
    } catch (e) {
      setCleanResult({
        ok: false,
        error: e instanceof Error ? e.message : "unknown error",
      });
    } finally {
      setCleaning(false);
    }
  }, [onCleaned]);

  return (
    <div className="border border-paper-soft rounded-2xl bg-white p-6 sm:p-8">
      <div className="text-[11px] uppercase tracking-[0.22em] text-accent font-semibold">
        Welcome back
      </div>
      <h2 className="mt-2 text-2xl sm:text-3xl font-semibold text-ink leading-tight">
        Your wiki is already set up.
      </h2>
      <p className="mt-3 text-ink-muted leading-relaxed">
        You have <span className="text-ink font-medium">{pageCount}</span>{" "}
        {pageCount === 1 ? "page" : "pages"} in{" "}
        <code className="font-mono text-[13px] text-ink">
          portablellm.wiki/{user.tenant_id}
        </code>
        . Pick up where you left off.
      </p>

      <SyncFreshnessPanel />

      <div className="mt-6 flex flex-wrap gap-3">
        {isMarionetteClient() ? (
          <Link
            href={buildOwnerConnectPath(user.tenant_id)}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-accent text-paper text-sm font-semibold hover:opacity-90"
          >
            <span>Connect to Marionette</span>
            <span aria-hidden>→</span>
          </Link>
        ) : null}
        <Link
          href={`/${user.tenant_id}`}
          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-ink text-paper text-sm font-semibold hover:bg-ink-soft"
        >
          <span>Open my wiki</span>
          <span aria-hidden>→</span>
        </Link>
        <Link
          href={buildOwnerConnectPath(user.tenant_id)}
          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-ink/20 text-ink text-sm font-medium hover:border-ink"
        >
          Owner console
        </Link>
      </div>

      {duplicateCount > 0 && !cleanResult && (
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 sm:p-5">
          <div className="text-[11px] uppercase tracking-[0.18em] text-amber-800 font-semibold">
            Cleanup available
          </div>
          <div className="mt-1.5 text-sm text-ink leading-relaxed">
            We found{" "}
            <span className="font-semibold">{duplicateCount}</span> files
            matching <code className="font-mono">*-imported*.md</code> —
            likely left over from a previous accidental re-import. Click
            below to delete them.
          </div>
          <button
            type="button"
            onClick={handleCleanup}
            disabled={cleaning}
            className="mt-3 px-3 py-1.5 rounded-md bg-ink text-paper text-xs font-medium hover:bg-ink-soft disabled:opacity-60"
          >
            {cleaning
              ? "Cleaning up…"
              : `Delete ${duplicateCount} duplicate ${
                  duplicateCount === 1 ? "file" : "files"
                }`}
          </button>
        </div>
      )}

      {cleanResult?.ok === true && (
        <div className="mt-6 rounded-xl border border-emerald-300 bg-emerald-50 p-4 sm:p-5">
          <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-800 font-semibold">
            Cleaned up
          </div>
          <div className="mt-1.5 text-sm text-ink leading-relaxed">
            Deleted {cleanResult.deletedCount}{" "}
            {cleanResult.deletedCount === 1 ? "file" : "files"}. Your wiki
            is back to its pre-duplicate state.
          </div>
          {cleanResult.deleted.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-ink-muted cursor-pointer hover:text-ink">
                show paths
              </summary>
              <ul className="mt-1 text-[11px] font-mono text-ink-muted space-y-0.5 pl-4 list-disc">
                {cleanResult.deleted.slice(0, 40).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {cleanResult.deleted.length > 40 && (
                  <li className="italic">
                    …and {cleanResult.deleted.length - 40} more
                  </li>
                )}
              </ul>
            </details>
          )}
        </div>
      )}

      {cleanResult?.ok === false && (
        <div className="mt-6 rounded-xl border border-red-300 bg-red-50 p-4 sm:p-5 text-sm text-red-800">
          Cleanup failed: {cleanResult.error}
        </div>
      )}

      <div className="mt-8 pt-6 border-t border-paper-soft">
        <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
          Need to import more
        </div>
        <p className="mt-1.5 text-sm text-ink-muted leading-relaxed">
          If you do want to merge additional content into your existing wiki,
          you can run the import wizard anyway. Conflicting slugs will get
          a <code className="font-mono">-imported</code> suffix.
        </p>
        <button
          type="button"
          onClick={onForceImport}
          className="mt-3 text-sm text-accent hover:underline font-medium"
        >
          Import additional content anyway →
        </button>
      </div>
    </div>
  );
}

// ---------- Header --------------------------------------------------------

function Header({
  user,
  stepBadge,
}: {
  user: AuthUser;
  /** Step-tracker copy for the current page state, or null when no
   * step badge belongs above the title (e.g. on the AlreadyOnboarded
   * bouncer). Source of truth lives in the parent so this badge and
   * the inner-card titles can't disagree about the total step count. */
  stepBadge: string | null;
}) {
  return (
    <div className="flex items-center gap-4 mb-8">
      {user.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.avatar_url}
          alt={user.login}
          className="w-12 h-12 rounded-full border border-paper-soft"
        />
      ) : (
        <div className="w-12 h-12 rounded-full bg-paper-soft border border-paper-soft" />
      )}
      <div className="flex-1 min-w-0">
        {stepBadge && (
          <div
            data-testid="welcome-step-badge"
            className="text-[11px] uppercase tracking-[0.22em] text-accent font-semibold"
          >
            {stepBadge}
          </div>
        )}
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-ink">
          Hi, {user.name || user.login}. Let&apos;s get your wiki seeded.
        </h1>
        <p className="text-sm text-ink-muted">
          Signed in as <span className="font-mono">@{user.login}</span>
        </p>
      </div>
    </div>
  );
}

// ---------- Form (paste / scrape / persona) -------------------------------

function FormSection(props: {
  tab: Tab;
  setTab: (t: Tab) => void;
  assembleAnswers: Record<string, string>;
  setAssembleAnswers: (
    update: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  assembleText: Record<TextSlotId, string>;
  setAssembleText: (
    update: (prev: Record<TextSlotId, string>) => Record<TextSlotId, string>,
  ) => void;
  assembleUrls: Array<{ id: string; url: string; label: string }>;
  setAssembleUrls: (
    update: (
      prev: Array<{ id: string; url: string; label: string }>,
    ) => Array<{ id: string; url: string; label: string }>,
  ) => void;
  wikiUrlValue: string;
  setWikiUrlValue: (v: string) => void;
  wikiMode: "verbatim" | "standardize";
  setWikiMode: (m: "verbatim" | "standardize") => void;
  submitAssemble: () => void;
  submitWiki: () => void;
  submitting: boolean;
  submitError: string | null;
  // When true, the user reached this form via the "Import additional
  // content anyway" override on AlreadyOnboarded — render a sticky
  // banner so they don't lose the context that they're about to merge
  // into an existing wiki, not start fresh.
  forceImport?: boolean;
  // Connect just seeded (or left empty) a private starter wiki. Keep
  // the assemble form as the first-source step instead of bouncing
  // home.
  needsFirstSource?: boolean;
}) {
  const {
    tab,
    setTab,
    assembleAnswers,
    setAssembleAnswers,
    assembleText,
    setAssembleText,
    assembleUrls,
    setAssembleUrls,
    wikiUrlValue,
    setWikiUrlValue,
    wikiMode,
    setWikiMode,
    submitAssemble,
    submitWiki,
    submitting,
    submitError,
    forceImport,
    needsFirstSource,
  } = props;

  return (
    <div className="border border-paper-soft rounded-2xl bg-white p-5 sm:p-7">
      {forceImport && (
        <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Merging into your existing wiki. Conflicting slugs will get a{" "}
          <code className="font-mono">-imported</code> suffix.
        </div>
      )}
      {needsFirstSource && !forceImport && (
        <p
          className="mb-5 text-sm text-ink-muted leading-relaxed"
          data-testid="first-source-step"
        >
          A private starter wiki is already in your repo. Add a first
          source below so the pages are about you — not an empty shell.
        </p>
      )}
      <Segmented tab={tab} setTab={setTab} />

      <div className="mt-6">
        {tab === "assemble" && (
          <AssembleForm
            answers={assembleAnswers}
            setAnswers={setAssembleAnswers}
            text={assembleText}
            setText={setAssembleText}
            urls={assembleUrls}
            setUrls={setAssembleUrls}
            onSubmit={submitAssemble}
            submitting={submitting}
          />
        )}
        {tab === "wiki" && (
          <WikiImportForm
            url={wikiUrlValue}
            setUrl={setWikiUrlValue}
            mode={wikiMode}
            setMode={setWikiMode}
            onSubmit={submitWiki}
            submitting={submitting}
          />
        )}
      </div>

      {submitError && (
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {submitError}
        </div>
      )}
    </div>
  );
}

function Segmented({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  // Two tabs only. Assemble is the primary, opinionated path; "Import
  // existing wiki" is the escape hatch for users who already have a
  // markdown corpus they want to bring (a fundamentally different mental
  // model — bring an existing wiki, vs. assemble a first one).
  const tabs: { id: Tab; label: string; badge?: string }[] = [
    { id: "assemble", label: "Assemble starter wiki" },
    { id: "wiki", label: "Import existing wiki" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Onboarding seeding method"
      className="inline-flex rounded-xl border border-paper-soft bg-paper-soft/60 p-1 gap-1 flex-wrap"
    >
      {tabs.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 ${
              active
                ? "bg-ink text-paper"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <span>{t.label}</span>
            {t.badge && (
              <span className="text-[10px] uppercase tracking-[0.12em] bg-paper border border-paper-soft text-ink-muted rounded px-1.5 py-0.5">
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------- AssembleForm — the guided first-signup wizard -------------
//
// Three optional sections, all feeding one POST /onboarding/assemble:
//
//   1. Interview prompts — 4 lightweight questions (who/working on/how
//      you work/anything else). Each blank prompt is still posted as
//      part of the bundle but filtered out client- and server-side.
//   2. Pasted material — three named slots (resume, LinkedIn About,
//      GitHub README) plus one freeform brain-dump. Maps to the
//      backend's `text_sources[]` with a stable `kind` per slot.
//   3. URL list — dynamic, with add/remove. Each gets scraped server-
//      side; partial failures are reported on the response and don't
//      block the rest of the bundle.
//
// "At least one non-empty input" is enforced both here (disabled submit)
// and server-side (422). The disabled state copy makes it explicit so
// the user knows what unblocks the button.

function AssembleForm({
  answers,
  setAnswers,
  text,
  setText,
  urls,
  setUrls,
  onSubmit,
  submitting,
}: {
  answers: Record<string, string>;
  setAnswers: (
    update: (prev: Record<string, string>) => Record<string, string>,
  ) => void;
  text: Record<TextSlotId, string>;
  setText: (
    update: (prev: Record<TextSlotId, string>) => Record<TextSlotId, string>,
  ) => void;
  urls: Array<{ id: string; url: string; label: string }>;
  setUrls: (
    update: (
      prev: Array<{ id: string; url: string; label: string }>,
    ) => Array<{ id: string; url: string; label: string }>,
  ) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const answeredCount = INTERVIEW_PROMPTS.filter(
    (p) => (answers[p.id] ?? "").trim().length > 0,
  ).length;
  const pasteCount = TEXT_SLOTS.filter(
    (slot) => (text[slot.id] ?? "").trim().length > 0,
  ).length;
  const urlCount = urls.filter((row) => row.url.trim().length > 0).length;
  const hasAnything = answeredCount + pasteCount + urlCount > 0;
  const totalChars =
    Object.values(answers).reduce((sum, v) => sum + (v?.length ?? 0), 0) +
    Object.values(text).reduce((sum, v) => sum + (v?.length ?? 0), 0);

  return (
    <div className="space-y-8" data-testid="assemble-form">
      <div className="rounded-xl border border-paper-soft bg-paper-soft/30 px-4 py-3 text-xs text-ink-muted leading-relaxed">
        Everything is optional. Add what you have on hand and we&apos;ll draft
        6–12 starter pages from the whole bundle in one pass. All pages
        start as <span className="font-mono">private</span> — you decide what
        to share later.
      </div>

      <SectionHeader
        step="1"
        title="Tell us a bit about yourself"
        subtitle="Answer whichever questions feel useful. One- or two-sentence answers are plenty."
      />
      <div className="space-y-4">
        {INTERVIEW_PROMPTS.map((p) => (
          <QuestionField
            key={p.id}
            prompt={p}
            value={answers[p.id] ?? ""}
            onChange={(v) =>
              setAnswers((prev) => ({ ...prev, [p.id]: v }))
            }
            disabled={submitting}
          />
        ))}
      </div>

      <SectionHeader
        step="2"
        title="Paste material you already have"
        subtitle="Imperfect is fine — the drafter handles dense text. Skip the slots you don't have."
      />
      <div className="grid sm:grid-cols-2 gap-4">
        {TEXT_SLOTS.map((slot) => (
          <TextSlotField
            key={slot.id}
            slot={slot}
            value={text[slot.id] ?? ""}
            onChange={(v) =>
              setText((prev) => ({ ...prev, [slot.id]: v }))
            }
            disabled={submitting}
          />
        ))}
      </div>

      <SectionHeader
        step="3"
        title="Add links worth reading"
        subtitle="Your portfolio, blog, GitHub profile — anything public. We'll fetch the content server-side."
      />
      <div className="space-y-3">
        {urls.map((row, i) => (
          <UrlRowField
            key={row.id}
            row={row}
            index={i}
            onChange={(patch) =>
              setUrls((prev) =>
                prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)),
              )
            }
            onRemove={() =>
              setUrls((prev) =>
                prev.length > 1
                  ? prev.filter((r) => r.id !== row.id)
                  // Last row stays — clear instead of remove so the
                  // form never collapses into an unaddable state.
                  : prev.map((r) =>
                      r.id === row.id ? { ...r, url: "", label: "" } : r,
                    ),
              )
            }
            disabled={submitting}
            canRemove={urls.length > 1 || row.url.trim() !== "" || row.label.trim() !== ""}
          />
        ))}
        <button
          type="button"
          onClick={() =>
            setUrls((prev) => [...prev, { id: makeId(), url: "", label: "" }])
          }
          disabled={submitting}
          className="text-xs text-accent hover:underline font-medium disabled:opacity-50"
        >
          + Add another link
        </button>
      </div>

      <div className="pt-4 border-t border-paper-soft flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="assemble-submit"
          onClick={onSubmit}
          disabled={!hasAnything || submitting}
          className="px-4 py-2.5 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
        >
          {submitting ? (
            <>Drafting…</>
          ) : (
            <>
              Draft my starter wiki <span aria-hidden>→</span>
            </>
          )}
        </button>
        <span className="text-xs text-ink-muted" data-testid="assemble-meter">
          {hasAnything ? (
            <>
              {answeredCount} answer{answeredCount === 1 ? "" : "s"} ·{" "}
              {pasteCount} paste{pasteCount === 1 ? "" : "s"} · {urlCount}{" "}
              link{urlCount === 1 ? "" : "s"} · {totalChars.toLocaleString()}{" "}
              characters
            </>
          ) : (
            <>Answer a question, paste something, or add a link to enable.</>
          )}
        </span>
      </div>
    </div>
  );
}

function SectionHeader({
  step,
  title,
  subtitle,
}: {
  step: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-accent font-semibold">
          Step {step}
        </span>
        <h3 className="text-base font-semibold text-ink">{title}</h3>
      </div>
      <p className="mt-1 text-xs text-ink-muted leading-relaxed">{subtitle}</p>
    </div>
  );
}

function QuestionField({
  prompt,
  value,
  onChange,
  disabled,
}: {
  prompt: InterviewPrompt;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Autoresize so a long answer doesn't get hidden behind a scrollbar.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [value]);

  return (
    <label className="block">
      <div className="text-sm font-medium text-ink">{prompt.prompt}</div>
      <p className="mt-0.5 text-[11px] text-ink-muted leading-relaxed">
        {prompt.hint}
      </p>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={prompt.placeholder}
        rows={2}
        disabled={disabled}
        data-testid={`assemble-question-${prompt.id}`}
        className="mt-2 w-full resize-none border border-paper-soft rounded-lg px-3 py-2 text-sm leading-relaxed bg-paper-soft/20 focus:outline-none focus:border-ink/40"
      />
    </label>
  );
}

function TextSlotField({
  slot,
  value,
  onChange,
  disabled,
}: {
  slot: TextSlotConfig;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`;
  }, [value]);

  return (
    <label className="block">
      <div className="text-sm font-medium text-ink">{slot.title}</div>
      <p className="mt-0.5 text-[11px] text-ink-muted leading-relaxed">
        {slot.hint}
      </p>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={slot.placeholder}
        rows={3}
        disabled={disabled}
        data-testid={`assemble-text-${slot.id}`}
        className="mt-2 w-full resize-none border border-paper-soft rounded-lg px-3 py-2 text-sm leading-relaxed bg-paper-soft/20 font-mono focus:outline-none focus:border-ink/40"
      />
    </label>
  );
}

function UrlRowField({
  row,
  index,
  onChange,
  onRemove,
  disabled,
  canRemove,
}: {
  row: { id: string; url: string; label: string };
  index: number;
  onChange: (patch: Partial<{ url: string; label: string }>) => void;
  onRemove: () => void;
  disabled: boolean;
  canRemove: boolean;
}) {
  return (
    <div
      className="grid grid-cols-[1fr_180px_auto] gap-2 items-center"
      data-testid={`assemble-url-row-${index}`}
    >
      <input
        type="url"
        value={row.url}
        onChange={(e) => onChange({ url: e.target.value })}
        placeholder="https://your-portfolio.com"
        disabled={disabled}
        className="border border-paper-soft rounded-lg px-3 py-2 text-sm font-mono bg-paper-soft/20 focus:outline-none focus:border-ink/40"
      />
      <input
        value={row.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Label (optional)"
        disabled={disabled}
        className="border border-paper-soft rounded-lg px-3 py-2 text-sm bg-paper-soft/20 focus:outline-none focus:border-ink/40"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled || !canRemove}
        className="text-xs text-ink-muted hover:text-red-600 disabled:opacity-30 px-2"
        aria-label="Remove link"
      >
        ×
      </button>
    </div>
  );
}

function WikiImportForm({
  url,
  setUrl,
  mode,
  setMode,
  onSubmit,
  submitting,
}: {
  url: string;
  setUrl: (v: string) => void;
  mode: "verbatim" | "standardize";
  setMode: (m: "verbatim" | "standardize") => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  // We support TWO selection modes in the same panel:
  //   1. Click-pick from a dropdown of the user's GitHub repos (the
  //      Vercel-style flow — zero typing, zero copy-paste).
  //   2. Paste any GitHub URL — useful for collaborator/org repos
  //      that don't show up in the "owner" affiliation list.
  //
  // On mount we fetch /onboarding/my-repos. If the stored OAuth token
  // doesn't have ``repo`` scope (older sign-in), we still render the
  // URL-paste fallback plus a "Re-authorize for private repos" CTA.

  const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [reposError, setReposError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data: MyReposResponse = await onboardingListMyRepos();
        if (cancelled) return;
        setRepos(data.repos);
        setNeedsReauth(data.needs_reauth);
      } catch (e) {
        if (cancelled) return;
        setReposError(
          e instanceof Error ? e.message : "Couldn't load your repos.",
        );
      } finally {
        if (!cancelled) setLoadingRepos(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Local heuristic that matches the backend's regex flexibility — used
  // to enable/disable the submit button for the URL-paste branch.
  const trimmed = url.trim();
  const looksLikeGithub =
    /^(https?:\/\/(www\.)?)?github\.com\/[^/\s]+\/[^/\s]+/i.test(trimmed) ||
    /^git@github\.com:[^/\s]+\/[^/\s]+/i.test(trimmed) ||
    /^[A-Za-z0-9][\w.-]+\/[\w.-]+$/.test(trimmed);
  const ready = trimmed.length > 0 && looksLikeGithub;

  const filteredRepos = (repos ?? []).filter((r) => {
    if (!filter.trim()) return true;
    const f = filter.toLowerCase();
    return (
      r.full_name.toLowerCase().includes(f) ||
      (r.description || "").toLowerCase().includes(f)
    );
  });

  const reauthHref = (() => {
    if (typeof window === "undefined") {
      return `${apiBase()}/auth/github/login?return_to=/welcome`;
    }
    return `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(
      window.location.href,
    )}`;
  })();

  return (
    <div>
      <label className="block text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
        Pick one of your repos
      </label>

      {needsReauth && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 leading-relaxed">
          You signed in with public-repo access only, so we can&apos;t see
          a private wiki to import. We ask for the <code>repo</code>{" "}
          scope so we can create/push one wiki repo and import yours.{" "}
          <a href={reauthHref} className="underline font-medium hover:text-amber-950">
            Re-authorize with private-repo access
          </a>{" "}
          (GitHub will ask for consent). A GitHub App installed on just
          that one repo is the narrower path, once it is live.
        </div>
      )}

      {loadingRepos ? (
        <div className="rounded-xl border border-paper-soft bg-paper-soft/30 px-3.5 py-3 text-sm text-ink-muted">
          Loading your repos…
        </div>
      ) : reposError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
          Couldn&apos;t load your repos: {reposError}
        </div>
      ) : repos && repos.length > 0 ? (
        <div className="border border-paper-soft rounded-xl bg-paper-soft/20">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter… (try 'wiki' or part of the repo name)"
            className="w-full bg-transparent border-b border-paper-soft px-3.5 py-2 text-xs focus:outline-none focus:bg-paper-soft/40"
          />
          <ul className="max-h-72 overflow-y-auto">
            {filteredRepos.length === 0 ? (
              <li className="px-3.5 py-3 text-xs text-ink-muted">
                No repos match &ldquo;{filter}&rdquo;.
              </li>
            ) : (
              filteredRepos.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setUrl(r.clone_url)}
                    disabled={submitting}
                    className={`w-full text-left px-3.5 py-2.5 border-b border-paper-soft/60 last:border-b-0 hover:bg-paper-soft/50 disabled:opacity-50 ${
                      url.trim() === r.clone_url ? "bg-paper-soft/70" : ""
                    }`}
                  >
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-medium text-ink font-mono">
                        {r.full_name}
                      </span>
                      <span
                        className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border ${
                          r.private
                            ? "border-amber-300 bg-amber-50 text-amber-800"
                            : "border-emerald-300 bg-emerald-50 text-emerald-800"
                        }`}
                      >
                        {r.private ? "private" : "public"}
                      </span>
                      {r.archived && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border border-paper-soft bg-paper-soft text-ink-muted">
                          archived
                        </span>
                      )}
                      {r.fork && (
                        <span className="text-[10px] uppercase tracking-wider text-ink-muted">
                          fork
                        </span>
                      )}
                    </div>
                    {r.description && (
                      <div className="mt-0.5 text-xs text-ink-muted line-clamp-1">
                        {r.description}
                      </div>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border border-paper-soft bg-paper-soft/20 px-3.5 py-3 text-xs text-ink-muted">
          You don&apos;t have any repos yet. Paste a URL below instead.
        </div>
      )}

      <div className="mt-5">
        <label className="block text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
          Or paste a repo URL
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/<owner>/<repo>"
          className="w-full border border-paper-soft rounded-xl px-3.5 py-3 text-sm bg-paper-soft/30 focus:outline-none focus:border-ink/40 font-mono"
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready && !submitting) onSubmit();
          }}
        />
      </div>

      {/* Layout: portable-llm-wiki shape vs LLM-standardize. The default
        * matches the literal historical behavior so nobody who's used
        * the import flow before is surprised; users with Obsidian /
        * Logseq / loose notes pick the second radio. */}
      <fieldset className="mt-5">
        <legend className="block text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-2">
          Source layout
        </legend>
        <div className="space-y-2">
          <label
            className={`flex items-start gap-2.5 cursor-pointer rounded-lg border px-3 py-2.5 ${
              mode === "verbatim"
                ? "border-ink bg-paper-soft/40"
                : "border-paper-soft hover:bg-paper-soft/20"
            }`}
          >
            <input
              type="radio"
              name="wiki-mode"
              value="verbatim"
              checked={mode === "verbatim"}
              onChange={() => setMode("verbatim")}
              disabled={submitting}
              className="mt-1"
            />
            <div className="text-xs leading-relaxed">
              <div className="text-sm font-medium text-ink">
                Copy verbatim
              </div>
              <div className="text-ink-muted">
                Source is already a portable-llm-wiki — pages live under
                a top-level <code className="font-mono">wiki/</code>{" "}
                directory with frontmatter. Files are copied unchanged;
                tiers, sections, and sources carry over.
              </div>
            </div>
          </label>
          <label
            className={`flex items-start gap-2.5 cursor-pointer rounded-lg border px-3 py-2.5 ${
              mode === "standardize"
                ? "border-ink bg-paper-soft/40"
                : "border-paper-soft hover:bg-paper-soft/20"
            }`}
          >
            <input
              type="radio"
              name="wiki-mode"
              value="standardize"
              checked={mode === "standardize"}
              onChange={() => setMode("standardize")}
              disabled={submitting}
              className="mt-1"
            />
            <div className="text-xs leading-relaxed">
              <div className="text-sm font-medium text-ink">
                Standardize my notes
              </div>
              <div className="text-ink-muted">
                Source is any markdown — Obsidian vault, Logseq, a{" "}
                <code className="font-mono">notes/</code> folder,
                root-level <code className="font-mono">*.md</code>, a
                hand-rolled wiki under a different name. We walk every
                markdown file (depth- and size-capped) and let the LLM
                drafter produce a Karpathy-schema wiki from the contents.
              </div>
            </div>
          </label>
        </div>
      </fieldset>

      <button
        onClick={onSubmit}
        disabled={!ready || submitting}
        className="mt-4 px-4 py-2.5 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
      >
        {submitting ? (
          <>Cloning &amp; importing…</>
        ) : (
          <>
            Import wiki <span aria-hidden>→</span>
          </>
        )}
      </button>
    </div>
  );
}

// ---------- Progress + Done -----------------------------------------------

function ProgressSection({
  phase,
  user,
}: {
  phase: WizardPhase;
  user: AuthUser;
}) {
  if (phase.kind === "submitting") {
    return (
      <div className="border border-paper-soft rounded-2xl bg-white p-6 sm:p-8 text-center">
        <Spinner />
        <div className="mt-3 text-ink font-medium">Sending your import…</div>
      </div>
    );
  }
  if (phase.kind === "running") return <RunningView phase={phase} user={user} />;
  if (phase.kind === "done") return <DoneView phase={phase} user={user} />;
  if (phase.kind === "error") return <ErrorView phase={phase} user={user} />;
  return null;
}

function elapsed(startedAt: number): string {
  const sec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Compact recap of the assembly bundle (questions answered, pastes
 * provided, URL outcomes). Reused on both the running and done panels so
 * partial-URL failures (e.g. one of the user's links was offline) are
 * always visible — they should never disappear silently. */
function AssembleSummaryBlock({
  summary,
  muted,
}: {
  summary: AssembleSummary;
  muted?: boolean;
}) {
  const totalUrls = summary.urls.length;
  const failed = summary.urls.filter((u) => u.status === "failed");
  const partial = summary.urls.filter((u) => u.status === "partial");
  return (
    <div
      data-testid="assemble-summary"
      className={`mt-5 rounded-xl border border-paper-soft bg-paper-soft/30 p-4 ${
        muted ? "opacity-90" : ""
      }`}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
        Source bundle
      </div>
      <div className="mt-1.5 text-xs text-ink leading-relaxed">
        Received <strong>{summary.answersCount}</strong> answer
        {summary.answersCount === 1 ? "" : "s"},{" "}
        <strong>{summary.textCount}</strong> paste
        {summary.textCount === 1 ? "" : "s"}, and read{" "}
        <strong>{summary.usableUrlCount}</strong> of{" "}
        <strong>{totalUrls}</strong> link
        {totalUrls === 1 ? "" : "s"}.
      </div>
      {(failed.length > 0 || partial.length > 0) && (
        <ul className="mt-2 space-y-1 text-[11px] font-mono leading-snug">
          {failed.map((u, i) => (
            <li key={`fail-${i}`} className="text-red-700">
              ✗ {u.label || u.url} — couldn&apos;t read
            </li>
          ))}
          {partial.map((u, i) => (
            <li key={`partial-${i}`} className="text-amber-800">
              ! {u.label || u.url} — read with warnings
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunningView({
  phase,
  user,
}: {
  phase: Extract<WizardPhase, { kind: "running" }>;
  user: AuthUser;
}) {
  const [, force] = useState(0);
  // Tick once a second so the elapsed timer animates even between polls.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const logTail = phase.lastStatus?.log_tail;
  const orchestratorMissing = !phase.orchestratorStarted;

  return (
    <div className="border border-paper-soft rounded-2xl bg-white p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <Spinner />
        <div className="text-ink font-semibold text-lg">
          {orchestratorMissing ? "Saved your import." : "Drafting pages…"}
        </div>
        <div className="ml-auto text-xs font-mono text-ink-muted">
          {elapsed(phase.startedAt)}
        </div>
      </div>

      <p className="mt-2 text-sm text-ink-muted leading-relaxed">
        Your wiki is at{" "}
        <Link
          href={`/${user.tenant_id}`}
          className="text-accent hover:underline font-mono"
        >
          portablellm.wiki/{user.tenant_id}
        </Link>
        . While the orchestrator drafts pages, you can already share it.
      </p>

      <div className="mt-4 grid sm:grid-cols-2 gap-3 text-xs">
        <Detail label="tracking id" value={phase.trackingId ?? "—"} mono />
        <Detail label="raw file" value={phase.rawPath} mono />
      </div>

      {phase.assembleSummary && (
        <AssembleSummaryBlock summary={phase.assembleSummary} muted />
      )}

      {phase.orchestratorError && (
        <div className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {phase.orchestratorError}
        </div>
      )}

      {logTail && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold mb-1.5">
            Live log
          </div>
          <pre className="text-[11px] font-mono bg-paper-soft/60 p-3 rounded-lg max-h-48 overflow-auto leading-snug whitespace-pre-wrap">
            {logTail}
          </pre>
        </div>
      )}

      <ShareBlock user={user} muted />
    </div>
  );
}

function DoneView({
  phase,
  user,
}: {
  phase: Extract<WizardPhase, { kind: "done" }>;
  user: AuthUser;
}) {
  const wiki = phase.wikiImport;
  const assemble = phase.assembleSummary;
  return (
    <div className="border-2 border-ink rounded-2xl bg-white p-6 sm:p-8">
      <div className="text-[11px] uppercase tracking-[0.22em] text-accent font-semibold">
        Done
      </div>
      <h2 className="mt-1 text-2xl sm:text-3xl font-semibold tracking-tight text-ink">
        {wiki ? "Your wiki is imported." : "Your wiki is live."}
      </h2>
      <p className="mt-2 text-sm text-ink-muted leading-relaxed">
        {wiki ? (
          <>
            Pulled <strong>{wiki.importedCount}</strong> page
            {wiki.importedCount === 1 ? "" : "s"} from{" "}
            <a
              href={wiki.sourceUrl}
              className="text-accent hover:underline font-mono"
              target="_blank"
              rel="noreferrer"
            >
              {prettifyGithubUrl(wiki.sourceUrl)}
            </a>{" "}
            into your tenant. Frontmatter, tiers, and cross-references are
            preserved as-is. Manage it any time at{" "}
            <Link
              href={`/${user.tenant_id}/owner`}
              className="text-accent hover:underline"
            >
              /{user.tenant_id}/owner
            </Link>
            .
          </>
        ) : assemble ? (
          <>
            Drafted{" "}
            {typeof assemble.pagesCreated === "number" ? (
              <>
                <strong>{assemble.pagesCreated}</strong> page
                {assemble.pagesCreated === 1 ? "" : "s"}{" "}
              </>
            ) : (
              <>your starter wiki </>
            )}
            from the bundle you assembled. Everything starts{" "}
            <span className="font-mono">private</span> — review and promote at{" "}
            <Link
              href={`/${user.tenant_id}/owner`}
              className="text-accent hover:underline"
            >
              /{user.tenant_id}/owner
            </Link>
            .
          </>
        ) : (
          <>
            Drafted from your import. You can refine it any time at{" "}
            <Link
              href={`/${user.tenant_id}/owner`}
              className="text-accent hover:underline"
            >
              /{user.tenant_id}/owner
            </Link>
            .
          </>
        )}
      </p>

      {assemble && <AssembleSummaryBlock summary={assemble} />}

      {wiki && (wiki.conflicts.length > 0 || wiki.skipped.length > 0) && (
        <div className="mt-4 text-xs space-y-2">
          {wiki.conflicts.length > 0 && (
            <details className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <summary className="cursor-pointer text-amber-900 font-medium">
                {wiki.conflicts.length} slug{wiki.conflicts.length === 1 ? "" : "s"}{" "}
                conflicted — written with a <code>-imported</code> suffix
              </summary>
              <ul className="mt-2 ml-4 list-disc text-amber-900 font-mono leading-relaxed">
                {wiki.conflicts.slice(0, 20).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {wiki.conflicts.length > 20 && (
                  <li className="list-none italic">
                    …and {wiki.conflicts.length - 20} more
                  </li>
                )}
              </ul>
              <UndoDuplicateImportButton conflictCount={wiki.conflicts.length} />
            </details>
          )}
          {wiki.skipped.length > 0 && (
            <details className="rounded-lg border border-paper-soft bg-paper-soft/40 p-3">
              <summary className="cursor-pointer text-ink-muted">
                {wiki.skipped.length} file{wiki.skipped.length === 1 ? "" : "s"}{" "}
                skipped (symlinks or oversize)
              </summary>
              <ul className="mt-2 ml-4 list-disc text-ink-muted font-mono leading-relaxed">
                {wiki.skipped.slice(0, 20).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-3 items-center">
        <ConnectMarionetteButton tenant={user.tenant_id} auto className="w-full sm:w-auto" />
        <Link
          href={`/${user.tenant_id}`}
          className="px-4 py-2.5 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft inline-flex items-center gap-2"
        >
          Open my wiki <span aria-hidden>→</span>
        </Link>
        {(() => {
          // The wiki-import path has its own header copy; nothing to add.
          if (wiki) return null;

          // Hosted path: Puppetmaster ("the orchestrator") is never
          // installed by design — the backend falls through to the
          // synchronous direct-LLM drafter, which returns pages_created.
          // When it drafted pages, that's a SUCCESS, not a failure. The
          // header already says "Drafted N pages", so don't contradict it
          // with an alarming "orchestrator was unavailable" amber. This
          // was the bug: pages were created, the wiki was live, but the
          // footer claimed the run failed.
          //
          // Prefer the top-level phase.pagesCreated (threaded through
          // beginJob for ALL drafter paths) and fall back to the
          // assembly recap, so the generic URL/text import path is
          // covered too — not just the guided-assembly bundle.
          const drafted = phase.pagesCreated ?? assemble?.pagesCreated;
          if (typeof drafted === "number" && drafted > 0) return null;

          // Self-host path: a real Puppetmaster job ran and finished.
          if (phase.orchestratorStarted) {
            return (
              <span className="text-xs text-ink-muted">
                Drafting finished{phase.summary ? `: ${phase.summary}` : "."}
              </span>
            );
          }

          // Genuinely nothing got drafted (the drafter returned zero or
          // errored). The raw input is saved — tell the user how to retry
          // without blaming an "orchestrator" they never opted into.
          return (
            <span className="text-xs text-amber-700">
              We saved your sources but couldn&apos;t draft pages
              automatically — raw saved at{" "}
              <span className="font-mono">{phase.rawPath}</span>. Draft from{" "}
              <Link
                href={`/${user.tenant_id}/owner`}
                className="underline hover:text-amber-900"
              >
                /{user.tenant_id}/owner
              </Link>
              .
            </span>
          );
        })()}
      </div>

      <ShareBlock user={user} />
    </div>
  );
}

function prettifyGithubUrl(clone: string): string {
  // Turn "https://github.com/foo/bar.git" into "foo/bar".
  const m = clone.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return m ? `${m[1]}/${m[2]}` : clone;
}

function ErrorView({
  phase,
  user,
}: {
  phase: Extract<WizardPhase, { kind: "error" }>;
  user: AuthUser;
}) {
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-2xl p-6 sm:p-8">
      <div className="text-[11px] uppercase tracking-[0.22em] text-amber-800 font-semibold">
        Heads up
      </div>
      <h2 className="mt-1 text-xl font-semibold text-ink">
        We saved your import, but the drafting step needs another nudge.
      </h2>
      <p className="mt-2 text-sm text-ink-muted leading-relaxed">
        {phase.rawPath && (
          <>
            We saved your import at{" "}
            <span className="font-mono">{phase.rawPath}</span>.
          </>
        )}{" "}
        The orchestrator was unavailable or errored: {phase.message}. Your wiki is
        live but pages will need to be drafted manually. Go to{" "}
        <Link
          href={`/${user.tenant_id}/owner`}
          className="text-accent hover:underline"
        >
          /{user.tenant_id}/owner
        </Link>{" "}
        to upload more or trigger a draft.
      </p>

      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href={`/${user.tenant_id}`}
          className="px-4 py-2.5 rounded-lg bg-ink text-paper text-sm font-medium hover:bg-ink-soft inline-flex items-center gap-2"
        >
          Open my wiki <span aria-hidden>→</span>
        </Link>
        <Link
          href={`/${user.tenant_id}/owner`}
          className="px-4 py-2.5 rounded-lg border border-ink/15 text-ink text-sm font-medium hover:border-ink"
        >
          Go to owner panel
        </Link>
      </div>

      <ShareBlock user={user} />
    </div>
  );
}

// ---------- Share CTAs ----------------------------------------------------

function ShareBlock({ user, muted }: { user: AuthUser; muted?: boolean }) {
  const wikiUrl = `https://portablellm.wiki/${user.tenant_id}`;
  // Vanity URL — Next.js rewrites /<tenant>/llm to the backend's
  // /t/<tenant>/llm in hosted mode (see frontend/next.config.mjs). LLMs
  // and humans see a clean shareable form.
  const llmUrl = `https://portablellm.wiki/${user.tenant_id}/llm`;
  const login = user.login;

  const tweetText =
    `Just spun up my portable LLM wiki at portablellm.wiki/${login} → ` +
    "any LLM can read my context now. Try pasting the URL into ChatGPT or Claude. " +
    "Built on the open Portable LLM Wiki protocol.";
  const tweetHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
  const linkedinHref = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(wikiUrl)}`;

  return (
    <div className={`mt-7 pt-6 border-t border-paper-soft ${muted ? "opacity-90" : ""}`}>
      <div className="text-[11px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
        Share it
      </div>
      <div className="mt-2 text-sm text-ink-muted leading-relaxed">
        Paste the URL into ChatGPT, Claude, Cursor, Gemini — any LLM that can
        fetch a URL can now read your context.
      </div>

      <CopyRow label="Your wiki" value={`portablellm.wiki/${user.tenant_id}`} fullValue={wikiUrl} />
      <CopyRow label="LLM handshake" value={`portablellm.wiki/${user.tenant_id}/llm`} fullValue={llmUrl} />

      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href={tweetHref}
          target="_blank"
          rel="noreferrer"
          className="px-3.5 py-2 rounded-lg border border-ink/15 hover:border-ink text-ink text-sm font-medium inline-flex items-center gap-2"
        >
          Share on X
        </a>
        <a
          href={linkedinHref}
          target="_blank"
          rel="noreferrer"
          className="px-3.5 py-2 rounded-lg border border-ink/15 hover:border-ink text-ink text-sm font-medium inline-flex items-center gap-2"
        >
          Share on LinkedIn
        </a>
      </div>
    </div>
  );
}

// Inline "undo the duplicate import" button rendered inside the DONE
// view's conflict <details> block. Calls the same cleanup endpoint as
// the AlreadyOnboarded bouncer — the two surfaces overlap because a
// returning user MAY have force-imported via the override path, and
// then immediately wants to undo it.
function UndoDuplicateImportButton({
  conflictCount,
}: {
  conflictCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; count: number }
    | { ok: false; error: string }
    | null
  >(null);

  const onClick = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const data = await onboardingCleanupImports();
      setResult({ ok: true, count: data.deleted_count });
    } catch (e) {
      setResult({
        ok: false,
        error: e instanceof Error ? e.message : "unknown error",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  if (result?.ok === true) {
    return (
      <div className="mt-3 text-emerald-800 text-xs font-medium">
        Deleted {result.count} duplicate file{result.count === 1 ? "" : "s"}.
        Refresh the page to see the cleaned-up state.
      </div>
    );
  }
  if (result?.ok === false) {
    return (
      <div className="mt-3 text-red-700 text-xs">Cleanup failed: {result.error}</div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="mt-3 px-2.5 py-1 rounded bg-amber-800/10 hover:bg-amber-800/20 text-amber-900 text-[11px] font-medium border border-amber-300/60 disabled:opacity-60"
    >
      {busy
        ? "Undoing…"
        : `Undo — delete the ${conflictCount} duplicate ${
            conflictCount === 1 ? "file" : "files"
          }`}
    </button>
  );
}

function CopyRow({
  label,
  value,
  fullValue,
}: {
  label: string;
  value: string;
  fullValue: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(fullValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="mt-3 flex items-center gap-2 bg-paper-soft/60 rounded-lg p-2 pr-2.5">
      <div className="text-[10px] uppercase tracking-[0.18em] text-ink-muted font-semibold shrink-0 w-28 sm:w-32 pl-2">
        {label}
      </div>
      <code className="flex-1 font-mono text-xs text-ink truncate">{value}</code>
      <button
        onClick={onCopy}
        className="shrink-0 px-2.5 py-1.5 rounded-md bg-ink text-paper text-xs font-medium hover:bg-ink-soft inline-flex items-center gap-1.5"
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

// ---------- Small helpers -------------------------------------------------

function Spinner() {
  return (
    <span
      className="inline-block w-4 h-4 border-2 border-ink/20 border-t-ink rounded-full animate-spin"
      aria-hidden
    />
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-paper-soft/50 border border-paper-soft px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
        {label}
      </div>
      <div className={`mt-0.5 text-[12px] text-ink break-all ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}
