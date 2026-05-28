"""Persistence module tests.

These directly exercise app.persistence against a local bare-git remote
(no network, no GitHub). The HTTP-level smoke test of the same flow lives
in `scripts/persist-e2e-test.sh` — here we verify the smaller building
blocks in isolation.
"""
from __future__ import annotations

import importlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _restore_canonical_global_state(wiki_root: Path, owner_token: str):
    """Keep this module order-independent.

    Most tests here ``importlib.reload(app.config / app.persistence)`` with a
    throwaway ``WIKI_ROOT`` + bare-repo remote. Those are *process-global*
    module attributes, so without cleanup the stale values leak into later
    test modules — an empty wiki (``page_count == 0``) and a dangling remote
    that can make a subsequent startup rename the canonical wiki aside.

    Restoring the canonical session wiki after every test makes the suite
    pass regardless of which subset (or single file) is selected, not just
    in the one full-suite ordering that happened to mask the leak. We take
    the canonical paths from the ``wiki_root`` / ``owner_token`` fixtures
    rather than importing conftest globals (which is import-resolution
    fragile).
    """
    yield
    os.environ["WIKI_ROOT"] = str(wiki_root)
    os.environ["OWNER_TOKEN"] = owner_token
    # Pin to empty (not pop): app.config.load_dotenv() would otherwise
    # re-inject the developer's real backend/.env on the reload below.
    os.environ["WIKI_GIT_REMOTE"] = ""
    os.environ["WIKI_GIT_AUTOSYNC"] = ""
    from app import config as _config

    importlib.reload(_config)
    from app import persistence as _persistence

    importlib.reload(_persistence)


def _init_bare_repo(path: Path) -> None:
    subprocess.run(
        ["git", "init", "--bare", "--initial-branch=main", str(path)],
        check=True,
        capture_output=True,
    )


def _seed_bare_remote(bare: Path, tmp: Path) -> None:
    """Push an initial commit to the bare repo so it's clone-able."""
    work = tmp / "_seed_work"
    subprocess.run(["git", "clone", str(bare), str(work)], check=True, capture_output=True)
    (work / "README.md").write_text("seed\n", encoding="utf-8")
    subprocess.run(["git", "config", "user.email", "seed@test.local"], cwd=work, check=True)
    subprocess.run(["git", "config", "user.name", "seed"], cwd=work, check=True)
    subprocess.run(["git", "add", "-A"], cwd=work, check=True)
    subprocess.run(["git", "commit", "-m", "seed"], cwd=work, check=True, capture_output=True)
    subprocess.run(["git", "push", "origin", "main"], cwd=work, check=True, capture_output=True)
    shutil.rmtree(work)


def test_get_status_is_disabled_without_remote(monkeypatch):
    """With no WIKI_GIT_REMOTE, the persistence layer is a no-op and
    reports as disabled."""
    monkeypatch.delenv("WIKI_GIT_REMOTE", raising=False)
    # Reload the module so it picks up the cleared env.
    import importlib

    from app import persistence as _persistence  # noqa: WPS433

    importlib.reload(_persistence)
    status = _persistence.get_status()
    assert status["enabled"] is False
    assert status["remote"] is None


def test_flush_async_is_noop_without_remote(monkeypatch):
    monkeypatch.delenv("WIKI_GIT_REMOTE", raising=False)
    import importlib

    from app import persistence as _persistence  # noqa: WPS433

    importlib.reload(_persistence)
    # Must not raise, must not commit
    _persistence.flush_async("noop test")
    result = _persistence.flush_now("noop test")
    assert result["committed"] is False
    assert result["pushed"] is False


def test_bootstrap_clones_and_flush_pushes(tmp_path: Path, monkeypatch):
    bare = tmp_path / "remote.git"
    _init_bare_repo(bare)
    _seed_bare_remote(bare, tmp_path)

    target = tmp_path / "local-wiki"

    monkeypatch.setenv("WIKI_GIT_REMOTE", str(bare))
    monkeypatch.setenv("WIKI_GIT_BRANCH", "main")
    monkeypatch.setenv("WIKI_GIT_USER_NAME", "Test Bot")
    monkeypatch.setenv("WIKI_GIT_USER_EMAIL", "bot@test.local")
    monkeypatch.setenv("WIKI_ROOT", str(target))
    monkeypatch.setenv("WIKI_GIT_PUSH_DELAY_S", "0.1")

    # Reload config to pick up the new WIKI_ROOT; then reload persistence
    # to re-read the GIT_* env vars.
    import importlib

    from app import config as _config

    importlib.reload(_config)
    from app import persistence as _persistence  # noqa: WPS433

    importlib.reload(_persistence)

    # Bootstrap should clone the remote into target
    result = _persistence.bootstrap_on_startup()
    assert result["enabled"] is True
    assert result["action"] == "cloned"
    assert target.exists()
    assert (target / "README.md").exists()
    assert (target / ".git").exists()

    # Write a new file and flush — verify the remote received the commit.
    (target / "new-page.md").write_text("hello persistence\n", encoding="utf-8")
    result = _persistence.flush_now("test write")
    assert result["committed"] is True, result
    assert result["pushed"] is True, result

    # Verify the remote ref now has 2 commits (seed + ours).
    out = subprocess.check_output(
        ["git", "--git-dir", str(bare), "log", "--oneline"],
        text=True,
    )
    log_lines = out.strip().splitlines()
    assert len(log_lines) == 2
    assert "test write" in log_lines[0]


