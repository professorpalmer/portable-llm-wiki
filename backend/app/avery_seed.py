"""Avery Chen demo-tenant seeder.

Used in two places:

* ``scripts/seed_avery_tenant.py`` — CLI entrypoint invoked by the Render
  build step (and runnable locally) to populate
  ``<TENANTS_ROOT>/avery/`` from the ``wiki-demo/wiki/`` source tree.
* :func:`auto_seed_if_missing` — called from :mod:`app.main` during
  multi-tenant startup, so a fresh Render container (where the build
  step may not have wired the script in) still ends up with a working
  ``/avery`` demo. Conservative: never raises, never overwrites.

The seeded layout matches what :mod:`app.tenants` expects:

    <TENANTS_ROOT>/avery/
        tenant.json   # metadata loaded by TenantManager.load_from_disk
        wiki/         # markdown pages (copied from wiki-demo/wiki/)
        raw/          # empty; demo tenant has no captured sources

Idempotency rule of thumb: if ``<TENANTS_ROOT>/avery/wiki/`` already
exists, do nothing. The demo is meant to be a frozen snapshot — we never
want a redeploy to silently overwrite an operator's local tweaks. The
explicit ``--force`` CLI flag is the only way to re-sync.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# Public ID and metadata for the demo tenant. Kept here (not in tenants.py)
# because tenants.py is meant to be content-agnostic — it shouldn't know
# that "avery" is special. The seeder is the one place that does.
AVERY_TENANT_ID = "avery"
AVERY_DISPLAY_NAME = "Avery Chen (demo)"


def repo_root_from_module() -> Path:
    """Best-effort repo root, inferred from this file's location.

    ``backend/app/avery_seed.py`` lives two parents under the repo root.
    Used as a fallback when callers don't pass an explicit ``repo_root``.
    """
    return Path(__file__).resolve().parents[2]


def find_demo_wiki_dir(repo_root: Optional[Path] = None) -> Optional[Path]:
    """Locate ``<repo>/wiki-demo/wiki/`` if it exists, else None.

    Returning None (rather than raising) lets callers decide what to do
    when the demo source isn't present — e.g. a deploy that stripped
    ``wiki-demo/`` to slim down the image should still boot fine.
    """
    root = repo_root or repo_root_from_module()
    candidate = root / "wiki-demo" / "wiki"
    if candidate.is_dir():
        return candidate
    return None


def _default_tenants_root() -> Path:
    """Where the CLI seeds when ``TENANTS_ROOT`` is unset.

    Matches the convention in ``app/config.py``: tenants live under a
    sibling ``tenants/`` dir next to the repo. For the CLI we prefer
    ``<repo>/data/tenants`` so a developer running the script locally
    gets a self-contained playground without trampling system paths.
    """
    return repo_root_from_module() / "data" / "tenants"


def resolve_tenants_root(explicit: Optional[Path] = None) -> Path:
    """Resolve the tenants root, honoring (in order) the explicit arg,
    the ``TENANTS_ROOT`` env var, then the default.

    Centralized so both the CLI and the startup hook agree on the lookup
    rule. The startup hook normally passes ``settings._base.tenants_root``
    explicitly — this function only matters for the CLI path.
    """
    if explicit is not None:
        return Path(explicit).expanduser().resolve()
    env_val = os.environ.get("TENANTS_ROOT", "").strip()
    if env_val:
        return Path(env_val).expanduser().resolve()
    return _default_tenants_root()


def _tenant_metadata(now_iso: str) -> dict:
    """The ``tenant.json`` payload for the Avery demo.

    Fields mirror :class:`app.tenants.Tenant` (and what TenantManager
    reads back in ``_tenant_from_json``). Keep them in sync if either
    side adds new fields — old seeds will still load (extras are
    ignored, missing fields use defaults).
    """
    return {
        "id": AVERY_TENANT_ID,
        "display_name": AVERY_DISPLAY_NAME,
        "gh_login": "",
        "gh_user_id": 0,
        # No OAuth token: this is a frozen public demo, no GitHub
        # mirroring. If somebody later wants to back the demo with a
        # real repo they can rotate this field in by hand.
        "gh_token": "",
        "gh_repo": "",
        "gh_default_branch": "main",
        "created_at": now_iso,
        "updated_at": now_iso,
        "is_demo": True,
        "visibility": "public",
    }


def _copy_demo_tree(src_wiki_dir: Path, dst_wiki_dir: Path) -> int:
    """Copy every ``*.md`` from src to dst, preserving relative subdirs.

    Returns the number of files copied. We intentionally do NOT use
    ``shutil.copytree(...)`` so we can:
      * Restrict to markdown (no stray ``.DS_Store`` / ``__pycache__``).
      * Count files for the caller's print/return summary.
      * Keep the operation idempotent at the file level (we recreate
        the dest tree from scratch — caller guarantees the dest is
        empty or wants a forced overwrite).
    """
    count = 0
    for md_path in sorted(src_wiki_dir.rglob("*.md")):
        rel = md_path.relative_to(src_wiki_dir)
        target = dst_wiki_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(md_path, target)
        count += 1
    return count


def seed_avery_tenant(
    tenants_root: Path,
    demo_wiki_dir: Path,
    *,
    force: bool = False,
) -> dict:
    """Materialize the Avery demo tenant on disk.

    Layout produced::

        <tenants_root>/avery/
            tenant.json
            wiki/           # md files copied from demo_wiki_dir
            raw/            # empty placeholder

    Args:
        tenants_root: Base directory under which ``avery/`` is created.
        demo_wiki_dir: Source markdown tree (typically
            ``<repo>/wiki-demo/wiki/``). Must exist and contain at
            least one ``*.md`` — otherwise we treat it as a config
            error and raise (the CLI surfaces a clear exit code; the
            startup hook catches and logs).
        force: If True, wipe ``<tenants_root>/avery/`` and rewrite.
            Used by the CLI's ``--force`` flag. Never set this from
            the startup hook.

    Returns:
        A dict describing what happened. Keys:
            action:        "created" | "skipped" | "forced"
            path:          str path of ``<tenants_root>/avery``
            files_copied:  int  (0 when action == "skipped")
            message:       human-readable summary

    Raises:
        FileNotFoundError: ``demo_wiki_dir`` does not exist.
        ValueError: ``demo_wiki_dir`` is empty (no ``.md`` files).
    """
    tenants_root = Path(tenants_root).expanduser().resolve()
    demo_wiki_dir = Path(demo_wiki_dir).expanduser().resolve()

    if not demo_wiki_dir.is_dir():
        raise FileNotFoundError(f"demo wiki dir not found: {demo_wiki_dir}")

    tenant_dir = tenants_root / AVERY_TENANT_ID
    wiki_dir = tenant_dir / "wiki"
    raw_dir = tenant_dir / "raw"
    meta_path = tenant_dir / "tenant.json"

    if wiki_dir.exists() and not force:
        return {
            "action": "skipped",
            "path": str(tenant_dir),
            "files_copied": 0,
            "message": (
                f"avery wiki dir already exists at {wiki_dir} — skipping. "
                "Use --force to overwrite."
            ),
        }

    # Force path: wipe the wiki/ subtree but keep raw/ around if it
    # has user-generated content. We never touch raw/ contents because
    # the demo doesn't ship any, and trampling user data on a --force
    # rebuild would be the wrong default.
    if force and wiki_dir.exists():
        shutil.rmtree(wiki_dir)

    tenants_root.mkdir(parents=True, exist_ok=True)
    tenant_dir.mkdir(parents=True, exist_ok=True)
    wiki_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    files_copied = _copy_demo_tree(demo_wiki_dir, wiki_dir)
    if files_copied == 0:
        # The source dir exists but had no .md files. That's almost
        # certainly a misconfigured deploy — fail loud rather than
        # leaving an empty demo tenant that 404s on every request.
        raise ValueError(
            f"demo wiki dir {demo_wiki_dir} contains no .md files; refusing to seed empty tenant"
        )

    now_iso = datetime.now(timezone.utc).isoformat()
    meta = _tenant_metadata(now_iso)
    # If forcing over an existing tenant, preserve the original
    # created_at so the audit trail stays honest.
    if force and meta_path.exists():
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(existing.get("created_at"), str) and existing["created_at"]:
                meta["created_at"] = existing["created_at"]
        except Exception:  # noqa: BLE001 — corrupt metadata, just rewrite
            pass

    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return {
        "action": "forced" if force else "created",
        "path": str(tenant_dir),
        "files_copied": files_copied,
        "message": (
            f"{'force-seeded' if force else 'seeded'} avery tenant at {tenant_dir} "
            f"with {files_copied} markdown file(s)"
        ),
    }


def auto_seed_if_missing(
    tenants_root: Optional[Path] = None,
    repo_root: Optional[Path] = None,
) -> dict:
    """Conservative startup hook: seed Avery iff safe to do so.

    Called from ``app.main._lifespan`` *before*
    ``TenantManager.load_from_disk()`` so the manager picks up the
    freshly-seeded tenant on the very first request.

    Contract:
      * Never raises. Catches everything and returns a diagnostic dict.
      * Never overwrites an existing ``<tenants_root>/avery/wiki/``.
        Idempotent across container restarts.
      * Skips quietly when ``wiki-demo/wiki/`` is not present (e.g. a
        slim production image that stripped the demo).

    Returns a small status dict so the caller can log it. The keys
    match :func:`seed_avery_tenant`, plus a possible
    ``action == "noop"`` when the demo source isn't there.
    """
    try:
        if tenants_root is None:
            tenants_root = resolve_tenants_root()
        else:
            tenants_root = Path(tenants_root).expanduser().resolve()

        demo_wiki_dir = find_demo_wiki_dir(repo_root)
        if demo_wiki_dir is None:
            return {
                "action": "noop",
                "path": str(tenants_root / AVERY_TENANT_ID),
                "files_copied": 0,
                "message": "wiki-demo/wiki/ not found in repo; skipping avery seed",
            }

        return seed_avery_tenant(tenants_root, demo_wiki_dir, force=False)
    except Exception as exc:  # noqa: BLE001 — startup hook must never crash
        log.warning("avery auto-seed failed: %s", exc, exc_info=True)
        return {
            "action": "error",
            "path": "",
            "files_copied": 0,
            "message": f"auto-seed error (suppressed): {exc!r}",
        }
