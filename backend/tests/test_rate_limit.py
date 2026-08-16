"""Tests for the in-memory token-bucket rate limiter.

State isolation: each test calls ``_reset_state()`` via the autouse
fixture below so the bucket dict starts empty. Without this, test
ordering would change meanings (a later test's "burst" would inherit
depleted tokens from an earlier test).

Time control: tests monkeypatch ``app.rate_limit.time.monotonic`` to a
mutable fake clock. Real ``time.sleep`` would make the suite slow and
flaky, especially with a refill rate of 1 token/sec.

App fixture: we build a fresh minimal FastAPI app per test with just
the rate-limit middleware and a trivial ``/ping`` endpoint, so the
tests are independent of how ``app/main.py`` is wired.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.rate_limit import RateLimitMiddleware, _reset_state
from tests.conftest import OWNER_TOKEN


@pytest.fixture(autouse=True)
def _isolate_state(monkeypatch):
    # The shared conftest disables rate limiting globally (so other tests
    # don't get throttled). This suite tests the limiter itself, so
    # explicitly re-enable for each case. Tests that need to verify the
    # disabled-via-env path override this with their own monkeypatch.
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "1")
    _reset_state()
    yield
    _reset_state()


class _Clock:
    """Mutable monotonic-clock stand-in for time-sensitive tests."""

    def __init__(self, start: float = 1_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _make_app() -> FastAPI:
    """A throw-away FastAPI app with just the rate limiter and one route.
    Building it per-test means middleware/state are fully isolated."""
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware)

    @app.get("/ping")
    def ping():
        return {"ok": True}

    # Extra routes used by the LLM-targeted-path bypass tests below.
    # Same handler shape; the path is the only thing that matters for
    # the bypass decision.
    @app.get("/llm")
    def llm_handshake():
        return {"ok": True}

    @app.get("/llms.txt")
    def llms_txt():
        return "fake llms.txt"

    @app.get("/wiki/manifest.json")
    def manifest():
        return {"pages": []}

    @app.get("/wiki/page/{slug}")
    def page(slug: str):
        return {"slug": slug}

    @app.get("/t/{tenant}/llm")
    def tenant_llm(tenant: str):
        return {"tenant": tenant}

    # Budget-spending synthesis endpoints — metered on the stricter LLM
    # bucket, NOT exempted by the /wiki/ crawler bypass.
    @app.post("/wiki/query")
    def wiki_query():
        return {"answer": "..."}

    @app.post("/wiki/chat")
    def wiki_chat():
        return {"answer": "..."}

    @app.post("/wiki/chat/stream")
    def wiki_chat_stream():
        return {"answer": "..."}

    @app.post("/onboarding/import-url")
    def onboarding_import_url():
        return {"ok": True}

    @app.post("/onboarding/import-text")
    def onboarding_import_text():
        return {"ok": True}

    @app.post("/onboarding/assemble")
    def onboarding_assemble():
        return {"ok": True}

    @app.post("/t/{tenant}/onboarding/assemble")
    def tenant_onboarding_assemble(tenant: str):
        return {"ok": True, "tenant": tenant}

    @app.get("/owner/share-tokens")
    def owner_share_tokens():
        # Owner-gated path — used by tests to verify NON-LLM paths
        # still rate-limit (the bypass should not extend to mutation /
        # owner surfaces just because the request happens to carry a
        # share token).
        return {"tokens": []}

    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_allows_burst_then_429(monkeypatch):
    """First ``burst`` requests succeed; the next one returns 429."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "3")

    client = TestClient(_make_app())
    for i in range(3):
        r = client.get("/ping")
        assert r.status_code == 200, f"request {i} unexpectedly 429"

    r = client.get("/ping")
    assert r.status_code == 429


def test_recovers_after_refill(monkeypatch):
    """After ``60 / per_minute`` seconds, one more token is available."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")

    clock = _Clock()
    monkeypatch.setattr("app.rate_limit.time.monotonic", clock)

    client = TestClient(_make_app())
    assert client.get("/ping").status_code == 200
    assert client.get("/ping").status_code == 200
    assert client.get("/ping").status_code == 429

    # refill rate = 60 / 60 = 1 token / sec, so 1.0s gives exactly 1 token
    clock.advance(1.0)
    assert client.get("/ping").status_code == 200
    # ...and nothing more without further wait
    assert client.get("/ping").status_code == 429


def test_owner_token_bypasses_limit(monkeypatch):
    """Requests with the owner Bearer token never 429, no matter how many."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")

    client = TestClient(_make_app())
    headers = {"Authorization": f"Bearer {OWNER_TOKEN}"}

    for _ in range(10):
        r = client.get("/ping", headers=headers)
        assert r.status_code == 200, r.text


