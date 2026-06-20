"""Multi-tenant infrastructure.

In SINGLE_TENANT_MODE (default, OSS self-host) this module is mostly inert:
all routes resolve to a single global tenant whose ``wiki_root`` is
``settings.default_wiki_root``. Existing code paths are unchanged.

In multi-tenant mode (hosted at portablellm.wiki), each user has their
own ``Tenant`` with:

* ``id``                — URL-safe slug used in ``portablellm.wiki/<id>``.
                          For GitHub-authed tenants this is the GitHub
                          login (e.g. ``cary``).
* ``wiki_root``         — local filesystem dir holding wiki/, raw/ for
                          this tenant only. The wiki is loaded into a
                          per-tenant :class:`~app.wiki.WikiIndex`.
* ``gh_token``          — GitHub OAuth access token (encrypted at rest
                          in v1.1; in-memory for v1.0).
* ``gh_repo``           — ``<owner>/<repo>`` of the user's GitHub repo
                          that mirrors this wiki. The persistence layer
                          pushes to this remote on every owner mutation.
* ``owner_user_id``     — primary key for who counts as "owner" of this
                          tenant. Currently the GitHub user id.

The tenant context for a request is stored in a ``ContextVar`` that the
HTTP middleware sets before route dispatch. Every helper that accesses
``settings.wiki_root`` or ``app.wiki.index`` reads through this context,
so existing handlers don't need to change their signatures.
"""

from __future__ import annotations

import json
import os
import threading
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from .config import settings

if TYPE_CHECKING:
    from .wiki import WikiIndex


# ---------------------------------------------------------------------------
# Tenant dataclass
# ---------------------------------------------------------------------------


@dataclass
class Tenant:
    """Metadata for one wiki tenant. Loaded from disk on demand."""

    id: str
    wiki_root: Path
    display_name: str = ""
    # GitHub-specific (only set for OAuth-provisioned tenants)
    gh_login: str = ""
    gh_user_id: int = 0
    gh_token: str = ""  # OAuth access token; rotated on re-auth
    gh_repo: str = ""  # "<owner>/<repo>" — the wiki content repo we push to
    gh_default_branch: str = "main"
    # Per-tenant secret used to verify GitHub push-webhook signatures
    # (X-Hub-Signature-256). Minted when we register the webhook at
    # repo-connect time. Like gh_token, it's a secret: persisted to
    # tenant.json (gitignored) but NEVER exposed over the wire.
    gh_webhook_secret: str = ""
    # Sync state (set + updated by persistence.flush_tenant_*). All values
    # are in-memory hints surfaced to the owner console; the wiki content
    # itself lives in git so these can be re-derived after a cold start.
    git_last_synced_at: float = 0.0   # unix ts of last successful push
    git_last_error: str = ""           # human-readable last failure (cleared on success)
    git_pushes_made: int = 0           # total successful pushes since boot
    # Provenance
    created_at: str = ""
    updated_at: str = ""
    # Misc
    is_demo: bool = False  # read-only public demo tenants (e.g. Avery)
    visibility: str = "public"  # public | unlisted | private

    # Lazy-loaded wiki index for this tenant; not serialized to disk.
    _index: Optional["WikiIndex"] = field(default=None, repr=False, compare=False)
    _index_lock: threading.RLock = field(
        default_factory=threading.RLock, repr=False, compare=False
    )

    @property
    def wiki_dir(self) -> Path:
        return self.wiki_root / "wiki"

    @property
    def raw_dir(self) -> Path:
        return self.wiki_root / "raw"

    @property
    def index(self) -> "WikiIndex":
        """Per-tenant WikiIndex. Lazily constructed on first access.

        We import :class:`WikiIndex` here (rather than at module top)
        because ``wiki.py`` imports from this module — avoiding a cycle.
        """
        if self._index is None:
            with self._index_lock:
                if self._index is None:
                    from .wiki import WikiIndex

                    idx = WikiIndex()
                    # Reload in the tenant's own context so it scans the
                    # right wiki_dir.
                    token = current_tenant_var.set(self)
                    try:
                        idx.reload()
                    finally:
                        current_tenant_var.reset(token)
                    self._index = idx
        return self._index

    def reload_index(self) -> None:
        """Force a reindex of this tenant's wiki dir."""
        idx = self.index
        token = current_tenant_var.set(self)
        try:
            idx.reload()
        finally:
            current_tenant_var.reset(token)

    def to_dict(self) -> dict:
        """Serializable summary (no token, no internal state).

        Build the dict by hand instead of using ``dataclasses.asdict()``.
        ``asdict`` deep-copies every field, which blows up on
        ``_index_lock`` (a ``threading.RLock`` is not picklable) before
        we get a chance to ``pop`` it out. Explicit construction is
        faster and lets us guarantee the OAuth token never escapes.
        """
        return {
            "id": self.id,
            "wiki_root": str(self.wiki_root),
            "display_name": self.display_name,
            "gh_login": self.gh_login,
            "gh_user_id": self.gh_user_id,
            # gh_token intentionally omitted — never expose over the wire.
            "gh_repo": self.gh_repo,
            "gh_default_branch": self.gh_default_branch,
            "git_last_synced_at": self.git_last_synced_at,
            "git_last_error": self.git_last_error,
            "git_pushes_made": self.git_pushes_made,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "is_demo": self.is_demo,
            "visibility": self.visibility,
        }


