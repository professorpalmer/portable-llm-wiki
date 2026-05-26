"""In-memory token-bucket rate limiter for the public API.

Per-client-IP token bucket implemented as a FastAPI middleware. Owner
requests (``Authorization: Bearer <OWNER_TOKEN>``) bypass the limit and
do NOT consume bucket tokens — the bucket exists to protect against
public abuse, not to throttle the wiki owner operating their own wiki.

Configuration (read from env on every request so tests can monkeypatch
without re-importing the module):

    RATE_LIMIT_PER_MINUTE  default 60   (refill rate, also reported as ``limit``)
    RATE_LIMIT_BURST       default 20   (bucket capacity)
    RATE_LIMIT_ENABLED     default "1"  ("0" disables the middleware entirely)

Response headers added to every limited response (success or 429):

    X-RateLimit-Limit:     per-minute quota
    X-RateLimit-Remaining: integer tokens left in the bucket
    X-RateLimit-Reset:     unix timestamp when the bucket fully refills

429 body shape:

    {
        "detail": "rate limit exceeded",
        "retry_after_seconds": float,
        "limit": int,
        "window_seconds": 60,
    }

Threading model: FastAPI runs sync endpoints in a thread pool, so the
shared bucket dict is guarded by a ``threading.Lock``. The lock is held
only for the (very fast) refill+consume math, never across ``call_next``.

Memory model: every 1000 requests we sweep the dict and drop entries
whose buckets are full or whose last-seen timestamp is older than 5
minutes. Full buckets carry no information (a fresh entry starts full
anyway) and stale entries are unbounded under adversarial traffic.

Test isolation: ``_reset_state()`` clears the bucket dict. Tests call
it in an autouse fixture so per-IP state doesn't leak between cases.
"""
from __future__ import annotations

import hmac
import os
import threading
import time
from typing import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .config import settings


# ---------------------------------------------------------------------------
# Env reading. Re-read on every request so tests can flip values per-case
# via monkeypatch.setenv without needing module-reload gymnastics.
# ---------------------------------------------------------------------------


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _per_minute() -> int:
    return max(1, _env_int("RATE_LIMIT_PER_MINUTE", 60))


def _burst() -> int:
    return max(1, _env_int("RATE_LIMIT_BURST", 20))


def _enabled() -> bool:
    return os.getenv("RATE_LIMIT_ENABLED", "1").strip() != "0"


# ---------------------------------------------------------------------------
# Bucket state. {ip: (tokens, last_refill_monotonic_ts)}.
# ---------------------------------------------------------------------------

_state: dict[str, tuple[float, float]] = {}
_lock = threading.Lock()
_request_counter = 0

_CLEANUP_EVERY_N_REQUESTS = 1000
_IDLE_PRUNE_SECONDS = 300.0


def _reset_state() -> None:
    """Test-only hook to clear the in-memory bucket dict.

    Exposed (single underscore) because each rate-limit test needs to
    start from an empty state — otherwise the order tests run in changes
    their meaning. Not part of the runtime public API.
    """
    global _request_counter
    with _lock:
        _state.clear()
        _request_counter = 0


