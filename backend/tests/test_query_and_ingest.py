"""Query + ingest happy paths (no LLM key required — keyword fallback)."""
from __future__ import annotations

from pathlib import Path


def test_keyword_query_returns_sourced_answer(client):
    r = client.post("/wiki/query", json={"question": "Tell me about the Public Entity"})
    assert r.status_code == 200
    data = r.json()
    assert data["backend"] == "keyword"  # no LLM configured in tests
    assert data["question"] == "Tell me about the Public Entity"
    slugs = {c["slug"] for c in data["citations"]}
    assert "public-entity" in slugs


def test_query_respects_tier(client):
    """A keyword search for 'Secret' must not surface private-entity to public."""
    r = client.post("/wiki/query", json={"question": "Secret"}).json()
    slugs = {c["slug"] for c in r["citations"]}
    assert "private-entity" not in slugs


def test_ingest_writes_raw_file(client, owner_headers, wiki_root: Path):
    r = client.post(
        "/owner/ingest",
        headers=owner_headers,
        json={
            "slug": "smoke-ingest",
            "content": "This is smoke-ingest content.",
            "subdir": "conversations",
            "note": "test",
            "run_orchestrator": False,
        },
    )
    assert r.status_code == 201
    data = r.json()
    assert data["ok"] is True
    assert "smoke-ingest" in data["rel_path"]
    assert data["orchestrator"] is None  # we didn't request the agent

    # File actually landed on disk
    raw_file = wiki_root / data["rel_path"]
    assert raw_file.exists()
    assert "This is smoke-ingest content." in raw_file.read_text()


def test_ingest_response_discloses_sync_state(client, owner_headers):
    """Every ingest must tell the truth about durability. In the test env
    there's no WIKI_GIT_REMOTE, so the response must flag will_sync=False
    rather than letting a local-only write look like a durable success."""
    r = client.post(
        "/owner/ingest",
        headers=owner_headers,
        json={
            "slug": "sync-disclosure",
            "content": "Does this sync?",
            "subdir": "conversations",
            "run_orchestrator": False,
        },
    )
    assert r.status_code == 201
    sync = r.json()["sync"]
    assert sync["will_sync"] is False
    assert sync["mode"] in ("local_only", "tenant")
    assert sync["detail"]  # human-readable, non-empty guidance


def test_raw_delete_response_discloses_sync_state(client, owner_headers):
    """Deletes mutate git-tracked content too — a delete that won't sync
    silently resurrects on restart. The response must carry the sync verdict
    just like ingest, so the disclosure can't drift between endpoints."""
    ingest = client.post(
        "/owner/ingest",
        headers=owner_headers,
        json={
            "slug": "delete-sync-disclosure",
            "content": "Delete me.",
            "subdir": "conversations",
            "run_orchestrator": False,
        },
    )
    assert ingest.status_code == 201
    rel_path = ingest.json()["rel_path"]  # e.g. "raw/conversations/<date>-slug.md"

    r = client.delete(f"/owner/{rel_path}", headers=owner_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "sync" in data
    assert data["sync"]["will_sync"] is False
    assert data["sync"]["detail"]


def test_ingest_duplicate_slug_is_409(client, owner_headers):
    body = {
        "slug": "dup-test",
        "content": "first write",
        "subdir": "conversations",
        "run_orchestrator": False,
    }
    r1 = client.post("/owner/ingest", json=body, headers=owner_headers)
    assert r1.status_code == 201
    r2 = client.post("/owner/ingest", json=body, headers=owner_headers)
    assert r2.status_code == 409


def test_import_endpoint_validates_kind(client, owner_headers):
    r = client.post(
        "/owner/import",
        json={"kind": "not-a-real-kind", "content": "a" * 50},
        headers=owner_headers,
    )
    assert r.status_code == 422


def test_import_endpoint_rejects_short_content(client, owner_headers):
    r = client.post(
        "/owner/import",
        json={"kind": "bio", "content": "too short"},  # < 20 chars
        headers=owner_headers,
    )
    assert r.status_code == 422


def test_well_known_manifest_is_self_describing(client):
    r = client.get("/.well-known/llm-wiki.json")
    assert r.status_code == 200
    data = r.json()
    assert data["name"]
    assert "operations" in data
    # The spec must point at concrete URLs an LLM can fetch.
    for key in ("manifest", "page", "query"):
        assert key in data["operations"]
    # v1.0+ commitment: server claims an llm-wiki 1.x spec_version and links
    # the canonical wire-protocol doc so clients can verify response shapes.
    assert data["spec_version"].startswith("1."), data["spec_version"]
    assert data.get("spec_url"), "spec_url must point at SPEC.md"
    assert "SPEC.md" in data["spec_url"]


def test_healthz_is_public_liveness_only(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    data = r.json()
    assert data == {"status": "ok"}


def test_owner_healthz_reports_page_count_and_volume(client, owner_headers):
    r = client.get("/owner/healthz", headers=owner_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    # The owner-visible page count includes private pages too.
    assert data["page_count"] >= 4
    assert data["disk_total_bytes"] > 0
    assert data["disk_used_bytes"] >= 0
    assert data["disk_free_bytes"] >= 0
    for leaked in ("wiki_root", "indexed_tenant_ids", "indexed_tenants"):
        assert leaked not in data, leaked


def test_owner_healthz_rejects_public(client):
    r = client.get("/owner/healthz")
    assert r.status_code in (401, 403)
