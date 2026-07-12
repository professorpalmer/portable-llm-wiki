"""Git-backed persistence for the wiki.

The hosted demo runs on Render's free tier, which uses an ephemeral
filesystem — any writes (ingest, capture, page edits, import drafts) are
lost the moment the container restarts. That kills the "I made a note on
my phone, now I can ask my wiki about it tomorrow" loop.

This module wires git into the lifecycle so:

  1. On container boot, if WIKI_GIT_REMOTE is set we clone it into
     WIKI_ROOT (or pull-fast-forward if the directory is already a clone).
  2. After any mutation (ingest, capture, page write, lint-draft, import),
     callers invoke `flush_async(message)` which schedules a coalesced
     git add / commit / push on a background thread.
  3. The debounce window (default 8s) lets bursts of writes — like an
     orchestrator job that touches 12 files — coalesce into one push.

Configuration (all env vars):
  WIKI_GIT_REMOTE       — full clone URL with credentials, e.g.
                          https://USER:PAT@github.com/USER/wiki.git
                          If unset, persistence is a no-op (legacy mode).
  WIKI_GIT_BRANCH       — branch to track. Default: main.
  WIKI_GIT_USER_NAME    — author name for commits. Default: Portable LLM Wiki.
  WIKI_GIT_USER_EMAIL   — author email for commits. Default: bot@portable-llm-wiki.
  WIKI_GIT_PUSH_DELAY_S — debounce window in seconds. Default: 8.
  WIKI_GIT_AUTOSYNC     — "1"/"true" to enable. Default: "1" if remote is set.

Security note: WIKI_GIT_REMOTE contains a Personal Access Token. Treat the
Render env-var panel like a secret store. Don't echo this URL into logs.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from .config import settings

if TYPE_CHECKING:
    from .tenants import Tenant


# ---------------------------------------------------------------------------
# Configuration (read once at import time)
# ---------------------------------------------------------------------------


def _env_truthy(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


GIT_REMOTE: str = os.environ.get("WIKI_GIT_REMOTE", "").strip()
GIT_BRANCH: str = os.environ.get("WIKI_GIT_BRANCH", "main").strip() or "main"
GIT_USER_NAME: str = os.environ.get("WIKI_GIT_USER_NAME", "Portable LLM Wiki").strip() or "Portable LLM Wiki"
GIT_USER_EMAIL: str = (
    os.environ.get("WIKI_GIT_USER_EMAIL", "bot@portable-llm-wiki").strip()
    or "bot@portable-llm-wiki"
)
PUSH_DELAY_S: float = float(os.environ.get("WIKI_GIT_PUSH_DELAY_S", "8") or "8")
AUTOSYNC_ENABLED: bool = _env_truthy("WIKI_GIT_AUTOSYNC", bool(GIT_REMOTE))
# Per-tenant autopush (hosted multi-tenant mode). Distinct from the
# single-tenant global AUTOSYNC_ENABLED above: a CONNECTED tenant repo is
# the user's durability guarantee, so hosted edits must auto-push to it by
# default — independent of whether a *global* WIKI_GIT_REMOTE is set (it
# isn't in hosted mode, which is exactly why gating tenant pushes on
# AUTOSYNC_ENABLED silently disabled them and left edits "saved on the
# server" but never durable). Default ON; set WIKI_TENANT_AUTOPUSH=0 to
# turn every tenant into manual-sync-only.
TENANT_AUTOPUSH_ENABLED: bool = _env_truthy("WIKI_TENANT_AUTOPUSH", True)
# How often the hosted background poller fast-forwards each connected
# tenant from GitHub, in seconds. This is the drift killer: without it,
# a hosted mirror only reconciles on owner login. 0 disables the poller.
# Default 300s (5 min) — cheap on Render's single service + persistent disk.
TENANT_PULL_POLL_S: float = float(
    os.environ.get("WIKI_TENANT_PULL_POLL_S", "300") or "300"
)


# ---------------------------------------------------------------------------
# Internal state
# ---------------------------------------------------------------------------


@dataclass
class _State:
    last_flush_attempt: Optional[float] = None
    last_flush_ok: Optional[float] = None
    last_error: Optional[str] = None
    commits_made: int = 0
    pushes_made: int = 0
    pending_messages: list[str] = field(default_factory=list)
    timer: Optional[threading.Timer] = None
    lock: threading.RLock = field(default_factory=threading.RLock)


_state = _State()


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------


def _run_git(args: list[str], cwd: Optional[Path] = None, timeout: int = 60) -> tuple[int, str]:
    """Run a git command, return (returncode, combined-output).

    Never raises — git failures are caught and surfaced as state. Persistence
    must NEVER prevent the main request from succeeding.
    """
    where = cwd or settings.wiki_root
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(where),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={
                **os.environ,
                "GIT_TERMINAL_PROMPT": "0",  # never block on credential prompt
                "GIT_ASKPASS": "true",  # treat as failure if creds are missing
            },
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode, out.strip()
    except subprocess.TimeoutExpired:
        return 124, "git command timed out"
    except FileNotFoundError:
        return 127, "git binary not found in PATH"
    except Exception as exc:  # noqa: BLE001
        return 1, f"git exec failed: {exc}"


def _is_git_repo(path: Path) -> bool:
    return (path / ".git").exists()


def _redact_remote(url: str) -> str:
    """Hide credentials in a git URL for logging."""
    if "@" not in url or "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    if "@" not in rest:
        return url
    creds, host = rest.split("@", 1)
    if ":" in creds:
        user, _ = creds.split(":", 1)
        return f"{scheme}://{user}:****@{host}"
    return f"{scheme}://****@{host}"


# ---------------------------------------------------------------------------
# Boot-time clone / pull
# ---------------------------------------------------------------------------


def bootstrap_on_startup() -> dict:
    """Called once when the FastAPI app boots.

    If WIKI_GIT_REMOTE is configured:
      * If WIKI_ROOT exists and isn't a git repo: archive it to
        WIKI_ROOT.preexisting and clone the remote in its place.
      * If WIKI_ROOT is a git repo: fetch + hard-reset to origin/<branch>.
      * If WIKI_ROOT doesn't exist: clone the remote into it.

    If WIKI_GIT_REMOTE is not configured, this is a no-op. The container
    keeps using whatever is in WIKI_ROOT (typically the baked-in demo wiki).
    """
    if not GIT_REMOTE:
        return {"enabled": False, "reason": "WIKI_GIT_REMOTE not set"}

    root = settings.wiki_root
    redacted = _redact_remote(GIT_REMOTE)
    result: dict = {"enabled": True, "remote": redacted, "branch": GIT_BRANCH}

    # Configure git user identity globally for this process — commits we
    # make on behalf of the owner need an author.
    _run_git(["config", "--global", "user.name", GIT_USER_NAME], cwd=Path("/tmp"))
    _run_git(["config", "--global", "user.email", GIT_USER_EMAIL], cwd=Path("/tmp"))
    _run_git(["config", "--global", "init.defaultBranch", GIT_BRANCH], cwd=Path("/tmp"))
    # Trust the wiki dir even if owned by a different uid (Render runs as a
    # non-root user but mounts may shift this around).
    _run_git(
        ["config", "--global", "--add", "safe.directory", str(root)],
        cwd=Path("/tmp"),
    )

    if root.exists() and not _is_git_repo(root):
        # Existing baked-in content (e.g. wiki-demo). Stash it so we can
        # clone over the top. We never delete user data; we move it aside.
        stash = root.parent / f"{root.name}.preexisting"
        if stash.exists():
            shutil.rmtree(stash, ignore_errors=True)
        root.rename(stash)
        result["preexisting_moved_to"] = str(stash)

    if not root.exists():
        rc, out = _run_git(
            ["clone", "--branch", GIT_BRANCH, "--depth", "1", GIT_REMOTE, str(root)],
            cwd=Path("/tmp"),
            timeout=120,
        )
        if rc == 0:
            result["action"] = "cloned"
        else:
            result["action"] = "clone_failed"
            result["error"] = out
            return result
    else:
        # Existing clone — fetch and reset to remote head so we get the
        # latest content even after redeploys.
        rc, out = _run_git(["fetch", "origin", GIT_BRANCH], timeout=60)
        if rc != 0:
            result["action"] = "fetch_failed"
            result["error"] = out
            return result
        rc, out = _run_git(["reset", "--hard", f"origin/{GIT_BRANCH}"])
        if rc != 0:
            result["action"] = "reset_failed"
            result["error"] = out
            return result
        result["action"] = "synced"

    # Make sure local user identity is set inside the repo too (for older
    # gits that don't pick up --global in container envs).
    _run_git(["config", "user.name", GIT_USER_NAME])
    _run_git(["config", "user.email", GIT_USER_EMAIL])
    return result


# ---------------------------------------------------------------------------
# Debounced flush — the public API mutation handlers call
# ---------------------------------------------------------------------------


def flush_async(message: str) -> None:
    """Schedule a coalesced commit + push.

    Multiple calls within PUSH_DELAY_S coalesce into one git commit whose
    message is the joined list of reasons. Safe to call from any thread.

    Dispatches in two ways depending on deployment mode:
      * Single-tenant (OSS): pushes to the global ``WIKI_GIT_REMOTE`` env
        var if configured. Same behavior since v0.
      * Multi-tenant (hosted): if a tenant is bound to the current request
        contextvar AND has a connected gh_repo, dispatches a per-tenant
        flush to push only that tenant's repo. Tenants without a connected
        repo silently no-op (they're not yet "portable").

    The two paths are not mutually exclusive — an OSS install with a
    global remote will use the global flush; a hosted install routes to
    per-tenant flushes. This means callers (capture, page write, ingest)
    never have to know which mode they're in.
    """
    # OSS / single-tenant: use the global remote if configured.
    if AUTOSYNC_ENABLED and GIT_REMOTE:
        with _state.lock:
            if message:
                _state.pending_messages.append(message)
            if _state.timer is None:
                _state.timer = threading.Timer(PUSH_DELAY_S, _do_flush)
                _state.timer.daemon = True
                _state.timer.start()
        return

    # Hosted / multi-tenant: dispatch to the bound tenant's repo if any.
    # We import here (not at top) to avoid a circular import: tenants.py
    # depends on settings, which is read at persistence module load time.
    try:
        from .tenants import current_tenant_or_none

        tenant = current_tenant_or_none()
    except Exception:  # noqa: BLE001
        tenant = None
    if tenant is None:
        return
    if not tenant.gh_repo or not tenant.gh_token:
        return  # not yet connected — silently no-op
    flush_tenant_async(tenant, message)


def flush_now(message: str = "") -> dict:
    """Synchronous commit + push. Returns a result dict.

    Bypasses the debounce — used by tests and the owner-console "force
    sync" button.
    """
    with _state.lock:
        if message:
            _state.pending_messages.append(message)
        if _state.timer is not None:
            _state.timer.cancel()
            _state.timer = None
    return _do_flush()


def _do_flush() -> dict:
    """Run the actual git add / commit / push. Holds the state lock for
    the duration so multiple debounced timers can't race."""
    with _state.lock:
        _state.timer = None
        _state.last_flush_attempt = time.time()
        messages = _state.pending_messages[:]
        _state.pending_messages = []

    result: dict = {"committed": False, "pushed": False, "messages": messages}
    if not GIT_REMOTE:
        result["skipped"] = "no remote configured"
        return result

    # Stage everything, including new and deleted files.
    rc, out = _run_git(["add", "-A"])
    if rc != 0:
        _record_error(f"git add failed: {out}")
        result["error"] = out
        return result

    # Are there any staged changes?
    rc_status, status_out = _run_git(["status", "--porcelain"])
    if rc_status == 0 and not status_out.strip():
        result["skipped"] = "no staged changes"
        return result

    summary = _compose_commit_message(messages)
    rc, out = _run_git(["commit", "-m", summary])
    if rc != 0:
        # If nothing to commit, git returns non-zero with a specific
        # message — treat that as success.
        if "nothing to commit" in out.lower():
            result["skipped"] = "nothing to commit"
            return result
        _record_error(f"git commit failed: {out}")
        result["error"] = out
        return result
    _state.commits_made += 1
    result["committed"] = True
    result["commit_summary"] = summary

    rc, out = _run_git(["push", "origin", GIT_BRANCH], timeout=60)
    if rc != 0:
        _record_error(f"git push failed: {out}")
        result["error"] = out
        return result
    _state.pushes_made += 1
    _state.last_flush_ok = time.time()
    _state.last_error = None
    result["pushed"] = True
    return result


def _record_error(msg: str) -> None:
    with _state.lock:
        _state.last_error = msg


def _compose_commit_message(messages: list[str]) -> str:
    if not messages:
        return "wiki: autosync"
    if len(messages) == 1:
        return f"wiki: {messages[0]}"
    head = f"wiki: {messages[0]}"
    body = "\n\nAlso:\n" + "\n".join(f"- {m}" for m in messages[1:])
    return head + body


# ---------------------------------------------------------------------------
# Inspection (used by owner-console UI + healthcheck)
# ---------------------------------------------------------------------------


def get_status() -> dict:
    """A read-only snapshot of the persistence layer's state for the
    owner console."""
    with _state.lock:
        return {
            "enabled": AUTOSYNC_ENABLED and bool(GIT_REMOTE),
            "remote": _redact_remote(GIT_REMOTE) if GIT_REMOTE else None,
            "branch": GIT_BRANCH,
            "push_delay_s": PUSH_DELAY_S,
            "user_name": GIT_USER_NAME,
            "user_email": GIT_USER_EMAIL,
            "commits_made": _state.commits_made,
            "pushes_made": _state.pushes_made,
            "last_flush_attempt": _state.last_flush_attempt,
            "last_flush_ok": _state.last_flush_ok,
            "last_error": _state.last_error,
            "pending_message_count": len(_state.pending_messages),
            "timer_scheduled": _state.timer is not None,
        }


def describe_sync() -> dict:
    """Caller-facing verdict on whether the CURRENT write context will sync.

    This is the antidote to the silent no-op trap: every mutation endpoint
    (ingest, capture, import, page write) embeds this in its response so a
    write that will never leave the box can never look like a durable
    success. The shape is intentionally small and human-readable — the MCP
    relays it verbatim, the owner console renders ``detail`` as a banner.

    Resolution order mirrors :func:`flush_async`:

      1. Global remote (OSS / single-tenant ``WIKI_GIT_REMOTE``) -> syncs.
      2. Bound tenant with a connected repo (hosted) -> syncs.
      3. Bound tenant without a repo -> does NOT sync (connect a repo).
      4. Single-tenant, no remote -> does NOT sync (set WIKI_GIT_REMOTE).
    """
    if AUTOSYNC_ENABLED and GIT_REMOTE:
        return {
            "will_sync": True,
            "mode": "global",
            "remote": _redact_remote(GIT_REMOTE),
            "branch": GIT_BRANCH,
            "detail": "Saved and auto-pushing to the configured git remote.",
        }

    try:
        from .tenants import current_tenant_or_none

        tenant = current_tenant_or_none()
    except Exception:  # noqa: BLE001
        tenant = None

    if tenant is not None:
        if tenant.gh_repo and tenant.gh_token:
            # Mirror flush_tenant_async, which no-ops when tenant autopush is
            # off or the tenant repo hasn't been cloned/bootstrapped yet —
            # either way the write won't actually reach the remote.
            if not TENANT_AUTOPUSH_ENABLED:
                return {
                    "will_sync": False,
                    "mode": "tenant",
                    "remote": tenant.gh_repo,
                    "branch": GIT_BRANCH,
                    "reason": "autopush_disabled",
                    "detail": (
                        "Saved on the server. Your GitHub repo "
                        f"({tenant.gh_repo}) is connected, but tenant autopush "
                        "is OFF (WIKI_TENANT_AUTOPUSH is disabled), so this "
                        "change won't reach GitHub until you trigger a manual "
                        "sync from the owner console."
                    ),
                }
            if not _is_git_repo(tenant.wiki_root):
                return {
                    "will_sync": False,
                    "mode": "tenant",
                    "remote": tenant.gh_repo,
                    "branch": GIT_BRANCH,
                    "reason": "not_bootstrapped",
                    "detail": (
                        "Saved on the server, but your connected repo isn't "
                        "initialized yet (clone/bootstrap is still pending), so "
                        "this change isn't durable yet. It will sync once the "
                        "repo finishes setting up."
                    ),
                }
            return {
                "will_sync": True,
                "mode": "tenant",
                "remote": tenant.gh_repo,
                "branch": GIT_BRANCH,
                "detail": "Saved and auto-pushing to your connected GitHub repo.",
            }
        return {
            "will_sync": False,
            "mode": "tenant",
            "remote": None,
            "reason": "no_repo_connected",
            "detail": (
                "Saved on the server, but this wiki isn't connected to a "
                "GitHub repo yet — changes are NOT durable and will be lost "
                "on restart. Connect a repo in the owner console to make "
                "your wiki portable."
            ),
        }

    # No tenant bound (single-tenant / OSS) and the global branch above didn't
    # take. Distinguish "no remote at all" from "remote set but autopush off",
    # since the remediation differs.
    if GIT_REMOTE and not AUTOSYNC_ENABLED:
        return {
            "will_sync": False,
            "mode": "local_only",
            "remote": None,
            "reason": "autosync_disabled",
            "detail": (
                "Saved to local disk only. A git remote is configured but "
                "autopush is OFF (WIKI_GIT_AUTOSYNC is disabled), so this will "
                "NOT reach the remote or any hosted site. Re-enable "
                "WIKI_GIT_AUTOSYNC to autopush."
            ),
        }
    return {
        "will_sync": False,
        "mode": "local_only",
        "remote": None,
        "reason": "no_remote_configured",
        "detail": (
            "Saved to local disk only. Git persistence is OFF "
            "(WIKI_GIT_REMOTE is unset), so this will NOT reach a remote or "
            "any hosted site. Set WIKI_GIT_REMOTE to enable autopush."
        ),
    }


# ===========================================================================
# Per-tenant persistence — hosted multi-tenant mode
# ===========================================================================
#
# In hosted mode each tenant has its own GitHub repo (`tenant.gh_repo`)
# authenticated by the tenant's own OAuth token (`tenant.gh_token`).
# Writes to a tenant's wiki_dir are pushed to THAT tenant's repo only.
#
# The functions below are parallel to the global persistence API above:
# OSS / single-tenant mode keeps using flush_async / get_status as before.
# Hosted-mode write paths call flush_tenant_async(tenant, message) instead.
#
# Why subprocess git instead of the Contents API?
#   * The OSS path already uses subprocess git and works well.
#   * Commit graph + history is preserved (the Contents API one-file-per-
#     commit pattern produces an ugly graph).
#   * The OAuth token is injected via the URL: x-access-token:<TOKEN>@github
#     — same pattern as the OSS WIKI_GIT_REMOTE env var.
# ---------------------------------------------------------------------------

# Per-tenant debounce state, keyed by tenant id. Each entry has its own
# timer, lock, and pending-message list. Acquire _tenant_states_lock only
# to swap entries in/out; per-tenant work uses each state's own lock.
_tenant_states: dict[str, _State] = {}
_tenant_states_lock = threading.RLock()

# What we write to tenant.wiki_root/.gitignore on first push so the OAuth
# token in tenant.json never lands in the user's repo.
_TENANT_GITIGNORE = """# Auto-generated by portable-llm-wiki.
# Never commit auth metadata — the OAuth token lives here.
tenant.json
"""


def _get_tenant_state(tenant_id: str) -> _State:
    with _tenant_states_lock:
        st = _tenant_states.get(tenant_id)
        if st is None:
            st = _State()
            _tenant_states[tenant_id] = st
        return st


def _tenant_remote_url(tenant: "Tenant") -> str:
    """Build the authenticated push URL for a tenant's repo.

    GitHub accepts ``https://x-access-token:<TOKEN>@github.com/<repo>.git``
    as basic-auth for both reads and writes. The token has the OAuth ``repo``
    scope granted at sign-in so this works for both public and private repos
    on the user's account.
    """
    if not tenant.gh_repo or not tenant.gh_token:
        return ""
    return f"https://x-access-token:{tenant.gh_token}@github.com/{tenant.gh_repo}.git"


def _ensure_tenant_git_identity(tenant: "Tenant") -> None:
    """Set the local git author identity inside the tenant's repo.

    We attribute commits to the user's GitHub identity so their repo shows
    the same author they'd see if they pushed manually. Falls back to the
    global bot identity if gh_login is somehow missing.
    """
    name = tenant.gh_login or GIT_USER_NAME
    # GitHub no-reply email format means the commit shows up linked to
    # their account without exposing their real email.
    email = (
        f"{tenant.gh_user_id}+{tenant.gh_login}@users.noreply.github.com"
        if tenant.gh_user_id and tenant.gh_login
        else GIT_USER_EMAIL
    )
    _run_git(["config", "user.name", name], cwd=tenant.wiki_root)
    _run_git(["config", "user.email", email], cwd=tenant.wiki_root)
    _run_git(
        ["config", "--add", "safe.directory", str(tenant.wiki_root)],
        cwd=Path("/tmp"),
    )


def bootstrap_tenant(tenant: "Tenant") -> dict:
    """Initialize the tenant's local repo from its GitHub remote.

    Called when a tenant connects a repo (first time) and on cold-start
    hydration (existing connection but empty local disk).

    Behavior:
      * If wiki_root is already a git repo with matching remote: fetch +
        fast-forward, no destructive ops.
      * If wiki_root exists but isn't a git repo (user has un-synced local
        content): move it aside to ``<wiki_root>.preexisting`` and clone.
        Always non-destructive — local content is preserved.
      * If clone returns an empty repo: initialize the working tree as a
        fresh git repo, write .gitignore, commit any existing wiki/raw
        content, push to seed the remote.
      * Returns a result dict suitable for surfacing in the connect-repo
        response or the owner-console sync panel.
    """
    if not tenant.gh_repo:
        return {"ok": False, "error": "tenant has no gh_repo configured"}
    if not tenant.gh_token:
        return {"ok": False, "error": "tenant has no gh_token (re-auth required)"}

    remote_url = _tenant_remote_url(tenant)
    redacted = _redact_remote(remote_url)
    branch = tenant.gh_default_branch or "main"
    root = tenant.wiki_root
    result: dict = {"ok": True, "remote": redacted, "branch": branch}

    # Case 1: Existing git repo at wiki_root. Verify the remote matches,
    # then fetch + fast-forward. No destructive ops.
    if _is_git_repo(root):
        _ensure_tenant_git_identity(tenant)
        # Set the remote URL (may have changed if token rotated).
        rc, _ = _run_git(["remote", "set-url", "origin", remote_url], cwd=root)
        if rc != 0:
            _run_git(["remote", "add", "origin", remote_url], cwd=root)
        rc, out = _run_git(["fetch", "origin", branch], cwd=root, timeout=60)
        if rc != 0:
            # Might be empty remote — that's fine, leave local as-is.
            result["action"] = "fetch_skipped"
            result["fetch_note"] = out[:200]
            return result
        rc, out = _run_git(["reset", "--hard", f"origin/{branch}"], cwd=root)
        if rc != 0:
            result["ok"] = False
            result["error"] = f"reset failed: {out}"
            return result
        result["action"] = "synced"
        return result

    # Case 2: wiki_root has content but isn't a git repo. Move it aside
    # for safety, then clone.
    preexisting: Optional[Path] = None
    if root.exists() and any(root.iterdir()):
        stash = root.parent / f"{root.name}.preexisting"
        if stash.exists():
            shutil.rmtree(stash, ignore_errors=True)
        root.rename(stash)
        preexisting = stash
        result["preexisting_moved_to"] = str(stash)

    # Try to clone. If the remote is empty, this returns 0 with a warning,
    # and we still end up with an initialized .git dir.
    rc, out = _run_git(
        ["clone", "--branch", branch, remote_url, str(root)],
        cwd=Path("/tmp"),
        timeout=120,
    )
    if rc != 0:
        # Common case: empty remote has no branches yet. Re-clone without
        # specifying a branch (lets git init the working tree from HEAD,
        # which on empty remotes just makes an empty .git).
        rc2, out2 = _run_git(
            ["clone", remote_url, str(root)],
            cwd=Path("/tmp"),
            timeout=120,
        )
        if rc2 != 0:
            # Restore preexisting content if clone failed entirely.
            if preexisting and not root.exists():
                preexisting.rename(root)
            result["ok"] = False
            result["error"] = f"clone failed: {out2 or out}"
            return result

    _ensure_tenant_git_identity(tenant)

    # If the local repo has no commits yet (empty remote), seed it from
    # the preexisting content (if any) and push.
    rc_head, _ = _run_git(["rev-parse", "HEAD"], cwd=root)
    if rc_head != 0:
        # Empty remote — initialize the working tree.
        result["action"] = "seeded_empty"
        # Ensure the wiki + raw dirs exist so the first commit isn't empty.
        (root / "wiki").mkdir(parents=True, exist_ok=True)
        (root / "raw").mkdir(parents=True, exist_ok=True)
        if preexisting:
            # Copy preexisting wiki+raw content back in.
            for sub in ("wiki", "raw"):
                src = preexisting / sub
                if src.exists():
                    shutil.copytree(src, root / sub, dirs_exist_ok=True)
        # Write .gitignore so tenant.json doesn't end up in the repo.
        # Use the ensure-and-append helper so we don't clobber any
        # gitignore content the user's empty repo template ships with
        # (GitHub's "Initialize this repo with a .gitignore" UI lets
        # users start with a Python/Node/etc. gitignore even on a
        # nominally empty repo).
        _ensure_tenant_gitignore(root)
        # Make sure we're on the right branch name.
        _run_git(["checkout", "-B", branch], cwd=root)
        rc, _ = _run_git(["add", "-A"], cwd=root)
        if rc == 0:
            _run_git(["commit", "-m", "wiki: initial commit"], cwd=root)
            rc, out = _run_git(
                ["push", "-u", "origin", branch], cwd=root, timeout=60
            )
            if rc != 0:
                result["ok"] = False
                result["error"] = f"initial push failed: {out}"
                return result
            _mark_tenant_synced(tenant)
    else:
        result["action"] = "cloned"
        # Make sure ``tenant.json`` is gitignored, no matter what other
        # gitignore content already exists in the cloned repo. The OLD
        # version of this code was:
        #
        #     if not gi.exists():
        #         gi.write_text(_TENANT_GITIGNORE, ...)
        #
        # which silently skipped when the cloned repo already had its
        # own ``.gitignore`` (which is true for every non-empty repo
        # any user might point at). In that case ``tenant.json`` was
        # NOT excluded and the first push committed a live ``gh_token``
        # to the user's repo — exactly the secret-leakage path the
        # tenant gitignore was supposed to prevent.
        #
        # The fix: ensure-and-append rather than write-if-missing. If
        # ``tenant.json`` already appears as its own line we leave the
        # file alone; otherwise we append the tenant rules so the
        # token can't slip through even when the cloned repo's own
        # gitignore is opinionated about formatting.
        _ensure_tenant_gitignore(root)
        # Defense in depth: if a *previous* run of this code path
        # already committed ``tenant.json`` (the only way the secret
        # could leak is to be tracked), untrack it now. ``git rm
        # --cached`` removes from the index without touching disk;
        # the file stays on the tenant's wiki_root for the runtime
        # to read, but stops being part of the next commit.
        if (root / "tenant.json").exists():
            _run_git(["rm", "--cached", "-q", "--", "tenant.json"], cwd=root)

    return result


def _ensure_tenant_gitignore(root: Path) -> None:
    """Make sure ``tenant.json`` is in ``<root>/.gitignore``.

    Safe to call on any layout — empty repo, fresh clone, or a clone
    of an existing repo that already has its own gitignore. Idempotent.

    Rationale lives at the call site (see ``bootstrap_tenant``). The
    short version: this is the load-bearing leak-prevention step, and
    it has to work even when the cloned repo already has unrelated
    gitignore content.
    """
    gi = root / ".gitignore"
    existing = gi.read_text(encoding="utf-8") if gi.exists() else ""
    # Match a line that is exactly ``tenant.json`` (no leading slash,
    # no trailing comment). Strict on purpose — we don't want to
    # silently accept ``# tenant.json (commented out)`` or a glob like
    # ``*.json`` as "good enough".
    has_rule = any(
        line.strip() == "tenant.json" for line in existing.splitlines()
    )
    if has_rule:
        return
    addendum = (
        ("\n" if existing and not existing.endswith("\n") else "")
        + _TENANT_GITIGNORE
    )
    gi.write_text(existing + addendum, encoding="utf-8")


def flush_tenant_async(tenant: "Tenant", message: str) -> None:
    """Schedule a coalesced commit + push for THIS tenant only.

    Safe to call from any thread. Each tenant has its own debounce timer;
    activity in tenant A doesn't delay tenant B's push.
    """
    if not tenant.gh_repo or not tenant.gh_token:
        return  # not connected, no-op
    if not TENANT_AUTOPUSH_ENABLED:
        return  # operator opted every tenant into manual-sync-only
    st = _get_tenant_state(tenant.id)
    with st.lock:
        if message:
            st.pending_messages.append(message)
        if st.timer is not None:
            return
        st.timer = threading.Timer(
            PUSH_DELAY_S,
            lambda: _do_tenant_flush(tenant),
        )
        st.timer.daemon = True
        st.timer.start()


def flush_tenant_now(tenant: "Tenant", message: str = "") -> dict:
    """Synchronous commit + push for one tenant. Used by the owner-console
    'Sync now' button and by tests. Cancels any pending debounced timer."""
    st = _get_tenant_state(tenant.id)
    with st.lock:
        if message:
            st.pending_messages.append(message)
        if st.timer is not None:
            st.timer.cancel()
            st.timer = None
    return _do_tenant_flush(tenant)


def _do_tenant_flush(tenant: "Tenant") -> dict:
    """The actual per-tenant git add + commit + push. Holds the tenant
    state's lock for the duration."""
    st = _get_tenant_state(tenant.id)
    with st.lock:
        st.timer = None
        st.last_flush_attempt = time.time()
        messages = st.pending_messages[:]
        st.pending_messages = []

    result: dict = {"committed": False, "pushed": False, "messages": messages}

    if not tenant.gh_repo or not tenant.gh_token:
        result["skipped"] = "tenant not connected"
        return result
    if not _is_git_repo(tenant.wiki_root):
        result["skipped"] = "tenant wiki_root is not a git repo (run bootstrap first)"
        return result

    _ensure_tenant_git_identity(tenant)
    # Refresh remote URL in case the token rotated since boot.
    _run_git(
        ["remote", "set-url", "origin", _tenant_remote_url(tenant)],
        cwd=tenant.wiki_root,
    )

    rc, out = _run_git(["add", "-A"], cwd=tenant.wiki_root)
    if rc != 0:
        _mark_tenant_error(tenant, f"git add failed: {out}")
        result["error"] = out
        return result

    rc_status, status_out = _run_git(
        ["status", "--porcelain"], cwd=tenant.wiki_root
    )
    if rc_status == 0 and not status_out.strip():
        result["skipped"] = "no staged changes"
        return result

    summary = _compose_commit_message(messages)
    rc, out = _run_git(["commit", "-m", summary], cwd=tenant.wiki_root)
    if rc != 0:
        if "nothing to commit" in out.lower():
            result["skipped"] = "nothing to commit"
            return result
        _mark_tenant_error(tenant, f"git commit failed: {out}")
        result["error"] = out
        return result
    result["committed"] = True
    result["commit_summary"] = summary

    branch = tenant.gh_default_branch or "main"
    rc, out = _run_git(
        ["push", "origin", branch], cwd=tenant.wiki_root, timeout=60
    )
    if rc != 0:
        # Non-fast-forward rejection is the COMMON failure mode in the
        # wild — the remote got a commit (web edits, another device,
        # an unrelated push to a shared repo, etc.) since our last
        # fetch. Before this auto-resolve was wired up, the owner-
        # console "Sync now" button just bubbled the rejection up:
        #
        #   ! [rejected] main -> main (fetch first)
        #   error: failed to push some refs
        #
        # and the only adjacent button was "force-reset to origin/main"
        # which discards every local change since the last successful
        # push. Real users hit this once and lost their pending wiki
        # content because there was no in-between option.
        #
        # The fix: try one rebase-then-push automatically. We only
        # auto-rebase when the remote can be fast-forwarded onto our
        # local commit (which is the case for parallel work that
        # doesn't touch the same lines). If the rebase has actual
        # conflicts, abort it and bubble up the original push failure
        # so the user can decide.
        looks_non_ff = (
            "non-fast-forward" in out.lower()
            or "fetch first" in out.lower()
            or "[rejected]" in out.lower()
        )
        if looks_non_ff:
            result["auto_rebase_attempted"] = True
            rc_fetch, fetch_out = _run_git(
                ["fetch", "origin", branch],
                cwd=tenant.wiki_root,
                timeout=60,
            )
            if rc_fetch == 0:
                rc_reb, reb_out = _run_git(
                    ["rebase", f"origin/{branch}"],
                    cwd=tenant.wiki_root,
                    timeout=60,
                )
                if rc_reb == 0:
                    # Rebase clean — retry the push.
                    rc2, out2 = _run_git(
                        ["push", "origin", branch],
                        cwd=tenant.wiki_root,
                        timeout=60,
                    )
                    if rc2 == 0:
                        result["pushed"] = True
                        result["auto_rebased"] = True
                        _mark_tenant_synced(tenant)
                        with st.lock:
                            st.pushes_made += 1
                            st.last_flush_ok = time.time()
                            st.last_error = None
                        return result
                    out = out2 or out
                else:
                    # Conflict during rebase — abort and report the
                    # original rejection. The user has to resolve via
                    # the "Pull from GitHub" button (which surfaces
                    # the dirty/diverged state with type-to-confirm
                    # before any data loss).
                    _run_git(
                        ["rebase", "--abort"],
                        cwd=tenant.wiki_root,
                        timeout=30,
                    )
                    result["auto_rebase_error"] = (
                        f"rebase had conflicts: {reb_out[:200]}"
                    )
            else:
                result["auto_rebase_error"] = (
                    f"fetch failed during auto-rebase: {fetch_out[:200]}"
                )
        _mark_tenant_error(tenant, f"git push failed: {out}")
        result["error"] = out
        return result
    result["pushed"] = True
    _mark_tenant_synced(tenant)
    with st.lock:
        st.pushes_made += 1
        st.last_flush_ok = time.time()
        st.last_error = None
    return result


def _mark_tenant_synced(tenant: "Tenant") -> None:
    """Update tenant + persist last-synced timestamp. Best-effort: if the
    manager isn't loaded (rare in tests), just mutate the in-memory tenant."""
    tenant.git_last_synced_at = time.time()
    tenant.git_last_error = ""
    tenant.git_pushes_made += 1
    try:
        from . import tenants as tenants_mod

        tenants_mod.manager()._persist(tenant)
    except Exception:  # noqa: BLE001
        pass


def _mark_tenant_error(tenant: "Tenant", msg: str) -> None:
    """Surface a sync failure on the tenant record (visible in owner console)."""
    tenant.git_last_error = msg[:500]
    st = _get_tenant_state(tenant.id)
    with st.lock:
        st.last_error = msg
    try:
        from . import tenants as tenants_mod

        tenants_mod.manager()._persist(tenant)
    except Exception:  # noqa: BLE001
        pass


def get_tenant_status(tenant: "Tenant") -> dict:
    """A read-only snapshot of one tenant's persistence state."""
    st = _get_tenant_state(tenant.id)
    with st.lock:
        return {
            "connected": bool(tenant.gh_repo and tenant.gh_token),
            "repo": tenant.gh_repo,
            "branch": tenant.gh_default_branch or "main",
            "remote_url_public": (
                f"https://github.com/{tenant.gh_repo}" if tenant.gh_repo else None
            ),
            "autopush_enabled": TENANT_AUTOPUSH_ENABLED,
            "last_synced_at": tenant.git_last_synced_at,
            "last_error": tenant.git_last_error,
            "pushes_made": tenant.git_pushes_made,
            "pending_message_count": len(st.pending_messages),
            "timer_scheduled": st.timer is not None,
        }


# ---------------------------------------------------------------------------
# Pull from GitHub
# ---------------------------------------------------------------------------
#
# The complement to ``flush_tenant_now``: instead of pushing local edits up
# to GitHub, this fetches and applies remote edits down to our hosted copy.
# Needed because users can also edit their wiki directly on GitHub (web
# editor, a local clone, another device, a webhook from elsewhere, etc.).
# Without this pull path our hosted copy goes stale silently the moment
# the user picks up an alternate edit channel.
#
# Conflict policy (smart pull):
#   * remote ahead + tree clean OR untracked-only → fast-forward pull.
#     Stray untracked files never block a hosted mirror's FF — there's
#     nothing authored on this side to lose. If an incoming file would
#     collide with untracked cruft, we stash the cruft, FF, then drop it.
#   * nothing new                       → "already up to date"
#   * unpushed local commits (ahead>0,  → "ahead_only" (nudge Sync now)
#     behind==0)
#   * tracked-modified files + remote   → refuse ("dirty"): real authored
#     ahead                               edits would be clobbered by FF;
#                                         force / Sync-now required.
#   * both sides have commits           → refuse ("diverged"); force req'd
#     (ahead>0 AND behind>0)
#   * force=True                        → ``git fetch && git reset --hard
#                                         origin/<branch>``. Destructive;
#                                         the UI confirms before sending.
#
# The wart this kills: the OLD policy treated ALL dirt as blocking, so a
# hosted mirror that accumulated a stray untracked file (the common drift
# case) refused every pull and the only escape was the scary "Force pull
# (discard local)" button — even though the mirror had nothing worth
# protecting. ``classify_pull_safety`` is the half-built classifier from
# ``preview_force_reset`` promoted to a first-class decision.
#
# Returned dict shape:
#   { ok, action: "pulled" | "up_to_date" | "ahead_only" | "diverged"
#                | "dirty" | "forced",
#     behind: int, ahead: int, dirty: bool,
#     tracked_modified: [str], untracked: [str],
#     error?: str, fetch_note?: str }


def _count_commits(cwd: Path, rev_range: str) -> int:
    """Return ``git rev-list --count <range>`` or 0 if anything fails.

    Used to compute how far ahead/behind we are vs. ``origin/<branch>``.
    A failure to count is treated as "no info" rather than an error —
    the worst case is we show "0 behind" when actually we don't know,
    which is mildly stale but never wrong in a dangerous direction.
    """
    rc, out = _run_git(["rev-list", "--count", rev_range], cwd=cwd)
    if rc != 0:
        return 0
    try:
        return int(out.strip())
    except ValueError:
        return 0


def _is_working_tree_dirty(cwd: Path) -> bool:
    rc, out = _run_git(["status", "--porcelain"], cwd=cwd)
    if rc != 0:
        return False
    return bool(out.strip())


def _porcelain_status(cwd: Path) -> list[dict]:
    """Parse ``git status --porcelain`` into structured rows.

    Each row is ``{"status": "M"|"A"|"D"|"R"|"??"|..., "path": "..."}``.
    Returns ``[]`` on any git failure. Used by the force-reset preview
    endpoint so the UI can show the user EXACTLY which local files are
    about to be discarded by ``git reset --hard origin/<branch>``.

    Porcelain format (per ``git help status``):
        XY <path>

    where X is the index-staged status and Y is the working-tree status.
    For untracked files the prefix is the literal "??". We collapse XY
    to a single visible code (Y when nonempty, else X) for display, but
    preserve the untracked marker so the UI can flag those rows
    DIFFERENTLY — git reset --hard removes tracked-modified files but
    leaves untracked files in place.

    We bypass ``_run_git`` here because it strip()s the combined output,
    which would eat the leading space on the FIRST line of porcelain
    output (e.g. ``" M wiki/foo.md"`` becomes ``"M wiki/foo.md"``,
    shifting every column by one and corrupting the path). Porcelain
    output is column-sensitive — strip() is the wrong helper.
    """
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return []
    if proc.returncode != 0:
        return []
    rows: list[dict] = []
    # Use splitlines on stdout ONLY — strip()/stderr would lose
    # column alignment. Porcelain is line-oriented, no need for
    # NUL-delimited output unless paths contain newlines (rare).
    for line in (proc.stdout or "").splitlines():
        if len(line) < 4:
            # "XY <path>" requires at least 4 chars (X, Y, space, 1-char path).
            continue
        # Porcelain format is "XY <path>". X is index, Y is worktree.
        # For renames the path is "old -> new"; we keep both for clarity.
        x = line[0]
        y = line[1]
        path = line[3:]
        if x == "?" and y == "?":
            code = "??"
            kind = "untracked"
        elif y != " " and y != "":
            code = y
            kind = "modified"
        else:
            code = x
            kind = "staged"
        rows.append({"status": code, "path": path, "kind": kind})
    return rows


def _split_porcelain_dirt(cwd: Path) -> tuple[list[str], list[str]]:
    """Classify working-tree dirt into (tracked_changes, untracked_paths).

    This powers the *smart pull* decision: an untracked-only working
    tree never blocks a fast-forward (a hosted mirror has no authored
    content to lose), whereas tracked modifications represent real
    edits and must be protected.

    Unlike :func:`_porcelain_status`, this goes through ``_run_git`` so
    the per-tenant pull tests can stub a divergence scenario without a
    real on-disk repo. ``_run_git`` strips the combined output, which
    can drop the single leading column-space on the first porcelain row
    (e.g. ``" M f"`` → ``"M f"``). That's fine here: we only need the
    tracked-vs-untracked split, and untracked rows are the unambiguous
    ``??`` prefix regardless of leading whitespace.
    """
    rc, out = _run_git(["status", "--porcelain"], cwd=cwd)
    tracked: list[str] = []
    untracked: list[str] = []
    if rc != 0:
        return tracked, untracked
    for line in out.splitlines():
        if not line.strip():
            continue
        stripped = line.lstrip()
        if stripped.startswith("??"):
            parts = stripped.split(None, 1)
            untracked.append(parts[1] if len(parts) > 1 else "")
        else:
            # Any non-untracked porcelain row is a tracked change
            # (modified, staged, renamed, deleted). Keep the path for
            # the UI; fall back to the raw row when we can't parse it.
            parts = line.split(None, 1)
            tracked.append(parts[1] if len(parts) > 1 else line.strip())
    return tracked, untracked


# Paths whose only meaningful dirt is share-token hit bookkeeping.
# ``.share-token-stats.json`` is gitignored in normal setups; included
# so a mis-tracked sidecar never alone blocks a fast-forward.
_SHARE_TOKEN_BOOKKEEPING_PATHS = frozenset(
    {".share-tokens.json", ".share-token-stats.json"}
)


def _normalize_share_token_identity(raw: dict) -> dict:
    """Identity fields used to decide whether share-token dirt is hits-only."""
    return {
        "id": raw.get("id"),
        "token_hash": raw.get("token_hash"),
        "label": raw.get("label"),
        "tier": raw.get("tier"),
        "created_at": raw.get("created_at"),
        "expires_at": raw.get("expires_at"),
        "revoked_at": raw.get("revoked_at"),
    }


def _share_token_records_identity_equal(head_raw: object, work_raw: object) -> bool:
    """True when two ``.share-tokens.json`` payloads differ only in hits
    / last_used_at (same token set and identity fields).
    """

    def _tokens(blob: object) -> list[dict]:
        if not isinstance(blob, dict):
            return []
        tokens = blob.get("tokens", [])
        if not isinstance(tokens, list):
            return []
        return [t for t in tokens if isinstance(t, dict)]

    # Accept already-parsed dicts or JSON text.
    def _parse(blob: object) -> object:
        if isinstance(blob, (bytes, str)):
            try:
                return json.loads(blob)
            except (TypeError, ValueError):
                return None
        return blob

    head_tokens = _tokens(_parse(head_raw))
    work_tokens = _tokens(_parse(work_raw))
    if len(head_tokens) != len(work_tokens):
        return False
    head_by_id = {
        str(t.get("id")): _normalize_share_token_identity(t) for t in head_tokens
    }
    work_by_id = {
        str(t.get("id")): _normalize_share_token_identity(t) for t in work_tokens
    }
    if set(head_by_id) != set(work_by_id):
        return False
    return all(head_by_id[tid] == work_by_id[tid] for tid in head_by_id)


def _is_share_tokens_hits_only_dirt(cwd: Path, tracked_paths: list[str]) -> bool:
    """True when the only tracked dirt is share-token hit bookkeeping.

    ``resolve()`` used to bump ``hits`` / ``last_used_at`` inside the
    tracked ``.share-tokens.json``. That left a permanent ``[M]`` that
    blocked every smart-pull while the tenant was behind GitHub — even
    though no real wiki content had changed. Hits now live in a
    gitignored sidecar, but older working trees (and any residual
    tracked rewrite) can still show hits-only dirt; treat that as
    disposable bookkeeping rather than authored edits.
    """
    if not tracked_paths:
        return False
    normalized: set[str] = set()
    for p in tracked_paths:
        if not p:
            continue
        path = p.replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        normalized.add(path)
    if not normalized or not normalized.issubset(_SHARE_TOKEN_BOOKKEEPING_PATHS):
        return False
    # Sidecar-only dirt (if somehow tracked) is always bookkeeping.
    if normalized == {".share-token-stats.json"}:
        return True
    if ".share-tokens.json" not in normalized:
        return False

    rc, head_out = _run_git(
        ["show", "HEAD:.share-tokens.json"], cwd=cwd
    )
    if rc != 0:
        # File not in HEAD — a brand-new uncommitted mint is substantive.
        return False
    work_path = cwd / ".share-tokens.json"
    if not work_path.exists():
        return False
    try:
        work_text = work_path.read_text(encoding="utf-8")
    except OSError:
        return False
    return _share_token_records_identity_equal(head_out, work_text)


def _discard_share_token_bookkeeping_dirt(cwd: Path) -> None:
    """Reset tracked share-token bookkeeping files to HEAD.

    Safe to call when dirt was already classified as hits-only: restores
    ``.share-tokens.json`` so the subsequent FF merge is unblocked.
    Sidecar checkout / cache-rm failures are ignored (normally untracked).
    """
    _run_git(["checkout", "--", ".share-tokens.json"], cwd=cwd)
    _run_git(["checkout", "--", ".share-token-stats.json"], cwd=cwd)
    _run_git(["rm", "--cached", "-f", ".share-token-stats.json"], cwd=cwd)


def _commits_in_range(cwd: Path, rev_range: str, *, limit: int = 20) -> list[dict]:
    """Return ``git log --oneline <range>`` parsed into structured rows.

    Each row: ``{"sha": "<short>", "subject": "..."}``. Capped at
    ``limit`` so the preview payload stays small even on a repo with
    100+ commits to drop. Returns ``[]`` on failure. The caller pairs
    this with ``_count_commits`` to surface the FULL count plus a
    sample — the UI can show "12 of 47 commits" without us streaming
    the entire log over HTTP.
    """
    rc, out = _run_git(
        ["log", "--oneline", "--no-decorate", "-n", str(limit), rev_range],
        cwd=cwd,
    )
    if rc != 0:
        return []
    rows: list[dict] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        # "abc1234 some subject" — split on first whitespace.
        parts = line.split(None, 1)
        if not parts:
            continue
        sha = parts[0]
        subject = parts[1] if len(parts) > 1 else ""
        rows.append({"sha": sha, "subject": subject})
    return rows


def preview_force_reset(tenant: "Tenant") -> dict:
    """Inspect what a ``git reset --hard origin/<branch>`` would discard.

    Returns a structured preview the owner UI can show in the type-to-
    confirm modal so a destructive click is never "blind". Pure read
    operation — no mutation of either local state or the remote.

    Returned dict shape (all fields always present, empty/zero when
    nothing applies)::

        {
          "ok": bool,
          "error": Optional[str],          # set when we couldn't inspect
          "branch": str,                   # the remote branch reset would target
          "behind": int,                   # remote commits we'd pick up
          "ahead": int,                    # local commits we'd lose
          "dirty_files": list[{status, path, kind}],
              # working-tree modifications that reset --hard will discard
          "untracked_files": list[str],
              # files NOT touched by reset --hard (left behind on disk)
          "commits_to_lose": list[{sha, subject}],
              # sample of unpushed local commits about to be discarded
          "commits_to_lose_total": int,
              # full count even if commits_to_lose was truncated
          "commits_to_gain": list[{sha, subject}],
              # what the working tree will look like after the reset
          "commits_to_gain_total": int,
        }

    Failure modes (return ok=False with error set):
      * tenant has no gh_repo or no token → can't fetch
      * fetch fails → preview reflects last known state, but we surface
        the fetch error so the UI can show "couldn't sync remote" rather
        than implying the local count is authoritative.
    """
    result: dict = {
        "ok": False,
        "error": None,
        "branch": "",
        "behind": 0,
        "ahead": 0,
        "dirty_files": [],
        "untracked_files": [],
        "commits_to_lose": [],
        "commits_to_lose_total": 0,
        "commits_to_gain": [],
        "commits_to_gain_total": 0,
    }
    if not tenant.gh_repo:
        result["error"] = "no GitHub repo connected"
        return result
    if not tenant.gh_token:
        result["error"] = "no GitHub token (re-auth required)"
        return result

    root = tenant.wiki_root
    if not (root / ".git").exists():
        result["error"] = "no local git repo (run bootstrap first)"
        return result

    branch = (tenant.gh_default_branch or "main").strip() or "main"
    result["branch"] = branch

    # Refresh the remote ref so behind/ahead/lose/gain are computed
    # against the current GitHub state, not a stale cached one. Best
    # effort — if fetch fails we surface the error but still return
    # what we can from the local state.
    remote_url = _tenant_remote_url(tenant)
    if remote_url:
        _run_git(
            ["remote", "set-url", "origin", remote_url], cwd=root
        )
    rc, fetch_out = _run_git(["fetch", "origin", branch], cwd=root, timeout=60)
    if rc != 0:
        result["error"] = f"fetch failed: {fetch_out[:200]}"
        # Don't early-return — local state is still useful to show.

    # Tracked working-tree changes vs untracked. Critical to split:
    # ``reset --hard`` discards modified-tracked but LEAVES untracked
    # files alone. The UI shows the untracked-files block as "these
    # will SURVIVE the reset" so the user knows nothing's getting
    # silently nuked beyond what we list.
    porcelain = _porcelain_status(root)
    result["dirty_files"] = [r for r in porcelain if r["kind"] != "untracked"]
    result["untracked_files"] = [
        r["path"] for r in porcelain if r["kind"] == "untracked"
    ]

    # Commits the reset would drop (local-only) and commits it would
    # apply (remote-only). Capped sample + full count.
    result["ahead"] = _count_commits(root, f"origin/{branch}..HEAD")
    result["behind"] = _count_commits(root, f"HEAD..origin/{branch}")
    result["commits_to_lose_total"] = result["ahead"]
    result["commits_to_gain_total"] = result["behind"]
    if result["ahead"] > 0:
        result["commits_to_lose"] = _commits_in_range(
            root, f"origin/{branch}..HEAD", limit=20
        )
    if result["behind"] > 0:
        result["commits_to_gain"] = _commits_in_range(
            root, f"HEAD..origin/{branch}", limit=20
        )

    # ok if we got far enough to inspect at all — even a failed fetch
    # leaves valid local-state info for the UI to display. ``error``
    # being set tells the caller "remote info may be stale".
    result["ok"] = True
    return result


def classify_pull_safety(tenant: "Tenant") -> dict:
    """Decide whether the tenant's wiki can be safely auto-fast-forwarded.

    This is the brain behind smart pull (and the background poller). It
    fetches ``origin/<branch>`` and reports how the local copy relates
    to it, splitting working-tree dirt into *tracked-modified* (real
    authored edits — must be protected) vs *untracked* (cruft — never
    blocks a mirror's fast-forward).

    ``auto_ff`` is True iff a fast-forward is both possible and safe:
    we are strictly behind the remote (``behind > 0``), have no local
    commits of our own (``ahead == 0``), and no tracked-modified files.
    Untracked files don't disqualify the FF.

    Returned dict (all fields always present)::

        {
          "ok": bool,                 # False only on connection/fetch error
          "auto_ff": bool,            # safe to fast-forward with no prompt
          "reason": str,              # short human-readable verdict
          "branch": str,
          "behind": int,
          "ahead": int,
          "dirty": bool,
          "tracked_modified": [str],  # paths blocking an FF
          "untracked": [str],         # paths that survive / get stashed
          "error": Optional[str],
        }

    Never raises. Pure read (fetch + rev-list + status) — no mutation.
    """
    out: dict = {
        "ok": False,
        "auto_ff": False,
        "reason": "",
        "branch": (tenant.gh_default_branch or "main"),
        "behind": 0,
        "ahead": 0,
        "dirty": False,
        "tracked_modified": [],
        "untracked": [],
        "error": None,
    }
    if not tenant.gh_repo or not tenant.gh_token:
        out["error"] = "tenant not connected"
        out["reason"] = "not connected"
        return out
    if not _is_git_repo(tenant.wiki_root):
        out["error"] = "wiki_root is not a git repo (run bootstrap first)"
        out["reason"] = "not bootstrapped"
        return out

    branch = tenant.gh_default_branch or "main"
    root = tenant.wiki_root

    _ensure_tenant_git_identity(tenant)
    _run_git(
        ["remote", "set-url", "origin", _tenant_remote_url(tenant)], cwd=root
    )
    rc, fetch_out = _run_git(["fetch", "origin", branch], cwd=root, timeout=60)
    if rc != 0:
        out["error"] = f"fetch failed: {fetch_out[:200]}"
        out["reason"] = "fetch failed"
        return out

    behind = _count_commits(root, f"HEAD..origin/{branch}")
    ahead = _count_commits(root, f"origin/{branch}..HEAD")
    tracked, untracked = _split_porcelain_dirt(root)
    out.update(
        ok=True,
        behind=behind,
        ahead=ahead,
        dirty=bool(tracked or untracked),
        tracked_modified=tracked,
        untracked=untracked,
    )

    if ahead > 0 and behind > 0:
        out["reason"] = f"diverged ({ahead} local, {behind} remote)"
    elif behind == 0 and ahead > 0:
        out["reason"] = f"ahead by {ahead} (nothing to pull)"
    elif behind == 0:
        out["reason"] = "up to date"
    elif tracked:
        out["reason"] = f"behind by {behind}, {len(tracked)} local edit(s) at risk"
    else:
        out["auto_ff"] = True
        out["reason"] = (
            f"behind by {behind}, fast-forward safe"
            + (f" ({len(untracked)} untracked file(s) stashed)" if untracked else "")
        )
    return out


def pull_tenant_now(tenant: "Tenant", *, force: bool = False) -> dict:
    """Pull the tenant's wiki from its GitHub remote.

    See module-level docstring for the conflict policy. Caller is
    responsible for reloading the in-memory index after a successful
    pull — we don't touch the index here so this module stays
    decoupled from tenants/index loading semantics.

    Never raises; failures land in the returned dict. The owner-console
    panel surfaces the ``action`` field verbatim.
    """
    result: dict = {
        "ok": False,
        "action": "noop",
        "behind": 0,
        "ahead": 0,
        "dirty": False,
        "tracked_modified": [],
        "untracked": [],
    }
    if not tenant.gh_repo or not tenant.gh_token:
        result["error"] = "tenant not connected"
        return result
    if not _is_git_repo(tenant.wiki_root):
        result["error"] = "wiki_root is not a git repo (run bootstrap first)"
        return result

    branch = tenant.gh_default_branch or "main"
    root = tenant.wiki_root

    _ensure_tenant_git_identity(tenant)
    _run_git(
        ["remote", "set-url", "origin", _tenant_remote_url(tenant)],
        cwd=root,
    )

    rc, fetch_out = _run_git(
        ["fetch", "origin", branch], cwd=root, timeout=60
    )
    if rc != 0:
        _mark_tenant_error(tenant, f"git fetch failed: {fetch_out}")
        result["error"] = f"fetch failed: {fetch_out[:200]}"
        return result

    behind = _count_commits(root, f"HEAD..origin/{branch}")
    ahead = _count_commits(root, f"origin/{branch}..HEAD")
    tracked, untracked = _split_porcelain_dirt(root)
    result["behind"] = behind
    result["ahead"] = ahead
    result["dirty"] = bool(tracked or untracked)
    result["tracked_modified"] = tracked
    result["untracked"] = untracked

    # Force path: blow away local state and take whatever GitHub has.
    # Wired up for the "yes I really want to discard local" button.
    if force:
        rc, out = _run_git(
            ["reset", "--hard", f"origin/{branch}"], cwd=root
        )
        if rc != 0:
            _mark_tenant_error(tenant, f"git reset --hard failed: {out}")
            result["error"] = out[:200]
            return result
        result["ok"] = True
        result["action"] = "forced"
        _mark_tenant_synced(tenant)
        return result

    # Smart-path decision tree. Note: dirt no longer blocks
    # unconditionally — only tracked-modified files on a fast-forwardable
    # branch do. Untracked cruft on a hosted mirror is disposable.
    if behind == 0 and ahead == 0:
        result["ok"] = True
        result["action"] = "up_to_date"
        return result
    if behind == 0 and ahead > 0:
        result["ok"] = True
        result["action"] = "ahead_only"
        # Not an error — we just have nothing to pull. The UI uses this
        # to tell the user "hit Sync now to push your local commits".
        return result
    if ahead > 0 and behind > 0:
        result["error"] = (
            f"Branches have diverged ({ahead} local, {behind} remote). "
            "Resolve by either pushing your local commits first ('Sync "
            "now') or pulling with force=true to discard local."
        )
        result["action"] = "diverged"
        return result

    # behind > 0, ahead == 0 → a fast-forward is on the table.
    if tracked:
        # Hit-count bookkeeping on .share-tokens.json is not authored
        # content — discard it and fall through to the same FF path as
        # a clean tree. Real edits (other files, or a substantive mint
        # that changed the token list) still block.
        if _is_share_tokens_hits_only_dirt(root, tracked):
            _discard_share_token_bookkeeping_dirt(root)
            tracked, untracked = _split_porcelain_dirt(root)
            result["tracked_modified"] = tracked
            result["untracked"] = untracked
            result["dirty"] = bool(tracked or untracked)
            result["discarded_share_token_hits"] = True
        if tracked:
            # Real authored edits live in the working tree. A FF would
            # checkout over them. Make the user resolve (push via Sync now,
            # or force to discard). This is the ONLY remaining "dirty" case.
            result["error"] = (
                f"Working tree has {len(tracked)} modified tracked file(s). "
                "Hit 'Sync now' to push them first, or pull with force=true "
                "to discard."
            )
            result["action"] = "dirty"
            return result

    # Clean OR untracked-only → auto fast-forward. Stray untracked files
    # on a mirror have nothing to protect, so they must never gate the
    # pull. Try a plain FF first; only if untracked cruft physically
    # blocks the merge (an incoming path collides with an untracked
    # file) do we stash + retry + drop, discarding the disposable cruft.
    rc, out = _run_git(
        ["merge", "--ff-only", f"origin/{branch}"], cwd=root
    )
    if rc != 0 and untracked and _looks_like_untracked_overwrite(out):
        result["stashed_untracked"] = True
        _run_git(
            ["stash", "push", "--include-untracked", "-m", "plw-auto-pull"],
            cwd=root,
        )
        rc, out = _run_git(
            ["merge", "--ff-only", f"origin/{branch}"], cwd=root
        )
        # The stash held only disposable cruft on a mirror. Drop it so a
        # stale copy of a now-tracked file can't re-conflict on pop.
        _run_git(["stash", "drop"], cwd=root)
    if rc != 0:
        _mark_tenant_error(tenant, f"git merge --ff-only failed: {out}")
        result["error"] = out[:200]
        return result
    result["ok"] = True
    result["action"] = "pulled"
    _mark_tenant_synced(tenant)
    return result


def _looks_like_untracked_overwrite(git_output: str) -> bool:
    """True when an FF merge failed because an incoming tracked file
    would clobber an existing untracked file. That's the one untracked
    scenario git refuses to fast-forward through — and the one where
    stashing the cruft is the right unblock on a hosted mirror."""
    low = (git_output or "").lower()
    return "untracked working tree files would be overwritten" in low


def smart_pull_all_tenants() -> dict:
    """Fast-forward every connected tenant from GitHub, skipping any that
    would require a force or human decision.

    This is the body of the background poller (and the webhook can reuse
    ``pull_tenant_now`` directly for a single tenant). It leans entirely
    on the smart-pull policy: ``pull_tenant_now`` never mutates local
    state destructively without ``force=True``, so iterating it over all
    tenants is safe by construction — diverged / dirty tenants are left
    untouched for the owner to resolve.

    Reloads the in-memory index for any tenant we actually moved on disk
    so freshly-pulled pages are reachable on the very next request. Never
    raises; returns a summary the caller can log.
    """
    from . import tenants as _tenants

    summary: dict = {
        "checked": 0,
        "pulled": 0,
        "up_to_date": 0,
        "skipped": 0,
        "errors": 0,
        "pulled_tenants": [],
    }
    try:
        all_tenants = _tenants.manager().all_tenants()
    except Exception:  # noqa: BLE001 — never let the poller die on a bad registry
        return summary

    for tenant in all_tenants:
        if not (tenant.gh_repo and tenant.gh_token):
            continue
        if not _is_git_repo(tenant.wiki_root):
            continue
        summary["checked"] += 1
        try:
            res = pull_tenant_now(tenant)
        except Exception:  # noqa: BLE001 — isolate one tenant's failure
            summary["errors"] += 1
            continue
        action = res.get("action")
        if res.get("ok") and action == "pulled":
            summary["pulled"] += 1
            summary["pulled_tenants"].append(tenant.id)
            try:
                with _tenants.set_current_tenant(tenant):
                    tenant.reload_index()
            except Exception:  # noqa: BLE001
                pass
        elif res.get("ok") and action == "up_to_date":
            summary["up_to_date"] += 1
        elif res.get("error"):
            summary["errors"] += 1
        else:
            # ahead_only / diverged / dirty — intentionally left alone.
            summary["skipped"] += 1
    return summary
