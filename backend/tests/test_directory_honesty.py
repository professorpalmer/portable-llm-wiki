"""Directory honesty: GET /tenants lists real public wikis, plus Avery.

Empty public shells stay off the directory. GET /tenants/{id} is unchanged
(public/unlisted 200, private 404) even when page_count is 0. Listing
counts markdown on disk and must not rewrite tenant.json visibility or
warm every WikiIndex into RAM.
"""

from __future__ import annotations

import json

from app.tenants import (
    Tenant,
    count_wiki_markdown_pages,
    listed_in_public_directory,
)
from tests.test_hosted_multitenant import multi_tenant_app  # noqa: F401


def _tenant(tmp_path, tenant_id: str, **kwargs) -> Tenant:
    root = tmp_path / tenant_id
    root.mkdir()
    return Tenant(id=tenant_id, wiki_root=root, display_name=tenant_id, **kwargs)


def test_count_missing_wiki_dir_is_zero(tmp_path) -> None:
    tenant = _tenant(tmp_path, "ghost", visibility="public")
    assert count_wiki_markdown_pages(tenant) == 0
    assert listed_in_public_directory(tenant) is False


def test_empty_public_tenant_is_not_listed(tmp_path) -> None:
    tenant = _tenant(tmp_path, "empty", visibility="public")
    tenant.wiki_dir.mkdir(parents=True)
    assert count_wiki_markdown_pages(tenant) == 0
    assert listed_in_public_directory(tenant) is False


def test_public_tenant_with_nested_markdown_is_listed(tmp_path) -> None:
    tenant = _tenant(tmp_path, "alice", visibility="public")
    (tenant.wiki_dir / "concepts").mkdir(parents=True)
    (tenant.wiki_dir / "index.md").write_text("# Alice\n", encoding="utf-8")
    (tenant.wiki_dir / "concepts" / "idea.md").write_text("# Idea\n", encoding="utf-8")
    assert count_wiki_markdown_pages(tenant) == 2
    assert listed_in_public_directory(tenant) is True


def test_unlisted_and_private_with_pages_are_not_listed(tmp_path) -> None:
    for vis in ("unlisted", "private"):
        tenant = _tenant(tmp_path, vis, visibility=vis)
        tenant.wiki_dir.mkdir(parents=True)
        (tenant.wiki_dir / "index.md").write_text("# Hi\n", encoding="utf-8")
        assert count_wiki_markdown_pages(tenant) == 1
        assert listed_in_public_directory(tenant) is False


def test_demo_tenant_is_listed_without_pages(tmp_path) -> None:
    tenant = _tenant(tmp_path, "avery", visibility="public", is_demo=True)
    tenant.wiki_dir.mkdir(parents=True)
    assert count_wiki_markdown_pages(tenant) == 0
    assert listed_in_public_directory(tenant) is True


def test_demo_tenant_is_listed_even_if_unlisted(tmp_path) -> None:
    tenant = _tenant(tmp_path, "avery", visibility="unlisted", is_demo=True)
    assert listed_in_public_directory(tenant) is True


def test_count_does_not_warm_wiki_index(tmp_path) -> None:
    tenant = _tenant(tmp_path, "alice", visibility="public")
    tenant.wiki_dir.mkdir(parents=True)
    (tenant.wiki_dir / "index.md").write_text("# Alice\n", encoding="utf-8")
    assert listed_in_public_directory(tenant) is True
    assert tenant._index is None
    assert count_wiki_markdown_pages(tenant) == 1
    assert tenant._index is None


def test_list_tenants_http_hides_empty_public_keeps_get_by_id(multi_tenant_app) -> None:
    from app import tenants as _tenants

    empty = _tenants.manager().provision_local("shell", display_name="Shell")
    empty.visibility = "public"
    _tenants.manager().upsert(empty)
    alice = _tenants.manager().require("alice")
    before = (alice.wiki_root / "tenant.json").read_text(encoding="utf-8")

    listed = {row["id"] for row in multi_tenant_app.get("/tenants").json()["tenants"]}
    assert "alice" in listed
    assert "avery" in listed
    assert "shell" not in listed

    r = multi_tenant_app.get("/tenants/shell")
    assert r.status_code == 200
    assert r.json()["visibility"] == "public"

    after = (alice.wiki_root / "tenant.json").read_text(encoding="utf-8")
    assert after == before
    assert json.loads(after)["visibility"] == "public"