def test_owner_bypass_does_not_consume_bucket(monkeypatch):
    """Owner-bypass requests must not deplete the public bucket for the
    same IP. After 5 owner-token requests, a single public request should
    leave (burst - 1) tokens remaining, not (burst - 6)."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "3")

    client = TestClient(_make_app())
    owner = {"Authorization": f"Bearer {OWNER_TOKEN}"}
    for _ in range(5):
        assert client.get("/ping", headers=owner).status_code == 200

    r = client.get("/ping")
    assert r.status_code == 200
    assert r.headers["X-RateLimit-Remaining"] == "2"


def test_bad_bearer_token_does_not_bypass(monkeypatch):
    """A wrong bearer token must fall through to rate limiting, not bypass."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")

    client = TestClient(_make_app())
    bad = {"Authorization": "Bearer not-the-owner-token"}
    assert client.get("/ping", headers=bad).status_code == 200
    assert client.get("/ping", headers=bad).status_code == 200
    assert client.get("/ping", headers=bad).status_code == 429


def test_headers_present_on_success(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "5")

    client = TestClient(_make_app())
    r = client.get("/ping")
    assert r.status_code == 200
    assert r.headers["X-RateLimit-Limit"] == "60"
    # consumed one of five
    assert r.headers["X-RateLimit-Remaining"] == "4"
    assert int(r.headers["X-RateLimit-Reset"]) > 0


def test_headers_present_on_429(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "1")

    client = TestClient(_make_app())
    assert client.get("/ping").status_code == 200
    r = client.get("/ping")
    assert r.status_code == 429
    assert r.headers["X-RateLimit-Limit"] == "60"
    assert r.headers["X-RateLimit-Remaining"] == "0"
    assert int(r.headers["X-RateLimit-Reset"]) > 0
    assert "Retry-After" in r.headers


def test_429_body_matches_contract(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "1")

    client = TestClient(_make_app())
    client.get("/ping")  # consume the one token
    r = client.get("/ping")
    assert r.status_code == 429

    body = r.json()
    assert body["detail"] == "rate limit exceeded"
    assert body["limit"] == 60
    assert body["window_seconds"] == 60
    assert "retry_after_seconds" in body
    assert isinstance(body["retry_after_seconds"], (int, float))
    assert body["retry_after_seconds"] > 0


def test_disabled_via_env_skips_middleware(monkeypatch):
    """RATE_LIMIT_ENABLED=0 must completely disable the limiter — no 429s,
    no X-RateLimit-* headers — so tests in the rest of the suite can opt out."""
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "0")
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")

    client = TestClient(_make_app())
    for _ in range(10):
        r = client.get("/ping")
        assert r.status_code == 200
        assert "X-RateLimit-Limit" not in r.headers
        assert "X-RateLimit-Remaining" not in r.headers


def test_x_forwarded_for_groups_by_real_client(monkeypatch):
    """Two different XFF values must use independent buckets, even when
    they share the same TCP peer (as they do behind a single proxy)."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "1")

    client = TestClient(_make_app())
    # Client A: burst=1, second request 429s
    assert client.get("/ping", headers={"X-Forwarded-For": "10.0.0.1"}).status_code == 200
    assert client.get("/ping", headers={"X-Forwarded-For": "10.0.0.1"}).status_code == 429
    # Client B from a different XFF gets its own bucket
    assert client.get("/ping", headers={"X-Forwarded-For": "10.0.0.2"}).status_code == 200


# ---------------------------------------------------------------------------
# LLM-targeted-path bypass — the user-visible "ChatGPT can't fetch my URL" fix
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/llm",
        "/llms.txt",
        "/wiki/manifest.json",
        "/wiki/page/index",
        "/t/professorpalmer/llm",  # tenant-prefixed variant
    ],
)
def test_llm_targeted_paths_bypass_rate_limit(monkeypatch, path):
    """Pin the user-reported bug: ChatGPT's browse infrastructure shares
    IPs across all OpenAI users, so a popular wiki burned through the
    20-token burst within seconds, then 429'd every subsequent fetch.
    ChatGPT swallows the 429, falls back to web search, and the model
    fabricates "I can't actually access that URL" — which the user
    reported as a broken product. These paths exist FOR LLM fetches;
    rate-limiting them by client IP is strictly counter-productive.
    """
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")

    client = TestClient(_make_app())
    # Burn far past burst capacity — none should 429.
    for i in range(25):
        r = client.get(path)
        assert r.status_code == 200, (
            f"request {i} to {path!r} should bypass rate-limit; got "
            f"{r.status_code}, body={r.text}"
        )
    # X-RateLimit-* headers MUST NOT appear on bypassed responses —
    # their presence is the contract for "this request was metered".
    assert "X-RateLimit-Limit" not in r.headers, (
        f"bypassed path {path!r} must not advertise a rate limit"
    )


def test_llm_path_bypass_does_not_drain_other_paths(monkeypatch):
    """Bypassed paths must NOT consume tokens from the same IP's bucket
    — otherwise a single popular /llm fetch storm would still 429 a
    legitimate /ping request, defeating the point of the bypass."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "3")

    client = TestClient(_make_app())
    # Burn what would normally be 30x the bucket on the LLM path.
    for _ in range(30):
        assert client.get("/llm").status_code == 200

    # Bucket should still be at full capacity for the metered path.
    r = client.get("/ping")
    assert r.status_code == 200
    assert r.headers["X-RateLimit-Remaining"] == "2"  # 3 - 1


