// Centralized prompt templates for the LLM handshake protocol.
//
// THE PROBLEM
// -----------
// We hand recipients a URL (e.g. portablellm.wiki/<tenant>/llm) and
// trust them to paste it into an LLM. In practice users paste the URL
// + a question like "who am I?" and the LLM (ChatGPT, Claude) often
// web-searches the domain instead of actually fetching the URL. The
// returned answer is a guess from cached search snippets and the wiki
// content is never read.
//
// THE FIX
// -------
// Wrap the URL in an imperative "fetch this URL and follow its API
// instructions" prompt. The /llm endpoint returns a self-describing
// markdown handshake that documents the wiki's API surface — once the
// LLM actually fetches it, the rest of the conversation works
// reliably across providers.
//
// We use the same wrapper in THREE places so the protocol is
// consistent end-to-end:
//
//   1. QR code payloads — when an LLM with vision decodes the QR (or
//      a phone camera scans it), the payload IS the fetch-forcing
//      prompt. Phone scanners still detect the embedded URL and offer
//      to open it as a browser link.
//
//   2. /share "Copy" buttons — three buttons let the owner copy the
//      bare URL, a "who am I?" tee-up, or the full force-fetch prompt
//      to clipboard, depending on how much hand-holding the target
//      LLM needs.
//
//   3. Future MCP / system prompt templates — same wrapper means we
//      have one canonical phrasing to A/B against if real-world LLMs
//      misbehave.

/** Builds the QR code payload.
 *
 *  WHY THIS IS JUST THE URL (no wrapper prompt)
 *  --------------------------------------------
 *  An earlier version of this helper wrapped the URL in a fetch-forcing
 *  prompt ("GET <url> and follow the API spec in the response.") so a
 *  vision-AI decoder would get an imperative instruction along with the
 *  URL. In practice that broke the dominant use case:
 *
 *    Phone camera scan → detects payload → sees "GET https://…" → does
 *    NOT recognize it as a clean URL → shows the text as a chip the
 *    user has to tap to copy, rather than offering "Open in browser".
 *
 *  Phone scanners (iOS Camera, Android Lens, Google Camera) only emit
 *  a one-tap "Open URL" action when the entire decoded payload IS a
 *  URL. Any prefix like "GET " or "LLM: " demotes the payload to plain
 *  text and adds a tap. For a print artifact whose whole job is to be
 *  scanned and opened, that's the wrong trade.
 *
 *  The fetch-forcing prompt isn't lost — it lives in the /share copy
 *  buttons (PROMPT_TEMPLATES below) where it actually matters, since
 *  the recipient is pasting into a chat box anyway. And the /llm
 *  endpoint the URL resolves to IS the self-describing handshake, so
 *  any LLM that fetches the URL gets the full API spec in the
 *  response. The QR's only job is to ferry that URL.
 *
 *  Length: a typical tenant URL is ~45 bytes, well under the threshold
 *  where QR density hurts scannability. A QR encoding just the URL
 *  fits in version 4 (33×33 modules) at error-correction level M and
 *  scans reliably down to ~150px on screen and ~0.6 inch in print. */
export function buildQrPayload(llmUrl: string): string {
  return llmUrl;
}


// =====================================================================
// Tier-aware URL builder
// =====================================================================

/** Tiers a share kit can produce a URL/QR for. "private" is owner-only
 *  and intentionally absent — there's no scenario where you'd hand
 *  someone a private-tier scan code, and excluding it from the toggle
 *  UI prevents the obvious footgun. */
export type ShareTier = "public" | "recruiter" | "friend";


/** Build the LLM-handshake URL for a given tier.
 *
 *  Public tier → bare /llm endpoint (no token needed).
 *  Recruiter / friend → /llm?t=<token>, which the backend resolves to
 *  the right viewer tier and returns markdown filtered to that tier's
 *  visible pages.
 *
 *  We use `?t=` (not `?share=`) because `/llm?t=` is the LLM-facing
 *  endpoint that returns the self-describing markdown handshake, while
 *  `?share=` is the human-browser path that stores the token in
 *  localStorage and renders the React wiki UI. Different audiences,
 *  different URLs — this helper is for the LLM/paste-into-ChatGPT path
 *  only. For QR codes (which are scanned by humans with phones, not by
 *  LLMs with vision), use buildHumanShareUrl instead. */
