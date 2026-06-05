/**
 * Tests for the /welcome page, focused on two regressions:
 *
 * Bug 1: duplicate step-counters disagreed about totals.
 *   The outer Header used to render a hard-coded "Step 1 of 1" while
 *   ConnectRepoStep rendered its own "Step 1 of 2 — Connect GitHub".
 *   Same page, two badges, two different totals. We lifted the badge
 *   into the parent so there's exactly one source of truth.
 *
 * Bug 2: stale ``pageCount`` after a successful connect-against-populated
 *   repo. The welcome page reads ``page_count`` from /auth/me at mount.
 *   When the user then connected to an existing wiki repo (e.g.
 *   ``cary-wiki``), bootstrap_tenant cloned the content into the wiki
 *   root and the response signalled connected=true. But the welcome
 *   page only updated ``syncStatus`` from that response — never
 *   re-fetched /auth/me — so ``pageCount`` stayed stale at 0 and the
 *   "already onboarded" bouncer never fired. The user got bounced into
 *   the import wizard instead of being sent to their now-populated
 *   wiki, with a confused "Paste your LinkedIn About" prompt on top of
 *   their 9 imported pages. The fix re-fetches /auth/me on the
 *   onConnected callback so the next render sees the live count.
 *
 * Locked invariants:
 *   1. Fresh + not-connected → badge "Step 1 of 2 — Connect GitHub",
 *      and ConnectRepoStep does NOT render its own duplicate badge.
 *   2. Migration (not-connected, pageCount > 0) → badge
 *      "One-time upgrade".
 *   3. Connected + pageCount === 0 → badge "Step 2 of 2 — Seed your wiki"
 *      and the FormSection (import wizard) renders.
 *   4. Connected + pageCount > 0 → NO step badge, AlreadyOnboarded
 *      bouncer renders.
 *   5. Successful connect triggers a /auth/me re-fetch so a now-populated
 *      tenant flips from connect-step → bouncer (not → import wizard).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

// Avoid pulling in the real link prefetch logic during tests.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiBase: vi.fn(() => "/api/backend"),
    onboardingConnectRepo: vi.fn(),
    onboardingListMyRepos: vi.fn(() =>
      Promise.resolve({
        ok: true,
        repos: [
          {
            full_name: "alice/cary-wiki",
            name: "cary-wiki",
            private: true,
            html_url: "https://github.com/alice/cary-wiki",
            description: null,
            default_branch: "main",
          },
        ],
        has_repo_scope: true,
      }),
    ),
    onboardingImportWiki: vi.fn(),
    onboardingCleanupImports: vi.fn(),
    // The guided-assembly path POSTs the bundle through this wrapper.
    // Default to a resolved response so individual tests can spy on
    // call args; tests that simulate failures override with mockRejectedValue.
    onboardingAssemble: vi.fn(),
  };
});

import { onboardingAssemble, onboardingConnectRepo } from "@/lib/api";
import WelcomePage from "@/app/welcome/page";

const mockConnect = onboardingConnectRepo as unknown as ReturnType<
  typeof vi.fn
>;
const mockAssemble = onboardingAssemble as unknown as ReturnType<typeof vi.fn>;

type AuthMeOverride = {
  authenticated?: boolean;
  pageCount?: number;
  connected?: boolean;
  repo?: string;
};

/** Build a stand-in /auth/me response. Defaults to a fresh signup who
 * has just OAuth'd in and has no GitHub repo bound yet. */
function authMeBody(overrides: AuthMeOverride = {}) {
  const {
    authenticated = true,
    pageCount = 0,
    connected = false,
    repo = "",
  } = overrides;
  return {
    authenticated,
    user: authenticated
      ? {
          tenant_id: "alice",
          login: "alice",
          name: "Alice Example",
          avatar_url: "https://example.com/a.png",
        }
      : undefined,
    tenant: authenticated ? { id: "alice", display_name: "Alice" } : undefined,
    page_count: pageCount,
    fresh_signup: pageCount === 0,
    duplicate_imports_count: 0,
    github_sync: {
      connected,
      repo,
      branch: "main",
      html_url: repo ? `https://github.com/${repo}` : "",
      last_synced_at: 0,
      last_error: "",
      pushes_made: 0,
    },
  };
}