def test_non_llm_paths_still_rate_limited(monkeypatch):
    """Defense check: only the LLM-targeted prefixes bypass. A request
    to /owner/share-tokens (an owner-mutation endpoint that happens to
    be hit by automated scripts) must still respect the limit. If we
    over-broadly bypass we lose the abuse protection."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")

    client = TestClient(_make_app())
    assert client.get("/owner/share-tokens").status_code == 200
    assert client.get("/owner/share-tokens").status_code == 200
    assert client.get("/owner/share-tokens").status_code == 429


# ---------------------------------------------------------------------------
# Share-token bypass — owner explicitly minted credential, treat as auth'd
# ---------------------------------------------------------------------------


def _stub_share_tokens(monkeypatch, valid_tokens: dict[str, str]) -> None:
    """Replace ``share_tokens.resolve`` with a deterministic stub.

    Real resolution goes to disk via per-tenant ``.share-tokens.json``;
    in this throwaway-app test we don't want to wire up a tenant store
    just to verify the bypass logic. The map keys are plaintext tokens,
    values are tiers.
    """
    def _resolve(token: str):
        return valid_tokens.get(token)

    monkeypatch.setattr("app.share_tokens.resolve", _resolve)


def test_share_token_in_bearer_bypasses_rate_limit(monkeypatch):
    """A valid share-token presented as ``Authorization: Bearer <tok>``
    must bypass — this is the "owner pastes their personal LLM URL into
    ChatGPT/Claude/Cursor and the model uses Bearer to fetch" case."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")
    _stub_share_tokens(monkeypatch, {"real-token": "private"})

    client = TestClient(_make_app())
    headers = {"Authorization": "Bearer real-token"}
    # /ping is NOT in the LLM-targeted list, so it tests the SHARE-
    # TOKEN bypass specifically rather than the path bypass.
    for _ in range(15):
        r = client.get("/ping", headers=headers)
        assert r.status_code == 200, r.text


def test_share_token_in_query_param_bypasses_rate_limit(monkeypatch):
    """The personal-LLM-URL format uses ``?t=<token>`` because LLM
    browse tools can't always set Authorization headers when given a
    bare URL. Bypass via query param too."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")
    _stub_share_tokens(monkeypatch, {"real-token": "private"})

    client = TestClient(_make_app())
    for _ in range(15):
        r = client.get("/ping?t=real-token")
        assert r.status_code == 200, r.text


def test_share_token_in_header_bypasses_rate_limit(monkeypatch):
    """``X-Share-Token: <tok>`` is the third transport — used by
    clients that strip Authorization or by the MCP server when it
    proxies tier-elevated reads to the wiki."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")
    _stub_share_tokens(monkeypatch, {"real-token": "private"})

    client = TestClient(_make_app())
    headers = {"X-Share-Token": "real-token"}
    for _ in range(15):
        r = client.get("/ping", headers=headers)
        assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# LLM-synthesis budget guard — the "viral wiki runs up an unbounded model
# bill" fix. query/chat/chat-stream must be metered even though they live
# under the /wiki/ crawler-bypass prefix.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "/wiki/query",
        "/wiki/chat",
        "/wiki/chat/stream",
        "/onboarding/import-url",
        "/onboarding/import-text",
        "/onboarding/assemble",
        "/t/alice/onboarding/assemble",
    ],
)
def test_synthesis_endpoints_are_metered_not_bypassed(monkeypatch, path):
    """The crawler bypass exempts /wiki/ reads, but the budget-spending
    synthesis endpoints must still be throttled or a scripted loop runs the
    owner's Anthropic/OpenAI bill to the moon."""
    monkeypatch.setenv("RATE_LIMIT_LLM_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_LLM_BURST", "3")
    monkeypatch.setenv("RATE_LIMIT_LLM_DAILY_MAX", "0")  # isolate per-IP bucket

    client = TestClient(_make_app())
    for _ in range(3):
        assert client.post(path).status_code == 200
    r = client.post(path)
    assert r.status_code == 429
    assert r.json()["scope"] == "per_ip"


