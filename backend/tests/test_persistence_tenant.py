"""Per-tenant persistence regression tests.

These pin two bugs that bit a real user in the wild:

1. ``tenant.json`` (which carries the user's live OAuth token) ended up
   getting pushed to the user's GitHub repo because the cloned-repo
   bootstrap path skipped writing the tenant ``.gitignore`` whenever
   the cloned repo already had one — which is true for any repo with
   a non-trivial template. The fix is the new ``_ensure_tenant_gitignore``
   helper, exercised below against a remote that ships with a non-empty
   ``.gitignore`` template (the realistic scenario).

2. The owner-console "Sync now (push)" button gave up immediately when
   git push was rejected non-fast-forward, leaving the user a binary
   choice between "fail" and "force-reset (discard local)". The fix
   is the auto-rebase retry inside ``_do_tenant_flush``: when the
   remote can be cleanly fast-forwarded over our local commit, we
   rebase + retry the push without prompting; real conflicts still
   bubble up.

Both tests run entirely against on-disk bare repos — no network.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Iterable

import pytest


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _rmtree_best_effort(path: Path) -> None:
    """Best-effort delete for ephemeral git workdirs.

    On Windows, git can briefly hold locks on ``.git/objects`` after a
    push, so ``shutil.rmtree`` races and raises PermissionError. Tests
    only need the bare remote afterwards; leaving a seed clone under
    ``tmp_path`` is fine — pytest cleans the session dir later.
    """
    try:
        shutil.rmtree(path)
    except OSError:
        pass


def _git(args: Iterable[str], cwd: Path) -> str:
    """Run git and return stdout; raise on nonzero exit."""
    out = subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    )
    return out.stdout


def _init_bare(path: Path) -> None:
    _git(["init", "--bare", "--initial-branch=main", str(path)], cwd=path.parent)


def _seed_remote(bare: Path, tmp: Path, gitignore_body: str = "") -> None:
    """Push an initial commit to the bare repo.

    Optionally write a ``.gitignore`` so we can simulate the realistic
    case where the user picked an existing repo (with a Python or Node
    gitignore template) as their wiki backing.
    """
    work = tmp / "_seed_work"
    _git(["clone", str(bare), str(work)], cwd=tmp)
    _git(["config", "user.email", "seed@test.local"], cwd=work)
    _git(["config", "user.name", "seed"], cwd=work)
    (work / "README.md").write_text("seed\n", encoding="utf-8")
    if gitignore_body:
        (work / ".gitignore").write_text(gitignore_body, encoding="utf-8")
    _git(["add", "-A"], cwd=work)
    _git(["commit", "-m", "seed"], cwd=work)
    _git(["push", "origin", "main"], cwd=work)
    _rmtree_best_effort(work)


def _make_tenant(tenant_id: str, wiki_root: Path, bare_remote: Path):
    """Construct a fake Tenant whose remote points at a local bare repo.

    We bypass the real OAuth-token flow by setting ``gh_token`` to a
    sentinel; ``_tenant_remote_url`` would normally build an
    ``https://x-access-token:...@github.com/...`` URL, but we override
    that to use the bare path by monkeypatching at the call site.
    """
    from app.tenants import Tenant

    return Tenant(
        id=tenant_id,
        wiki_root=wiki_root,
        display_name=tenant_id,
        gh_login=tenant_id,
        gh_user_id=1,
        gh_token="fake-token-not-used",
        gh_repo="owner/repo",
        gh_default_branch="main",
    )


def _patch_remote_url(monkeypatch, bare_remote: Path) -> None:
    """Force ``_tenant_remote_url`` to return the local bare-repo path
    instead of a github.com URL with our fake token."""
    from app import persistence as _persistence

    monkeypatch.setattr(
        _persistence,
        "_tenant_remote_url",
        lambda tenant: str(bare_remote),
    )


# ---------------------------------------------------------------------------
# 1. tenant.json never leaks even when the cloned repo has its own gitignore
# ---------------------------------------------------------------------------


def test_clone_into_repo_with_existing_gitignore_appends_tenant_rule(
    tmp_path: Path, monkeypatch
):
    """Regression for the public-token-leak bug.

    Setup: the user's chosen wiki backing repo already has a
    ``.gitignore`` (the realistic case — every non-empty repo does).
    The OLD code path saw ``gi.exists()`` was True and skipped writing
    the tenant rule, leaving ``tenant.json`` un-ignored. The first
    push then committed the live OAuth token to the user's public repo.

    This test pins the fix: ``_ensure_tenant_gitignore`` MUST append
    ``tenant.json`` even when other gitignore content is already there.
    """
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    # Simulate a Python project gitignore template the user might have
    # selected when creating the repo on github.com.
    _seed_remote(
        bare,
        tmp_path,
        gitignore_body="__pycache__/\n*.pyc\n.venv/\n.env\n",
    )

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)

    result = _persistence.bootstrap_tenant(tenant)
    assert result["ok"] is True, result

    gi_text = (wiki_root / ".gitignore").read_text(encoding="utf-8")
    # Pre-existing content preserved...
    assert "__pycache__/" in gi_text
    assert "*.pyc" in gi_text
    # ...AND the load-bearing tenant.json rule was appended.
    assert any(
        line.strip() == "tenant.json" for line in gi_text.splitlines()
    ), f"tenant.json must be gitignored after bootstrap; got:\n{gi_text}"
    assert any(
        line.strip() == ".share-token-stats.json" for line in gi_text.splitlines()
    ), f"share-token stats must be gitignored after bootstrap; got:\n{gi_text}"


def test_clone_already_has_tenant_json_rule_no_duplicate_append(
    tmp_path: Path, monkeypatch
):
    """Idempotency: re-bootstrapping a tenant whose remote already has
    the ``tenant.json`` rule must not duplicate it. Without this guard
    the gitignore would grow by a few lines on every restart, which
    isn't catastrophic but pollutes commits."""
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    _seed_remote(
        bare,
        tmp_path,
        gitignore_body="tenant.json\n*.pyc\n",
    )

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    gi_text = (wiki_root / ".gitignore").read_text(encoding="utf-8")
    # The rule appears exactly once.
    matches = [
        line for line in gi_text.splitlines() if line.strip() == "tenant.json"
    ]
    assert len(matches) == 1, (
        f"tenant.json rule should appear exactly once, found {len(matches)} "
        f"in:\n{gi_text}"
    )
    stats_matches = [
        line
        for line in gi_text.splitlines()
        if line.strip() == ".share-token-stats.json"
    ]
    assert len(stats_matches) == 1, (
        "share-token stats rule should appear exactly once, "
        f"found {len(stats_matches)} in:\n{gi_text}"
    )


