"""FIRST WIKI, NOT FIRST LOGIN.

A 0-page tenant after a successful connect-repo is a failed signup.
These tests lock the deterministic private starter seeder and the
connect-repo success-path hook that calls it.

Invariants:
  * Empty wiki after connect → purpose + how-to-ingest, tier=private,
    valid frontmatter, manifest page_count >= 1.
  * Existing pages (bootstrap imported a real wiki) → do nothing.
  * Never clone Avery's 29-page demo.
  * Never overwrite a page that already exists.
"""

from __future__ import annotations

from pathlib import Path

import frontmatter
import pytest

from app.onboarding_seed import (
    STARTER_PAGES,
    count_wiki_pages,
    seed_starter_wiki,
)
from app.tenants import Tenant
from tests.test_hosted_multitenant import (  # noqa: F401 — fixture + helpers
    _set_session_user,
    _stub_github_create_repo,
    _stub_persistence_git,
    multi_tenant_app,
)


AVERY_DEMO_SLUGS = {
    "avery-chen",
    "strand-bio",
    "linh-park",
    "mia-patel",
    "hannah-wu",
    "theo-nakamura",
    "benchling",
    "boring-stack-first",
    "working-memory",
}


def _empty_tenant(tmp_path: Path, tenant_id: str = "carol") -> Tenant:
    root = tmp_path / tenant_id
    (root / "wiki").mkdir(parents=True)
    (root / "raw").mkdir(parents=True)
    return Tenant(id=tenant_id, wiki_root=root, display_name=tenant_id.title())


def test_seed_writes_purpose_and_how_to_ingest(tmp_path: Path) -> None:
    tenant = _empty_tenant(tmp_path)
    result = seed_starter_wiki(tenant)

    assert result["action"] == "seeded"
    assert result["page_count"] >= 1
    assert sorted(result["pages"]) == ["how-to-ingest.md", "purpose.md"]
    assert count_wiki_pages(tenant) == 2

    slugs = {p.stem for p in tenant.wiki_dir.rglob("*.md")}
    assert slugs == {"purpose", "how-to-ingest"}
    assert slugs.isdisjoint(AVERY_DEMO_SLUGS)
    assert len(list(tenant.wiki_dir.rglob("*.md"))) != 29


def test_seed_pages_are_private_with_valid_frontmatter(tmp_path: Path) -> None:
    tenant = _empty_tenant(tmp_path)
    seed_starter_wiki(tenant)

    for filename, title, _body in STARTER_PAGES:
        path = tenant.wiki_dir / filename
        post = frontmatter.load(path)
        assert post.metadata["title"] == title
        assert post.metadata["tier"] == "private"
        assert post.metadata["type"] == "overview"
        assert post.content.strip()


def test_seed_skips_when_wiki_already_has_pages(tmp_path: Path) -> None:
    tenant = _empty_tenant(tmp_path)
    existing = tenant.wiki_dir / "index.md"
    existing.write_text(
        "---\ntitle: Existing\ntier: public\n---\n# Existing\n",
        encoding="utf-8",
    )

    result = seed_starter_wiki(tenant)

    assert result["action"] == "skipped"
    assert result["reason"] == "existing_pages"
    assert result["page_count"] == 1
    assert not (tenant.wiki_dir / "purpose.md").exists()
    assert existing.read_text(encoding="utf-8").startswith("---\ntitle: Existing")


def test_seed_does_not_overwrite_existing_starter_filenames(tmp_path: Path) -> None:
    tenant = _empty_tenant(tmp_path)
    first = seed_starter_wiki(tenant)
    assert first["action"] == "seeded"
    purpose = tenant.wiki_dir / "purpose.md"
    original = purpose.read_text(encoding="utf-8")
    purpose.write_text(original + "\n<!-- user edit -->\n", encoding="utf-8")

    second = seed_starter_wiki(tenant)
    assert second["action"] == "skipped"
    assert "<!-- user edit -->" in purpose.read_text(encoding="utf-8")


def test_seed_is_idempotent_on_seeded_wiki(tmp_path: Path) -> None:
    tenant = _empty_tenant(tmp_path)
    seed_starter_wiki(tenant)
    again = seed_starter_wiki(tenant)
    assert again["action"] == "skipped"
    assert again["page_count"] == 2


def _clear_alice_pages() -> None:
    from app import tenants

    alice = tenants.manager().require("alice")
    if alice.wiki_dir.exists():
        for path in alice.wiki_dir.rglob("*.md"):
            path.unlink()
    alice.invalidate_index()


def test_connect_repo_seeds_empty_tenant(
    multi_tenant_app, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: connect a new empty repo → starter pages land and
    the owner-visible manifest reports page_count >= 1."""
    from app import tenants

    _clear_alice_pages()
    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_fake_for_test"
    alice.gh_login = "alice"
    tenants.manager().upsert(alice)

    _set_session_user(multi_tenant_app, "alice", login="alice")
    _stub_github_create_repo(monkeypatch)
    _stub_persistence_git(monkeypatch, [])

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "my-portable-llm-wiki", "private": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["connected"] is True
    assert body["starter_seed"]["action"] == "seeded"
    assert body["starter_seed"]["page_count"] >= 1

    refreshed = tenants.manager().require("alice")
    slugs = {p.stem for p in refreshed.wiki_dir.rglob("*.md")}
    assert "purpose" in slugs
    assert "how-to-ingest" in slugs
    assert slugs.isdisjoint(AVERY_DEMO_SLUGS)

    manifest = multi_tenant_app.get("/t/alice/wiki/manifest.json")
    assert manifest.status_code == 200, manifest.text
    assert manifest.json()["page_count"] >= 1
    tiers = {p["tier"] for p in manifest.json()["pages"]}
    assert tiers == {"private"}


def test_connect_repo_skips_seed_when_bootstrap_imported_pages(
    multi_tenant_app, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Alice's fixture wiki already has index.md. Connect must not
    overwrite it or drop Avery-sized content on top."""
    from app import tenants

    alice = tenants.manager().require("alice")
    original = (alice.wiki_dir / "index.md").read_text(encoding="utf-8")
    alice.gh_token = "ghp_fake_for_test"
    alice.gh_login = "alice"
    tenants.manager().upsert(alice)

    _set_session_user(multi_tenant_app, "alice", login="alice")
    _stub_github_create_repo(monkeypatch)
    _stub_persistence_git(monkeypatch, [])

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "my-portable-llm-wiki", "private": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["starter_seed"]["action"] == "skipped"
    assert body["starter_seed"]["reason"] == "existing_pages"

    refreshed = tenants.manager().require("alice")
    assert (refreshed.wiki_dir / "index.md").read_text(encoding="utf-8") == original
    assert not (refreshed.wiki_dir / "purpose.md").exists()
    assert not (refreshed.wiki_dir / "entities" / "avery-chen.md").exists()
    assert count_wiki_pages(refreshed) == 1
