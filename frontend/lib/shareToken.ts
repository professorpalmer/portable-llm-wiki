// Tenant-scoped share-token store for human share links (?share=).
//
// Share tokens are NOT owner tokens. Storing a recruiter/friend token
// under llmwiki:ownerToken would overwrite a real OSS OWNER_TOKEN and
// send it as Authorization on owner routes. Browse/API reads send the
// value here as X-Share-Token instead.

const SHARE_TOKEN_PREFIX = "llmwiki:shareToken:";
const DEFAULT_SCOPE = "default";

const RESERVED_FIRST_SEGMENTS = new Set([
  "welcome",
  "signup",
  "signin",
  "me",
  "owner",
  "browse",
  "capture",
  "share",
  "connect",
  "ask",
  "graph",
  "page",
  "og",
  "api",
  "auth",
  "healthz",
  "_next",
  "favicon.ico",
]);

export const SHARE_TOKEN_CHANGE_EVENT = "wiki:share-token-change";

/** First path segment when it looks like a hosted tenant id. */
export function tenantFromPathname(pathname?: string): string | undefined {
  const path =
    pathname ??
    (typeof window !== "undefined" ? window.location.pathname : "");
  const first = path.split("/").filter(Boolean)[0];
  if (!first || RESERVED_FIRST_SEGMENTS.has(first)) return undefined;
  return first;
}

export function shareTokenStorageKey(tenant?: string | null): string {
  const scope = tenant || tenantFromPathname() || DEFAULT_SCOPE;
  return `${SHARE_TOKEN_PREFIX}${scope}`;
}

export function getShareToken(tenant?: string | null): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(shareTokenStorageKey(tenant));
}

export function setShareToken(
  token: string | null,
  tenant?: string | null,
): void {
  if (typeof window === "undefined") return;
  const key = shareTokenStorageKey(tenant);
  if (token) window.localStorage.setItem(key, token);
  else window.localStorage.removeItem(key);
  window.dispatchEvent(new Event(SHARE_TOKEN_CHANGE_EVENT));
  // HandshakeCallout and ViewerBadge already listen for this.
  window.dispatchEvent(new Event("wiki:preview-as-change"));
}

/** Replace plaintext ?t= / ?share= values so tokens never render as text. */
export function redactTokenizedUrl(url: string): string {
  return url
    .replace(/([?&]t=)[^&#]*/gi, "$1••••••••")
    .replace(/([?&]share=)[^&#]*/gi, "$1••••••••");
}