def test_already_committed_tenant_json_gets_untracked_on_bootstrap(
    tmp_path: Path, monkeypatch
):
    """Recovery: when a tenant has already leaked tenant.json into a
    prior commit (the exact failure mode that bit professorpalmer in
    the wild), the next bootstrap should ``git rm --cached`` it so the
    next push removes it from the repo HEAD. The on-disk file is kept
    because the runtime still needs to read it."""
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    # Seed the remote WITH a tenant.json already committed — simulating
    # the leak having already happened.
    work = tmp_path / "_seed_with_leak"
    _git(["clone", str(bare), str(work)], cwd=tmp_path)
    _git(["config", "user.email", "seed@test.local"], cwd=work)
    _git(["config", "user.name", "seed"], cwd=work)
    (work / "README.md").write_text("seed\n", encoding="utf-8")
    (work / "tenant.json").write_text('{"gh_token":"leaked"}\n', encoding="utf-8")
    _git(["add", "-A"], cwd=work)
    _git(["commit", "-m", "leak"], cwd=work)
    _git(["push", "origin", "main"], cwd=work)
    _rmtree_best_effort(work)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    # File still exists on disk so the runtime can read it.
    assert (wiki_root / "tenant.json").exists()
    # But it's no longer tracked — git ls-files won't list it.
    tracked = _git(["ls-files"], cwd=wiki_root).split()
    assert "tenant.json" not in tracked, (
        f"tenant.json should be untracked after bootstrap; tracked files: "
        f"{tracked}"
    )


