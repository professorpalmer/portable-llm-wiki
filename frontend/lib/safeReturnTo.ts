/**
 * Safe return_to for GitHub login / post-auth redirects.
 *
 * Login URLs must never forward ?share=, ?t=, ?return=, or ?nonce= —
 * those leak share tokens and marionette loopback secrets through
 * OAuth. Pathname only is enough: marionette client state is already
 * remembered in sessionStorage before we bounce to GitHub.
 */
export function loginReturnTo(href?: string): string {
  try {
    const raw =
      href ??
      (typeof window !== "undefined" ? window.location.href : "/");
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://portablellm.wiki";
    const url = new URL(raw, origin);
    return url.pathname || "/";
  } catch {
    return "/";
  }
}

export function safeReturnTo(href?: string): string {
  return loginReturnTo(href);
}
