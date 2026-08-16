"""Deterministic private starter wiki for empty post-connect tenants.

A 0-page tenant after a successful ``/onboarding/connect-repo`` is a
failed signup: the user has a login, not a wiki. This module writes a
tiny, LLM-free starter — a purpose page plus a how-to-ingest page —
so ``GET /t/{id}/wiki/manifest.json`` reports ``page_count >= 1``.

Rules:

* Never overwrite existing pages. If bootstrap cloned or imported a
  wiki that already has markdown, do nothing.
* Never clone the Avery Chen 29-page demo. These two pages are generic
  onboarding copy, not a persona snapshot.
* Pages are ``tier: private`` with valid frontmatter the wiki index
  can load.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .tenants import Tenant

log = logging.getLogger(__name__)

# Fixed stamp so every empty tenant gets byte-identical starter files.
STARTER_DATE = "2026-08-16"

STARTER_PAGES: tuple[tuple[str, str, str], ...] = (
    (
        "purpose.md",
        "Purpose",
        """# Purpose

This is your Portable LLM Wiki — a git-backed markdown corpus that any
LLM client can query. Pages live in your GitHub repo as plain files.
You own them.

The wiki is private until you promote a page. Start by adding a first
source on the welcome assemble step (a short bio, a resume, a URL, or
an existing markdown wiki). The drafter turns that into linked pages.

## What belongs here

- **Entities**: people, companies, products
- **Concepts**: operating principles and ways of thinking
- **Decisions**: choices with rationale
- **Projects**: what you are shipping
- **Sources**: the raw material those pages were derived from

See [[How to ingest]] for the concrete next step.
""",
    ),
    (
        "how-to-ingest.md",
        "How to ingest",
        """# How to ingest

A wiki with no sources stays a shell. Add material, then let the
drafter (or your own edits) turn it into pages.

## First source

On `/welcome`, use **Assemble starter wiki**:

1. Answer one or two interview questions, or
2. Paste a resume / LinkedIn About / README, or
3. Add a URL to scrape

Submit the bundle. Pages land in this repo automatically.

## Other paths

- **Import existing wiki** — paste a GitHub URL to a markdown wiki
- **Owner console** — capture a file or conversation later
- **Edit in git** — clone the repo and write markdown yourself

Every ingest should cite where the claim came from. Prefer verbatim
source files under `raw/` over reconstructed memory.

This wiki's [[Purpose]] page is the other half of the starter set.
""",
    ),
)


def count_wiki_pages(tenant: Tenant) -> int:
    """Count ``*.md`` files under ``tenant.wiki_dir``.

    Matches :func:`app.hosted_routes._count_tenant_pages` so the seeder
    and ``/auth/me`` agree on "empty".
    """
    wiki_dir = tenant.wiki_dir
    try:
        if not wiki_dir.exists():
            return 0
        return sum(1 for _ in wiki_dir.rglob("*.md"))
    except OSError:
        return 0


def _render_page(title: str, body: str) -> str:
    return (
        "---\n"
        "type: overview\n"
        f"title: {title}\n"
        f"created: {STARTER_DATE}\n"
        f"updated: {STARTER_DATE}\n"
        "tier: private\n"
        "sources: []\n"
        "tags: [meta, onboarding]\n"
        "---\n\n"
        + body.strip()
        + "\n"
    )


def _write_starter_page(wiki_dir: Path, filename: str, title: str, body: str) -> Path | None:
    """Write one starter page. Returns the path, or None if it already exists."""
    target = wiki_dir / filename
    if target.exists():
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_render_page(title, body), encoding="utf-8")
    return target


def seed_starter_wiki(tenant: Tenant) -> dict:
    """Write the private starter wiki if ``tenant`` currently has 0 pages.

    Returns a JSON-safe dict for the connect-repo response::

        {"action": "seeded"|"skipped"|"error", "pages": [...], "page_count": int, ...}

    Never raises — connect-repo already succeeded; a seed failure must
    not turn that into a 500. Local files still count even if the
    in-memory index reload fails.
    """
    existing = count_wiki_pages(tenant)
    if existing > 0:
        return {
            "action": "skipped",
            "reason": "existing_pages",
            "pages": [],
            "page_count": existing,
        }

    written: list[str] = []
    try:
        wiki_dir = tenant.wiki_dir
        wiki_dir.mkdir(parents=True, exist_ok=True)
        for filename, title, body in STARTER_PAGES:
            path = _write_starter_page(wiki_dir, filename, title, body)
            if path is not None:
                written.append(path.name)
    except Exception as exc:  # noqa: BLE001 — seed must not fail connect
        log.exception("starter seed failed for tenant %s", getattr(tenant, "id", "?"))
        return {
            "action": "error",
            "error": str(exc)[:200],
            "pages": written,
            "page_count": count_wiki_pages(tenant),
        }

    if not written:
        return {
            "action": "skipped",
            "reason": "starter_files_already_present",
            "pages": [],
            "page_count": count_wiki_pages(tenant),
        }

    try:
        tenant.reload_index()
    except Exception as exc:  # noqa: BLE001 — disk is source of truth
        log.warning(
            "starter seed wrote pages for %s but index reload failed: %s",
            getattr(tenant, "id", "?"),
            exc,
        )

    return {
        "action": "seeded",
        "pages": written,
        "page_count": count_wiki_pages(tenant),
    }