# ---------------------------------------------------------------------------
# 2. auto-rebase saves a non-FF push from a force-reset / data-loss outcome
# ---------------------------------------------------------------------------


def _commit_local_change(root: Path, filename: str, body: str) -> None:
    """Write + commit a local change in the tenant's working tree."""
    (root / filename).write_text(body, encoding="utf-8")
    _git(["add", "-A"], cwd=root)
    _git(["commit", "-m", f"local: {filename}"], cwd=root)


def _commit_remote_change(
    bare: Path, tmp: Path, filename: str, body: str
) -> None:
    """Simulate a second-device / web-edit push to the remote that
    happens between our last fetch and our next push."""
    # Use a slash-free workdir name so nested filenames like
    # ``wiki/conflict.md`` don't accidentally make the workdir itself
    # nested ("workdir-named-after-the-file-with-a-slash-in-it").
    safe_label = filename.replace("/", "__")
    work = tmp / f"_other_device_{safe_label}"
    _git(["clone", str(bare), str(work)], cwd=tmp)
    _git(["config", "user.email", "other@test.local"], cwd=work)
    _git(["config", "user.name", "other"], cwd=work)
    target = work / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")
    _git(["add", "-A"], cwd=work)
    _git(["commit", "-m", f"remote: {filename}"], cwd=work)
    _git(["push", "origin", "main"], cwd=work)
    _rmtree_best_effort(work)


def test_flush_auto_rebases_when_push_is_non_fast_forward(
    tmp_path: Path, monkeypatch
):
    """Regression for the data-loss UX bug.

    Setup: the local tenant has a pending commit; before we get to
    push, someone else (or another instance of the same server)
    pushes an unrelated commit to the same branch. ``git push`` fails:

      ! [rejected] main -> main (fetch first)
      error: failed to push some refs

    Before the fix this dead-ended in the UI. The only adjacent button
    was "force-reset to origin/main" which silently discards every
    local commit since the last successful push — a real user lost
    their wiki content this way.

    After the fix: we detect non-FF, fetch + rebase onto the remote
    (clean because the two changes don't touch the same files), and
    retry the push. The user never sees the rejection.
    """
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    _seed_remote(bare, tmp_path)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    # Local edit (will become the pending commit on push attempt).
    (wiki_root / "wiki").mkdir(exist_ok=True)
    (wiki_root / "wiki" / "local-page.md").write_text(
        "# Local page\n\nLocal-only content.\n", encoding="utf-8"
    )

    # Remote edit on a DIFFERENT file (no conflict on rebase).
    _commit_remote_change(
        bare, tmp_path, "remote-page.md", "# Remote\n\nOther device.\n"
    )

    # Flush — this would have failed without the auto-rebase.
    result = _persistence.flush_tenant_now(tenant, "test local write")
    assert result.get("error") is None, result
    assert result.get("pushed") is True, result
    assert result.get("auto_rebased") is True, (
        f"flush should auto-rebase on non-FF; got: {result}"
    )

    # Both files end up in the remote ref — local survived.
    log = _git(["log", "--oneline", "--all"], cwd=wiki_root)
    assert "test local write" in log, log
    assert "remote: remote-page.md" in log, log
    # And the local file we wrote is still on disk under the new HEAD.
    assert (wiki_root / "wiki" / "local-page.md").exists()


