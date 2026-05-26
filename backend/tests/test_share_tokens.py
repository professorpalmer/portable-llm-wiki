"""Share-token mint / list / revoke / resolve.

Share tokens are how the owner gives recruiters/friends access without
sharing the owner_token. Each token is bound to a tier and a label, can be
revoked, and the plaintext is only available at mint time.
"""
from __future__ import annotations


def test_mint_token_returns_plaintext_once(client, owner_headers):
    r = client.post(
        "/owner/share-tokens",
        json={"label": "Test recruiter", "tier": "recruiter"},
        headers=owner_headers,
    )
    assert r.status_code == 201
    data = r.json()
    assert "token" in data, "mint response must include plaintext token once"
    assert data["token"].startswith("") and len(data["token"]) >= 30
    assert data["tier"] == "recruiter"
    assert data["label"] == "Test recruiter"
    assert "id" in data

    # Subsequent listings must NOT include plaintext.
    r = client.get("/owner/share-tokens", headers=owner_headers)
    assert r.status_code == 200
    tokens = r.json()["tokens"]
    matching = [t for t in tokens if t["id"] == data["id"]]
    assert len(matching) == 1
    listed = matching[0]
    assert "token" not in listed  # plaintext gone forever
    assert listed["label"] == "Test recruiter"
    assert listed["tier"] == "recruiter"


