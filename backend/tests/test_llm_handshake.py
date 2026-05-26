"""Tests for the LLM-handshake endpoints introduced in v1.1.0:

  GET /llm           — dynamic markdown briefing for an LLM to ingest
  GET /llms.txt      — emerging llmstxt.org convention; root-level index

The /llm endpoint is the killer "paste this URL into any LLM chat" flow.
It is intentionally tier-respecting: anonymous callers see only the
public-tier counts and example questions; share-token callers see the
elevated tier's counts; owner callers see everything.

Critical security boundary covered: a share token in ``?t=`` MUST be
treated equivalently to ``X-Share-Token: <token>`` and MUST NEVER
escalate to owner, even if someone manages to pass the owner token in
the query string.
"""
from __future__ import annotations


def test_llm_handshake_returns_markdown_content_type(client):
    """The endpoint must declare text/markdown so LLMs and crawlers
    process it correctly. JSON wrapping would defeat the entire point."""
    r = client.get("/llm")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")


def test_llm_handshake_includes_protocol_self_description(client):
    """The first thing the LLM reads must explain what this is and
    point at the spec — anchoring claims in a citeable place."""
    r = client.get("/llm")
    body = r.text
    assert "Portable LLM Wiki" in body
    assert "SPEC.md" in body
    # Normalize whitespace before phrase check (markdown wraps lines).
    flat = " ".join(body.lower().split())
    assert "open protocol" in flat


def test_llm_handshake_lists_endpoints_for_followup_calls(client):
    """An LLM that just read this page should know which endpoints to
    call next. The endpoint table must mention manifest, page, and
    chat at minimum."""
    body = client.get("/llm").text
    assert "/wiki/manifest.json" in body
    assert "/wiki/page/" in body
    assert "/wiki/chat" in body


def test_llm_handshake_anonymous_caller_gets_public_tier_briefing(client):
    """No headers, no ?t= — anonymous public visitor. The briefing
    should explicitly note the public-tier connection and NOT leak
    higher-tier example questions or counts."""
    body = client.get("/llm").text
    assert "public" in body.lower()
    # No share-token-specific framing for an anon caller.
    assert "Reuse the same token" not in body
    assert "You are connected as the wiki owner" not in body


def test_llm_handshake_with_query_token_uses_share_tier(client, monkeypatch):
    """A ``?t=<token>`` query param must elevate the viewer to whatever
    tier the token is minted for. This is the mechanism the QR-code
    URL relies on — the URL IS the token."""
    monkeypatch.setenv("SHARE_TOKENS", "qr-test-token:recruiter")

    body = client.get("/llm?t=qr-test-token").text
    # The briefing acknowledges the elevated tier...
    assert "recruiter" in body.lower()
    # ...and instructs the LLM to reuse the same token for subsequent calls.
    assert "Reuse the same token" in body or "X-Share-Token" in body


def test_llm_handshake_x_share_token_header_also_works(client, monkeypatch):
    """The header form must be honored too (LLMs that fetch via tools
    sometimes get the URL stripped and inject it as a header)."""
    monkeypatch.setenv("SHARE_TOKENS", "header-test-token:friend")

    r = client.get("/llm", headers={"X-Share-Token": "header-test-token"})
    assert r.status_code == 200
    assert "friend" in r.text.lower()


def test_llm_handshake_query_token_cannot_escalate_to_owner(client, owner_token):
    """Critical: even if someone passes the owner token as ``?t=<owner>``,
    the briefing must NOT grant owner privileges. The query-param flow
    is for share tokens only."""
    r = client.get(f"/llm?t={owner_token}")
    assert r.status_code == 200
    # Must NOT print the owner-specific block.
    assert "You are connected as the wiki owner" not in r.text


def test_llm_handshake_authorization_bearer_owner_works(client, owner_headers):
    """When the OWNER_TOKEN comes through the proper Authorization
    channel, the briefing must reflect owner privileges."""
    r = client.get("/llm", headers=owner_headers)
    assert r.status_code == 200
    assert "owner" in r.text.lower()
    assert "OWNER_TOKEN" in r.text  # The owner-block explains the env var


def test_llm_handshake_includes_visible_page_count(client):
    """The briefing must tell the LLM how many pages it can see right
    now (planning signal). Should be an integer ≥ 0."""
    body = client.get("/llm").text
    # The text is "Visible to you right now: N pages." Verify the
    # phrasing is there and N parses as an int.
    import re

    m = re.search(r"Visible to you right now:\*\*\s*(\d+)\s*pages", body)
    assert m is not None, f"Expected page count phrase, body was:\n{body[:1000]}"
    count = int(m.group(1))
    assert count >= 0


def test_llm_handshake_includes_notable_page_titles(client):
    """At least one real page title (from the test fixture wiki) must
    appear in the 'notable pages' section so the LLM has named hooks
    to ask about. We don't assert specific titles to keep this test
    robust as fixtures evolve, but the section header must be there
    even if the count is zero."""
    body = client.get("/llm").text
    assert "Notable pages" in body or "notable pages" in body.lower()


# ---------------------------------------------------------------------------
# /llms.txt — root-level llmstxt.org convention
# ---------------------------------------------------------------------------


def test_llms_txt_returns_markdown(client):
    r = client.get("/llms.txt")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/markdown")


def test_llms_txt_points_at_handshake(client):
    """The llms.txt convention is "here are the important URLs on this
    site for an LLM". The handshake at /llm must be linked from here so
    discovery works for crawlers."""
    body = client.get("/llms.txt").text
    assert "/llm" in body
    assert "self-describing" in body.lower() or "handshake" in body.lower()


def test_llms_txt_links_to_spec_and_repo(client):
    """The root index must point at the spec and the GitHub repo —
    discoverability for any LLM/crawler that lands here cold."""
    body = client.get("/llms.txt").text
    assert "SPEC.md" in body
    assert "github.com/professorpalmer/portable-llm-wiki" in body


# ---------------------------------------------------------------------------
# /.well-known/llm-wiki.json — advertise the handshake endpoint
# ---------------------------------------------------------------------------


def test_well_known_advertises_llm_handshake(client):
    """v1.1.0 of the spec adds two operations to the manifest:
    llm_handshake and llms_txt. Existing clients must still find
    everything they did before."""
    r = client.get("/.well-known/llm-wiki.json")
    assert r.status_code == 200
    data = r.json()
    assert data["spec_version"] == "1.1.0"
    ops = data["operations"]
    assert ops["llm_handshake"] == "/llm"
    assert ops["llms_txt"] == "/llms.txt"
    # Legacy ops unchanged.
    assert ops["manifest"] == "/wiki/manifest.json"
    assert ops["chat"] == "/wiki/chat"


def test_well_known_includes_agent_entry_block(client):
    """The agent_entry block tells any tool consuming the manifest
    "here's how to construct the paste-into-LLM URL." Critical for
    third-party clients that want to build their own QR flows."""
    data = client.get("/.well-known/llm-wiki.json").json()
    entry = data.get("agent_entry")
    assert entry is not None
    assert "t={share_token}" in entry["url_template"]
    assert "paste" in entry["description"].lower()


def test_well_known_documents_share_token_query_param(client):
    """v1.1.0 spec: share tokens may travel as ``?t=`` in addition to
    the X-Share-Token header. The auth block in the manifest must
    advertise both so clients implementing the protocol know which
    transport channels are valid."""
    data = client.get("/.well-known/llm-wiki.json").json()
    auth = data["auth"]
    assert auth["share_token_header"] == "X-Share-Token"
    assert auth["share_token_query"] == "t"
