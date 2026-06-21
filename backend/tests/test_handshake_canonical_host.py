"""Regression tests for the apex⇄www canonicalization of LLM-facing URLs.

THE BUG THIS LOCKS DOWN
-----------------------
Production serves the frontend on both an apex (``portablellm.wiki``) and
a www (``www.portablellm.wiki``) host, with a 307 redirect between them.
OpenAI's browse tool (and phone QR scanners) refuse to follow a
cross-host redirect — so when the handshake at ``/llm`` was fetched via
the redirecting host, or emitted follow-up URLs (manifest/search/chat)
pointing at the redirecting host, the model gave up and fabricated an
"I can't access that URL" answer.

THE FIX
-------
Every public-facing URL we emit is rebuilt on the SAME host the request
was actually served on, whenever that host is the apex/www twin of the
configured ``PUBLIC_BASE_URL``. Whichever host the LLM successfully
fetched from is the host all its follow-up calls target — no redirect to
follow, in either redirect direction.

These tests pin:
  * the pure host helpers (``_apex_www_twins``, ``_served_host``,
    ``_canonical_base_for_host``),
  * the route-level behavior of ``/llm`` and ``/llms.txt`` under a
    simulated ``x-forwarded-host``,
  * the anti-confabulation fetch-confirmation guard in the handshake.
"""
from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# _apex_www_twins — the apex⇄www pairing primitive
# ---------------------------------------------------------------------------


def test_apex_host_pairs_with_its_www_twin():
    from app.main import _apex_www_twins

    assert _apex_www_twins("portablellm.wiki") == {
        "portablellm.wiki",
        "www.portablellm.wiki",
    }


def test_www_host_pairs_with_its_apex_twin():
    from app.main import _apex_www_twins

    assert _apex_www_twins("www.portablellm.wiki") == {
        "portablellm.wiki",
        "www.portablellm.wiki",
    }


def test_deeper_subdomains_are_not_twins():
    """Only the single ``www.`` label collapses. ``api.`` / ``app.`` must
    NOT be treated as redirect twins — rewriting an emitted URL onto an
    API-only host would break the follow-up calls entirely."""
    from app.main import _apex_www_twins

    twins = _apex_www_twins("portablellm.wiki")
    assert "api.portablellm.wiki" not in twins
    assert "app.portablellm.wiki" not in twins


def test_empty_host_yields_empty_set():
    from app.main import _apex_www_twins

    assert _apex_www_twins("") == set()
    assert _apex_www_twins("   ") == set()


# ---------------------------------------------------------------------------
# _served_host — extract the real request host from forwarded headers
# ---------------------------------------------------------------------------


class _FakeRequest:
    """Minimal Request stand-in exposing only ``.headers``."""

    def __init__(self, headers: dict[str, str]):
        self.headers = headers


def _fake_req(headers: dict[str, str]):
    """Build a duck-typed Request the host helper can read. Cast keeps the
    static checker happy without dragging in Starlette's Request scope."""
    from typing import cast

    from fastapi import Request

    return cast(Request, _FakeRequest(headers))


def test_served_host_prefers_x_forwarded_host():
    from app.main import _served_host

    req = _fake_req(
        {"x-forwarded-host": "www.portablellm.wiki", "host": "internal:8000"}
    )
    assert _served_host(req) == "www.portablellm.wiki"


def test_served_host_falls_back_to_host_header():
    from app.main import _served_host

    assert _served_host(_fake_req({"host": "Portablellm.Wiki"})) == "portablellm.wiki"


def test_served_host_strips_port():
    from app.main import _served_host

    assert _served_host(_fake_req({"host": "localhost:3000"})) == "localhost"


def test_served_host_takes_first_hop_of_comma_list():
    """Chained proxies can comma-join their views of the host. We trust
    the first (closest-to-client) hop."""
    from app.main import _served_host

    req = _fake_req({"x-forwarded-host": "www.portablellm.wiki, internal-lb"})
    assert _served_host(req) == "www.portablellm.wiki"


def test_served_host_empty_when_no_headers():
    from app.main import _served_host

    assert _served_host(_fake_req({})) == ""


# ---------------------------------------------------------------------------
# _canonical_base_for_host — the single source of truth
# ---------------------------------------------------------------------------


def test_canonical_rewrites_apex_base_onto_served_www():
    """The production failure mode: PUBLIC_BASE_URL is the apex, but the
    LLM reached the www host. Emit www so follow-ups don't redirect."""
    from app.main import _canonical_base_for_host

    out = _canonical_base_for_host(
        "https://portablellm.wiki", "www.portablellm.wiki"
    )
    assert out == "https://www.portablellm.wiki"


def test_canonical_rewrites_www_base_onto_served_apex():
    """Symmetric: if the canonical host is www but the LLM reached the
    apex, emit the apex. The fix is direction-agnostic."""
    from app.main import _canonical_base_for_host

    out = _canonical_base_for_host(
        "https://www.portablellm.wiki", "portablellm.wiki"
    )
    assert out == "https://portablellm.wiki"