/** Set up a fetch stub that returns a queue of responses keyed by URL.
 * Each call to ``/auth/me`` shifts the next queued response off the
 * front so tests can simulate "mount fetch returns A, post-connect
 * fetch returns B". */
function stubAuthMeQueue(responses: ReturnType<typeof authMeBody>[]): void {
  const queue = [...responses];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/auth/me")) {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Onboarding-related side fetches (e.g. orchestrator job polls)
    // shouldn't fire during the test paths we exercise — fail loud if
    // they do so we notice when a refactor accidentally adds traffic.
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as any;
}

describe("WelcomePage step badge + post-connect refetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });
  afterEach(() => {
    // Reset the global fetch override between tests so a leak from
    // one test can't poison the next.
    delete (global as any).fetch;
  });

  it("fresh signup renders the 'Step 1 of 2 — Connect GitHub' badge ONCE", async () => {
    stubAuthMeQueue([authMeBody({ pageCount: 0, connected: false })]);

    render(<WelcomePage />);

    const badge = await screen.findByTestId("welcome-step-badge");
    expect(badge.textContent).toMatch(/Step 1 of 2 — Connect GitHub/);

    // ConnectRepoStep must NOT render its own step-badge text. Before
    // the fix, ``Step 1 of 2 — Connect GitHub`` appeared TWICE on the
    // same page (once in Header, once inside ConnectRepoStep). Now
    // only the Header carries it.
    const stepCopies = screen.queryAllByText(/Step 1 of 2 — Connect GitHub/);
    expect(stepCopies).toHaveLength(1);

    // The connect-step card must be the one that's rendering (sanity
    // check that we're on the right branch).
    expect(screen.getByTestId("connect-repo-step")).toBeInTheDocument();
  });

  it("existing-tenant migration renders 'One-time upgrade' instead of fresh-signup copy", async () => {
    // Migration case: tenant already has pages from a pre-GitHub-sync
    // era, but isn't connected yet. The badge should pivot to the
    // migration copy.
    stubAuthMeQueue([authMeBody({ pageCount: 12, connected: false })]);

    render(<WelcomePage />);

    const badge = await screen.findByTestId("welcome-step-badge");
    expect(badge.textContent).toMatch(/One-time upgrade/);
    expect(badge.textContent).not.toMatch(/Step 1 of 2/);
  });

  it("connected + populated → bouncer with NO step badge", async () => {
    // A returning user who already finished onboarding. There's no
    // "step" to be on — they should see the AlreadyOnboarded panel
    // with no step badge above it.
    stubAuthMeQueue([
      authMeBody({ pageCount: 9, connected: true, repo: "alice/cary-wiki" }),
    ]);

    render(<WelcomePage />);

    // Wait for the page-count branch to render. We pin on a copy
    // string that AlreadyOnboarded uses for the count line.
    await waitFor(() => {
      expect(screen.queryByTestId("welcome-step-badge")).not.toBeInTheDocument();
    });
  });

  it("connected + empty → 'Step 2 of 2 — Seed your wiki'", async () => {
    stubAuthMeQueue([
      authMeBody({ pageCount: 0, connected: true, repo: "alice/empty-wiki" }),
    ]);

    render(<WelcomePage />);

    const badge = await screen.findByTestId("welcome-step-badge");
    expect(badge.textContent).toMatch(/Step 2 of 2 — Seed your wiki/);
  });

  it("post-connect /auth/me re-fetch flips to bouncer when the new repo had content", async () => {
    // This is the load-bearing regression test for the
    // cary-wiki-connect bug: after a successful connect against a
    // populated repo, the welcome page MUST re-fetch /auth/me to pick
    // up the freshly-cloned content. Without the re-fetch, pageCount
    // stayed stale at 0 and the user got bounced into the import
    // wizard instead of the AlreadyOnboarded panel.
    stubAuthMeQueue([
      // Mount fetch: nothing connected yet, no content.
      authMeBody({ pageCount: 0, connected: false }),
      // Post-connect fetch: connect succeeded, bootstrap cloned 9
      // pages, /auth/me now reports the live count.
      authMeBody({ pageCount: 9, connected: true, repo: "alice/cary-wiki" }),
    ]);

    mockConnect.mockResolvedValueOnce({
      ok: true,
      connected: true,
      repo: "alice/cary-wiki",
      branch: "main",
      html_url: "https://github.com/alice/cary-wiki",
      bootstrap: { ok: true, action: "synced" },
      status: {
        connected: true,
        repo: "alice/cary-wiki",
        branch: "main",
        html_url: "https://github.com/alice/cary-wiki",
        last_synced_at: 0,
        last_error: "",
        pushes_made: 0,
      },
    });

    render(<WelcomePage />);

    // Wait for the connect-step card to render before we drive it.
    await screen.findByTestId("connect-repo-step");

    // The connect form defaults to "Create new repo" mode. Switch to
    // "Use an existing repo" and drive the picker.
    fireEvent.click(screen.getByText(/Use an existing repo/i));

    // Wait for the repo picker dropdown to load (mocked
    // onboardingListMyRepos resolves immediately).
    const picker = await screen.findByRole("combobox");
    fireEvent.change(picker, { target: { value: "alice/cary-wiki" } });
    fireEvent.click(screen.getByText(/Connect this repo/i));

    await waitFor(() => {
      // Confirm onboarding/connect-repo was hit with the right repo.
      expect(mockConnect).toHaveBeenCalledWith({
        create_new: false,
        repo: "alice/cary-wiki",
      });
    });

    // The fix: after onConnected, fetchAuthMe re-runs. The next render
    // sees pageCount=9 + connected=true, which routes to the bouncer.
    // The connect-step card must be gone AND there must be no step
    // badge anymore (bouncer doesn't show one).
    await waitFor(() => {
      expect(screen.queryByTestId("connect-repo-step")).not.toBeInTheDocument();
      expect(screen.queryByTestId("welcome-step-badge")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Guided assembly UI — first-signup bundle wizard
// ---------------------------------------------------------------------------
//
// Locks the behavioral contract of the new /onboarding/assemble form:
//   1. Renders only after the user is GitHub-connected (repo-first gate).
//   2. Submit button disabled while the bundle is empty.
//   3. Filling in ONE field enables submit.
//   4. Pressing submit posts a payload that includes the question text
//      (so the backend doesn't need a question catalog).
//   5. URL rows are dynamic — add/remove without losing the rest of
//      the form state.
//   6. On success the wizard transitions out of the form.

describe("WelcomePage guided-assembly form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    // Default success response — most tests assert against the form
    // before/after submit, not the response shape itself. Tests that
    // care about the response override per-call.
    mockAssemble.mockResolvedValue({
      ok: true,
      tenant_id: "alice",
      answers_count: 0,
      text_count: 0,
      urls: [],
      usable_url_count: 0,
      raw_path: "raw/imports/2026-06-04-onboarding-assembly.md",
      orchestrator_started: false,
      tracking_id: null,
      pages_created: 6,
      draft_backend: "anthropic",
    });
  });
  afterEach(() => {
    delete (global as any).fetch;
  });

  it("renders the assemble form (not paste/URL tabs) when connected + empty", async () => {
    stubAuthMeQueue([
      authMeBody({ pageCount: 0, connected: true, repo: "alice/empty-wiki" }),
    ]);

    render(<WelcomePage />);

    // The guided form should be the primary path. The two-tab segmented
    // control has "Assemble starter wiki" + "Import existing wiki" —
    // not the legacy "Paste bio / Scrape URL / Import existing wiki".
    expect(await screen.findByTestId("assemble-form")).toBeInTheDocument();
    expect(screen.getByText(/Assemble starter wiki/i)).toBeInTheDocument();
    expect(screen.getByText(/Import existing wiki/i)).toBeInTheDocument();
    // The old paste/URL tab labels MUST be gone — leaving them around
    // would resurrect the "pick one source" UX we replaced.
    expect(screen.queryByText(/^Paste bio$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Scrape URL$/)).not.toBeInTheDocument();
  });

  it("disables submit while the bundle is empty and enables once a question is answered", async () => {
    stubAuthMeQueue([
      authMeBody({ pageCount: 0, connected: true, repo: "alice/empty-wiki" }),
    ]);

    render(<WelcomePage />);

    const submit = (await screen.findByTestId("assemble-submit")) as HTMLButtonElement;
    expect(submit).toBeDisabled();
    // Meter copy should hint at what unblocks the button.
    expect(screen.getByTestId("assemble-meter").textContent).toMatch(
      /Answer a question, paste something, or add a link/i,
    );

    // Type into the first interview question. The button should flip
    // to enabled and the meter copy should switch to a count.
    const firstQuestion = screen.getByTestId("assemble-question-identity") as HTMLTextAreaElement;
    fireEvent.change(firstQuestion, {
      target: { value: "Staff engineer at Strand Bio." },
    });

    await waitFor(() => {
      expect(submit).not.toBeDisabled();
    });
    expect(screen.getByTestId("assemble-meter").textContent).toMatch(
      /1 answer/i,
    );
  });

  it("submits the bundle with the literal question prompt + filled-in fields", async () => {
    stubAuthMeQueue([
      authMeBody({ pageCount: 0, connected: true, repo: "alice/empty-wiki" }),
    ]);

    render(<WelcomePage />);

    // Answer one question.
    fireEvent.change(
      await screen.findByTestId("assemble-question-current"),
      { target: { value: "Building portablellm.wiki." } },
    );
    // Paste a resume.
    fireEvent.change(screen.getByTestId("assemble-text-resume"), {
      target: { value: "Resume body: Staff Eng @ Acme since 2024." },
    });
    // Fill the first URL row.
    const urlInputs = screen.getAllByPlaceholderText(/your-portfolio/i);
    fireEvent.change(urlInputs[0], {
      target: { value: "https://alice.example" },
    });

    const submit = screen.getByTestId("assemble-submit") as HTMLButtonElement;
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mockAssemble).toHaveBeenCalledTimes(1);
    });
    const [payload] = mockAssemble.mock.calls[0];

    // The wizard MUST post the literal prompt text for the catalog-free
    // backend contract. Whitespace-only / unfilled questions are filtered
    // out client-side.
    expect(payload.answers).toEqual([
      {
        question: "What are you working on right now?",
        answer: "Building portablellm.wiki.",
      },
    ]);
    // Resume slot maps to kind:"resume".
    expect(payload.text_sources).toEqual([
      {
        kind: "resume",
        label: "Resume or CV",
        content: "Resume body: Staff Eng @ Acme since 2024.",
      },
    ]);
    // Empty label is filtered server-side; we just verify the URL is sent.
    expect(payload.urls).toEqual([
      { url: "https://alice.example", label: "" },
    ]);
    expect(payload.run_orchestrator).toBe(true);
  });

  it("supports adding and removing URL rows without losing other state", async () => {
    stubAuthMeQueue([
      authMeBody({ pageCount: 0, connected: true, repo: "alice/empty-wiki" }),
    ]);

    render(<WelcomePage />);

    // Fill an answer so we can verify it survives URL-row churn.
    fireEvent.change(
      await screen.findByTestId("assemble-question-identity"),
      { target: { value: "I am Alice." } },
    );

    // One URL row by default.
    expect(screen.getByTestId("assemble-url-row-0")).toBeInTheDocument();
    expect(screen.queryByTestId("assemble-url-row-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Add another link/i));
    expect(screen.getByTestId("assemble-url-row-1")).toBeInTheDocument();

    // Fill both rows.
    const urlInputs = screen.getAllByPlaceholderText(/your-portfolio/i);
    fireEvent.change(urlInputs[0], {
      target: { value: "https://first.example" },
    });
    fireEvent.change(urlInputs[1], {
      target: { value: "https://second.example" },
    });

    // Remove the first row via its "×" button.
    const removeButtons = screen.getAllByLabelText(/Remove link/i);
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(screen.queryByTestId("assemble-url-row-1")).not.toBeInTheDocument();
    });

    // The second row's URL must have moved into row 0 (its content
    // survived the removal). The unrelated answer must also survive.
    const remainingUrlInputs = screen.getAllByPlaceholderText(/your-portfolio/i);
    expect((remainingUrlInputs[0] as HTMLInputElement).value).toBe(
      "https://second.example",
    );
    expect(
      (screen.getByTestId("assemble-question-identity") as HTMLTextAreaElement)
        .value,
    ).toBe("I am Alice.");
  });

  it("clears the last URL row instead of removing it (form never collapses)", async () => {
    stubAuthMeQueue([
      authMeBody({ pageCount: 0, connected: true, repo: "alice/empty-wiki" }),
    ]);

    render(<WelcomePage />);

    const urlInput = (await screen.findAllByPlaceholderText(/your-portfolio/i))[0];
    fireEvent.change(urlInput, { target: { value: "https://lonely.example" } });

    // Remove the only row.
    fireEvent.click(screen.getByLabelText(/Remove link/i));

    // Row must still be present (just blanked) so the user can keep
    // typing without re-discovering the "Add another link" button.
    const after = screen.getByTestId("assemble-url-row-0");
    expect(after).toBeInTheDocument();
    const cleared = screen.getAllByPlaceholderText(/your-portfolio/i)[0] as HTMLInputElement;
    expect(cleared.value).toBe("");
  });

  it("transitions out of the form on a successful submit and shows the bundle recap", async () => {
    stubAuthMeQueue([
      authMeBody({ pageCount: 0, connected: true, repo: "alice/empty-wiki" }),
    ]);

    mockAssemble.mockResolvedValueOnce({
      ok: true,
      tenant_id: "alice",
      answers_count: 1,
      text_count: 0,
      urls: [
        {
          url: "https://offline.example",
          label: "",
          status: "failed",
          scraped: { url: "https://offline.example", errors: ["http 500"] },
        },
      ],
      usable_url_count: 0,
      raw_path: "raw/imports/2026-06-04-onboarding-assembly.md",
      orchestrator_started: false,
      tracking_id: null,
      pages_created: 6,
      draft_backend: "anthropic",
    });

    render(<WelcomePage />);

    // Provide one answer + one (failing) URL so the bundle is non-empty.
    fireEvent.change(
      await screen.findByTestId("assemble-question-identity"),
      { target: { value: "I am Alice." } },
    );
    const urlInputs = screen.getAllByPlaceholderText(/your-portfolio/i);
    fireEvent.change(urlInputs[0], {
      target: { value: "https://offline.example" },
    });

    fireEvent.click(screen.getByTestId("assemble-submit"));

    // On success with no tracking_id the wizard short-circuits to done.
    // The summary recap must be visible AND mention the failed URL so
    // the user isn't left wondering what happened to their link.
    const recap = await screen.findByTestId("assemble-summary");
    expect(recap.textContent).toMatch(/read 0 of 1 link/i);
    expect(recap.textContent).toMatch(/offline\.example/);

    // The form itself must be gone — we transitioned to the done view.
    expect(screen.queryByTestId("assemble-form")).not.toBeInTheDocument();

    // Regression guard: on the hosted path Puppetmaster ("the
    // orchestrator") is never installed, so the synchronous direct-LLM
    // drafter does the work and returns pages_created. Drafting 6 pages
    // is a SUCCESS — the done view must NOT contradict its own "Drafted
    // N pages" header with an alarming "Orchestrator was unavailable"
    // footer. That false-negative is exactly the bug this fix closed.
    expect(screen.queryByText(/Orchestrator was unavailable/i)).toBeNull();
    expect(
      screen.queryByText(/couldn['’]t draft pages automatically/i),
    ).toBeNull();
  });
});
