"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { apiBase, authLogout, authMe, isHostedMode, type AuthUser } from "@/lib/api";
import { loginReturnTo } from "@/lib/safeReturnTo";

import { ViewerBadge } from "./ViewerBadge";

// Links anyone can see (viewer pages). In hosted mode they're scoped to
// whichever tenant the nav resolves to (URL tenant > signed-in user >
// "avery" demo).
const VIEWER_LINKS: { slug: string; label: string }[] = [
  { slug: "browse", label: "browse" },
  { slug: "graph", label: "graph" },
  { slug: "ask", label: "ask" },
  { slug: "connect", label: "connect" },
];

// Owner-only links. In hosted mode we only render these when the
// signed-in viewer is on their OWN tenant's pages — anonymous demo
// viewers and people peeking at someone else's wiki should not see
// owner controls in the chrome.
const OWNER_LINKS: { slug: string; label: string }[] = [
  { slug: "capture", label: "capture" },
  { slug: "owner", label: "owner" },
  { slug: "share", label: "share" },
];

// Routes where the global nav has no business showing — auth flow,
// onboarding, raw redirect pages. The header bar (logo + sign-in CTA)
// still shows; only the nav links collapse.
const HIDE_NAV_ON: string[] = ["/welcome", "/signup", "/signin", "/me"];

