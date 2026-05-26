"""Tests for the Avery Chen demo-tenant seeder.

Covers both entrypoints in :mod:`app.avery_seed`:

* :func:`seed_avery_tenant` — the workhorse used by
  ``scripts/seed_avery_tenant.py``. We verify it produces a layout
  that :class:`app.tenants.TenantManager` can load.
* :func:`auto_seed_if_missing` — the startup hook called from
  ``app.main._lifespan`` in multi-tenant mode. We verify it's
  idempotent and never raises.

We never touch the real repo's ``wiki-demo/`` — every test builds a
small synthetic demo tree in a tmp dir so failures here can't pollute
the OSS demo content.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.avery_seed import (
    AVERY_TENANT_ID,
    auto_seed_if_missing,
    seed_avery_tenant,
)


def _make_demo_wiki(repo_root: Path) -> Path:
    """Build a minimal but realistic ``wiki-demo/wiki/`` under ``repo_root``.

    Mirrors the layout of the real demo (subdirs + root-level pages)
    so the test catches a regression where the seeder forgot to copy
    nested files. Returns the path that :func:`seed_avery_tenant`
    expects as its ``demo_wiki_dir`` argument.
    """
    demo_wiki = repo_root / "wiki-demo" / "wiki"
    (demo_wiki / "entities").mkdir(parents=True, exist_ok=True)
    (demo_wiki / "concepts").mkdir(parents=True, exist_ok=True)

    (demo_wiki / "index.md").write_text(
        "---\ntitle: Index\ntier: public\n---\n# Index\n",
        encoding="utf-8",
    )
    (demo_wiki / "log.md").write_text(
        "---\ntitle: Log\ntier: public\n---\n# Log\n",
        encoding="utf-8",
    )
    (demo_wiki / "entities" / "avery-chen.md").write_text(
        "---\ntitle: Avery Chen\ntier: public\n---\n# Avery Chen\n",
        encoding="utf-8",
    )
    (demo_wiki / "concepts" / "boring-stack-first.md").write_text(
        "---\ntitle: Boring stack first\ntier: public\n---\n# Boring stack first\n",
        encoding="utf-8",
    )
    return demo_wiki


def test_seed_creates_expected_layout(tmp_path: Path) -> None:
    """First call materializes the avery tenant under tenants_root."""
    demo_wiki = _make_demo_wiki(tmp_path / "repo")
    tenants_root = tmp_path / "tenants"

    result = seed_avery_tenant(tenants_root, demo_wiki)

    assert result["action"] == "created"
    assert result["files_copied"] == 4  # index, log, 1 entity, 1 concept

    avery = tenants_root / AVERY_TENANT_ID
    assert (avery / "wiki").is_dir()
    assert (avery / "raw").is_dir()

    # tenant.json content matches the spec the user pinned us to.
    meta_path = avery / "tenant.json"
    assert meta_path.exists()
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["id"] == "avery"
    assert meta["display_name"] == "Avery Chen (demo)"
    assert meta["is_demo"] is True
    assert meta["visibility"] == "public"
    assert meta["gh_login"] == ""
    assert meta["gh_user_id"] == 0
    assert meta["gh_token"] == ""
    assert meta["gh_repo"] == ""
    assert meta["gh_default_branch"] == "main"
    # Timestamps are ISO-formatted and equal on initial create.
    assert meta["created_at"] == meta["updated_at"]
    assert "T" in meta["created_at"]

    # At least one copied .md file lives at the right relative path.
    copied_md = sorted(p.relative_to(avery / "wiki") for p in (avery / "wiki").rglob("*.md"))
    assert Path("index.md") in copied_md
    assert Path("entities/avery-chen.md") in copied_md


def test_seed_is_idempotent_without_force(tmp_path: Path) -> None:
    """Second call skips and preserves the original tenant.json + files."""
    demo_wiki = _make_demo_wiki(tmp_path / "repo")
    tenants_root = tmp_path / "tenants"

    first = seed_avery_tenant(tenants_root, demo_wiki)
    assert first["action"] == "created"

    # User edits the wiki out-of-band — we must NOT clobber that.
    custom_page = tenants_root / AVERY_TENANT_ID / "wiki" / "custom.md"
    custom_page.write_text("---\ntitle: Custom\ntier: public\n---\n# hand-edited\n", encoding="utf-8")
    pre_meta = (tenants_root / AVERY_TENANT_ID / "tenant.json").read_text(encoding="utf-8")

    second = seed_avery_tenant(tenants_root, demo_wiki)
    assert second["action"] == "skipped"
    assert second["files_copied"] == 0

    # The hand-edited page is intact and the metadata wasn't rewritten.
    assert custom_page.exists()
    assert custom_page.read_text(encoding="utf-8").startswith("---\ntitle: Custom")
    assert (tenants_root / AVERY_TENANT_ID / "tenant.json").read_text(encoding="utf-8") == pre_meta


def test_seed_force_rewrites_but_preserves_created_at(tmp_path: Path) -> None:
    """--force wipes wiki/ and rewrites metadata while keeping created_at."""
    demo_wiki = _make_demo_wiki(tmp_path / "repo")
    tenants_root = tmp_path / "tenants"

    first = seed_avery_tenant(tenants_root, demo_wiki)
    original_created_at = json.loads(
        (tenants_root / AVERY_TENANT_ID / "tenant.json").read_text(encoding="utf-8")
    )["created_at"]

    # Stale user edit that --force is expected to remove.
    stale = tenants_root / AVERY_TENANT_ID / "wiki" / "stale.md"
    stale.write_text("# stale\n", encoding="utf-8")

    second = seed_avery_tenant(tenants_root, demo_wiki, force=True)
    assert second["action"] == "forced"
    assert second["files_copied"] == first["files_copied"]
    assert not stale.exists()

    meta = json.loads((tenants_root / AVERY_TENANT_ID / "tenant.json").read_text(encoding="utf-8"))
    assert meta["created_at"] == original_created_at
    # updated_at should be refreshed — but we only assert it's a non-empty
    # string; comparing to original is brittle on fast clocks.
    assert isinstance(meta["updated_at"], str) and meta["updated_at"]


def test_seed_raises_when_demo_dir_missing(tmp_path: Path) -> None:
    """Caller misconfiguration surfaces as a clear FileNotFoundError."""
    with pytest.raises(FileNotFoundError):
        seed_avery_tenant(tmp_path / "tenants", tmp_path / "nope" / "wiki")


def test_auto_seed_noops_without_demo(tmp_path: Path) -> None:
    """Startup hook: missing wiki-demo/ returns a noop, never raises.

    Simulates a slim production image that stripped the demo content.
    """
    # repo_root has no wiki-demo/ subdir.
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    tenants_root = tmp_path / "tenants"

    result = auto_seed_if_missing(tenants_root=tenants_root, repo_root=repo_root)
    assert result["action"] == "noop"
    assert not (tenants_root / AVERY_TENANT_ID).exists()


def test_auto_seed_idempotent_and_creates_metadata(tmp_path: Path) -> None:
    """End-to-end startup-hook path: first call seeds, second call skips.

    Verifies the full happy path the multi-tenant lifespan exercises:
    given a repo with ``wiki-demo/wiki/``, the hook materializes
    ``<tenants_root>/avery/`` and is safe to call again on the next
    container boot.
    """
    repo_root = tmp_path / "repo"
    _make_demo_wiki(repo_root)
    tenants_root = tmp_path / "tenants"

    first = auto_seed_if_missing(tenants_root=tenants_root, repo_root=repo_root)
    assert first["action"] == "created"
    assert first["files_copied"] >= 1

    avery_meta = tenants_root / AVERY_TENANT_ID / "tenant.json"
    assert avery_meta.exists()
    meta = json.loads(avery_meta.read_text(encoding="utf-8"))
    assert meta["is_demo"] is True
    assert meta["visibility"] == "public"

    # Re-run: must not raise, must not overwrite.
    pre = avery_meta.read_text(encoding="utf-8")
    second = auto_seed_if_missing(tenants_root=tenants_root, repo_root=repo_root)
    assert second["action"] == "skipped"
    assert second["files_copied"] == 0
    assert avery_meta.read_text(encoding="utf-8") == pre


def test_auto_seed_swallows_internal_errors(tmp_path: Path, monkeypatch) -> None:
    """The startup hook is a safety net — internal errors must not crash boot.

    We force :func:`seed_avery_tenant` to raise an unexpected error and
    verify ``auto_seed_if_missing`` catches it and returns a diagnostic
    dict with ``action == "error"``.
    """
    repo_root = tmp_path / "repo"
    _make_demo_wiki(repo_root)
    tenants_root = tmp_path / "tenants"

    from app import avery_seed as _avery_seed

    def _boom(*_args, **_kwargs):  # noqa: ANN001
        raise RuntimeError("simulated I/O failure")

    monkeypatch.setattr(_avery_seed, "seed_avery_tenant", _boom)

    result = _avery_seed.auto_seed_if_missing(
        tenants_root=tenants_root, repo_root=repo_root
    )
    assert result["action"] == "error"
    assert "simulated I/O failure" in result["message"]
