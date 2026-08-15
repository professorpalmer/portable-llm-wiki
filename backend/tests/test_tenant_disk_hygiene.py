"""Tenant-volume hygiene: skip/prune ``*.preexisting``, healthz disk.

Connect-repo stashes a non-git wiki_root as ``<id>.preexisting``. Those
dirs keep ``tenant.json``, so a naive scan registered them as tenants
and doubled disk use. They are leftovers, not tenants.
"""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from app.config import settings
from app.tenants import (
    TenantManager,
    is_preexisting_tenant_id,
    prune_preexisting_tenant_dirs,
)


def _write_tenant(root: Path, tenant_id: str) -> Path:
    dest = root / tenant_id
    dest.mkdir()
    (dest / "tenant.json").write_text(
        json.dumps(
            {
                "id": tenant_id,
                "display_name": tenant_id,
                "gh_login": tenant_id,
                "visibility": "public",
            }
        ),
        encoding="utf-8",
    )
    return dest


def test_preexisting_id_helper() -> None:
    assert is_preexisting_tenant_id("alice.preexisting")
    assert is_preexisting_tenant_id("plttn.preexisting")
    assert not is_preexisting_tenant_id("alice")
    assert not is_preexisting_tenant_id("preexisting")


def test_load_from_disk_skips_preexisting(tmp_path: Path, monkeypatch) -> None:
    _write_tenant(tmp_path, "alice")
    leftover = _write_tenant(tmp_path, "alice.preexisting")
    orphan = _write_tenant(tmp_path, "plttn.preexisting")
    monkeypatch.setattr(
        settings,
        "_base",
        replace(settings._base, single_tenant_mode=False, tenants_root=tmp_path),
    )
    mgr = TenantManager()
    mgr.load_from_disk()
    ids = {tenant.id for tenant in mgr.all_tenants()}
    assert ids == {"alice"}
    assert leftover.is_dir()
    assert orphan.is_dir()


def test_prune_preexisting_removes_stash_dirs(tmp_path: Path) -> None:
    live = _write_tenant(tmp_path, "alice")
    leftover = _write_tenant(tmp_path, "alice.preexisting")
    orphan = _write_tenant(tmp_path, "plttn.preexisting")
    result = prune_preexisting_tenant_dirs(tmp_path)
    assert set(result["removed"]) == {"alice.preexisting", "plttn.preexisting"}
    assert result["errors"] == []
    assert live.is_dir()
    assert not leftover.exists()
    assert not orphan.exists()