def test_synthesis_bucket_independent_of_public_bucket(monkeypatch):
    """Cheap reads and expensive synthesis must not drain each other."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "5")
    monkeypatch.setenv("RATE_LIMIT_LLM_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_LLM_BURST", "2")
    monkeypatch.setenv("RATE_LIMIT_LLM_DAILY_MAX", "0")

    client = TestClient(_make_app())
    # Exhaust the LLM bucket.
    assert client.post("/wiki/query").status_code == 200
    assert client.post("/wiki/query").status_code == 200
    assert client.post("/wiki/query").status_code == 429
    # The public bucket for the same IP is untouched.
    r = client.get("/ping")
    assert r.status_code == 200
    assert r.headers["X-RateLimit-Remaining"] == "4"


def test_synthesis_global_daily_budget_ceiling(monkeypatch):
    """Once the global daily ceiling is hit, synthesis 429s with a distinct
    scope even if the per-IP bucket still has tokens (rotating IPs can't
    defeat the spend cap)."""
    monkeypatch.setenv("RATE_LIMIT_LLM_PER_MINUTE", "600")
    monkeypatch.setenv("RATE_LIMIT_LLM_BURST", "100")
    monkeypatch.setenv("RATE_LIMIT_LLM_DAILY_MAX", "2")

    client = TestClient(_make_app())
    assert client.post("/wiki/query").status_code == 200
    assert client.post("/wiki/query").status_code == 200
    r = client.post("/wiki/query")
    assert r.status_code == 429
    assert r.json()["scope"] == "global_daily_budget"


def test_owner_bypasses_synthesis_meter(monkeypatch):
    """The owner running their own wiki is never throttled on chat/query."""
    monkeypatch.setenv("RATE_LIMIT_LLM_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_LLM_BURST", "1")
    monkeypatch.setenv("RATE_LIMIT_LLM_DAILY_MAX", "1")

    client = TestClient(_make_app())
    headers = {"Authorization": f"Bearer {OWNER_TOKEN}"}
    for _ in range(10):
        assert client.post("/wiki/chat", headers=headers).status_code == 200


# ---------------------------------------------------------------------------
# X-Forwarded-For trust — the spoof-resistance fix. The real client is the
# rightmost (proxy-appended) entry, not the leftmost (client-forgeable) one.
# ---------------------------------------------------------------------------


def test_spoofed_leftmost_xff_does_not_evade_limiter(monkeypatch):
    """Behind one trusted proxy, a client rotating the LEFTMOST XFF value
    per request must still share one bucket (keyed on the rightmost,
    proxy-appended hop) — otherwise the limiter is trivially defeated."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")
    monkeypatch.setenv("RATE_LIMIT_TRUSTED_PROXY_HOPS", "1")

    client = TestClient(_make_app())
    # Same trusted peer (rightmost = 203.0.113.9) but a forged, rotating
    # leftmost value. All three hit the SAME bucket → third 429s.
    assert client.get(
        "/ping", headers={"X-Forwarded-For": "1.1.1.1, 203.0.113.9"}
    ).status_code == 200
    assert client.get(
        "/ping", headers={"X-Forwarded-For": "2.2.2.2, 203.0.113.9"}
    ).status_code == 200
    assert client.get(
        "/ping", headers={"X-Forwarded-For": "3.3.3.3, 203.0.113.9"}
    ).status_code == 429


def test_invalid_share_token_does_not_bypass(monkeypatch):
    """A token that doesn't resolve falls through to the normal
    rate-limit path. Without this guard, anyone could bypass by sending
    ``?t=anything`` — the bypass would be a free DDoS amplifier."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")
    _stub_share_tokens(monkeypatch, {"real-token": "private"})

    client = TestClient(_make_app())
    # Same shape as a real token, but not in the store.
    assert client.get("/ping?t=fake-token").status_code == 200
    assert client.get("/ping?t=fake-token").status_code == 200
    assert client.get("/ping?t=fake-token").status_code == 429


def test_share_token_resolve_failure_falls_back_to_normal_limit(monkeypatch):
    """If the share-token store itself errors (disk full, file locked,
    JSON corrupted), the bypass must fail safely — fall through to the
    normal rate-limit path. We never want a token-store outage to 5xx
    every request via an unhandled exception in middleware."""
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "60")
    monkeypatch.setenv("RATE_LIMIT_BURST", "2")

    def _explode(token: str):
        raise RuntimeError("token store is having a bad day")

    monkeypatch.setattr("app.share_tokens.resolve", _explode)

    client = TestClient(_make_app())
    headers = {"X-Share-Token": "anything"}
    # First two get through (burst), third 429s — same as no token at all.
    assert client.get("/ping", headers=headers).status_code == 200
    assert client.get("/ping", headers=headers).status_code == 200
    assert client.get("/ping", headers=headers).status_code == 429