def _client_ip(request: Request) -> str:
    """Render and Vercel both forward the originating client via
    X-Forwarded-For. The first comma-separated value is the real client;
    the rest is the proxy chain we don't care about. Fall back to the
    direct TCP peer when no XFF header is present (local dev / curl)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",", 1)[0].strip()
        if first:
            return first
    client = request.client
    if client and client.host:
        return client.host
    return "unknown"


def _is_owner(request: Request) -> bool:
    """Constant-time compare against settings.owner_token. Anything that
    isn't a Bearer match — missing header, wrong scheme, wrong token — is
    treated as non-owner and gets rate-limited."""
    auth = request.headers.get("authorization")
    if not auth:
        return False
    parts = auth.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return False
    token = parts[1].strip()
    owner = settings.owner_token
    if not owner:
        return False
    return hmac.compare_digest(token, owner)


# Path prefixes that are intentionally crawler/LLM-targeted. Hitting
# any of these aggressively is the *use case*, not abuse — they're the
# read surfaces the product exists to expose to ChatGPT, Claude,
# Cursor, etc. Rate-limiting them by client IP backfires on the
# product because OpenAI's browse infrastructure (and Anthropic's, and
# Perplexity's, etc.) consolidates fetches behind a small pool of IPs,
# so a popular wiki gets 429'd within seconds whenever multiple users
# of those services fetch it in parallel — and ChatGPT in particular
# silently falls back to web-search-with-fabrication when the fetch
# fails, so the user just sees "I can't actually access that URL"
# even though the server is healthy.
_LLM_TARGETED_PREFIXES: tuple[str, ...] = (
    "/llm",                # handshake (and HEAD probe)
    "/llms.txt",           # llms.txt convention
    "/.well-known/",       # llm-wiki.json + future protocol files
    "/llm-writeback-spec", # public schema for ChatGPT/Claude writeback
    "/wiki/",              # manifest, per-page reads, search, chat
    "/og",                 # social-share image (also LLM crawlers fetch this)
    "/robots.txt",
    "/sitemap.xml",
)


def _is_llm_targeted_path(path: str) -> bool:
    """Return True for paths designed to be crawled/fetched by LLMs.

    Tenant-prefixed variants (``/t/<tenant>/llm`` etc.) match too — the
    middleware sees the raw URL path before tenant routing rewrites it.
    """
    # Strip the multi-tenant ``/t/<tenant>`` prefix so the same path
    # list works for both single-tenant and hosted modes.
    if path.startswith("/t/"):
        # /t/<tenant>/<rest> → /<rest>
        _, rest = path[3:].split("/", 1) if "/" in path[3:] else (path[3:], "")
        path = "/" + rest
    return any(
        path == p or path.startswith(p + ("/" if not p.endswith("/") else ""))
        or (p.endswith("/") and path.startswith(p))
        for p in _LLM_TARGETED_PREFIXES
    )


def _has_valid_share_token(request: Request) -> bool:
    """Return True if the request carries a share token that resolves
    to a real tier in the current tenant's store.

    Why we validate (rather than just check "header present"): a free
    bypass on bare presence would let any client spam ``X-Share-Token:
    anything`` to skip rate-limiting. Validating keeps the bypass
    tied to a tenant-issued credential — the same gate the read paths
    use for tier elevation.

    The resolve() call hits disk (the per-tenant ``.share-tokens.json``
    file), but only when one of the three transport headers is actually
    present — typical anonymous traffic never pays that cost. Disk
    reads are local SSD on Render so single-digit-millisecond.
    """
    candidate = ""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        candidate = auth[7:].strip()
    if not candidate:
        candidate = request.headers.get("x-share-token", "").strip()
    if not candidate:
        candidate = request.query_params.get("t", "").strip()
    if not candidate:
        return False
    try:
        # Local import — share_tokens depends on settings.wiki_root,
        # which is tenant-scoped via a ContextVar. Importing here keeps
        # the rate_limit module test-friendly (no module-load-time
        # tenant binding required) and ensures we always resolve
        # against the correct tenant's token store.
        from .share_tokens import resolve as resolve_share_token

        return resolve_share_token(candidate) is not None
    except Exception:  # noqa: BLE001
        # Never let a token-store failure 429 the user. Fall back to
        # the normal rate-limit path (request still gets evaluated;
        # only the bypass shortcut is denied).
        return False


def _maybe_cleanup_locked(now: float, refill_rate: float, capacity: float) -> None:
    """Caller must already hold ``_lock``. Drop entries whose buckets have
    refilled to full (no useful state to remember — a fresh request would
    start at the same place) or whose last activity was longer than 5
    minutes ago (we'd rather re-create than carry dead weight)."""
    stale: list[str] = []
    for ip, (tokens, last_ts) in _state.items():
        elapsed = max(0.0, now - last_ts)
        projected = min(capacity, tokens + elapsed * refill_rate)
        if projected >= capacity - 1e-9 or elapsed > _IDLE_PRUNE_SECONDS:
            stale.append(ip)
    for ip in stale:
        _state.pop(ip, None)


def _consume(ip: str) -> tuple[bool, float, float, float]:
    """Try to consume one token from ``ip``'s bucket.

    Returns ``(allowed, remaining_after_decision, retry_after_seconds,
    reset_unix_timestamp)``. ``retry_after_seconds`` is 0.0 on success.
    """
    global _request_counter
    per_minute = _per_minute()
    burst = _burst()
    refill_rate = per_minute / 60.0  # tokens per second
    capacity = float(burst)
    now = time.monotonic()

    with _lock:
        _request_counter += 1
        # New IPs start with a full bucket. ``last_ts = now`` so the
        # first request doesn't get phantom refill credit.
        tokens, last_ts = _state.get(ip, (capacity, now))
        elapsed = max(0.0, now - last_ts)
        tokens = min(capacity, tokens + elapsed * refill_rate)

        if tokens >= 1.0:
            tokens -= 1.0
            _state[ip] = (tokens, now)
            allowed = True
            retry_after = 0.0
        else:
            # Persist the refilled (sub-1) token count and now-ts so the
            # next call gets correct refill from this moment, not the
            # original last_ts.
            _state[ip] = (tokens, now)
            allowed = False
            retry_after = (1.0 - tokens) / refill_rate if refill_rate > 0 else 60.0

        seconds_to_full = (
            (capacity - tokens) / refill_rate if refill_rate > 0 else 60.0
        )
        # X-RateLimit-Reset is, by convention, a wall-clock unix timestamp.
        # We deliberately use time.time() here even though refill math uses
        # monotonic — clients that look at this header want "when in the
        # real world should I retry", not a monotonic offset.
        reset_unix = time.time() + seconds_to_full

        if _request_counter % _CLEANUP_EVERY_N_REQUESTS == 0:
            _maybe_cleanup_locked(now, refill_rate, capacity)

    return allowed, tokens, retry_after, reset_unix


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Per-client-IP token-bucket rate limiter. Owner bypasses.

    Wire it into ``app/main.py`` by calling ``app.add_middleware(
    RateLimitMiddleware)`` BEFORE the CORSMiddleware registration so that
    CORS ends up as the outermost wrapper (CORS still gets to handle
    preflight OPTIONS without consuming a token, and 429 responses still
    carry CORS headers so browsers can read them).
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if not _enabled():
            return await call_next(request)
        if _is_owner(request):
            return await call_next(request)

        # ----- LLM-targeted-endpoint bypass -------------------------------
        # The whole point of this product is to be fetched by ChatGPT,
        # Claude, Cursor, etc. Limiting their fetches by client IP
        # backfires because those services share IPs across all their
        # users — a popular wiki burns through 20 tokens in seconds
        # whenever a few users in parallel paste the URL into their
        # chats. The LLM tool then 429s, ChatGPT swallows the error
        # and falls back to web search, the model fabricates "I can't
        # actually access that URL", and the user thinks the product
        # is broken. Skip the limiter on read-only LLM-facing surfaces.
        if _is_llm_targeted_path(request.url.path):
            return await call_next(request)

        # ----- Authenticated-share-token bypass --------------------------
        # When a viewer presents a real share token (the personal-LLM-
        # URL flow, or a recruiter/friend handoff), they're an
        # authenticated reader of someone else's wiki, not an
        # anonymous prober. Heavy fetches against the wiki are
        # the *expected* usage — the owner explicitly minted the
        # token to enable that. Bypassing also makes sense from a
        # blast-radius perspective: a stolen share token is a tier-
        # downgraded read credential, not a write one, and rate-
        # limiting it doesn't prevent abuse (the attacker just slows
        # down).
        if _has_valid_share_token(request):
            return await call_next(request)

        ip = _client_ip(request)
        allowed, remaining, retry_after, reset_unix = _consume(ip)
        per_minute = _per_minute()

        if not allowed:
            response: Response = JSONResponse(
                status_code=429,
                content={
                    "detail": "rate limit exceeded",
                    "retry_after_seconds": round(retry_after, 3),
                    "limit": per_minute,
                    "window_seconds": 60,
                },
            )
            # Retry-After is the standard HTTP header; we round up so a
            # well-behaved client waits at least until a token is ready.
            response.headers["Retry-After"] = str(max(1, int(retry_after + 0.999)))
        else:
            response = await call_next(request)

        response.headers["X-RateLimit-Limit"] = str(per_minute)
        response.headers["X-RateLimit-Remaining"] = str(max(0, int(remaining)))
        response.headers["X-RateLimit-Reset"] = str(int(reset_unix))
        return response
