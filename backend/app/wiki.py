"""Wiki loader: scans the markdown corpus, builds an in-memory index.

Pages are organized by type (entities, concepts, decisions, sources, queries,
projects, overview). Tier comes from frontmatter; pages without an explicit
tier fall back to settings.default_tier (default "private") so nothing leaks
unintentionally.
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import frontmatter

from .config import TIER_ORDER, VALID_TIERS, settings
from .importance import load_access, score_pages

# How long a freshness verdict is trusted before we re-walk the corpus.
# Under load, ``reload_if_stale`` would otherwise rglob+stat every markdown
# file on EVERY read request; bounding it to one scan per interval turns an
# O(pages) per-request cost into an amortized near-zero one. Writes call
# ``reload()`` directly, so post-mutation freshness is unaffected. Tunable
# via env for very-large or very-hot wikis.
_STALE_CHECK_INTERVAL_S: float = float(
    os.environ.get("WIKI_STALE_CHECK_INTERVAL_S", "2") or "2"
)

WIKILINK_RE = re.compile(r"\[\[([^\]\|]+?)(?:\|([^\]]+))?\]\]")
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_TITLE_PHRASE_PER_WORD = 40.0
_SLUG_PHRASE_BONUS = 40.0
PAGE_TYPES = (
    "entity",
    "concept",
    "decision",
    "source",
    "query",
    "project",
    "overview",
)


def _slugify(title: str) -> str:
    s = title.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def _tokens(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def _folded_text(text: str) -> str:
    return " ".join(_tokens(text))


def _best_ngram_bonus(query_folded: str, words: list[str]) -> float:
    for n in range(min(4, len(words)), 1, -1):
        for i in range(len(words) - n + 1):
            phrase = " ".join(words[i : i + n])
            if phrase in query_folded:
                return _TITLE_PHRASE_PER_WORD * n
    return 0.0


def _phrase_bonus(query_folded: str, title: str, slug: str) -> float:
    """Boost pages whose multi-word title or slug appears in the query.

    Unigram scoring on long questions otherwise ranks huge hub bodies
    above the page the question named.
    """
    if not query_folded:
        return 0.0
    bonus = _best_ngram_bonus(query_folded, _tokens(title))
    slug_words = [part for part in slug.lower().split("-") if part]
    if len(slug_words) >= 2 and " ".join(slug_words) in query_folded:
        bonus = max(bonus, _SLUG_PHRASE_BONUS)
    elif slug_words:
        bonus = max(bonus, _best_ngram_bonus(query_folded, slug_words))
    return bonus


# Dated pages (decisions, sources) carry a ``YYYY-MM-DD`` filename/slug prefix
# but are routinely linked by a human "2026-07-01 Title" display form — or by an
# undated title, or by the bare slug. Strip a leading ISO date (``-`` or
# whitespace separated) so every form normalizes to the same key.
_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[-\s]+")


def _strip_date_prefix(text: str) -> str:
    return _DATE_PREFIX_RE.sub("", text.strip())


class LinkResolver:
    """Resolve a raw ``[[target]]`` string to a canonical page slug, tolerant of
    the slug-vs-title and date-prefix display forms that pervade the corpus.

    A target resolves (in priority order) to a page whose:
      * title matches verbatim (case-insensitive), or
      * slug matches verbatim, or
      * slugified title/slug matches the slugified target — so
        ``[[Jeppesen ForeFlight]]`` finds slug ``jeppesen-foreflight`` and
        ``[[project-compass]]`` finds title ``Project Compass``, or
      * any of the above after stripping a leading ISO date prefix — so
        ``[[2026-07-01 Marionette Public Repo]]`` finds the dated page and an
        undated link finds a dated page.

    Exact title/slug matches always win over normalized ones; ambiguous
    normalized collisions resolve to the first page seen (insertion order).
    """

    def __init__(self, pages: Iterable["Page"]):
        self._by_title: dict[str, str] = {}
        self._by_slug: dict[str, str] = {}
        self._by_norm: dict[str, str] = {}
        for page in pages:
            self._by_title.setdefault(page.title.strip().lower(), page.slug)
            self._by_slug.setdefault(page.slug.strip().lower(), page.slug)
            for key in self._norm_keys(page.title) | self._norm_keys(page.slug):
                self._by_norm.setdefault(key, page.slug)

    @staticmethod
    def _norm_keys(text: str) -> set[str]:
        keys: set[str] = set()
        for candidate in (text, _strip_date_prefix(text)):
            slug = _slugify(candidate)
            if slug:
                keys.add(slug)
        return keys

    def resolve(self, target: str) -> str | None:
        key = target.strip().lower()
        if key in self._by_title:
            return self._by_title[key]
        if key in self._by_slug:
            return self._by_slug[key]
        undated = _strip_date_prefix(target).lower()
        if undated in self._by_title:
            return self._by_title[undated]
        for norm_key in self._norm_keys(target):
            if norm_key in self._by_norm:
                return self._by_norm[norm_key]
        return None

    def resolves(self, target: str) -> bool:
        return self.resolve(target) is not None


@dataclass
class Page:
    slug: str  # filename stem, e.g. "calibrated-honesty"
    title: str
    rel_path: str  # relative to wiki_root, e.g. "wiki/concepts/calibrated-honesty.md"
    section: str  # one of: entities, concepts, decisions, sources, queries, projects, root
    page_type: str
    tier: str
    created: str | None
    updated: str | None
    sources: list[str]
    tags: list[str]
    body: str  # markdown without frontmatter
    excerpt: str  # first ~280 chars of body (no headings, no wikilinks)
    links_out: list[str] = field(default_factory=list)  # other page titles linked from this page
    links_in: list[str] = field(default_factory=list)  # other page titles linking TO this page
    word_count: int = 0
    mtime: float = 0.0

    def to_summary(self, base_url: str = "") -> dict:
        return {
            "slug": self.slug,
            "title": self.title,
            "section": self.section,
            "type": self.page_type,
            "tier": self.tier,
            "created": self.created,
            "updated": self.updated,
            "tags": self.tags,
            "excerpt": self.excerpt,
            "word_count": self.word_count,
            "rel_path": self.rel_path,
            "url": f"{base_url}/wiki/page/{self.slug}" if base_url else f"/wiki/page/{self.slug}",
        }

    def to_full(self, base_url: str = "") -> dict:
        return {
            **self.to_summary(base_url=base_url),
            "body": self.body,
            "sources": self.sources,
            "links_out": self.links_out,
            "links_in": self.links_in,
        }


def _section_from_relpath(rel: Path) -> str:
    parts = rel.parts
    if len(parts) >= 2 and parts[0] == "wiki":
        if len(parts) == 2:
            return "root"
        return parts[1]  # entities | concepts | decisions | sources | queries | projects
    return "other"


def _infer_type(section: str, fm_type: str | None) -> str:
    if fm_type and fm_type.lower() in PAGE_TYPES:
        return fm_type.lower()
    mapping = {
        "entities": "entity",
        "concepts": "concept",
        "decisions": "decision",
        "sources": "source",
        "queries": "query",
        "projects": "project",
    }
    return mapping.get(section, "overview" if section == "root" else "other")


def _excerpt(body: str, max_chars: int = 280) -> str:
    cleaned_lines: list[str] = []
    for line in body.splitlines():
        ls = line.strip()
        if not ls:
            continue
        if ls.startswith("#"):
            continue
        if ls.startswith("---"):
            continue
        if ls.startswith(">"):
            ls = ls.lstrip("> ")
        cleaned_lines.append(ls)
    text = " ".join(cleaned_lines)
    text = WIKILINK_RE.sub(lambda m: m.group(2) or m.group(1), text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


def _extract_wikilink_titles(body: str) -> list[str]:
    titles: list[str] = []
    for match in WIKILINK_RE.finditer(body):
        title = match.group(1).strip()
        if title and title not in titles:
            titles.append(title)
    return titles


def _normalize_tier(value: object) -> str | None:
    if value is None:
        return None
    v = str(value).strip().lower()
    if v not in VALID_TIERS:
        return None
    return v


def _normalize_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        return [s]
    return [str(value)]


class WikiIndex:
    """Filesystem-backed wiki index. Reload when files change."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._pages_by_slug: dict[str, Page] = {}
        self._slug_by_title: dict[str, str] = {}
        self._last_scan: float = 0.0
        self._last_wiki_mtime: float = 0.0
        self._last_stale_check: float = 0.0

    # ---------- public API ----------

    @property
    def last_scan(self) -> float:
        return self._last_scan

    def reload_if_stale(self) -> None:
        # Debounce the full-tree mtime scan: at most one walk per
        # _STALE_CHECK_INTERVAL_S no matter the request rate. This is the
        # difference between "feels instant under a traffic spike" and
        # "stats the whole corpus on every page view".
        now = time.monotonic()
        if now - self._last_stale_check < _STALE_CHECK_INTERVAL_S:
            return
        self._last_stale_check = now
        latest = self._latest_mtime(settings.wiki_dir)
        if latest > self._last_wiki_mtime:
            self.reload()

    def reload(self) -> None:
        with self._lock:
            pages: dict[str, Page] = {}
            titles: dict[str, str] = {}

            if settings.wiki_dir.exists():
                for md_path in settings.wiki_dir.rglob("*.md"):
                    if md_path.name.startswith("."):
                        continue
                    try:
                        page = self._load_page(md_path)
                    except Exception as exc:  # noqa: BLE001
                        print(f"[wiki] skipping {md_path}: {exc}")
                        continue
                    pages[page.slug] = page
                    titles[page.title.lower()] = page.slug

            resolver = LinkResolver(pages.values())
            for slug, page in pages.items():
                resolved: list[str] = []
                for linked_title in page.links_out:
                    target_slug = resolver.resolve(linked_title)
                    if target_slug and target_slug != slug and target_slug not in resolved:
                        resolved.append(target_slug)
                page.links_out = resolved

            for slug, page in pages.items():
                for target_slug in page.links_out:
                    target = pages.get(target_slug)
                    if target and slug not in target.links_in:
                        target.links_in.append(slug)

            self._pages_by_slug = pages
            self._slug_by_title = titles
            self._last_scan = datetime.now(timezone.utc).timestamp()
            self._last_wiki_mtime = self._latest_mtime(settings.wiki_dir)

    def all_pages(self) -> list[Page]:
        return list(self._pages_by_slug.values())

    def visible_pages(self, viewer_tier: str) -> list[Page]:
        viewer_rank = TIER_ORDER.get(viewer_tier, 0)
        return [p for p in self._pages_by_slug.values() if TIER_ORDER[p.tier] <= viewer_rank]

    def get(self, slug: str) -> Page | None:
        return self._pages_by_slug.get(slug)

    def find_by_title(self, title: str) -> Page | None:
        slug = self._slug_by_title.get(title.lower())
        if not slug:
            return None
        return self._pages_by_slug.get(slug)

    # ---------- graph operations ----------

    def neighbors(self, slug: str, viewer_tier: str, hops: int = 1) -> list[str]:
        """Slugs reachable from `slug` within `hops` wikilink steps (in either
        direction). Tier-filtered."""
        if slug not in self._pages_by_slug:
            return []
        viewer_rank = TIER_ORDER.get(viewer_tier, 0)

        def visible(s: str) -> bool:
            p = self._pages_by_slug.get(s)
            return p is not None and TIER_ORDER[p.tier] <= viewer_rank

        visited: set[str] = {slug}
        frontier: deque[tuple[str, int]] = deque([(slug, 0)])
        out: list[str] = []
        while frontier:
            cur, d = frontier.popleft()
            if d >= hops:
                continue
            page = self._pages_by_slug.get(cur)
            if not page:
                continue
            for nbr in (*page.links_out, *page.links_in):
                if nbr in visited or not visible(nbr):
                    continue
                visited.add(nbr)
                out.append(nbr)
                frontier.append((nbr, d + 1))
        return out

    def subgraph(self, anchor_slugs: Iterable[str], viewer_tier: str, hops: int = 1) -> dict:
        """Build a connected subgraph rooted at `anchor_slugs`, expanded `hops`
        times. Returns {nodes: [...], edges: [...], anchors: [...]}."""
        viewer_rank = TIER_ORDER.get(viewer_tier, 0)
        anchors = [a for a in anchor_slugs if a in self._pages_by_slug]

        def visible(s: str) -> bool:
            p = self._pages_by_slug.get(s)
            return p is not None and TIER_ORDER[p.tier] <= viewer_rank

        included: set[str] = set(a for a in anchors if visible(a))
        frontier: deque[tuple[str, int]] = deque((a, 0) for a in included)
        while frontier:
            cur, d = frontier.popleft()
            if d >= hops:
                continue
            page = self._pages_by_slug.get(cur)
            if not page:
                continue
            for nbr in (*page.links_out, *page.links_in):
                if nbr in included or not visible(nbr):
                    continue
                included.add(nbr)
                frontier.append((nbr, d + 1))

        nodes: list[dict] = []
        edges: list[dict] = []
        seen_edge: set[tuple[str, str]] = set()
        for s in included:
            p = self._pages_by_slug[s]
            nodes.append(
                {
                    "slug": p.slug,
                    "title": p.title,
                    "section": p.section,
                    "tier": p.tier,
                    "is_anchor": s in anchors,
                    "degree": len(p.links_out) + len(p.links_in),
                }
            )
            for tgt in p.links_out:
                if tgt in included:
                    key = (p.slug, tgt)
                    if key not in seen_edge:
                        seen_edge.add(key)
                        edges.append({"source": p.slug, "target": tgt})
        return {"nodes": nodes, "edges": edges, "anchors": list(included & set(anchors))}

    def full_graph(self, viewer_tier: str) -> dict:
        return self.subgraph(
            anchor_slugs=[p.slug for p in self.visible_pages(viewer_tier)],
            viewer_tier=viewer_tier,
            hops=0,
        )

    def affected(self, slug: str, viewer_tier: str) -> list[str]:
        """Pages that link IN to this slug (i.e. would be impacted if this
        page changed or disappeared)."""
        page = self._pages_by_slug.get(slug)
        if not page:
            return []
        viewer_rank = TIER_ORDER.get(viewer_tier, 0)
        return [
            s
            for s in page.links_in
            if (q := self._pages_by_slug.get(s)) and TIER_ORDER[q.tier] <= viewer_rank
        ]

    def centrality(self, viewer_tier: str, limit: int = 10) -> list[tuple[Page, int]]:
        """Highest-degree visible pages."""
        out = [
            (p, len(p.links_in) + len(p.links_out))
            for p in self.visible_pages(viewer_tier)
        ]
        out.sort(key=lambda r: r[1], reverse=True)
        return out[:limit]

    def keyword_search(self, query: str, viewer_tier: str, limit: int = 20) -> list[tuple[Page, float]]:
        query_folded = _folded_text(query)
        terms = _tokens(query)
        if not terms:
            return []
        results: list[tuple[Page, float]] = []
        for page in self.visible_pages(viewer_tier):
            score = _phrase_bonus(query_folded, page.title, page.slug)
            title_tokens = set(_tokens(page.title))
            tag_tokens = set(_tokens(" ".join(page.tags)))
            body_counts = Counter(_tokens(page.body))
            for term in terms:
                if term in title_tokens:
                    score += 5.0
                if term in tag_tokens:
                    score += 2.0
                score += min(body_counts.get(term, 0), 5) * 1.0
            if score > 0:
                results.append((page, score))
        if not results:
            return []
        # Keyword term weights stay primary. Importance is a secondary key
        # among pages that already matched — it must not swamp the query.
        breakdowns = score_pages((p for p, _ in results), load_access())
        results.sort(
            key=lambda r: (
                r[1],
                breakdowns[r[0].slug].score if r[0].slug in breakdowns else 0.0,
            ),
            reverse=True,
        )
        return results[:limit]

    # ---------- internals ----------

    def _load_page(self, md_path: Path) -> Page:
        rel = md_path.relative_to(settings.wiki_root)
        # Defense-in-depth: a single page with malformed YAML frontmatter must never
        # crash a reader. frontmatter.load raises ScannerError on e.g. an unquoted
        # colon in a title; fall back to body-only + filename-derived metadata so one
        # bad page degrades gracefully instead of 500ing the manifest / /llm handshake.
        try:
            post = frontmatter.load(md_path)
            meta = post.metadata or {}
            body = post.content or ""
        except Exception as exc:  # noqa: BLE001
            print(f"[wiki] frontmatter parse failed for {md_path}: {exc} -- loading body-only")
            try:
                raw = md_path.read_text(encoding="utf-8")
            except Exception:
                raw = ""
            # strip a leading frontmatter block if present, keep the body
            body = raw
            if raw.startswith("---"):
                _end = raw.find("\n---", 3)
                if _end != -1:
                    body = raw[_end + 4:]
            meta = {}
        section = _section_from_relpath(rel)

        title = str(meta.get("title") or md_path.stem.replace("-", " ").title()).strip()
        slug = md_path.stem
        page_type = _infer_type(section, str(meta.get("type")) if meta.get("type") else None)
        tier = _normalize_tier(meta.get("tier")) or settings.default_tier
        created = str(meta.get("created")) if meta.get("created") else None
        updated = str(meta.get("updated")) if meta.get("updated") else None

        page = Page(
            slug=slug,
            title=title,
            rel_path=str(rel).replace("\\", "/"),
            section=section,
            page_type=page_type,
            tier=tier,
            created=created,
            updated=updated,
            sources=_normalize_list(meta.get("sources")),
            tags=_normalize_list(meta.get("tags")),
            body=body,
            excerpt=_excerpt(body),
            links_out=_extract_wikilink_titles(body),
            links_in=[],
            word_count=len(body.split()),
            mtime=md_path.stat().st_mtime,
        )
        return page

    @staticmethod
    def _latest_mtime(root: Path) -> float:
        if not root.exists():
            return 0.0
        latest = 0.0
        for p in root.rglob("*.md"):
            try:
                latest = max(latest, p.stat().st_mtime)
            except OSError:
                continue
        return latest


