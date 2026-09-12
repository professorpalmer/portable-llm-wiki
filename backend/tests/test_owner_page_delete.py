"""DELETE /owner/page/{slug} — owner-only page removal."""
from __future__ import annotations

from pathlib import Path


def _seed_deletable_page(wiki_root: Path, slug: str, title: str) -> Path:
    path = wiki_root / "wiki" / "concepts" / f"{slug}.md"
    path.write_text(
        f"""---
type: concept
title: {title}
tier: private
created: 2026-09-12
updated: 2026-09-12
---

Temporary page used only by the delete-route tests.
""",
        encoding="utf-8",
    )
    return path


def test_delete_page_removes_file_and_index(client, owner_headers, wiki_root):
    from app.main import index

    slug = "delete-target-happy"
    path = _seed_deletable_page(wiki_root, slug, "Delete Target Happy")
    try:
        index.reload()
        assert index.get(slug) is not None
        assert path.is_file()

        r = client.delete(f"/owner/page/{slug}", headers=owner_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["slug"] == slug
        assert data["rel_path"] == f"wiki/concepts/{slug}.md"
        assert not path.exists()
        assert index.get(slug) is None

        missing = client.get(f"/wiki/page/{slug}", headers=owner_headers)
        assert missing.status_code == 404
    finally:
        if path.exists():
            path.unlink()
            index.reload()


def test_delete_unknown_slug_is_404(client, owner_headers):
    r = client.delete("/owner/page/definitely-not-a-page", headers=owner_headers)
    assert r.status_code == 404


def test_delete_then_manifest_reflects_change(client, owner_headers, wiki_root):
    from app.main import index

    slug = "delete-target-manifest"
    path = _seed_deletable_page(wiki_root, slug, "Delete Target Manifest")
    try:
        index.reload()

        before = client.get("/wiki/manifest.json", headers=owner_headers)
        assert before.status_code == 200
        assert slug in {p["slug"] for p in before.json()["pages"]}

        deleted = client.delete(f"/owner/page/{slug}", headers=owner_headers)
        assert deleted.status_code == 200

        after = client.get("/wiki/manifest.json", headers=owner_headers)
        assert after.status_code == 200
        assert slug not in {p["slug"] for p in after.json()["pages"]}
        assert index.get(slug) is None
        assert not path.exists()
    finally:
        if path.exists():
            path.unlink()
            index.reload()
