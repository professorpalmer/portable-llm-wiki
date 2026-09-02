"""Shared pytest fixtures.

We isolate every test session in a fresh tmp wiki directory. The crucial
constraint is that `app.config` loads settings at module-import time, so
the environment has to be configured BEFORE any `from app.* import …` runs.
This conftest sets up `WIKI_ROOT` and friends at collection time so all
tests inherit a clean, isolated wiki.

Test wiki structure:
    <tmp>/wiki/
        index.md
        log.md
        entities/public-entity.md       (tier: public)
        entities/private-entity.md      (tier: private)
        concepts/recruiter-concept.md   (tier: recruiter)
        concepts/friend-concept.md      (tier: friend)
    <tmp>/raw/
        (empty — populated by tests)

This lets us exercise tier filtering across all four tiers.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

OWNER_TOKEN = "test-owner-token-do-not-leak"
SESSION_TMP: Path = Path(tempfile.mkdtemp(prefix="portable-llm-wiki-test-"))


def _seed_wiki(root: Path) -> None:
    """Write a minimal-but-complete wiki tree under `root`."""
    wiki = root / "wiki"
    (wiki / "entities").mkdir(parents=True, exist_ok=True)
    (wiki / "concepts").mkdir(parents=True, exist_ok=True)
    (wiki / "sources").mkdir(parents=True, exist_ok=True)
    (root / "raw" / "conversations").mkdir(parents=True, exist_ok=True)

    (wiki / "index.md").write_text(
        """---
type: overview
title: Index
tier: public
created: 2026-05-24
updated: 2026-05-24
---

# Index

- [[Public Entity]]
- [[Recruiter Concept]]
""",
        encoding="utf-8",
    )

    (wiki / "log.md").write_text(
        """---
type: overview
title: Log
tier: private
---

# Log
""",
        encoding="utf-8",
    )

    (wiki / "entities" / "public-entity.md").write_text(
        """---
type: entity
title: Public Entity
tier: public
created: 2026-05-24
updated: 2026-05-24
---

This is a public entity. Anyone can see it.
References [[Recruiter Concept]].
""",
        encoding="utf-8",
    )

    (wiki / "entities" / "private-entity.md").write_text(
        """---
type: entity
title: Private Entity
tier: private
created: 2026-05-24
updated: 2026-05-24
---

Secret. Owner-only.
""",
        encoding="utf-8",
    )

    (wiki / "concepts" / "recruiter-concept.md").write_text(
        """---
type: concept
title: Recruiter Concept
tier: recruiter
created: 2026-05-24
updated: 2026-05-24
---

Visible to recruiters and above.
""",
        encoding="utf-8",
    )

    (wiki / "concepts" / "friend-concept.md").write_text(
        """---
type: concept
title: Friend Concept
tier: friend
created: 2026-05-24
updated: 2026-05-24
---

Visible to friends and above.
""",
        encoding="utf-8",
    )


def pytest_configure(config: pytest.Config) -> None:
    """Configure the global test environment BEFORE any tests collect.

    pytest_configure runs once per session, before pytest starts importing
    test modules. By the time `from app.main import …` happens inside a
    test module, these env vars are already set.
    """
    _seed_wiki(SESSION_TMP)

    # Isolate git's global/system config so persistence code that runs
    # `git config --global ...` (user.name/email, safe.directory) during tests
    # writes to a throwaway file instead of polluting the developer's real
    # ~/.gitconfig. Without this, the persistence suite rewrites the global git
    # identity (e.g. to "Test Bot") and appends a safe.directory entry per run.
    # GIT_CONFIG_GLOBAL points at a file inside SESSION_TMP, cleaned up in
    # pytest_unconfigure; GIT_CONFIG_SYSTEM=/dev/null blocks system-config writes.
    os.environ["GIT_CONFIG_GLOBAL"] = str(SESSION_TMP / "gitconfig")
    os.environ["GIT_CONFIG_SYSTEM"] = os.devnull

    os.environ["WIKI_ROOT"] = str(SESSION_TMP)
    os.environ["OWNER_TOKEN"] = OWNER_TOKEN
    os.environ["DEFAULT_TIER"] = "public"
    os.environ["CORS_ORIGINS"] = "http://localhost:3000"
    # Disable rate limiting for shared-app tests. The dedicated rate-limit
    # suite (test_rate_limit.py) builds its own FastAPI app + flips
    # RATE_LIMIT_ENABLED per-case, so it's unaffected by this default.
    os.environ["RATE_LIMIT_ENABLED"] = "0"

    # Hermetic env: `app.config` calls `load_dotenv()` at import, which would
    # otherwise inject the developer's real `backend/.env` into the test
    # process (e.g. a real WIKI_GIT_REMOTE or API key) and silently break the
    # "no remote / keyword fallback" assumptions these tests rely on.
    # `load_dotenv(override=False)` skips keys already present, so we pin the
    # sensitive ones to empty *values* (not pop — pop just lets dotenv re-add
    # them). Persistence tests still override WIKI_GIT_REMOTE per-case via
    # monkeypatch.setenv, which takes precedence and auto-reverts.
    for _leaky in (
        "WIKI_GIT_REMOTE",
        "WIKI_GIT_BRANCH",
        "WIKI_GIT_AUTOSYNC",
        "WIKI_GIT_USER_NAME",
        "WIKI_GIT_USER_EMAIL",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
    ):
        os.environ[_leaky] = ""

    # Force `app.config` to import now, so its module-level ``load_dotenv()``
    # runs exactly once while the hermetic env above is in place. Otherwise a
    # test that ``monkeypatch.delenv("WIKI_GIT_REMOTE")`` *before* the first
    # config import would open a gap for ``load_dotenv`` to re-inject the
    # developer's real backend/.env value (a real remote/key), which made
    # the persistence tests pass only in the full-suite ordering. Importing
    # here pins it deterministically for any subset/single-file run.
    import app.config  # noqa: F401


def pytest_unconfigure(config: pytest.Config) -> None:
    """Clean up the tmp dir after the session."""
    try:
        shutil.rmtree(SESSION_TMP, ignore_errors=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def wiki_root() -> Path:
    return SESSION_TMP


@pytest.fixture(scope="session")
def owner_token() -> str:
    return OWNER_TOKEN


@pytest.fixture()
def client():
    """Fresh TestClient. Triggers app startup events so persistence hooks
    fire (they no-op without WIKI_GIT_REMOTE in this environment)."""
    from fastapi.testclient import TestClient

    from app.main import app, index

    # Re-read the wiki off disk in case a previous test mutated it.
    index.reload()
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def owner_headers(owner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {owner_token}"}


@pytest.fixture(autouse=True)
def _reset_share_tokens(wiki_root: Path):
    """Each test starts with a clean share-token store + stats sidecar."""
    store = wiki_root / ".share-tokens.json"
    stats = wiki_root / ".share-token-stats.json"
    for path in (store, stats):
        if path.exists():
            path.unlink()
    yield
    for path in (store, stats):
        if path.exists():
            path.unlink()


@pytest.fixture(autouse=True)
def _reset_page_access(wiki_root: Path):
    """Each test starts with a clean page-access sidecar."""
    path = wiki_root / ".page-access.json"
    tmp = wiki_root / ".page-access.json.tmp"
    for candidate in (path, tmp):
        if candidate.exists():
            candidate.unlink()
    yield
    for candidate in (path, tmp):
        if candidate.exists():
            candidate.unlink()