def test_canonical_noop_when_served_host_matches_base():
    from app.main import _canonical_base_for_host

    out = _canonical_base_for_host(
        "https://portablellm.wiki", "portablellm.wiki"
    )
    assert out == "https://portablellm.wiki"


def test_canonical_noop_for_unrelated_host():
    """A served host that is NOT an apex/www twin must leave the base
    untouched — we never rewrite onto an arbitrary Host header (that
    would be an open-redirect-style footgun)."""
    from app.main import _canonical_base_for_host

    out = _canonical_base_for_host(
        "https://portablellm.wiki", "evil.example.com"
    )
    assert out == "https://portablellm.wiki"


def test_canonical_noop_for_api_subdomain():
    from app.main import _canonical_base_for_host

    out = _canonical_base_for_host(
        "https://portablellm.wiki", "api.portablellm.wiki"
    )
    assert out == "https://portablellm.wiki"


def test_canonical_preserves_port_and_strips_trailing_slash():
    from app.main import _canonical_base_for_host

    out = _canonical_base_for_host(
        "https://portablellm.wiki:8443/", "www.portablellm.wiki"
    )
    assert out == "https://www.portablellm.wiki:8443"


def test_canonical_empty_served_host_returns_stripped_base():
    from app.main import _canonical_base_for_host

    assert (
        _canonical_base_for_host("https://portablellm.wiki/", "")
        == "https://portablellm.wiki"
    )


def test_canonical_handles_unparseable_base_gracefully():
    from app.main import _canonical_base_for_host

    # No scheme/host — urlsplit returns empty hostname; we fall back to
    # the rstripped input rather than raising.
    assert _canonical_base_for_host("not a url/", "www.x") == "not a url"


# ---------------------------------------------------------------------------
# Route-level: /llm and /llms.txt emit the served host
# ---------------------------------------------------------------------------


@pytest.fixture()
def apex_base(monkeypatch):
    """Pin PUBLIC_BASE_URL to the apex so we can prove the handshake
    rewrites follow-up URLs onto whichever twin host served the request.

    ``settings`` is the live proxy used inside the route handlers; setting
    an instance attribute shadows the ``__getattr__`` delegation and
    auto-reverts on teardown."""
    import app.main as _main

    monkeypatch.setattr(_main.settings, "public_base_url", "https://portablellm.wiki")
    return "https://portablellm.wiki"


def test_handshake_emits_served_www_host_when_fetched_via_www(client, apex_base):
    """End-to-end: a request arriving on the www host (the redirect
    target) must produce a handshake whose API base is www — so the
    LLM's manifest/search/chat calls never hit the redirecting apex."""
    r = client.get(
        "/llm", headers={"x-forwarded-host": "www.portablellm.wiki"}
    )
    assert r.status_code == 200
    assert "https://www.portablellm.wiki/api/backend" in r.text


def test_handshake_emits_served_apex_host_when_fetched_via_apex(client, apex_base):
    """Symmetric direction: fetched via the apex → emit the apex. (The
    base is already the apex here, so this is also the no-op baseline.)"""
    r = client.get("/llm", headers={"x-forwarded-host": "portablellm.wiki"})
    assert r.status_code == 200
    assert "https://portablellm.wiki/api/backend" in r.text


def test_handshake_does_not_rewrite_onto_unrelated_host(client, apex_base):
    """A spoofed/unrelated Host header must NOT redirect the emitted URLs
    away from the configured canonical host."""
    r = client.get("/llm", headers={"x-forwarded-host": "evil.example.com"})
    assert r.status_code == 200
    assert "evil.example.com" not in r.text
    assert "https://portablellm.wiki/api/backend" in r.text


def test_llms_txt_emits_served_www_host(client, apex_base):
    r = client.get(
        "/llms.txt", headers={"x-forwarded-host": "www.portablellm.wiki"}
    )
    assert r.status_code == 200
    # The handshake link and page links should all be on the www host.
    assert "https://www.portablellm.wiki" in r.text


# ---------------------------------------------------------------------------
# Anti-confabulation guard
# ---------------------------------------------------------------------------


def test_handshake_includes_fetch_confirmation_guard(client):
    """The top of the handshake must assert the fetch succeeded and forbid
    answering from training knowledge — the cheap insurance against the
    'model fabricates a summary it never read' failure mode."""
    body = client.get("/llm").text
    flat = " ".join(body.lower().split())
    assert "successfully fetched" in flat
    # Must explicitly forbid inventing / fabricating answers.
    assert "fabricate" in flat or "invent" in flat
    # Must tell the model to say so when a fetch fails.
    assert "fetch fails" in flat or "could not reach" in flat


def test_handshake_guard_appears_before_endpoint_table(client):
    """The guard has to be read before the model starts making calls, so
    it must precede the endpoints section in document order."""
    body = client.get("/llm").text
    guard_idx = body.lower().find("successfully fetched")
    endpoints_idx = body.find("### Endpoints")
    assert guard_idx != -1 and endpoints_idx != -1
    assert guard_idx < endpoints_idx
