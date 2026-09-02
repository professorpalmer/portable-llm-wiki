"""Selective Forgetting-style importance scoring (arXiv 2608.28978).

Paper Experiment 2: recency + frequency + centrality + age, then prune the
low-importance tail. For this wiki that is RANKING + lint suggestion — never
silent deletion, never entity-extraction Graph RAG.

Access counts live in a gitignored sidecar next to the tenant wiki root so
hits never dirty markdown or the tracked worktree.
"""
from __future__ import annotations

import json
import math
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from .config import settings


RECENCY_WEIGHT = 0.35
FREQUENCY_WEIGHT = 0.25
CENTRALITY_WEIGHT = 0.20
FRESHNESS_WEIGHT = 0.20
RECENCY_HALF_LIFE_DAYS = 90.0
FRESHNESS_HALF_LIFE_DAYS = 365.0
DORMANT_SCORE_MAX = 0.10

_LOCK = threading.Lock()


@dataclass(frozen=True)
class AccessRecord:
    hits: int = 0
    last_accessed_at: str | None = None


@dataclass(frozen=True)
class ImportanceBreakdown:
    recency: float
    frequency: float
    centrality: float
    freshness: float
    score: float


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def exponential_decay(days: float, half_life_days: float) -> float:
    """exp(-ln(2) * days / half_life). 0 days → 1; one half-life → 0.5."""
    if days <= 0:
        return 1.0
    if half_life_days <= 0:
        return 0.0
    return _clamp01(math.exp(-math.log(2.0) * days / half_life_days))


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        dt = None
        for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%S", "%Y/%m/%d"):
            try:
                dt = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        if dt is None:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _days_since(value: str | None, now: datetime) -> float | None:
    dt = _parse_timestamp(value)
    if dt is None:
        return None
    return max(0.0, (now - dt).total_seconds() / 86400.0)


def _log1p_ratio(value: int, maximum: int) -> float:
    if maximum <= 0 or value <= 0:
        return 0.0
    return _clamp01(math.log1p(value) / math.log1p(maximum))


def _as_access_record(value: object) -> AccessRecord:
    if isinstance(value, AccessRecord):
        return value
    if not isinstance(value, Mapping):
        return AccessRecord()
    hits_raw = value.get("hits", 0)
    try:
        hits = int(hits_raw or 0)
    except (TypeError, ValueError):
        hits = 0
    if hits < 0:
        hits = 0
    last = value.get("last_accessed_at")
    last_s = str(last) if last else None
    return AccessRecord(hits=hits, last_accessed_at=last_s)


def _page_degree(page: Any) -> int:
    links_in = getattr(page, "links_in", None) or []
    links_out = getattr(page, "links_out", None) or []
    return len(links_in) + len(links_out)


def score_page(
    page: Any,
    access: AccessRecord | Mapping[str, Any] | None = None,
    *,
    max_hits: int,
    max_degree: int,
    now: datetime | None = None,
) -> ImportanceBreakdown:
    """Pure page score. No I/O. Components and total are clamped to [0, 1]."""
    clock = now or datetime.now(timezone.utc)
    rec = _as_access_record(access)
    created = getattr(page, "created", None)
    updated = getattr(page, "updated", None)

    recency_src = rec.last_accessed_at or updated or created
    recency_days = _days_since(recency_src, clock)
    recency = (
        0.0
        if recency_days is None
        else exponential_decay(recency_days, RECENCY_HALF_LIFE_DAYS)
    )

    frequency = _log1p_ratio(rec.hits, max_hits)

    centrality = _log1p_ratio(_page_degree(page), max_degree)

    freshness_src = updated or created
    freshness_days = _days_since(freshness_src, clock)
    freshness = (
        0.0
        if freshness_days is None
        else exponential_decay(freshness_days, FRESHNESS_HALF_LIFE_DAYS)
    )

    recency = _clamp01(recency)
    frequency = _clamp01(frequency)
    centrality = _clamp01(centrality)
    freshness = _clamp01(freshness)
    score = _clamp01(
        RECENCY_WEIGHT * recency
        + FREQUENCY_WEIGHT * frequency
        + CENTRALITY_WEIGHT * centrality
        + FRESHNESS_WEIGHT * freshness
    )
    return ImportanceBreakdown(
        recency=recency,
        frequency=frequency,
        centrality=centrality,
        freshness=freshness,
        score=score,
    )


def score_pages(
    pages: Iterable[Any],
    access_map: Mapping[str, AccessRecord | Mapping[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, ImportanceBreakdown]:
    """Score a corpus. max_hits and max_degree are computed once."""
    page_list = list(pages)
    records = access_map or {}
    clock = now or datetime.now(timezone.utc)
    max_hits = 0
    max_degree = 0
    for page in page_list:
        rec = _as_access_record(records.get(getattr(page, "slug", "")))
        if rec.hits > max_hits:
            max_hits = rec.hits
        degree = _page_degree(page)
        if degree > max_degree:
            max_degree = degree
    out: dict[str, ImportanceBreakdown] = {}
    for page in page_list:
        slug = getattr(page, "slug", "")
        out[slug] = score_page(
            page,
            records.get(slug),
            max_hits=max_hits,
            max_degree=max_degree,
            now=clock,
        )
    return out


def _access_path() -> Path:
    return settings.wiki_root / ".page-access.json"


def _ensure_sidecar_ignored() -> None:
    """Append .page-access.json to the wiki-root gitignore if missing.

    Hosted bootstrap also writes this via persistence._ensure_tenant_gitignore.
    Query-path writes still have to cover existing clones that never re-bootstrap.
    """
    try:
        gi = settings.wiki_root / ".gitignore"
        existing = gi.read_text(encoding="utf-8") if gi.exists() else ""
        rules = {line.strip() for line in existing.splitlines()}
        if ".page-access.json" in rules:
            return
        addendum = (
            ("\n" if existing and not existing.endswith("\n") else "")
            + "# Page access counters are runtime bookkeeping, not wiki content.\n"
            + ".page-access.json\n"
        )
        gi.write_text(existing + addendum, encoding="utf-8")
    except OSError:
        return


def _read_raw() -> dict[str, dict]:
    path = _access_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict] = {}
    for key, val in raw.items():
        if isinstance(val, dict):
            out[str(key)] = val
    return out


def _write_raw(data: dict[str, dict]) -> None:
    path = _access_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_access() -> dict[str, AccessRecord]:
    """Fail-soft read of the access sidecar. Never raises."""
    try:
        with _LOCK:
            raw = _read_raw()
        return {slug: _as_access_record(val) for slug, val in raw.items()}
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return {}


def record_access(slugs: Iterable[str], now: datetime | None = None) -> None:
    """Increment hits and stamp last_accessed_at. Never raises. Never writes markdown."""
    try:
        wanted = [str(s) for s in slugs if s]
        if not wanted:
            return
        stamp = (now or datetime.now(timezone.utc)).isoformat()
        with _LOCK:
            raw = _read_raw()
            for slug in wanted:
                rec = _as_access_record(raw.get(slug))
                raw[slug] = {
                    "hits": rec.hits + 1,
                    "last_accessed_at": stamp,
                }
            _ensure_sidecar_ignored()
            _write_raw(raw)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return