export function NavBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const params = useParams();
  const hosted = isHostedMode();

  // ---- Resolve the tenant the nav links should point at ----------------
  //
  // 1. If the URL has a [tenant] segment (we're on /<tenant>/...): that wins.
  //    Even anonymous viewers browsing /avery/ask should have nav links
  //    going to /avery/<page> rather than wandering off to /signup.
  // 2. Else if we're signed in: use our own tenant.
  // 3. Else (anonymous on /, /welcome, etc.): default to the public
  //    "avery" demo so the demo is always one click away.
  const urlTenant =
    typeof params?.tenant === "string"
      ? params.tenant
      : Array.isArray(params?.tenant)
        ? params.tenant[0]
        : undefined;

  const [viewer, setViewer] = useState<AuthUser | null>(null);
  const [viewerLoaded, setViewerLoaded] = useState(false);

  useEffect(() => {
    if (!hosted) {
      setViewerLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const me = await authMe();
        if (cancelled) return;
        if (me.authenticated && me.user) setViewer(me.user);
      } catch {
        // Auth check is best-effort — failures degrade to "anonymous".
      } finally {
        if (!cancelled) setViewerLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hosted]);

  const effectiveTenant = useMemo(() => {
    if (!hosted) return undefined;
    if (urlTenant) return urlTenant;
    if (viewer?.tenant_id) return viewer.tenant_id;
    return "avery";
  }, [hosted, urlTenant, viewer]);

  // Show owner-only links only when the signed-in user OWNS the tenant
  // the nav is pointing at. (Anonymous viewers and viewers on someone
  // else's wiki never see them.)
  const showOwnerLinks =
    !hosted || (!!viewer && viewer.tenant_id === effectiveTenant);

  // Hide nav links entirely on auth-flow pages — they're a distraction
  // and most of them would 404 in those contexts anyway.
  const shouldHideNav = !!pathname && HIDE_NAV_ON.some((p) => pathname === p);

  const buildHref = (slug: string): string => {
    if (!hosted) return `/${slug}`;
    return `/${effectiveTenant}/${slug}`;
  };

  const isActive = (slug: string): boolean => {
    if (!pathname) return false;
    if (!hosted) return pathname.startsWith(`/${slug}`);
    return pathname.startsWith(`/${effectiveTenant}/${slug}`);
  };

  type NavItem = { slug: string; label: string };
  const navItems: NavItem[] = shouldHideNav
    ? []
    : [
        ...VIEWER_LINKS,
        ...(showOwnerLinks ? OWNER_LINKS : []),
      ];

  // Close drawer on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while drawer is open
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) {
      const original = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [open]);

  return (
    <header className="border-b border-paper-soft bg-paper sticky top-0 z-30">
      <div className="max-w-5xl mx-auto px-4 sm:px-5 py-3 flex items-center gap-4 sm:gap-6">
        <Link
          href="/"
          className="font-semibold tracking-tight text-ink text-sm sm:text-base whitespace-nowrap"
        >
          <span className="text-accent">·</span> portable llm wiki
        </Link>

        {/* Desktop nav */}
        {navItems.length > 0 && (
          <nav className="hidden md:flex gap-4 text-sm text-ink-muted">
            {navItems.map((l) => (
              <Link
                key={l.slug}
                href={buildHref(l.slug)}
                className={`hover:text-ink ${
                  isActive(l.slug) ? "text-ink font-medium" : ""
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden sm:block">
            {hosted ? (
              <HostedIdentityBadge viewer={viewer} loaded={viewerLoaded} />
            ) : (
              <ViewerBadge />
            )}
          </div>

          {/* Mobile hamburger — only when there's actually a menu */}
          {navItems.length > 0 && (
            <button
              type="button"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="md:hidden p-1.5 rounded text-ink hover:bg-paper-soft"
            >
              {open ? <CloseIcon /> : <MenuIcon />}
            </button>
          )}
        </div>
      </div>

      {/* Mobile drawer */}
      {open && navItems.length > 0 && (
        <div
          className="md:hidden fixed inset-x-0 top-[57px] bottom-0 z-30 bg-paper/95 backdrop-blur-sm border-t border-paper-soft animate-in fade-in duration-150"
          onClick={() => setOpen(false)}
        >
          <div
            className="max-w-5xl mx-auto px-5 py-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 sm:hidden">
              {hosted ? (
                <HostedIdentityBadge viewer={viewer} loaded={viewerLoaded} />
              ) : (
                <ViewerBadge />
              )}
            </div>
            <nav className="flex flex-col">
              {navItems.map((l) => (
                <Link
                  key={l.slug}
                  href={buildHref(l.slug)}
                  className={`block py-3 border-b border-paper-soft text-base ${
                    isActive(l.slug)
                      ? "text-ink font-medium"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {l.label}
                </Link>
              ))}
            </nav>
            <div className="mt-6 text-xs text-ink-muted">
              tap outside or hit × to close
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Hosted-mode identity badge: replaces ViewerBadge in the hosted product.
//
// Anonymous viewer → "Sign in with GitHub" button.
// Signed-in viewer → @username chip that opens an account menu with
//   Open my wiki / Owner console / Share / Switch account / Sign out.
//
// Account switching: GitHub OAuth has no select-account prompt (unlike
// Google), so "Switch account" can only clear OUR session and send the
// user back through GitHub. They have to be signed into the OTHER
// GitHub account in their browser already (or open a different
// browser / incognito) for the switch to land on a different identity.
// The menu copy makes that explicit.
// ---------------------------------------------------------------------------

function HostedIdentityBadge({
  viewer,
  loaded,
}: {
  viewer: AuthUser | null;
  loaded: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!loaded) {
    return <span className="text-xs text-ink-muted">…</span>;
  }
  if (!viewer) {
    const signInUrl = `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(
      loginReturnTo(),
    )}`;
    return (
      <a
        href={signInUrl}
        className="text-xs uppercase tracking-wider text-ink-muted border border-paper-soft px-2 py-1 rounded hover:text-ink hover:border-ink-muted"
      >
        sign in
      </a>
    );
  }

  const signOut = async () => {
    try {
      await authLogout();
    } catch {
      /* still leave the page */
    }
    window.location.assign("/");
  };

  // GET /auth/switch-account no longer clears the session (CSRF).
  // POST logout, then send the user through GitHub login ourselves.
  const switchAccount = async () => {
    try {
      await authLogout();
    } catch {
      /* still offer a fresh login */
    }
    const returnTo = loginReturnTo();
    window.location.assign(
      `${apiBase()}/auth/github/login?return_to=${encodeURIComponent(returnTo)}`,
    );
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-xs uppercase tracking-wider text-ink-muted border border-paper-soft px-2 py-1 rounded hover:text-ink hover:border-ink-muted inline-flex items-center gap-1.5"
      >
        <span>@{viewer.login}</span>
        <svg
          aria-hidden
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-40 w-64 rounded-xl border border-paper-soft bg-white shadow-[0_8px_30px_-12px_rgba(14,14,16,0.25)] overflow-hidden"
        >
          {/* Header — who you are */}
          <div className="px-4 py-3 border-b border-paper-soft bg-paper-soft/40">
            <div className="text-[10px] uppercase tracking-[0.18em] text-ink-muted font-semibold">
              Signed in as
            </div>
            <div className="mt-0.5 text-sm font-medium text-ink font-mono">
              @{viewer.login}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-muted truncate">
              portablellm.wiki/{viewer.tenant_id}
            </div>
          </div>

          {/* Primary nav into your wiki */}
          <div className="py-1">
            <MenuLink
              href={`/${viewer.tenant_id}`}
              label="Open my wiki"
              onClick={() => setOpen(false)}
            />
            <MenuLink
              href={`/${viewer.tenant_id}/owner`}
              label="Owner console"
              onClick={() => setOpen(false)}
            />
            <MenuLink
              href={`/${viewer.tenant_id}/share`}
              label="Share & QR"
              onClick={() => setOpen(false)}
            />
          </div>

          {/* Account management */}
          <div className="border-t border-paper-soft py-1">
            <MenuLink
              label="Switch GitHub account"
              onAction={switchAccount}
              hint="Uses whichever account you're currently signed into on github.com. Open incognito to use a different one."
            />
            <MenuLink
              label="Sign out"
              onAction={signOut}
              danger
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  label,
  danger,
  hint,
  onClick,
  onAction,
}: {
  href?: string;
  label: string;
  danger?: boolean;
  hint?: string;
  onClick?: () => void;
  onAction?: () => void | Promise<void>;
}) {
  const className = `block w-full text-left px-4 py-2 text-sm hover:bg-paper-soft/60 ${
    danger ? "text-red-700 hover:text-red-800" : "text-ink"
  }`;
  if (onAction) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          onClick?.();
          void onAction();
        }}
      >
        <div>{label}</div>
        {hint && (
          <div className="mt-0.5 text-[11px] text-ink-muted font-normal leading-snug">
            {hint}
          </div>
        )}
      </button>
    );
  }
  return (
    <Link href={href || "/"} className={className} onClick={onClick}>
      <div>{label}</div>
      {hint && (
        <div className="mt-0.5 text-[11px] text-ink-muted font-normal leading-snug">
          {hint}
        </div>
      )}
    </Link>
  );
}

function MenuIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}