def test_bootstrap_fetches_existing_clone(tmp_path: Path, monkeypatch):
    """If WIKI_ROOT already holds a clone, bootstrap should fast-forward."""
    bare = tmp_path / "remote.git"
    _init_bare_repo(bare)
    _seed_bare_remote(bare, tmp_path)

    target = tmp_path / "local-wiki"
    subprocess.run(["git", "clone", str(bare), str(target)], check=True, capture_output=True)
    assert (target / "README.md").exists()

    # Push a new commit to the remote from a side-clone simulating "someone
    # else updated the wiki between this container's last sync and now".
    side = tmp_path / "side"
    subprocess.run(["git", "clone", str(bare), str(side)], check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "side@test.local"], cwd=side, check=True)
    subprocess.run(["git", "config", "user.name", "side"], cwd=side, check=True)
    (side / "added-from-side.md").write_text("from side\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=side, check=True)
    subprocess.run(["git", "commit", "-m", "side commit"], cwd=side, check=True, capture_output=True)
    subprocess.run(["git", "push", "origin", "main"], cwd=side, check=True, capture_output=True)

    monkeypatch.setenv("WIKI_GIT_REMOTE", str(bare))
    monkeypatch.setenv("WIKI_GIT_BRANCH", "main")
    monkeypatch.setenv("WIKI_ROOT", str(target))

    import importlib

    from app import config as _config

    importlib.reload(_config)
    from app import persistence as _persistence  # noqa: WPS433

    importlib.reload(_persistence)

    result = _persistence.bootstrap_on_startup()
    assert result["enabled"] is True
    assert result["action"] == "synced"
    assert (target / "added-from-side.md").exists(), "fetch+reset should have pulled the side commit"


def test_flush_coalesces_messages(tmp_path: Path, monkeypatch):
    """Multiple writes within the debounce window should produce ONE commit
    whose message references all of them."""
    bare = tmp_path / "remote.git"
    _init_bare_repo(bare)
    _seed_bare_remote(bare, tmp_path)

    target = tmp_path / "local-wiki"
    monkeypatch.setenv("WIKI_GIT_REMOTE", str(bare))
    monkeypatch.setenv("WIKI_GIT_BRANCH", "main")
    monkeypatch.setenv("WIKI_GIT_USER_NAME", "Test Bot")
    monkeypatch.setenv("WIKI_GIT_USER_EMAIL", "bot@test.local")
    monkeypatch.setenv("WIKI_ROOT", str(target))

    import importlib

    from app import config as _config

    importlib.reload(_config)
    from app import persistence as _persistence  # noqa: WPS433

    importlib.reload(_persistence)
    _persistence.bootstrap_on_startup()

    # Three writes in rapid succession
    for i in range(3):
        (target / f"write-{i}.md").write_text(f"content {i}\n", encoding="utf-8")

    result = _persistence.flush_now("write A | write B | write C")
    assert result["committed"] is True
    assert result["pushed"] is True

    # The commit message should contain our combined description
    out = subprocess.check_output(
        ["git", "--git-dir", str(bare), "log", "-1", "--format=%B"],
        text=True,
    )
    assert "write A" in out


# ---------------------------------------------------------------------------
# describe_sync — the caller-facing "will this write actually sync?" verdict
# that every mutation endpoint embeds so a silent no-op can't look like
# durable success.
# ---------------------------------------------------------------------------


def test_describe_sync_local_only_without_remote(monkeypatch):
    """Single-tenant, no remote: writes stay on local disk and the verdict
    must say so loudly (will_sync False, actionable detail)."""
    monkeypatch.delenv("WIKI_GIT_REMOTE", raising=False)
    import importlib

    from app import persistence as _persistence  # noqa: WPS433

    importlib.reload(_persistence)
    verdict = _persistence.describe_sync()
    assert verdict["will_sync"] is False
    assert verdict["mode"] == "local_only"
    assert verdict["remote"] is None
    assert verdict["reason"] == "no_remote_configured"
    assert "WIKI_GIT_REMOTE" in verdict["detail"]


def test_describe_sync_global_with_remote_redacts_credentials(tmp_path, monkeypatch):
    """With a configured remote, the verdict reports will_sync True and the
    remote URL is credential-redacted (never leak a PAT in a response)."""
    monkeypatch.setenv(
        "WIKI_GIT_REMOTE",
        "https://user:supersecrettoken@github.com/acme/wiki.git",
    )
    monkeypatch.setenv("WIKI_GIT_AUTOSYNC", "1")
    import importlib

    from app import persistence as _persistence  # noqa: WPS433

    importlib.reload(_persistence)
    verdict = _persistence.describe_sync()
    assert verdict["will_sync"] is True
    assert verdict["mode"] == "global"
    assert "supersecrettoken" not in (verdict["remote"] or "")
    assert "****" in (verdict["remote"] or "")
    # Reset module state for subsequent tests in the session.
    monkeypatch.delenv("WIKI_GIT_REMOTE", raising=False)
    importlib.reload(_persistence)


def test_describe_sync_local_only_remote_set_but_autosync_off(monkeypatch):
    """A remote IS configured but autopush is disabled: the verdict must not
    tell the owner to 'set WIKI_GIT_REMOTE' (it's already set) — it must point
    at WIKI_GIT_AUTOSYNC instead."""
    from app import persistence as _persistence  # noqa: WPS433

    monkeypatch.setattr(_persistence, "GIT_REMOTE", "https://github.com/acme/wiki.git")
    monkeypatch.setattr(_persistence, "AUTOSYNC_ENABLED", False)
    verdict = _persistence.describe_sync()
    assert verdict["will_sync"] is False
    assert verdict["mode"] == "local_only"
    assert verdict["reason"] == "autosync_disabled"
    assert "WIKI_GIT_AUTOSYNC" in verdict["detail"]
    assert "WIKI_GIT_REMOTE is unset" not in verdict["detail"]


def _bound_tenant(tmp_path, *, gh_repo="acme/wiki", gh_token="tok", git=True):
    """Build a Tenant whose wiki_root is (optionally) a real git repo."""
    from app.tenants import Tenant

    root = tmp_path
    if git:
        (root / ".git").mkdir(parents=True, exist_ok=True)
    return Tenant(id="t1", wiki_root=root, gh_repo=gh_repo, gh_token=gh_token)


def test_describe_sync_tenant_connected_syncs(tmp_path, monkeypatch):
    """Connected tenant + autosync on + bootstrapped repo -> durable."""
    from app import persistence as _persistence  # noqa: WPS433
    from app.tenants import set_current_tenant

    monkeypatch.setattr(_persistence, "GIT_REMOTE", "")
    monkeypatch.setattr(_persistence, "AUTOSYNC_ENABLED", True)
    with set_current_tenant(_bound_tenant(tmp_path)):
        verdict = _persistence.describe_sync()
    assert verdict["will_sync"] is True
    assert verdict["mode"] == "tenant"
    assert verdict["remote"] == "acme/wiki"


def test_describe_sync_tenant_autosync_disabled_does_not_lie(tmp_path, monkeypatch):
    """Connected tenant but WIKI_GIT_AUTOSYNC off: flush_tenant_async no-ops,
    so the verdict must report will_sync False (not a durable success)."""
    from app import persistence as _persistence  # noqa: WPS433
    from app.tenants import set_current_tenant

    monkeypatch.setattr(_persistence, "GIT_REMOTE", "")
    monkeypatch.setattr(_persistence, "AUTOSYNC_ENABLED", False)
    with set_current_tenant(_bound_tenant(tmp_path)):
        verdict = _persistence.describe_sync()
    assert verdict["will_sync"] is False
    assert verdict["mode"] == "tenant"
    assert verdict["reason"] == "autosync_disabled"
    assert "WIKI_GIT_AUTOSYNC" in verdict["detail"]


def test_describe_sync_tenant_not_bootstrapped_does_not_lie(tmp_path, monkeypatch):
    """Connected tenant whose repo isn't cloned yet: _do_tenant_flush skips
    with 'not a git repo', so the verdict must not promise durability."""
    from app import persistence as _persistence  # noqa: WPS433
    from app.tenants import set_current_tenant

    monkeypatch.setattr(_persistence, "GIT_REMOTE", "")
    monkeypatch.setattr(_persistence, "AUTOSYNC_ENABLED", True)
    with set_current_tenant(_bound_tenant(tmp_path, git=False)):
        verdict = _persistence.describe_sync()
    assert verdict["will_sync"] is False
    assert verdict["mode"] == "tenant"
    assert verdict["reason"] == "not_bootstrapped"


def test_describe_sync_tenant_no_repo_connected(tmp_path, monkeypatch):
    """Bound tenant with no GitHub repo: not yet portable -> will_sync False."""
    from app import persistence as _persistence  # noqa: WPS433
    from app.tenants import set_current_tenant

    monkeypatch.setattr(_persistence, "GIT_REMOTE", "")
    monkeypatch.setattr(_persistence, "AUTOSYNC_ENABLED", True)
    tenant = _bound_tenant(tmp_path, gh_repo="", gh_token="", git=False)
    with set_current_tenant(tenant):
        verdict = _persistence.describe_sync()
    assert verdict["will_sync"] is False
    assert verdict["mode"] == "tenant"
    assert verdict["reason"] == "no_repo_connected"
