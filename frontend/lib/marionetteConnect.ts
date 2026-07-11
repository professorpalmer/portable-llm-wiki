/**
 * Marionette deep-link helpers for portablellm.wiki ↔ Marionette handshake.
 *
 * Flow:
 *   1. Marionette opens /welcome?client=marionette (or /connect/marionette)
 *   2. After signup / owner auth, we mint a private personal LLM token
 *   3. Navigate to marionette://wiki-connect?url=<personal LLM URL>
 *   4. Electron intercepts the scheme, POSTs /api/wiki/config, wiki panel refreshes
 */

export const MARIONETTE_CLIENT_KEY = "pllmwiki.client.marionette";
export const MARIONETTE_SCHEME = "marionette://wiki-connect";

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
      return true;
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

/** Navigate into Marionette via custom protocol (Electron intercepts). */
export function handoffToMarionette(personalLlmUrl: string): void {
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
