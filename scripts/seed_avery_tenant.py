#!/usr/bin/env python3
"""Seed the Avery Chen demo tenant for the hosted multi-tenant mode.

Run from the repo root:

    python scripts/seed_avery_tenant.py            # idempotent
    python scripts/seed_avery_tenant.py --force    # wipe + recopy

It copies every markdown file under ``wiki-demo/wiki/`` into
``<TENANTS_ROOT>/avery/wiki/`` and writes a ``tenant.json`` that
:class:`app.tenants.TenantManager` will pick up on next boot. Used by
the Render build step (see ``render.yaml``) so a deploy with
``SINGLE_TENANT_MODE=0`` always has a public ``/avery`` demo.

``TENANTS_ROOT`` defaults to ``<repo>/data/tenants`` when unset, so you
can dry-run the script locally without touching the production layout.

The actual seeding logic lives in :mod:`app.avery_seed` so the same
code path runs from this script AND from the backend startup hook.
That keeps the two entrypoints from drifting out of sync.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# This script lives at <repo>/scripts/seed_avery_tenant.py. The
# backend package is at <repo>/backend/app, so insert <repo>/backend
# into sys.path before importing.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_BACKEND_DIR = _REPO_ROOT / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.avery_seed import (  # noqa: E402 — sys.path mutation above
    find_demo_wiki_dir,
    resolve_tenants_root,
    seed_avery_tenant,
)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Seed the Avery Chen demo tenant for multi-tenant deploys.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Wipe any existing <TENANTS_ROOT>/avery/wiki/ and recopy from wiki-demo/.",
    )
    p.add_argument(
        "--tenants-root",
        type=Path,
        default=None,
        help=(
            "Override TENANTS_ROOT. Defaults to $TENANTS_ROOT, then "
            "<repo>/data/tenants when neither is set."
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    tenants_root = resolve_tenants_root(args.tenants_root)
    demo_wiki_dir = find_demo_wiki_dir(_REPO_ROOT)
    if demo_wiki_dir is None:
        print(
            f"[seed-avery] ERROR: wiki-demo/wiki/ not found under {_REPO_ROOT}. "
            "Nothing to copy. Aborting.",
            file=sys.stderr,
        )
        return 2

    try:
        result = seed_avery_tenant(tenants_root, demo_wiki_dir, force=args.force)
    except FileNotFoundError as exc:
        print(f"[seed-avery] ERROR: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"[seed-avery] ERROR: {exc}", file=sys.stderr)
        return 3

    # Print as a single human-readable line; CI / Render logs are
    # easier to grep this way than a multi-line block.
    print(
        f"[seed-avery] {result['action']}: {result['message']} "
        f"(files_copied={result['files_copied']}, path={result['path']})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