export function buildLlmUrlForTier(opts: {
  origin: string;
  tenant?: string;
  tier: ShareTier;
  token?: string | null;
}): string {
  const base = opts.origin.replace(/\/+$/, "");
  const tenantSegment = opts.tenant ? `/${opts.tenant}` : "";
  if (opts.tier === "public") {
    return `${base}${tenantSegment}/llm`;
  }
  // Non-public tiers require a token; if we don't have one yet we
  // still return the bare URL (the toggle UI is expected to surface
  // a "mint a token first" CTA in this state).
  if (!opts.token) {
    return `${base}${tenantSegment}/llm`;
  }
  return `${base}${tenantSegment}/llm?t=${encodeURIComponent(opts.token)}`;
}


/** Build the HUMAN-FACING share URL — the one we encode in QRs and DM
 *  to a person who'll open it in a browser.
 *
 *  Public tier → bare tenant landing path (e.g. /<tenant>). The wiki
 *  renders its own HTML, including the "Paste this URL into any LLM"
 *  callout at the top of the page — so a human who scans the QR lands
 *  on something they can read, AND has one-click access to the LLM
 *  URL for the paste-into-ChatGPT flow.
 *
 *  Recruiter / friend → /<tenant>?share=<token>. ShareTokenCatcher
 *  (mounted globally in app/layout.tsx) pulls the token out of the URL
 *  on first paint, stores it in localStorage, and strips ?share= from
 *  the address bar so the user doesn't accidentally leak the token via
 *  reload / clipboard. Subsequent page navigation respects the
 *  elevated tier.
 *
 *  Why a SEPARATE helper from buildLlmUrlForTier: the two URLs have
 *  different audiences (humans vs LLMs), different query-param shapes
 *  (?share= captured by JS vs ?t= read by the backend), and live on
 *  different routes (landing page vs /llm endpoint). Conflating them
 *  caused our original bug where QR scans opened raw markdown instead
 *  of the wiki landing. Different audiences, different builders. */
export function buildHumanShareUrl(opts: {
  origin: string;
  tenant?: string;
  tier: ShareTier;
  token?: string | null;
}): string {
  const base = opts.origin.replace(/\/+$/, "");
  const tenantSegment = opts.tenant ? `/${opts.tenant}` : "";
  if (opts.tier === "public" || !opts.token) {
    return `${base}${tenantSegment}` || "/";
  }
  return `${base}${tenantSegment}?share=${encodeURIComponent(opts.token)}`;
}


/** Strip the origin off an absolute URL so a fetch goes through the
 *  current page's origin (Next.js rewrites do the proxying).
 *
 *  Why this exists: the /share page renders absolute URLs like
 *  ``https://portablellm.wiki/<tenant>/llm`` for display, copy, and QR
 *  encoding — those have to be canonical so people who paste them get
 *  the right destination. But the in-product "preview what an LLM
 *  sees" button does a ``fetch()`` against that same URL, which
 *  becomes a CROSS-ORIGIN request when the user is on
 *  ``www.portablellm.wiki`` and the canonical URL is the apex
 *  ``portablellm.wiki`` (or vice versa). Browsers then either block
 *  the request outright (mixed CORS) or surface a generic
 *  ``NetworkError`` because the canonical host's CORS allowlist
 *  doesn't include the ``www.`` variant.
 *
 *  Converting to a same-origin path before fetching sidesteps the
 *  problem entirely: the request goes to the same host as the page,
 *  Next.js rewrites it to the backend, and CORS never enters the
 *  picture. The DISPLAYED URL is unchanged.
 *
 *  Falls back to the input string when the URL is already relative or
 *  can't be parsed — fetch() will then just hit the input verbatim. */
