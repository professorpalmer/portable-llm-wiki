"""Lightweight observability: structured request logging + optional Sentry.

Two cheap, dependency-light wins for running a public service:

1. **Request logging** — one structured line per request (method, path,
   status, latency, client IP) so a traffic spike, a 5xx cluster, or a
   slow endpoint is visible in Render's log stream without any extra
   infrastructure. Query strings are dropped (they can carry share
   tokens); only the path is logged.

2. **Error tracking (optional)** — if ``SENTRY_DSN`` is set we initialize
   Sentry so unhandled exceptions during the surge are captured with a
   stack trace instead of vanishing into stdout. Entirely opt-in: the
   import is guarded, so the backend runs fine without ``sentry-sdk``
   installed or without a DSN configured.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("portable_llm_wiki.request")


def _configure_logging_once() -> None:
    """Attach a stream handler if the root logger has none. Idempotent so
    repeated imports (tests, reload) don't stack duplicate handlers."""
    root = logging.getLogger()
    if root.handlers:
        return
    level = os.getenv("LOG_LEVEL", "INFO").strip().upper() or "INFO"
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def init_sentry() -> bool:
    """Initialize Sentry iff SENTRY_DSN is set AND sentry-sdk is installed.

    Returns True when Sentry was initialized. Never raises — a broken or
    missing Sentry must not stop the app from booting.
    """
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk  # type: ignore
    except ImportError:
        logger.warning("SENTRY_DSN set but sentry-sdk is not installed; skipping")
        return False
    try:
        sentry_sdk.init(
            dsn=dsn,
            traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0") or "0"),
            environment=os.getenv("SENTRY_ENVIRONMENT", "production"),
        )
        return True
    except Exception as exc:  # noqa: BLE001 — observability must never crash boot
        logger.warning("sentry init failed: %s", exc)
        return False


def _client_ip(request: Request) -> str:
    """Best-effort client IP for log correlation. Mirrors the rate
    limiter's trusted-hop logic loosely (rightmost XFF entry)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    client = request.client
    return client.host if client and client.host else "-"


class RequestLogMiddleware(BaseHTTPMiddleware):
    """Emit one structured log line per request with timing and status.

    Logs the PATH only (never the query string, which can carry share
    tokens). 5xx responses log at ERROR, 4xx at WARNING, the rest at INFO,
    so Render's log filters surface problems first.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        start = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            dur_ms = (time.monotonic() - start) * 1000.0
            logger.exception(
                "request method=%s path=%s status=500 dur_ms=%.1f ip=%s",
                request.method,
                request.url.path,
                dur_ms,
                _client_ip(request),
            )
            raise
        dur_ms = (time.monotonic() - start) * 1000.0
        status = response.status_code
        level = (
            logging.ERROR
            if status >= 500
            else logging.WARNING
            if status >= 400
            else logging.INFO
        )
        logger.log(
            level,
            "request method=%s path=%s status=%d dur_ms=%.1f ip=%s",
            request.method,
            request.url.path,
            status,
            dur_ms,
            _client_ip(request),
        )
        return response


_configure_logging_once()