def test_flush_aborts_rebase_on_real_conflict(tmp_path: Path, monkeypatch):
    """When the auto-rebase has an actual content conflict (both sides
    touched the same lines), we MUST abort the rebase and surface the
    original push rejection. Silently picking one side would be worse
    than the force-reset UX it replaced.

    Verifies that:
      1. The flush returns error (not pushed).
      2. The auto_rebase_error field explains what went wrong.
      3. The tenant repo is left in a clean state (no half-rebased
         working tree that would block subsequent operations).
    """
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    _seed_remote(bare, tmp_path)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    # Both sides edit the SAME file with conflicting content.
    (wiki_root / "wiki").mkdir(exist_ok=True)
    (wiki_root / "wiki" / "conflict.md").write_text(
        "# Conflict\n\nLocal version.\n", encoding="utf-8"
    )

    _commit_remote_change(
        bare, tmp_path, "wiki/conflict.md", "# Conflict\n\nRemote version.\n"
    )

    result = _persistence.flush_tenant_now(tenant, "trigger conflict")
    assert result.get("pushed") is not True, result
    assert result.get("error"), f"expected error field, got: {result}"
    assert "auto_rebase_error" in result, (
        f"expected auto_rebase_error for conflict diagnosis; got: {result}"
    )

    # Rebase aborted cleanly — no .git/rebase-merge dir lingering.
    assert not (wiki_root / ".git" / "rebase-merge").exists()
    assert not (wiki_root / ".git" / "rebase-apply").exists()


# ---------------------------------------------------------------------------
# 3. smart pull — untracked cruft never blocks a mirror's fast-forward,
#    but tracked-modified edits still do (real on-disk git, no stubs)
# ---------------------------------------------------------------------------


def test_pull_untracked_cruft_fast_forwards(tmp_path: Path, monkeypatch):
    """The headline fix. A hosted mirror that's behind GitHub but has a
    stray UNTRACKED file in its working tree must fast-forward cleanly —
    not dead-end on the old ``dirty`` refusal that only the scary force
    button could escape. The untracked cruft has nothing to protect.
    """
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    _seed_remote(bare, tmp_path)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    # Remote moves ahead by one commit (a web edit / another device).
    _commit_remote_change(
        bare, tmp_path, "remote-page.md", "# Remote\n\nNew content.\n"
    )
    # Leave a stray untracked file in the local working tree.
    (wiki_root / "cruft.tmp").write_text("editor swap file\n", encoding="utf-8")

    result = _persistence.pull_tenant_now(tenant)
    assert result.get("ok") is True, result
    assert result.get("action") == "pulled", result
    assert result.get("behind") == 1, result
    # The remote commit actually landed locally.
    assert (wiki_root / "remote-page.md").exists()


def test_pull_tracked_modified_blocks_without_force(tmp_path: Path, monkeypatch):
    """Smart pull still guards REAL authored edits: a tracked file with
    uncommitted changes blocks the fast-forward (action ``dirty``), so a
    FF checkout can't silently clobber the user's work. Force is the
    explicit escape hatch."""
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    _seed_remote(bare, tmp_path)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    _commit_remote_change(
        bare, tmp_path, "remote-page.md", "# Remote\n\nNew content.\n"
    )
    # Modify a TRACKED file (README.md was seeded + committed) without
    # committing — a real in-progress edit.
    (wiki_root / "README.md").write_text("seed\n\nlocal WIP edit\n", encoding="utf-8")

    result = _persistence.pull_tenant_now(tenant)
    assert result.get("ok") is False, result
    assert result.get("action") == "dirty", result
    assert result.get("tracked_modified"), result
    # We did not move HEAD — the remote commit is NOT applied yet.
    assert not (wiki_root / "remote-page.md").exists()


