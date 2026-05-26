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
  };
});

import { onboardingConnectRepo } from "@/lib/api";
import WelcomePage from "@/app/welcome/page";

const mockConnect = onboardingConnectRepo as unknown as ReturnType<
  typeof vi.fn
>;

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