# ---------------------------------------------------------------------------
# Tenant-aware ``index`` proxy
# ---------------------------------------------------------------------------
#
# Backward compatibility: every existing route + helper reads ``index.foo()``
# directly. Rather than change 80+ call sites, we expose ``index`` as a thin
# proxy that delegates to the current tenant's :class:`WikiIndex` instance.
#
# * Single-tenant mode (OSS / self-host): ``current_tenant()`` returns the
#   default tenant, whose ``index`` is the single global wiki. Identical to
#   the v0 behavior.
# * Multi-tenant mode (hosted): ``current_tenant()`` returns the
#   request-scoped tenant. Each tenant has its own :class:`WikiIndex` and
#   each request sees its own wiki, transparently.


class _IndexProxy:
    """Behaves like a :class:`WikiIndex` but resolves to the current
    tenant's index on every attribute access."""

    def _target(self) -> WikiIndex:
        # Import is deferred so ``wiki.py`` and ``tenants.py`` don't
        # depend on each other's module init order.
        from . import tenants as _tenants

        return _tenants.current_tenant().index

    def __getattr__(self, name: str):
        return getattr(self._target(), name)


index = _IndexProxy()  # type: ignore[assignment]


def render_page_html_safe(body: str) -> str:
    """Convert [[Wikilinks]] to clickable links keyed by slug.

    Returns markdown (not HTML) — leaves the rest of the markdown intact so
    the frontend renderer (react-markdown) can format it. This only resolves
    wikilinks to standard markdown links.
    """

    def repl(match: re.Match[str]) -> str:
        target = match.group(1).strip()
        label = (match.group(2) or target).strip()
        page = index.find_by_title(target)
        if page is None:
            return f"_{label}_"
        return f"[{label}](/wiki/page/{page.slug})"

    return WIKILINK_RE.sub(repl, body)