def test_pull_share_tokens_hits_only_dirt_fast_forwards(
    tmp_path: Path, monkeypatch
):
    """Hits-only dirt on ``.share-tokens.json`` must not block smart-pull.

    Regression for the Force-reset modal that fired on every sync when
    ``resolve()`` had rewritten hit counters into the tracked identity
    file while the tenant was behind GitHub. Bookkeeping dirt is
    discarded and the fast-forward proceeds; real WIP (see
    ``test_pull_tracked_modified_blocks_without_force``) still blocks.
    """
    import json

    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)

    # Seed remote WITH a tracked .share-tokens.json (the durable mint
    # path) so local hit bumps show up as tracked modifications.
    token_record = {
        "id": "abcd1234efgh",
        "token_hash": "a" * 64,
        "label": "Recruiter",
        "tier": "recruiter",
        "created_at": "2026-05-23T22:00:00+00:00",
        "expires_at": None,
        "revoked_at": None,
        "hits": 0,
        "last_used_at": None,
    }
    work = tmp_path / "_seed_share"
    _git(["clone", str(bare), str(work)], cwd=tmp_path)
    _git(["config", "user.email", "seed@test.local"], cwd=work)
    _git(["config", "user.name", "seed"], cwd=work)
    (work / "README.md").write_text("seed\n", encoding="utf-8")
    (work / ".share-tokens.json").write_text(
        json.dumps({"tokens": [token_record]}, indent=2),
        encoding="utf-8",
    )
    _git(["add", "-A"], cwd=work)
    _git(["commit", "-m", "seed with share tokens"], cwd=work)
    _git(["push", "origin", "main"], cwd=work)
    _rmtree_best_effort(work)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    _commit_remote_change(
        bare, tmp_path, "remote-page.md", "# Remote\n\nNew content.\n"
    )

    # Simulate the old resolve() bookkeeping rewrite: same identity,
    # bumped hits / last_used_at only.
    dirty = dict(token_record)
    dirty["hits"] = 7
    dirty["last_used_at"] = "2026-07-12T08:00:00+00:00"
    (wiki_root / ".share-tokens.json").write_text(
        json.dumps({"tokens": [dirty]}, indent=2),
        encoding="utf-8",
    )

    result = _persistence.pull_tenant_now(tenant)
    assert result.get("ok") is True, result
    assert result.get("action") == "pulled", result
    assert result.get("discarded_share_token_hits") is True, result
    assert (wiki_root / "remote-page.md").exists()


def test_pull_share_token_stats_sidecar_fast_forwards(
    tmp_path: Path, monkeypatch
):
    """Tracked ``.share-token-stats.json`` with newer local counters must not block smart-pull.

    Regression for hosted mirrors where a legacy tracked stats sidecar left
    permanent ``[M]`` dirt while the tenant was behind GitHub. Classification
    must treat it as disposable bookkeeping, the pull must fast-forward without
    force, local hit counters must survive, and no staged index change may
    remain for the sidecar path.
    """
    import json

    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)

    token_id = "abcd1234efgh"
    stats_head = {
        token_id: {"hits": 1, "last_used_at": "2026-05-23T22:00:00+00:00"}
    }
    work = tmp_path / "_seed_stats"
    _git(["clone", str(bare), str(work)], cwd=tmp_path)
    _git(["config", "user.email", "seed@test.local"], cwd=work)
    _git(["config", "user.name", "seed"], cwd=work)
    (work / "README.md").write_text("seed\n", encoding="utf-8")
    (work / ".share-token-stats.json").write_text(
        json.dumps(stats_head, indent=2),
        encoding="utf-8",
    )
    _git(["add", "-A"], cwd=work)
    _git(["commit", "-m", "seed with tracked stats sidecar"], cwd=work)
    _git(["push", "origin", "main"], cwd=work)
    _rmtree_best_effort(work)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    _commit_remote_change(
        bare, tmp_path, "remote-page.md", "# Remote\n\nNew content.\n"
    )

    stats_local = {
        token_id: {"hits": 42, "last_used_at": "2026-07-12T08:00:00+00:00"}
    }
    stats_path = wiki_root / ".share-token-stats.json"
    stats_path.write_text(json.dumps(stats_local, indent=2), encoding="utf-8")

    classification = _persistence.classify_pull_safety(tenant)
    assert classification.get("ok") is True, classification
    assert classification.get("auto_ff") is True, classification
    assert classification.get("tracked_modified") == [], classification

    result = _persistence.pull_tenant_now(tenant)
    assert result.get("ok") is True, result
    assert result.get("action") == "pulled", result
    assert result.get("discarded_share_token_hits") is True, result
    assert (wiki_root / "remote-page.md").exists()

    saved = json.loads(stats_path.read_text(encoding="utf-8"))
    assert saved[token_id]["hits"] == 42
    assert saved[token_id]["last_used_at"] == "2026-07-12T08:00:00+00:00"

    rc, porcelain = _persistence._run_git(["status", "--porcelain"], cwd=wiki_root)
    assert rc == 0
    assert ".share-token-stats.json" not in porcelain
    rc_cached, cached_diff = _persistence._run_git(
        ["diff", "--cached", "--", ".share-token-stats.json"], cwd=wiki_root
    )
    assert rc_cached == 0
    assert not cached_diff.strip()