def test_minted_token_grants_correct_tier(client, owner_headers):
    plaintext = _mint(client, owner_headers, "Friend test", "friend")["token"]
    r = client.get(
        "/wiki/manifest.json",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["viewer_tier"] == "friend"
    assert data["viewer_is_owner"] is False
    slugs = {p["slug"] for p in data["pages"]}
    assert {"public-entity", "recruiter-concept", "friend-concept"} <= slugs
    # Friend should NOT see private
    assert "private-entity" not in slugs


def test_revoked_token_no_longer_grants_access(client, owner_headers):
    minted = _mint(client, owner_headers, "Soon to be revoked", "recruiter")
    plaintext = minted["token"]
    token_id = minted["id"]

    # Confirm initially valid
    r = client.get(
        "/wiki/manifest.json",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.json()["viewer_tier"] == "recruiter"

    # Revoke
    r = client.delete(f"/owner/share-tokens/{token_id}", headers=owner_headers)
    assert r.status_code == 200

    # No longer grants the recruiter tier
    r = client.get(
        "/wiki/manifest.json",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.json()["viewer_tier"] == "public"


def test_revoking_unknown_token_is_404(client, owner_headers):
    r = client.delete("/owner/share-tokens/nonexistent-id", headers=owner_headers)
    assert r.status_code == 404


def test_mint_requires_owner(client):
    r = client.post(
        "/owner/share-tokens",
        json={"label": "Should fail", "tier": "public"},
    )
    assert r.status_code in (401, 403)


def test_mint_rejects_bogus_tier(client, owner_headers):
    # Any tier outside the four-element enum is a 422.
    r = client.post(
        "/owner/share-tokens",
        json={"label": "x", "tier": "godmode"},
        headers=owner_headers,
    )
    assert r.status_code == 422


def test_mint_private_tier_succeeds_and_grants_full_read(client, owner_headers):
    """The 'personal LLM URL' contract.

    Private-tier share tokens are the artifact the owner pastes into
    ChatGPT/Claude/Cursor so those LLMs see the SAME wiki the owner
    sees in their browser. Conceptually: a self-issued, scoped-to-just-
    me share token. The HTTP layer used to reject ``private`` here on
    the assumption "you can't SHARE to private tier", but that
    conflated 'share with others' with 'portability for myself'. They're
    different flows; both need the same machinery.

    This test pins:
      1. The mint endpoint accepts tier="private" (no 422).
      2. The plaintext token, when used via Authorization: Bearer or
         ?t=, resolves to a private-tier viewer.
      3. The viewer sees ALL pages (public + recruiter + friend +
         private) — the whole point of the personal-LLM-URL flow.
    """
    minted = _mint(client, owner_headers, "ChatGPT desktop", "private")
    plaintext = minted["token"]
    assert minted["tier"] == "private"

    # Via the Authorization header (the bearer-token path):
    r = client.get(
        "/wiki/manifest.json",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["viewer_tier"] == "private"
    # The viewer is_owner stays False — a private-tier share token
    # grants full READ but never WRITE. This is intentional: a leaked
    # personal LLM URL should not let the holder mutate the wiki.
    assert data["viewer_is_owner"] is False
    slugs = {p["slug"] for p in data["pages"]}
    assert {
        "public-entity",
        "recruiter-concept",
        "friend-concept",
        "private-entity",
    } <= slugs


def test_private_share_token_via_query_param_on_llm_endpoint(client, owner_headers):
    """The /llm handshake endpoint must accept the personal LLM URL's
    ?t= query token and return private-tier markdown. This is the
    paste-into-ChatGPT path — ChatGPT can't carry a Bearer header on
    fetched URLs, only the URL itself, so ?t= is the only viable
    transport."""
    plaintext = _mint(client, owner_headers, "Cursor laptop", "private")["token"]
    r = client.get(f"/llm?t={plaintext}")
    assert r.status_code == 200
    body = r.text
    # The handshake's Auth block names the resolved viewer tier
    # verbatim; this is the deterministic place to assert tier
    # resolution succeeded. Checking for slugs in the markdown body is
    # brittle because the handshake intentionally lists titles (not
    # slugs) and only ~4 per type, so a low-prominence private page
    # might not appear.
    assert "**private** tier" in body
    # Cross-check via the manifest endpoint: same token via header
    # form must also see the private-tier page.
    r2 = client.get(
        "/wiki/manifest.json",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    slugs = {p["slug"] for p in r2.json()["pages"]}
    assert "private-entity" in slugs


def test_private_share_token_cannot_write(client, owner_headers):
    """Hardening: a leaked personal-LLM-URL token must not be able to
    mutate the wiki even though it can read everything. The viewer it
    resolves to has tier='private' but is_owner=False — owner-gated
    routes (require_owner) must reject it."""
    plaintext = _mint(client, owner_headers, "Claude mobile", "private")["token"]
    # Mint another share-token using the private token as auth — would
    # be a privilege escalation if it succeeded.
    r = client.post(
        "/owner/share-tokens",
        json={"label": "should fail", "tier": "recruiter"},
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code in (401, 403)


def test_mint_triggers_persistence_push(client, owner_headers, monkeypatch):
    """Regression test for the silent disappearance bug:

    Until this test landed, ``POST /owner/share-tokens`` wrote the new token
    to ``<wiki_root>/.share-tokens.json`` but never told the persistence
    module about it. The file change sat on local disk until some
    OTHER write (a page edit, an ingest, etc.) tripped the next git push,
    which on a quiet wiki could be never. On ephemeral-disk hosts the
    server would restart between mint and the next unrelated write, the
    token file would reset to whatever GitHub had (no new token), and
    every URL the owner had handed out would silently downgrade to
    public-tier — without surfacing any error to the owner. This test
    pins the load-bearing flush_async call.
    """
    from app import persistence

    calls: list[str] = []

    def _capture(message: str) -> None:
        calls.append(message)

    monkeypatch.setattr(persistence, "flush_async", _capture)

    r = client.post(
        "/owner/share-tokens",
        json={"label": "ChatGPT desktop", "tier": "private"},
        headers=owner_headers,
    )
    assert r.status_code == 201
    assert any("mint share token" in m for m in calls), (
        f"mint must schedule a git push (got flush_async calls: {calls!r})"
    )


def test_revoke_triggers_persistence_push(client, owner_headers, monkeypatch):
    """Same load-bearing flush as the mint test, for the revoke path.

    A revoke that only lives on local disk is worse than a missed mint:
    when the server restarts, the leaked-and-revoked URL comes back to
    life because GitHub's copy of .share-tokens.json never recorded the
    revoke. The owner thinks they killed it; the attacker still has access.
    """
    from app import persistence

    minted = _mint(client, owner_headers, "to be revoked", "recruiter")
    token_id = minted["id"]

    calls: list[str] = []
    monkeypatch.setattr(persistence, "flush_async", lambda m: calls.append(m))

    r = client.delete(f"/owner/share-tokens/{token_id}", headers=owner_headers)
    assert r.status_code == 200
    assert any("revoke share token" in m for m in calls), (
        f"revoke must schedule a git push (got flush_async calls: {calls!r})"
    )


def test_unknown_token_via_query_param_says_did_not_resolve(client):
    """A caller who passes ``?t=<bogus>`` should be told their token
    didn't resolve — not silently treated as a public-tier share-token
    holder.

    Before this regression test, the handshake said "you are connected
    at the **public** tier via a share token", which sounds plausible to
    an LLM but is misleading: the token might be revoked, expired, or
    typo'd. The LLM then proceeds as if everything is fine, the user
    gets stripped-down answers, and nobody knows why. The diagnostic
    string lives in the markdown the LLM reads, so the LLM can tell
    the user the URL is stale."""
    r = client.get("/llm?t=this-is-not-a-real-token-blah-blah")
    assert r.status_code == 200
    body = r.text
    assert "did not resolve" in body.lower()
    assert "**public** tier" in body


def test_head_llm_handshake_succeeds(client):
    """HEAD /llm must return 200, not 405.

    A surprising number of link-preview and crawler tools probe a URL
    with HEAD before doing GET (ChatGPT's browse tool, Slack unfurl,
    Twitter card scraper, Discord, etc.). If we 405 the HEAD, some of
    those tools bail without ever attempting the GET — and the owner
    can't paste their /llm URL into chat without it looking broken.
    """
    r = client.head("/llm")
    assert r.status_code == 200, (
        f"HEAD /llm should be allowed (got {r.status_code}); broken HEAD makes "
        "ChatGPT-style probes give up before they ever try GET"
    )
    r2 = client.head("/llms.txt")
    assert r2.status_code == 200


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _mint(client, owner_headers, label: str, tier: str) -> dict:
    r = client.post(
        "/owner/share-tokens",
        json={"label": label, "tier": tier},
        headers=owner_headers,
    )
    assert r.status_code == 201, r.text
    return r.json()
