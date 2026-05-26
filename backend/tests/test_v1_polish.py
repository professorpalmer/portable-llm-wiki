"""Tests for the v1.0.1 polish pass:

  1. /wiki/search now honors ?limit= (1..100, default 25).
  2. X-Share-Token header is an Authorization alternative for share tokens
     (but cannot escalate to owner).
  3. OrchestratorUnavailable is a typed exception raised when puppetmaster
     is missing — endpoints return a clean 503 instead of NameError'ing.

These cover the v1.1 friction-removal items called out by the SPEC.md
review: search clients were silently passing limit into the void, and
some webhook proxies strip Authorization headers, leaving share-token
URL flows broken.
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

from app import auth as auth_module


# ---------------------------------------------------------------------------
# /wiki/search ?limit=
# ---------------------------------------------------------------------------


def test_search_limit_defaults_to_25(client):
    """No ?limit= → server defaults to 25 (matches the legacy hardcoded
    value). The response echoes the limit so clients can detect it."""
    r = client.get("/wiki/search?q=a")
    assert r.status_code == 200
    data = r.json()
    assert data["limit"] == 25
    assert len(data["results"]) <= 25


def test_search_limit_caps_results(client, owner_headers):
    """An explicit ?limit=2 must cap the returned results regardless of
    how many pages match. Use the owner viewer so we know there's enough
    matchable content."""
    r = client.get("/wiki/search?q=a&limit=2", headers=owner_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["limit"] == 2
    assert len(data["results"]) <= 2


def test_search_limit_rejects_zero(client):
    r = client.get("/wiki/search?q=a&limit=0")
    assert r.status_code == 422


def test_search_limit_rejects_oversize(client):
    """Cap at 100 — anything bigger is paginate-or-use-manifest territory."""
    r = client.get("/wiki/search?q=a&limit=101")
    assert r.status_code == 422


def test_search_limit_accepts_max(client):
    r = client.get("/wiki/search?q=a&limit=100")
    assert r.status_code == 200
    assert r.json()["limit"] == 100


# ---------------------------------------------------------------------------
# X-Share-Token header
# ---------------------------------------------------------------------------


def test_x_share_token_resolves_static_share_token(client, monkeypatch):
    """X-Share-Token is an alternative channel for the same tokens the
    Authorization: Bearer flow accepts. Set up a static SHARE_TOKENS env
    and verify the header grants the corresponding tier."""
    monkeypatch.setenv("SHARE_TOKENS", "test-recruiter-tok:recruiter")

    r = client.get(
        "/wiki/manifest.json",
        headers={"X-Share-Token": "test-recruiter-tok"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["viewer_tier"] == "recruiter"
    assert data["viewer_is_owner"] is False
    slugs = {p["slug"] for p in data["pages"]}
    assert "recruiter-concept" in slugs


def test_x_share_token_cannot_escalate_to_owner(client, owner_token):
    """Critical security boundary: even passing the owner token via
    X-Share-Token must NOT grant owner privileges. The header is for
    share-tier escape hatches only."""
    r = client.get(
        "/wiki/manifest.json",
        headers={"X-Share-Token": owner_token},
    )
    assert r.status_code == 200
    data = r.json()
    # Owner token is consulted by viewer_from_header, but the X-Share-Token
    # path explicitly rejects owner-tier candidates. The viewer should
    # remain public (or whichever the bearer chain resolved).
    assert data["viewer_is_owner"] is False


def test_authorization_header_wins_over_x_share_token(
    client, owner_headers, monkeypatch
):
    """If both headers are present, the Authorization bearer flow takes
    priority. X-Share-Token is consulted only when Authorization didn't
    resolve to a non-public viewer."""
    monkeypatch.setenv("SHARE_TOKENS", "test-friend-tok:friend")

    h = {**owner_headers, "X-Share-Token": "test-friend-tok"}
    r = client.get("/wiki/manifest.json", headers=h)
    assert r.status_code == 200
    data = r.json()
    # Owner wins despite the X-Share-Token header.
    assert data["viewer_is_owner"] is True


def test_x_share_token_garbage_falls_back_to_public(client):
    """An unrecognized X-Share-Token must NOT crash and must NOT grant
    any privilege. Falls back to the bearer resolution (public)."""
    r = client.get(
        "/wiki/manifest.json",
        headers={"X-Share-Token": "not-a-real-token"},
    )
    assert r.status_code == 200
    assert r.json()["viewer_tier"] == "public"


# ---------------------------------------------------------------------------
# OrchestratorUnavailable
# ---------------------------------------------------------------------------


def test_orchestrator_unavailable_is_importable():
    """The whole point of the v1.0.1 fix: main.py imports
    OrchestratorUnavailable. If this import breaks, the except clauses
    in /owner/raw/bulk and /owner/raw/{path}/reingest would NameError
    on a FileNotFoundError path."""
    from app.main import OrchestratorUnavailable
    from app.orchestrator import OrchestratorUnavailable as Original

    assert OrchestratorUnavailable is Original
    assert issubclass(OrchestratorUnavailable, RuntimeError)


def test_orchestrator_unavailable_raised_when_binary_missing(monkeypatch):
    """When PUPPETMASTER_BIN points at something that doesn't exist,
    start_ingest_job raises OrchestratorUnavailable instead of letting
    FileNotFoundError bubble. This is what main.py catches."""
    from app import orchestrator

    # Point at a path that's guaranteed not to exist.
    monkeypatch.setattr(
        orchestrator, "PUPPETMASTER_BIN", "/no/such/binary-pllmw-test"
    )

    with pytest.raises(orchestrator.OrchestratorUnavailable, match="not found"):
        orchestrator.start_ingest_job("raw/test.md", note="testing")


def test_reingest_endpoint_returns_503_when_orchestrator_missing(
    client, owner_headers, wiki_root
):
    """End-to-end: hit /owner/raw/<path>/reingest with the orchestrator
    binary missing. Expected: 503, not 500 (or NameError)."""
    # Create a raw file so the endpoint gets past the existence check.
    raw_dir = wiki_root / "raw" / "conversations"
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / "smoke.md"
    raw_path.write_text(
        "---\nkind: paste\ndate: 2026-05-24\n---\n\ntest content\n",
        encoding="utf-8",
    )

    # Force the binary lookup to fail.
    from app import orchestrator

    with patch.object(
        orchestrator, "PUPPETMASTER_BIN", "/no/such/binary-pllmw-test"
    ):
        r = client.post(
            "/owner/raw/conversations/smoke.md/reingest",
            headers=owner_headers,
        )

    # 503 = orchestrator unavailable. The detail message tells the
    # caller exactly what's wrong (no NameError, no opaque 500).
    assert r.status_code == 503
    assert "puppetmaster" in r.json()["detail"].lower()
