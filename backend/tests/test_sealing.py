"""Sealed-tier backend: keyring, loader, HTTP guards, zero-regression."""
from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path

import pytest

from app.sealing import (
    KEYRING_REL,
    load_state,
    validate_keyring,
)


def valid_keyring(tiers: tuple[str, ...] = ("private",)) -> dict:
    return {
        "v": 1,
        "tiers": list(tiers),
        "kdf": "pbkdf2-sha256",
        "iterations": 100000,
        "salt": base64.b64encode(b"s" * 16).decode(),
        "wrapped_dek": base64.b64encode(b"d" * 48).decode(),
        "check": base64.b64encode(b"c" * 48).decode(),
        "created": "2026-09-12T00:00:00Z",
    }


SEALED_SLUG = "s-aaaabbbbccccdddd"
SEALED_ENVELOPE_WRAPPED = "YWJjZGVm\n  Z2hpams=\n"
SEALED_ENVELOPE_STRIPPED = "YWJjZGVmZ2hpams="

SEALED_DOC = (
    "---\n"
    "sealed: v1\n"
    "type: concept\n"
    "tier: private\n"
    f"slug: {SEALED_SLUG}\n"
    "created: 2026-09-12\n"
    "updated: 2026-09-12\n"
    "---\n"
    f"{SEALED_ENVELOPE_WRAPPED}"
)

MANIFEST_KEYS = {
    "wiki_title",
    "generated_at",
    "viewer_tier",
    "viewer_is_owner",
    "page_count",
    "sections",
    "pages",
    "base_url",
    "endpoints",
    "instructions_for_llm",
}
SUMMARY_KEYS = {
    "slug",
    "title",
    "section",
    "type",
    "tier",
    "created",
    "updated",
    "tags",
    "excerpt",
    "word_count",
    "rel_path",
    "url",
}
QUERY_KEYS = {
    "question",
    "viewer_tier",
    "answer",
    "citations",
    "backend",
    "model",
    "used_pages",
    "retrieval",
}


def _enable(client, owner_headers, tiers=("private",), force=False):
    return client.put(
        "/owner/sealing",
        headers=owner_headers,
        json={"keyring": valid_keyring(tiers), "force": force},
    )


def _mint_recruiter(client, owner_headers) -> str:
    r = client.post(
        "/owner/share-tokens",
        json={"label": "sealing recruiter", "tier": "recruiter"},
        headers=owner_headers,
    )
    assert r.status_code == 201, r.text
    return r.json()["token"]