# ---------------------------------------------------------------------------
# Request-scoped tenant context (one entry per HTTP request)
# ---------------------------------------------------------------------------


current_tenant_var: ContextVar[Optional[Tenant]] = ContextVar(
    "plw_current_tenant", default=None
)


def current_tenant_or_none() -> Optional[Tenant]:
    """Return the tenant bound to the current request, or None if unset.

    Used by ``settings`` and ``wiki.index`` proxies — they fall back to
    the global default tenant when this returns None. Safe to call from
    any thread; if called from a thread that wasn't a request handler
    (e.g. a Persistence flush timer), the contextvar will not be set and
    callers must explicitly pass a tenant via ``with set_current_tenant(t):``.
    """
    return current_tenant_var.get()


def current_tenant() -> Tenant:
    """Like :func:`current_tenant_or_none` but falls back to the default
    tenant. Always returns a usable Tenant."""
    t = current_tenant_var.get()
    if t is not None:
        return t
    return _manager.default_tenant()


class _TenantContextManager:
    """Context manager that temporarily sets the current tenant.

    Used by background workers (orchestrator subprocesses, persistence
    flush timers) that don't run inside an HTTP request context.
    """

    def __init__(self, tenant: Tenant) -> None:
        self._tenant = tenant
        self._token = None

    def __enter__(self) -> Tenant:
        self._token = current_tenant_var.set(self._tenant)
        return self._tenant

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._token is not None:
            current_tenant_var.reset(self._token)


def set_current_tenant(tenant: Tenant) -> _TenantContextManager:
    """`with set_current_tenant(t): ...` to scope work to a tenant.

    Returns a context manager so background threads (orchestrator jobs,
    persistence flushes) can run wiki operations on a specific tenant
    without relying on the HTTP request contextvar.
    """
    return _TenantContextManager(tenant)


# ---------------------------------------------------------------------------
# Tenant store: load + save tenant metadata to disk
# ---------------------------------------------------------------------------


_TENANT_META_FILE = "tenant.json"


