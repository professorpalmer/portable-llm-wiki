# Security policy

## Reporting a vulnerability

If you find a security issue that could affect users of self-hosted
deployments (owner-token leakage, tier bypass, share-token misuse,
SSRF, RCE, etc.), please report it privately rather than opening a
public GitHub issue.

Email: see `mcp/package.json` → `author` for contact.

I'll acknowledge within a few days, work with you on a fix, and credit
you in the release notes if you'd like.

## What counts as a vulnerability

**Yes, please report:**

- Tier-boundary bypass — anything that lets a `public` viewer see
  content marked `friend` or `private`.
- Owner-token leakage — anything that exposes the token to
  unprivileged callers (logs, error responses, frontend bundle, etc.).
- Share-token forgery or revocation bypass.
- Path traversal — getting the server to read or write files outside
  `WIKI_ROOT`.
- Server-side request forgery, remote code execution, or anything
  that lets a request author execute code on the server.
- Issues in the published `portable-llm-wiki-mcp` npm package that
  could affect local LLM clients (e.g. command injection through
  the WIKI_BASE_URL env var).

**Probably not vulnerabilities:**

- Rate-limit bypasses on individual endpoints (the rate limiter is
  defense-in-depth, not a primary security boundary).
- "An LLM might say something embarrassing about a public page" —
  that's a content issue, not a security one. The owner controls
  page tiers.
- Self-DoS by an authenticated owner doing something destructive
  (deleting their own wiki, etc.).

## Supported versions

The `main` branch and the latest tagged release are supported. Older
versions don't receive security fixes — upgrade if you're behind.

## Disclosure timeline

I aim for:

1. Acknowledgement within 5 business days.
2. A fix or mitigation within 30 days for confirmed high-severity
   issues, 90 days for medium-severity.
3. A public advisory + release notes after a fix ships.

If a fix takes longer (e.g. needs a protocol change), I'll keep you
posted.