def _write_sealed_page(wiki_root: Path) -> Path:
    path = wiki_root / "wiki" / "concepts" / f"{SEALED_SLUG}.md"
    path.write_text(SEALED_DOC, encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def _reset_sealing_state(wiki_root: Path):
    yield
    sealed_dir = wiki_root / "wiki" / ".sealed"
    if sealed_dir.exists():
        shutil.rmtree(sealed_dir)
    extra = wiki_root / "wiki" / "concepts" / f"{SEALED_SLUG}.md"
    if extra.exists():
        extra.unlink()
    for pattern in (
        "wiki/concepts/seal-*.md",
        "wiki/concepts/s-*.md",
        "wiki/entities/seal-*.md",
    ):
        for path in wiki_root.glob(pattern):
            path.unlink()
    from app.main import index

    index.reload()


# ---------------------------------------------------------------------------
# Golden no-regression (no keyring)
# ---------------------------------------------------------------------------


def test_unsealed_to_summary_has_no_sealed_key():
    from app.main import index

    index.reload()
    page = index.get("public-entity")
    assert page is not None
    summary = page.to_summary()
    full = page.to_full()
    assert "sealed" not in summary
    assert "sealed" not in full
    assert "envelope" not in full
    assert set(summary) == SUMMARY_KEYS
    dumped = json.dumps(summary, sort_keys=True)
    from app import sealing as _sealing  # noqa: F401

    assert json.dumps(page.to_summary(), sort_keys=True) == dumped


def test_no_keyring_http_json_is_unchanged(client):
    manifest = client.get("/wiki/manifest.json").json()
    page = client.get("/wiki/page/public-entity").json()
    search = client.get("/wiki/search", params={"q": "Public"}).json()
    query = client.post(
        "/wiki/query", json={"question": "Tell me about the Public Entity"}
    ).json()

    assert set(manifest) == MANIFEST_KEYS
    assert "sealing" not in manifest
    for item in manifest["pages"]:
        assert "sealed" not in item
        assert "envelope" not in item
        assert set(item) == SUMMARY_KEYS

    assert "sealed" not in page
    assert "envelope" not in page
    assert "sealed_excluded" not in query
    assert set(query) == QUERY_KEYS
    for item in search["results"]:
        assert "sealed" not in item

    assert json.dumps(manifest["pages"], sort_keys=True)
    assert json.dumps(page, sort_keys=True)
    assert json.dumps(search, sort_keys=True)
    assert json.dumps(query, sort_keys=True)


def test_wiki_sealing_404_when_disabled(client, owner_headers):
    r = client.get("/wiki/sealing", headers=owner_headers)
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# validate_keyring / load_state
# ---------------------------------------------------------------------------


def test_validate_keyring_rejects_bad_tiers():
    bad = valid_keyring()
    bad["tiers"] = ["public"]
    with pytest.raises(ValueError, match="tiers"):
        validate_keyring(bad)


def test_validate_keyring_rejects_low_iterations():
    bad = valid_keyring()
    bad["iterations"] = 99999
    with pytest.raises(ValueError, match="iterations"):
        validate_keyring(bad)


def test_validate_keyring_rejects_missing_fields():
    bad = valid_keyring()
    del bad["salt"]
    with pytest.raises(ValueError, match="salt"):
        validate_keyring(bad)


def test_load_state_missing_is_disabled(tmp_path: Path):
    state = load_state(tmp_path)
    assert state.enabled is False
    assert state.tiers == ()
    assert state.keyring is None


def test_load_state_malformed_json_is_disabled(tmp_path: Path, caplog):
    path = tmp_path / KEYRING_REL
    path.parent.mkdir(parents=True)
    path.write_text("{not-json", encoding="utf-8")
    with caplog.at_level("WARNING"):
        state = load_state(tmp_path)
    assert state.enabled is False
    assert "malformed" in caplog.text


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def test_loader_sealed_page_is_opaque(wiki_root: Path):
    _write_sealed_page(wiki_root)
    from app.main import index

    index.reload()
    page = index.get(SEALED_SLUG)
    assert page is not None
    assert page.sealed is True
    assert page.title == "Sealed page"
    assert page.body == ""
    assert page.excerpt == ""
    assert page.tags == []
    assert page.sources == []
    assert page.links_out == []
    assert page.word_count == 0
    assert page.envelope == SEALED_ENVELOPE_STRIPPED
    summary = page.to_summary()
    assert summary["sealed"] is True
    full = page.to_full()
    assert full["envelope"] == SEALED_ENVELOPE_STRIPPED
    assert full["body"] == ""
    assert full["links_out"] == []
    assert full["links_in"] == []


def test_loader_ignores_wikilinks_in_sealed_body(wiki_root: Path):
    path = wiki_root / "wiki" / "concepts" / "s-linkleaktest.md"
    path.write_text(
        "---\nsealed: v1\ntype: concept\ntier: private\n---\n"
        "[[Public Entity]]\n",
        encoding="utf-8",
    )
    from app.main import index

    index.reload()
    page = index.get("s-linkleaktest")
    assert page is not None
    assert page.sealed is True
    assert page.links_out == []


# ---------------------------------------------------------------------------
# Manifest / keyring / bundle
# ---------------------------------------------------------------------------


def test_manifest_gains_sealing_only_when_enabled(client, owner_headers):
    before = client.get("/wiki/manifest.json").json()
    assert "sealing" not in before
    r = _enable(client, owner_headers)
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True
    assert r.json()["enabled"] is True
    assert r.json()["tiers"] == ["private"]
    assert "sync" in r.json()
    after = client.get("/wiki/manifest.json").json()
    assert after["sealing"] == {
        "enabled": True,
        "tiers": ["private"],
        "keyring_url": "/wiki/sealing",
        "bundle_url": "/wiki/sealed/bundle",
    }


def test_wiki_sealing_owner_200_public_denied(client, owner_headers):
    _enable(client, owner_headers)
    owner = client.get("/wiki/sealing", headers=owner_headers)
    assert owner.status_code == 200
    body = owner.json()
    assert body["v"] == 1
    assert body["tiers"] == ["private"]
    public = client.get("/wiki/sealing")
    assert public.status_code == 403


def test_wiki_sealing_recruiter_token_allowed(client, owner_headers):
    _enable(client, owner_headers)
    token = _mint_recruiter(client, owner_headers)
    r = client.get("/wiki/sealing", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["v"] == 1


def test_bundle_tier_gating(client, owner_headers, wiki_root: Path):
    _write_sealed_page(wiki_root)
    _enable(client, owner_headers)
    from app.main import index

    index.reload()
    owner = client.get("/wiki/sealed/bundle", headers=owner_headers)
    assert owner.status_code == 200
    slugs = {p["slug"] for p in owner.json()["pages"]}
    assert SEALED_SLUG in slugs
    token = _mint_recruiter(client, owner_headers)
    rec = client.get(
        "/wiki/sealed/bundle", headers={"Authorization": f"Bearer {token}"}
    )
    assert rec.status_code == 200
    rec_slugs = {p["slug"] for p in rec.json()["pages"]}
    assert SEALED_SLUG not in rec_slugs


# ---------------------------------------------------------------------------
# PUT / DELETE /owner/sealing
# ---------------------------------------------------------------------------


def test_put_sealing_validation_errors(client, owner_headers):
    bad_tiers = valid_keyring()
    bad_tiers["tiers"] = ["public"]
    r = client.put(
        "/owner/sealing",
        headers=owner_headers,
        json={"keyring": bad_tiers},
    )
    assert r.status_code == 400
    assert "tiers" in r.json()["detail"]

    low = valid_keyring()
    low["iterations"] = 10
    r = client.put(
        "/owner/sealing", headers=owner_headers, json={"keyring": low}
    )
    assert r.status_code == 400
    assert "iterations" in r.json()["detail"]

    missing = valid_keyring()
    del missing["wrapped_dek"]
    r = client.put(
        "/owner/sealing", headers=owner_headers, json={"keyring": missing}
    )
    assert r.status_code == 400
    assert "wrapped_dek" in r.json()["detail"]


def test_put_sealing_keyring_exists_and_force(client, owner_headers):
    first = _enable(client, owner_headers)
    assert first.status_code == 200
    second = _enable(client, owner_headers, force=False)
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "keyring_exists"
    forced = _enable(client, owner_headers, tiers=("private", "friend"), force=True)
    assert forced.status_code == 200, forced.text
    assert set(forced.json()["tiers"]) == {"private", "friend"}


def test_delete_sealing_disables_and_drops_manifest_key(client, owner_headers):
    _enable(client, owner_headers)
    assert "sealing" in client.get("/wiki/manifest.json").json()
    r = client.delete("/owner/sealing", headers=owner_headers)
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["enabled"] is False
    assert "sealing" not in client.get("/wiki/manifest.json").json()
    assert client.get("/wiki/sealing", headers=owner_headers).status_code == 404


def test_delete_sealing_404_when_absent(client, owner_headers):
    r = client.delete("/owner/sealing", headers=owner_headers)
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# 409 guards + allowed paths
# ---------------------------------------------------------------------------


def test_ingest_orchestrator_409(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/ingest",
        headers=owner_headers,
        json={
            "slug": "seal-orch-ingest",
            "content": "hello",
            "run_orchestrator": True,
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "sealing_enabled"


def test_ingest_without_orchestrator_allowed(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/ingest",
        headers=owner_headers,
        json={
            "slug": "seal-raw-ingest",
            "content": "hello",
            "run_orchestrator": False,
        },
    )
    assert r.status_code == 201, r.text


def test_import_409(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/import",
        headers=owner_headers,
        json={"kind": "bio", "content": "A" * 40},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "sealing_enabled"


def test_paste_orchestrator_409(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/capture/paste",
        headers=owner_headers,
        json={"content": "pasted notes", "run_orchestrator": True},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "sealing_enabled"


def test_lint_409(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post("/owner/lint", headers=owner_headers)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "sealing_enabled"


def test_reingest_single_and_bulk_409(client, owner_headers):
    r = client.post(
        "/owner/ingest",
        headers=owner_headers,
        json={"slug": "seal-reingest", "content": "hello", "run_orchestrator": False},
    )
    assert r.status_code == 201, r.text
    rel_path = r.json()["rel_path"]
    _enable(client, owner_headers)

    r = client.post(f"/owner/raw/{rel_path}/reingest", headers=owner_headers)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "sealing_enabled"

    r = client.post(
        "/owner/raw/bulk",
        headers=owner_headers,
        json={"rel_paths": [rel_path], "action": "reingest"},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "sealing_enabled"

    r = client.post(
        "/owner/raw/bulk",
        headers=owner_headers,
        json={"rel_paths": [rel_path], "action": "delete"},
    )
    assert r.status_code == 200, r.text


def test_structured_409_when_private_sealed(client, owner_headers):
    _enable(client, owner_headers, tiers=("private",))
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-seal-test",
            "pages": [
                {
                    "slug": "seal-structured",
                    "title": "Seal Structured",
                    "section": "concepts",
                    "body": "A paragraph long enough to look like a real page.",
                }
            ],
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "plaintext_into_sealed_tier"


def test_verbatim_plaintext_into_sealed_tier_409(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={
            "content": (
                "---\ntype: concept\ntitle: Plain Into Seal\n"
                "tier: private\n---\n\nplaintext body\n"
            )
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "plaintext_into_sealed_tier"


def test_verbatim_sealed_write_succeeds(client, owner_headers, wiki_root: Path):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": SEALED_DOC, "force_overwrite": True},
    )
    assert r.status_code == 201, r.text
    written = r.json()["written"]
    assert written["slug"] == SEALED_SLUG
    assert written["tier"] == "private"
    on_disk = (wiki_root / written["rel_path"]).read_text(encoding="utf-8")
    expected = SEALED_DOC if SEALED_DOC.endswith("\n") else SEALED_DOC + "\n"
    assert on_disk == expected


def test_post_owner_page_plaintext_into_sealed_409(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/page",
        headers=owner_headers,
        json={
            "title": "Seal Plain Post",
            "section": "concepts",
            "tier": "private",
            "body": "plaintext",
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "plaintext_into_sealed_tier"


def test_post_owner_page_public_still_allowed(client, owner_headers):
    _enable(client, owner_headers)
    r = client.post(
        "/owner/page",
        headers=owner_headers,
        json={
            "title": "Seal Public Allowed",
            "section": "concepts",
            "tier": "public",
            "body": "public plaintext is fine",
        },
    )
    assert r.status_code == 201, r.text


def test_put_plaintext_into_sealed_tier_409(client, owner_headers):
    created = client.post(
        "/owner/page",
        headers=owner_headers,
        json={
            "title": "Seal Put Target",
            "section": "concepts",
            "tier": "public",
            "body": "start public",
        },
    )
    assert created.status_code == 201, created.text
    slug = created.json()["slug"]
    _enable(client, owner_headers)
    r = client.put(
        f"/owner/page/{slug}",
        headers=owner_headers,
        json={
            "markdown": (
                "---\ntype: concept\ntitle: Seal Put Target\n"
                "tier: private\n---\n\nnow private plaintext\n"
            )
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "plaintext_into_sealed_tier"


def test_put_with_sealed_marker_succeeds(client, owner_headers):
    created = client.post(
        "/owner/page",
        headers=owner_headers,
        json={
            "title": "Seal Put Marker",
            "section": "concepts",
            "tier": "public",
            "body": "start",
        },
    )
    slug = created.json()["slug"]
    _enable(client, owner_headers)
    r = client.put(
        f"/owner/page/{slug}",
        headers=owner_headers,
        json={
            "markdown": (
                "---\nsealed: v1\ntype: concept\ntier: private\n"
                f"slug: {slug}\n---\nYWJj\n"
            )
        },
    )
    assert r.status_code == 200, r.text


def test_put_to_public_plaintext_succeeds(client, owner_headers):
    created = client.post(
        "/owner/page",
        headers=owner_headers,
        json={
            "title": "Seal Put Public",
            "section": "concepts",
            "tier": "recruiter",
            "body": "start",
        },
    )
    slug = created.json()["slug"]
    _enable(client, owner_headers)
    r = client.put(
        f"/owner/page/{slug}",
        headers=owner_headers,
        json={
            "markdown": (
                "---\ntype: concept\ntitle: Seal Put Public\n"
                "tier: public\n---\n\nnow public\n"
            )
        },
    )
    assert r.status_code == 200, r.text


def test_patch_boundary_crossing_both_directions(
    client, owner_headers, wiki_root: Path
):
    created = client.post(
        "/owner/page",
        headers=owner_headers,
        json={
            "title": "Seal Patch Plain",
            "section": "concepts",
            "tier": "public",
            "body": "plain",
        },
    )
    plain_slug = created.json()["slug"]
    _write_sealed_page(wiki_root)
    _enable(client, owner_headers)
    from app.main import index

    index.reload()

    into_sealed = client.patch(
        f"/owner/page/{plain_slug}/tier",
        headers=owner_headers,
        json={"tier": "private"},
    )
    assert into_sealed.status_code == 409
    assert into_sealed.json()["detail"]["code"] == "seal_boundary_crossing"

    out_of_sealed = client.patch(
        f"/owner/page/{SEALED_SLUG}/tier",
        headers=owner_headers,
        json={"tier": "public"},
    )
    assert out_of_sealed.status_code == 409
    assert out_of_sealed.json()["detail"]["code"] == "seal_boundary_crossing"


# ---------------------------------------------------------------------------
# Search / query
# ---------------------------------------------------------------------------


def test_search_never_returns_sealed_pages(
    client, owner_headers, wiki_root: Path
):
    _write_sealed_page(wiki_root)
    _enable(client, owner_headers)
    from app.main import index

    index.reload()
    r = client.get("/wiki/search", params={"q": "Sealed"}, headers=owner_headers)
    slugs = {item["slug"] for item in r.json()["results"]}
    assert SEALED_SLUG not in slugs


def test_query_sealed_excluded_and_not_retrieved(
    client, owner_headers, wiki_root: Path
):
    _write_sealed_page(wiki_root)
    _enable(client, owner_headers)
    from app.main import index

    index.reload()
    r = client.post(
        "/wiki/query",
        headers=owner_headers,
        json={"question": "Tell me about the Public Entity"},
    )
    data = r.json()
    assert data["sealed_excluded"] >= 1
    used = set(data["used_pages"])
    cited = {c["slug"] for c in data["citations"]}
    assert SEALED_SLUG not in used
    assert SEALED_SLUG not in cited
    assert SEALED_ENVELOPE_STRIPPED not in data["answer"]


def test_query_omits_sealed_excluded_when_zero_visible(
    client, owner_headers, wiki_root: Path
):
    _write_sealed_page(wiki_root)
    _enable(client, owner_headers)
    from app.main import index

    index.reload()
    token = _mint_recruiter(client, owner_headers)
    r = client.post(
        "/wiki/query",
        headers={"Authorization": f"Bearer {token}"},
        json={"question": "Tell me about the Public Entity"},
    )
    assert "sealed_excluded" not in r.json()


def test_verbatim_parse_sealed_title_optional():
    from app.verbatim_capture import parse_and_validate

    metadata, body, page_type, section, title, slug = parse_and_validate(
        content=SEALED_DOC
    )
    assert page_type == "concept"
    assert section == "concepts"
    assert slug == SEALED_SLUG
    assert title == SEALED_SLUG
    assert "sealed" in metadata
