"""Auth and tier-filtering boundaries.

These are the most security-critical paths: a stranger should NEVER see a
page tagged tier: private. A recruiter share token should see public +
recruiter only. The preview-as header should let an owner audit lower
tiers without granting privilege.
"""
from __future__ import annotations


def test_public_viewer_sees_only_public_in_manifest(client):
    r = client.get("/wiki/manifest.json")
    assert r.status_code == 200
    data = r.json()
    assert data["viewer_tier"] == "public"
    assert data["viewer_is_owner"] is False
    slugs = {p["slug"] for p in data["pages"]}
    assert "public-entity" in slugs
    assert "private-entity" not in slugs
    assert "recruiter-concept" not in slugs
    assert "friend-concept" not in slugs


def test_owner_sees_all_pages(client, owner_headers):
    r = client.get("/wiki/manifest.json", headers=owner_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["viewer_is_owner"] is True
    slugs = {p["slug"] for p in data["pages"]}
    assert {"public-entity", "private-entity", "recruiter-concept", "friend-concept"} <= slugs


def test_public_viewer_cannot_read_private_page(client):
    r = client.get("/wiki/page/private-entity")
    # Either 403 or 404 is acceptable as long as it's not 200 with the body.
    assert r.status_code in (403, 404)
    # And the body must NOT leak the page contents.
    assert "Secret" not in r.text
    assert "Owner-only" not in r.text


def test_owner_can_read_private_page(client, owner_headers):
    r = client.get("/wiki/page/private-entity", headers=owner_headers)
    assert r.status_code == 200
    assert "Secret" in r.json()["body"]


def test_bad_owner_token_falls_back_to_public(client):
    r = client.get("/wiki/manifest.json", headers={"Authorization": "Bearer not-the-real-token"})
    assert r.status_code == 200
    # An invalid token should NOT grant owner — it should resolve to public.
    assert r.json()["viewer_is_owner"] is False


def test_require_owner_endpoints_reject_public(client):
    # /owner/reload is the simplest write endpoint
    r = client.post("/owner/reload")
    assert r.status_code in (401, 403)
    # And rejects a wrong bearer
    r = client.post("/owner/reload", headers={"Authorization": "Bearer wrong"})
    assert r.status_code in (401, 403)
    r = client.get("/owner/healthz")
    assert r.status_code in (401, 403)


def test_preview_as_downgrades_owner(client, owner_headers):
    """The X-Preview-As header lets the owner browse as a lower tier WITHOUT
    losing owner status for write endpoints. Verify both halves."""
    h = {**owner_headers, "X-Preview-As": "public"}
    r = client.get("/wiki/manifest.json", headers=h)
    assert r.status_code == 200
    data = r.json()
    assert data["viewer_is_owner"] is False  # downgraded by preview
    assert data["viewer_tier"] == "public"
    slugs = {p["slug"] for p in data["pages"]}
    assert "private-entity" not in slugs

    # But /owner/reload must STILL accept the owner token even with the preview header,
    # otherwise the owner can't operate the wiki while previewing.
    r = client.post("/owner/reload", headers=h)
    assert r.status_code == 200


def test_preview_as_cannot_escalate_a_public_viewer(client):
    """An unauthenticated viewer with X-Preview-As: owner should NOT become owner."""
    r = client.get(
        "/wiki/manifest.json", headers={"X-Preview-As": "owner"}
    )
    assert r.status_code == 200
    assert r.json()["viewer_is_owner"] is False


def test_search_respects_viewer_tier(client, owner_headers):
    # Public viewer
    pub = client.get("/wiki/search?q=secret").json()
    pub_slugs = {r["slug"] for r in pub["results"]}
    assert "private-entity" not in pub_slugs

    # Owner viewer
    own = client.get("/wiki/search?q=secret", headers=owner_headers).json()
    own_slugs = {r["slug"] for r in own["results"]}
    assert "private-entity" in own_slugs