class TenantManager:
    """In-memory registry of tenants, persisted to disk as JSON.

    Each tenant lives at ``<tenants_root>/<tenant_id>/`` and has a
    ``tenant.json`` file at its root with metadata. The wiki itself lives
    at ``<tenants_root>/<tenant_id>/wiki/`` (markdown pages) and
    ``.../raw/`` (immutable source material).

    In single-tenant mode the manager still works but only knows about
    one tenant: ``default``.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._tenants: dict[str, Tenant] = {}
        self._default_tenant_id = "default"
        self._loaded = False

    # ---------- bootstrap ----------

    def load_from_disk(self) -> None:
        """Scan ``<tenants_root>/`` for tenant.json files and load each."""
        with self._lock:
            self._tenants.clear()

            # The default tenant always exists. In single-tenant mode it
            # points at settings.default_wiki_root. In multi-tenant mode
            # it's an unused fallback for unauthenticated calls.
            self._tenants[self._default_tenant_id] = Tenant(
                id=self._default_tenant_id,
                wiki_root=settings._base.default_wiki_root,
                display_name="default",
            )

            if not settings.single_tenant_mode:
                root = settings._base.tenants_root
                if root.exists():
                    for entry in sorted(root.iterdir()):
                        if not entry.is_dir() or entry.name.startswith("."):
                            continue
                        meta_path = entry / _TENANT_META_FILE
                        if not meta_path.exists():
                            continue
                        try:
                            data = json.loads(meta_path.read_text(encoding="utf-8"))
                        except Exception:  # noqa: BLE001
                            continue
                        tenant = self._tenant_from_json(entry.name, entry, data)
                        self._tenants[tenant.id] = tenant

            self._loaded = True

    def _tenant_from_json(self, tenant_id: str, wiki_root: Path, data: dict) -> Tenant:
        return Tenant(
            id=tenant_id,
            wiki_root=wiki_root,
            display_name=str(data.get("display_name", "")),
            gh_login=str(data.get("gh_login", "")),
            gh_user_id=int(data.get("gh_user_id", 0) or 0),
            gh_token=str(data.get("gh_token", "")),
            gh_repo=str(data.get("gh_repo", "")),
            gh_default_branch=str(data.get("gh_default_branch", "main")) or "main",
            gh_webhook_secret=str(data.get("gh_webhook_secret", "")),
            git_last_synced_at=float(data.get("git_last_synced_at", 0) or 0),
            git_last_error=str(data.get("git_last_error", "")),
            git_pushes_made=int(data.get("git_pushes_made", 0) or 0),
            created_at=str(data.get("created_at", "")),
            updated_at=str(data.get("updated_at", "")),
            is_demo=bool(data.get("is_demo", False)),
            visibility=str(data.get("visibility", "public")) or "public",
        )

    # ---------- lookups ----------

    def default_tenant(self) -> Tenant:
        if not self._loaded:
            self.load_from_disk()
        return self._tenants[self._default_tenant_id]

    def get(self, tenant_id: str) -> Optional[Tenant]:
        if not self._loaded:
            self.load_from_disk()
        return self._tenants.get(tenant_id)

    def require(self, tenant_id: str) -> Tenant:
        t = self.get(tenant_id)
        if t is None:
            raise KeyError(f"unknown tenant {tenant_id!r}")
        return t

    def all_tenants(self) -> list[Tenant]:
        if not self._loaded:
            self.load_from_disk()
        return [t for tid, t in self._tenants.items() if tid != self._default_tenant_id]

    # ---------- mutation ----------

    def upsert(self, tenant: Tenant) -> Tenant:
        """Create or update a tenant. Writes ``tenant.json`` to disk."""
        with self._lock:
            now = datetime.now(timezone.utc).isoformat()
            if not tenant.created_at:
                tenant.created_at = now
            tenant.updated_at = now
            self._tenants[tenant.id] = tenant
            self._persist(tenant)
            return tenant

    def _persist(self, tenant: Tenant) -> None:
        """Write ``tenant.json`` to ``<tenant.wiki_root>/tenant.json``.

        Default tenant in single-tenant mode is not persisted (it derives
        from env vars).
        """
        if tenant.id == self._default_tenant_id and settings.single_tenant_mode:
            return
        tenant.wiki_root.mkdir(parents=True, exist_ok=True)
        meta_path = tenant.wiki_root / _TENANT_META_FILE
        data = {
            "id": tenant.id,
            "display_name": tenant.display_name,
            "gh_login": tenant.gh_login,
            "gh_user_id": tenant.gh_user_id,
            # NOTE: writing the OAuth token to disk in plaintext is a v1.0
            # shortcut. v1.1 must encrypt or move to a secret store. Render
            # disk is already private but multi-tenant means we don't want
            # an accidental ``ls`` to leak someone else's token.
            "gh_token": tenant.gh_token,
            # Webhook secret: same sensitivity class as the token. Stays
            # on disk (gitignored via tenant.json) and never goes to_dict.
            "gh_webhook_secret": tenant.gh_webhook_secret,
            "gh_repo": tenant.gh_repo,
            "gh_default_branch": tenant.gh_default_branch,
            "git_last_synced_at": tenant.git_last_synced_at,
            "git_last_error": tenant.git_last_error,
            "git_pushes_made": tenant.git_pushes_made,
            "created_at": tenant.created_at,
            "updated_at": tenant.updated_at,
            "is_demo": tenant.is_demo,
            "visibility": tenant.visibility,
        }
        meta_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        try:
            os.chmod(meta_path, 0o600)
        except OSError:
            pass  # not all FSes support chmod (e.g. windows)

    def delete(self, tenant_id: str) -> bool:
        """Wipe a tenant: remove the on-disk directory and drop it from
        the in-memory registry.

        Returns True if a real tenant was deleted, False if the id
        didn't resolve to a real (non-default) tenant. The default
        tenant is *never* deletable — in single-tenant mode it's the
        only tenant; in multi-tenant mode it's an unused fallback that
        shouldn't be removable by a user-driven flow.

        Safety: we resolve the tenant root real-path and verify it
        actually lives under ``tenants_root`` before recursive-delete.
        That defends against a malformed ``tenant.json`` pointing
        ``wiki_root`` at, say, ``/``. ``shutil.rmtree`` does not follow
        symlinks by default (``follow_symlinks=False`` is the default
        behavior on POSIX onerror semantics; we additionally check
        before invoking).
        """
        import shutil

        if tenant_id == self._default_tenant_id:
            return False
        with self._lock:
            tenant = self._tenants.get(tenant_id)
            if tenant is None:
                return False
            root = tenant.wiki_root
            try:
                resolved = root.resolve(strict=False)
            except OSError:
                resolved = root
            tenants_root = settings._base.tenants_root.resolve(strict=False)
            # Refuse to recurse outside the tenants_root sandbox. This
            # is the line of defense against a malformed tenant.json.
            if not str(resolved).startswith(str(tenants_root) + os.sep):
                # Drop from memory but don't touch disk.
                self._tenants.pop(tenant_id, None)
                return True
            if resolved.exists() and resolved.is_dir():
                shutil.rmtree(resolved, ignore_errors=True)
            self._tenants.pop(tenant_id, None)
            return True

    def provision_local(
        self,
        tenant_id: str,
        *,
        display_name: str = "",
        gh_login: str = "",
        gh_user_id: int = 0,
        gh_token: str = "",
        is_demo: bool = False,
    ) -> Tenant:
        """Create a new tenant with an empty wiki dir on local disk.

        Caller is responsible for seeding the wiki/ content afterwards
        (e.g. via the onboarding import flow).
        """
        root = settings._base.tenants_root / tenant_id
        (root / "wiki").mkdir(parents=True, exist_ok=True)
        (root / "raw").mkdir(parents=True, exist_ok=True)
        tenant = Tenant(
            id=tenant_id,
            wiki_root=root,
            display_name=display_name or tenant_id,
            gh_login=gh_login,
            gh_user_id=gh_user_id,
            gh_token=gh_token,
            is_demo=is_demo,
        )
        return self.upsert(tenant)


# Module-level manager. Loaded on first access (lazy).
_manager = TenantManager()


def manager() -> TenantManager:
    return _manager