def list_raw_files(*, excerpt_chars: int = 0) -> list[dict]:
    """List raw/ source files (owner-only).

    Args:
        excerpt_chars: if > 0, includes the first N characters of each file's
            body (frontmatter stripped) so the capture history view can render
            previews without fetching each file separately.

    Each row includes the `kind` (the first path segment under raw/, e.g.
    "conversations" or "imports"). UI uses this to group/filter.
    """
    raw = settings.raw_dir
    if not raw.exists():
        return []
    out: list[dict] = []
    for p in raw.rglob("*.md"):
        rel = p.relative_to(settings.wiki_root)
        # raw/<kind>/<filename>.md -> kind. Defaults to "other" if a flat file.
        rel_parts = rel.parts
        kind = rel_parts[1] if len(rel_parts) > 2 else "other"

        row: dict = {
            "rel_path": str(rel).replace("\\", "/"),
            "kind": kind,
            "size": p.stat().st_size,
            "mtime": p.stat().st_mtime,
        }

        if excerpt_chars > 0:
            try:
                text = p.read_text(encoding="utf-8", errors="ignore")
                # Strip leading YAML frontmatter for a cleaner preview.
                if text.startswith("---\n"):
                    end = text.find("\n---\n", 4)
                    if end > 0:
                        text = text[end + 5 :]
                # Collapse whitespace so the preview is one line of useful prose.
                text = " ".join(text.split())
                row["excerpt"] = text[:excerpt_chars]
            except OSError:
                # File deleted between glob and read — surface an empty excerpt.
                row["excerpt"] = ""

        out.append(row)
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def read_raw_file(rel_path: str) -> str | None:
    """Read a raw/<subdir>/<file>.md (owner-only). Returns None if invalid."""
    base = settings.raw_dir.resolve()
    target = (settings.wiki_root / rel_path).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    if not target.exists() or not target.is_file():
        return None
    return target.read_text(encoding="utf-8")


def delete_raw_file(rel_path: str) -> bool:
    """Delete a raw/<subdir>/<file>.md (owner-only).

    Returns True on success, False if the path was missing or escaped the
    raw/ directory. Path-traversal safety: we resolve the absolute path
    and reject anything not inside settings.raw_dir.
    """
    base = settings.raw_dir.resolve()
    target = (settings.wiki_root / rel_path).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return False
    if not target.exists() or not target.is_file():
        return False
    target.unlink()
    return True
