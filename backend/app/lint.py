"""Wiki lint: surface contradictions, stale claims, orphans, missing pages,
broken provenance, missing index entries.

The prototype implements deterministic structural checks. Semantic checks
(contradictions, stale claims that need LLM judgment) are left as a v2.
"""
from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .config import settings
from .wiki import LinkResolver, Page, _slugify, _strip_date_prefix, index


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _orphan_pages(pages: list[Page]) -> list[dict]:
    out: list[dict] = []
    for p in pages:
        if p.section in ("root", "queries"):
            continue
        if not p.links_in:
            out.append({"slug": p.slug, "title": p.title, "section": p.section})
    return out


def _stale_pages(pages: list[Page], days: int = 30) -> list[dict]:
    now = datetime.now(timezone.utc)
    out: list[dict] = []
    for p in pages:
        dt = _parse_date(p.updated) or _parse_date(p.created)
        if dt is None:
            continue
        age_days = (now - dt).days
        if age_days > days:
            out.append(
                {
                    "slug": p.slug,
                    "title": p.title,
                    "age_days": age_days,
                    "last_dated": (p.updated or p.created),
                }
            )
    out.sort(key=lambda r: r["age_days"], reverse=True)
    return out


_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")


def _missing_pages(pages: list[Page], min_mentions: int = 3) -> list[dict]:
    """Wikilink targets that don't resolve to a real page but are mentioned a lot.

    ``index.reload()`` overwrites ``page.links_out`` with the *resolved* target
    slugs, so counting those and comparing against titles reports links that
    resolved fine (slug != title) — the inverse of the intent. Instead we
    re-extract the raw ``[[target]]`` strings from each body and keep only those
    that resolve to no existing page under the shared slug/date normalization
    (``wiki.LinkResolver``): the genuinely dangling links.
    """
    resolver = LinkResolver(pages)
    counter: Counter[str] = Counter()
    for p in pages:
        for match in _WIKILINK_RE.finditer(p.body):
            target = match.group(1).strip()
            if resolver.resolves(target):
                continue
            counter[target] += 1
    candidates = [
        {"title": target, "mentions": count}
        for target, count in counter.items()
        if count >= min_mentions
    ]
    candidates.sort(key=lambda r: r["mentions"], reverse=True)
    return candidates


def _broken_provenance(pages: list[Page]) -> list[dict]:
    out: list[dict] = []
    for p in pages:
        for src in p.sources:
            target = settings.wiki_root / src
            if not target.exists():
                out.append({"slug": p.slug, "title": p.title, "missing_source": src})
    return out


def _missing_index_entries(pages: list[Page]) -> list[dict]:
    index_path = settings.wiki_dir / "index.md"
    if not index_path.exists():
        return [{"reason": "no index.md found"}]
    text = index_path.read_text(encoding="utf-8")
    # Normalize every wikilink target in index.md to a set of comparable keys
    # (verbatim, slugified, and date-stripped) so a page counts as "listed"
    # regardless of whether the index references it by title, slug, or a
    # dated display form. Prevents false "missing from index" on dated pages.
    indexed: set[str] = set()
    for match in _WIKILINK_RE.finditer(text):
        target = match.group(1).strip()
        indexed.add(target.lower())
        indexed.add(_slugify(target))
        indexed.add(_slugify(_strip_date_prefix(target)))
    out: list[dict] = []
    for p in pages:
        if p.slug == "index" or p.section in ("sources",):
            continue
        if p.section == "root":
            continue
        forms = {
            p.title.lower(),
            p.slug.lower(),
            _slugify(p.title),
            _slugify(p.slug),
            _slugify(_strip_date_prefix(p.title)),
            _slugify(_strip_date_prefix(p.slug)),
        }
        if forms.isdisjoint(indexed):
            out.append({"slug": p.slug, "title": p.title, "section": p.section})
    return out


def lint_wiki() -> dict:
    pages = index.all_pages()
    return {
        "totals": {
            "pages": len(pages),
            "by_section": dict(Counter(p.section for p in pages)),
            "by_tier": dict(Counter(p.tier for p in pages)),
        },
        "orphans": _orphan_pages(pages),
        "stale": _stale_pages(pages),
        "missing_pages": _missing_pages(pages),
        "broken_provenance": _broken_provenance(pages),
        "missing_index_entries": _missing_index_entries(pages),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
