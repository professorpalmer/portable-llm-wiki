"""Persistence module tests.

These directly exercise app.persistence against a local bare-git remote
(no network, no GitHub). The HTTP-level smoke test of the same flow lives
in `scripts/persist-e2e-test.sh` — here we verify the smaller building
blocks in isolation.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest


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
