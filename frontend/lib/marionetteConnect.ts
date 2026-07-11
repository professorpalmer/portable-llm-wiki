/**
 * Marionette deep-link helpers for portablellm.wiki ↔ Marionette handshake.
 *
 * Preferred flow (Windows-safe):
 *   1. Marionette opens /welcome?client=marionette&return=http://127.0.0.1:PORT/api/wiki/connect&nonce=…
 *   2. After signup / owner auth, mint a private personal LLM token
 *   3. Navigate to the loopback return URL with ?url=<personal LLM URL>
 *   4. Marionette harness applies config; no custom protocol, no Store hijack
 *
 * Fallback: marionette://wiki-connect (macOS / registered protocol). On Windows
 * outside Electron, prefer clipboard instead of an unregistered scheme that
 * opens the Microsoft Store.
 */

export const MARIONETTE_CLIENT_KEY = "pllmwiki.client.marionette";
export const MARIONETTE_RETURN_KEY = "pllmwiki.marionette.return";
export const MARIONETTE_NONCE_KEY = "pllmwiki.marionette.nonce";
export const MARIONETTE_SCHEME = "marionette://wiki-connect";
/** Owner-console hash target for the Connect to Marionette control. */
export const MARIONETTE_CONNECT_HASH = "connect-marionette";

function isLoopbackReturn(url: string): boolean {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      return false;
    }
    return u.pathname === "/api/wiki/connect";
  } catch {
    return false;
  }
}

export function rememberMarionetteClientFromLocation(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  try {
    const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
    const client = (params.get("client") || "").toLowerCase();
    if (client === "marionette" || params.get("marionette") === "1") {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(MARIONETTE_CLIENT_KEY, "1");
      }
    }
    const ret = params.get("return") || "";
    if (ret && isLoopbackReturn(ret) && typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(MARIONETTE_RETURN_KEY, ret);
    }
    const nonce = params.get("nonce") || "";
    if (nonce && typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(MARIONETTE_NONCE_KEY, nonce);
    }
  } catch {
    /* ignore */
  }
  return isMarionetteClient();
}

export function isMarionetteClient(): boolean {
  try {
    if (typeof sessionStorage !== "undefined") {
      if (sessionStorage.getItem(MARIONETTE_CLIENT_KEY) === "1") return true;
      if (sessionStorage.getItem(MARIONETTE_RETURN_KEY)) return true;
    }
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const client = (params.get("client") || "").toLowerCase();
      if (client === "marionette" || params.get("marionette") === "1") return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function buildPersonalLlmUrl(
  publicBaseUrl: string,
  tenant: string,
  token: string,
): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const seg = tenant ? `/${tenant}` : "";
  return `${base}${seg}/llm?t=${encodeURIComponent(token)}`;
}

export function buildMarionetteDeepLink(personalLlmUrl: string): string {
  return `${MARIONETTE_SCHEME}?url=${encodeURIComponent(personalLlmUrl)}`;
}

export function buildLoopbackHandoffUrl(personalLlmUrl: string): string | null {
  try {
    const returnBase =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem(MARIONETTE_RETURN_KEY)
        : null;
    if (!returnBase || !isLoopbackReturn(returnBase)) return null;
    const nonce =
      typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem(MARIONETTE_NONCE_KEY) || ""
        : "";
    const u = new URL(returnBase);
    if (nonce) u.searchParams.set("nonce", nonce);
    u.searchParams.set("url", personalLlmUrl);
    return u.toString();
  } catch {
    return null;
  }
}

function isWindowsUa(): boolean {
  try {
    return /Windows/i.test(navigator.userAgent || "");
  } catch {
    return false;
  }
}

function isElectronUa(): boolean {
  try {
    return /Electron/i.test(navigator.userAgent || "");
  } catch {
    return false;
  }
}

/** Navigate into Marionette via loopback return URL, else custom protocol. */
export function handoffToMarionette(personalLlmUrl: string): void {
  const loopback = buildLoopbackHandoffUrl(personalLlmUrl);
  if (loopback) {
    try {
      window.location.assign(loopback);
      return;
    } catch {
      /* fall through */
    }
  }

  // Unregistered marionette:// on Windows opens the Microsoft Store. Prefer
  // clipboard when we are not inside Electron and have no loopback return.
  if (isWindowsUa() && !isElectronUa()) {
    try {
      void navigator.clipboard.writeText(personalLlmUrl);
    } catch {
      /* ignore */
    }
    try {
      window.alert(
        "Personal LLM URL copied. In Marionette open Settings → Wiki Graph, paste it, and Save.",
      );
    } catch {
      /* ignore */
    }
    return;
  }

  const deep = buildMarionetteDeepLink(personalLlmUrl);
  try {
    window.location.assign(deep);
  } catch {
    try {
      window.open(deep, "_self");
    } catch {
      /* ignore */
    }
  }
}

/** Path + hash that lands on Owner console scrolled to Connect Marionette. */
export function buildOwnerConnectPath(tenant: string): string {
  const seg = (tenant || "").replace(/^\/+|\/+$/g, "");
  return `/${seg}/owner#${MARIONETTE_CONNECT_HASH}`;
}

export function shouldFocusMarionetteConnect(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const hash = (window.location.hash || "").replace(/^#/, "");
    return hash === MARIONETTE_CONNECT_HASH;
  } catch {
    return false;
  }
}

/** Smooth-scroll + brief highlight on the Connect to Marionette anchor. */
export function scrollToMarionetteConnect(): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(MARIONETTE_CONNECT_HASH);
  if (!el) return;
  try {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    try {
      el.scrollIntoView();
    } catch {
      /* ignore */
    }
  }
  try {
    el.classList.add("ring-2", "ring-accent", "ring-offset-2", "ring-offset-paper");
    window.setTimeout(() => {
      el.classList.remove(
        "ring-2",
        "ring-accent",
        "ring-offset-2",
        "ring-offset-paper",
      );
    }, 3500);
  } catch {
    /* ignore */
  }
}