export function toSameOriginPath(absoluteUrl: string): string {
  try {
    const u = new URL(absoluteUrl);
    return u.pathname + u.search + u.hash;
  } catch {
    return absoluteUrl;
  }
}


/** Per-tier copy that explains what scanning the QR will reveal —
 *  surfaced as a caption under each tier toggle so the owner knows
 *  exactly what they're handing out before they hand it out. */
export const TIER_LABEL: Record<ShareTier, string> = {
  public: "Public",
  recruiter: "Recruiter",
  friend: "Friend",
};


export const TIER_DESCRIPTION: Record<ShareTier, string> = {
  public:
    "What anyone with the URL sees. Safe for résumés, portfolios, social posts.",
  recruiter:
    "Public + recruiter pages. Career-facing detail an interviewer might want.",
  friend:
    "Public + recruiter + friend pages. Personal context (not sensitive).",
};


/** Tier badge colors mirror the ShareTokensPanel palette so the same
 *  colors mean the same tier everywhere in the product. */
export const TIER_BADGE_CLASSES: Record<ShareTier, string> = {
  public: "border-emerald-300 bg-emerald-50 text-emerald-800",
  recruiter: "border-blue-300 bg-blue-50 text-blue-800",
  friend: "border-purple-300 bg-purple-50 text-purple-800",
};


/** The "who am I?" prompt — the most common ask. Copy-pasteable. */
export function buildWhoAmIPrompt(llmUrl: string): string {
  return (
    `Use the URL below to answer "Who am I?". Fetch the URL with ` +
    `your browse/web tool — the response is a self-describing ` +
    `markdown handshake. Follow the API instructions in the handshake ` +
    `to fetch the relevant wiki pages, then answer in your own words ` +
    `with inline links back to the pages you cited.\n\n${llmUrl}`
  );
}


/** The "full briefing" prompt — most aggressive force-fetch wording.
 *  Use this when an LLM has been lazy and just paraphrasing the URL
 *  instead of fetching. */
export function buildFullFetchPrompt(llmUrl: string): string {
  return (
    `You are connected to a Portable LLM Wiki — a vendor-neutral, ` +
    `markdown-based personal context system. You MUST fetch the URL ` +
    `below using your web/browse tool BEFORE answering anything. The ` +
    `response is a self-describing handshake with the wiki's API ` +
    `endpoints documented in plain text. Follow those endpoints to ` +
    `retrieve the relevant pages, then answer my questions citing ` +
    `the page URLs you read.\n\nHandshake URL: ${llmUrl}\n\n` +
    `First task: introduce this person to me and tell me the three ` +
    `most interesting things about them.`
  );
}


export type PromptVariant = "url-only" | "who-am-i" | "full-fetch";


export type PromptTemplate = {
  id: PromptVariant;
  /** Short label shown on the button. */
  label: string;
  /** One-line description shown beneath the button. */
  description: string;
  /** Builds the clipboard payload from the wiki's /llm URL. */
  build: (llmUrl: string) => string;
};


/** Ordered list of templates surfaced in /share's copy-button row.
 *  Order matters: we lead with the bare URL (lowest commitment), then
 *  the casual "who am I?" tee-up, then the full force-fetch instruction
 *  for stubborn LLMs that web-search instead of browse. */
export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "url-only",
    label: "Just the URL",
    description: "Bare URL. Paste it and hope the LLM browses (most do).",
    build: (url) => url,
  },
  {
    id: "who-am-i",
    label: '+ "Who am I?"',
    description: "URL plus a casual prompt — works in ChatGPT, Claude, Gemini.",
    build: buildWhoAmIPrompt,
  },
  {
    id: "full-fetch",
    label: "Full briefing prompt",
    description: "Force-fetch wording for lazy LLMs that web-search instead.",
    build: buildFullFetchPrompt,
  },
] as const;
