"""Wiki lint: surface contradictions, stale claims, orphans, missing pages,
broken provenance, missing index entries.

The prototype implements deterministic structural checks. Semantic checks
(contradictions, stale claims that need LLM judgment) are left as a v2.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .config import settings
from .wiki import Page, index


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


def _missing_pages(pages: list[Page], min_mentions: int = 3) -> list[dict]:
    """Wikilink targets that don't resolve to a real page but are mentioned a lot."""
    counter: Counter[str] = Counter()
    have_titles = {p.title.lower() for p in pages}
    for p in pages:
        for target in p.links_out:
            counter[target] += 1
    candidates: list[dict] = []
    for title, count in counter.items():
        if title.lower() in have_titles:
            continue
        if count >= min_mentions:
            candidates.append({"title": title, "mentions": count})
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
    text = index_path.read_text(encoding="utf-8").lower()
    out: list[dict] = []
    for p in pages:
        if p.slug == "index" or p.section in ("sources",):
            continue
        if p.section == "root":
            continue
        if f"[[{p.title.lower()}]]" not in text:
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