def test_pull_share_tokens_substantive_mint_still_blocks(
    tmp_path: Path, monkeypatch
):
    """A real uncommitted mint (new token id) must still return dirty."""
    import json

    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)

    token_record = {
        "id": "abcd1234efgh",
        "token_hash": "a" * 64,
        "label": "Recruiter",
        "tier": "recruiter",
        "created_at": "2026-05-23T22:00:00+00:00",
        "expires_at": None,
        "revoked_at": None,
    }
    work = tmp_path / "_seed_share2"
    _git(["clone", str(bare), str(work)], cwd=tmp_path)
    _git(["config", "user.email", "seed@test.local"], cwd=work)
    _git(["config", "user.name", "seed"], cwd=work)
    (work / "README.md").write_text("seed\n", encoding="utf-8")
    (work / ".share-tokens.json").write_text(
        json.dumps({"tokens": [token_record]}, indent=2),
        encoding="utf-8",
    )
    _git(["add", "-A"], cwd=work)
    _git(["commit", "-m", "seed with share tokens"], cwd=work)
    _git(["push", "origin", "main"], cwd=work)
    _rmtree_best_effort(work)

    from app import persistence as _persistence

    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-prof"
    tenant = _make_tenant("prof", wiki_root, bare)
    _persistence.bootstrap_tenant(tenant)

    _commit_remote_change(
        bare, tmp_path, "remote-page.md", "# Remote\n\nNew content.\n"
    )

    # Uncommitted mint: add a second token — identity changed.
    minted = dict(token_record)
    new_token = {
        "id": "newtoken0001",
        "token_hash": "b" * 64,
        "label": "Friend",
        "tier": "friend",
        "created_at": "2026-07-12T08:00:00+00:00",
        "expires_at": None,
        "revoked_at": None,
    }
    (wiki_root / ".share-tokens.json").write_text(
        json.dumps({"tokens": [minted, new_token]}, indent=2),
        encoding="utf-8",
    )

    result = _persistence.pull_tenant_now(tenant)
    assert result.get("ok") is False, result
    assert result.get("action") == "dirty", result
    assert not (wiki_root / "remote-page.md").exists()


def test_bootstrap_tenant_clone_is_shallow(tmp_path: Path, monkeypatch):
    """connect-repo must shallow-clone onto the tenant volume."""
    bare = tmp_path / "remote.git"
    bare.mkdir()
    _init_bare(bare)
    _seed_remote(bare, tmp_path)

    from app import persistence as _persistence

    recorded = []
    real_run = _persistence._run_git

    def _capture(args, **kwargs):
        recorded.append(list(args))
        return real_run(args, **kwargs)

    monkeypatch.setattr(_persistence, "_run_git", _capture)
    _patch_remote_url(monkeypatch, bare)
    wiki_root = tmp_path / "tenant-shallow"
    tenant = _make_tenant("shallow", wiki_root, bare)

    result = _persistence.bootstrap_tenant(tenant)
    assert result["ok"] is True, result
    clones = [args for args in recorded if args and args[0] == "clone"]
    assert clones, recorded
    assert clones[0][:3] == ["clone", "--depth", "1"]
