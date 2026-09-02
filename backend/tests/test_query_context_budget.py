"""Query synthesizer must not dump catalog hubs or unbounded page bodies.

Index and Log are catalogs (they link to, or accumulate, the whole corpus).
Bidirectional expansion therefore pulls them into almost every query.
Their full bodies are what blew a 200k-token Anthropic limit in production.
"""
from __future__ import annotations

from pathlib import Path

from app import llm
from app.importance import record_access
from app.main import index as wiki_index


def test_query_does_not_use_index_as_context_page(client):
    """Public Entity is linked from Index, so a 1-hop walk includes Index.
    Catalog hubs must not occupy query context / citations."""
    r = client.post(
        "/wiki/query", json={"question": "Tell me about the Public Entity"}
    )
    assert r.status_code == 200
    data = r.json()
    used = set(data["used_pages"])
    cited = {c["slug"] for c in data["citations"]}
    assert "public-entity" in used
    assert "index" not in used
    assert "log" not in used
    assert "index" not in cited
    assert "log" not in cited
    anchors = {a["slug"] for a in (data.get("retrieval") or {}).get("anchors") or []}
    assert "index" not in anchors
    assert "log" not in anchors


def test_select_context_pages_skips_catalog_hubs(client):
    pages, debug = llm._select_context_pages(
        "Tell me about the Public Entity", viewer_tier="public"
    )
    slugs = [p.slug for p in pages]
    assert "public-entity" in slugs
    assert "index" not in slugs
    assert "log" not in slugs
    assert debug["hops"] == 2
    omitted = {item["slug"] for item in debug.get("omitted_catalog") or []}
    assert "index" in omitted


def test_context_block_caps_page_bodies(wiki_root: Path):
    """A leaf page larger than MAX_PAGE_CHARS must be truncated in the
    synthesizer prompt. Restore the seed file so later tests see the original
    entity."""
    entity = wiki_root / "wiki" / "entities" / "public-entity.md"
    original = entity.read_text(encoding="utf-8")
    tail = "QUERY_CONTEXT_TAIL_SENTINEL_DO_NOT_INJECT"
    filler = "x" * (llm.MAX_PAGE_CHARS + 200)
    try:
        entity.write_text(
            original.rstrip() + "\n\n" + filler + tail + "\n",
            encoding="utf-8",
        )
        wiki_index.reload()
        pages, _debug = llm._select_context_pages(
            "Tell me about the Public Entity", viewer_tier="public"
        )
        block = llm._build_context_block(pages)
        assert tail not in block
        assert len(block) < llm.MAX_PAGE_CHARS * (llm.MAX_CONTEXT_PAGES + 1)
    finally:
        entity.write_text(original, encoding="utf-8")
        wiki_index.reload()


def test_expanded_neighbors_prefer_higher_importance(wiki_root: Path, client):
    """When the cap cannot keep every neighbor, rank by importance.score."""
    hub = wiki_root / "wiki" / "entities" / "importance-hub.md"
    high = wiki_root / "wiki" / "entities" / "importance-high.md"
    low = wiki_root / "wiki" / "entities" / "importance-low.md"
    page = """---
type: entity
title: {title}
tier: public
created: 2020-01-01
updated: 2020-01-01
---

{body}
"""
    hub.write_text(
        page.format(
            title="Importance Hub",
            body="UNIQUEIMPORTANCEANCHOR see [[Importance High]] and [[Importance Low]].",
        ),
        encoding="utf-8",
    )
    high.write_text(
        page.format(title="Importance High", body="High neighbor."),
        encoding="utf-8",
    )
    low.write_text(
        page.format(title="Importance Low", body="Low neighbor."),
        encoding="utf-8",
    )
    try:
        wiki_index.reload()
        record_access(["importance-high"])
        pages, debug = llm._select_context_pages(
            "UNIQUEIMPORTANCEANCHOR",
            viewer_tier="public",
            max_total=2,
        )
        slugs = [p.slug for p in pages]
        assert slugs[0] == "importance-hub"
        assert "importance-high" in slugs
        assert "importance-low" not in slugs
        assert debug["hops"] == 2
        chosen_importance = {item["slug"]: item["score"] for item in debug["importance"]}
        assert chosen_importance["importance-high"] > chosen_importance.get(
            "importance-low", -1.0
        )
        block = llm._build_context_block(pages)
        assert "UNIQUEIMPORTANCEANCHOR" in block
        assert "===== PAGE:" in block
    finally:
        for path in (hub, high, low):
            if path.exists():
                path.unlink()
        wiki_index.reload()


_NAMED_TITLE_QUERY = (
    "What prior findings, metrics, papers, repositories, and methodological "
    "decisions exist for State, Not Tokens, durable repository-scale agent "
    "reasoning, concurrency ceilings, and a possible extreme-scale Linux "
    "kernel follow-on benchmark?"
)

_HUB_UNIGRAMS = (
    "findings metrics papers repositories methodological decisions durable "
    "repository scale agent reasoning concurrency ceilings extreme scale "
    "linux kernel follow benchmark prior exist possible "
) * 8

_PAGE_TEMPLATE = """---
type: entity
title: {title}
tier: public
created: 2020-01-01
updated: 2020-01-01
---

{body}
"""


def _write_named_title_fixture(wiki_root: Path) -> list[Path]:
    """Hub pages that win bag-of-words scoring against a named research title."""
    paths = []
    for slug, title in (
        ("product-hub-one", "Product Hub One"),
        ("product-hub-two", "Product Hub Two"),
        ("product-hub-three", "Product Hub Three"),
    ):
        path = wiki_root / "wiki" / "entities" / f"{slug}.md"
        path.write_text(
            _PAGE_TEMPLATE.format(
                title=title,
                body=(
                    f"{_HUB_UNIGRAMS} see [[Product Hub One]] [[Product Hub Two]] "
                    "[[Product Hub Three]] [[State Not Tokens Research]]."
                ),
            ),
            encoding="utf-8",
        )
        paths.append(path)
    research = wiki_root / "wiki" / "entities" / "state-not-tokens-research.md"
    research.write_text(
        _PAGE_TEMPLATE.format(
            title="State Not Tokens Research",
            body="Paper v12. Mean pass 91.1 percent. About 2.28 times published SOTA.",
        ),
        encoding="utf-8",
    )
    paths.append(research)
    return paths


def test_keyword_search_ranks_named_title_above_unigram_hubs(wiki_root: Path):
    """A query that names a multi-word title must rank that page first.

    Production miss: the long State, Not Tokens question ranked Marionette
    hubs above state-not-tokens-research because terms kept commas and
    scored unigrams in huge bodies.
    """
    paths = _write_named_title_fixture(wiki_root)
    try:
        wiki_index.reload()
        ranked = [
            page.slug
            for page, _score in wiki_index.keyword_search(
                _NAMED_TITLE_QUERY, viewer_tier="public", limit=10
            )
        ]
        assert ranked[0] == "state-not-tokens-research"
        quoted = [
            page.slug
            for page, _score in wiki_index.keyword_search(
                '"State, Not Tokens"', viewer_tier="public", limit=5
            )
        ]
        assert quoted[0] == "state-not-tokens-research"
    finally:
        for path in paths:
            if path.exists():
                path.unlink()
        wiki_index.reload()


def test_select_context_keeps_named_title_when_hubs_dominate_unigrams(
    wiki_root: Path,
):
    """Query context must keep the named page even when only three slots exist."""
    paths = _write_named_title_fixture(wiki_root)
    try:
        wiki_index.reload()
        pages, debug = llm._select_context_pages(
            _NAMED_TITLE_QUERY,
            viewer_tier="public",
            max_total=3,
        )
        slugs = [page.slug for page in pages]
        assert "state-not-tokens-research" in slugs
        assert any(
            anchor["slug"] == "state-not-tokens-research"
            for anchor in debug["anchors"]
        )
    finally:
        for path in paths:
            if path.exists():
                path.unlink()
        wiki_index.reload()


def test_select_context_keeps_named_hit_neighbor_over_extra_hubs(
    wiki_root: Path,
):
    """The bench page linked from the named paper must survive hub fill."""
    paths: list[Path] = []
    for i in range(1, 7):
        path = wiki_root / "wiki" / "entities" / f"product-hub-{i}.md"
        path.write_text(
            _PAGE_TEMPLATE.format(
                title=f"Product Hub {i}",
                body=(
                    f"{_HUB_UNIGRAMS} see [[State Not Tokens Research]] "
                    "[[Product Hub 1]] [[Product Hub 2]]."
                ),
            ),
            encoding="utf-8",
        )
        paths.append(path)
    research = wiki_root / "wiki" / "entities" / "state-not-tokens-research.md"
    research.write_text(
        _PAGE_TEMPLATE.format(
            title="State Not Tokens Research",
            body="Paper v12. Validated on [[NL2Repo Bench]].",
        ),
        encoding="utf-8",
    )
    paths.append(research)
    bench = wiki_root / "wiki" / "entities" / "nl2repo-bench.md"
    bench.write_text(
        _PAGE_TEMPLATE.format(
            title="NL2Repo Bench",
            body="Independent repository-scale pytest suite.",
        ),
        encoding="utf-8",
    )
    paths.append(bench)
    try:
        wiki_index.reload()
        pages, _debug = llm._select_context_pages(
            _NAMED_TITLE_QUERY,
            viewer_tier="public",
            max_total=8,
        )
        slugs = [page.slug for page in pages]
        assert "state-not-tokens-research" in slugs
        assert "nl2repo-bench" in slugs
    finally:
        for path in paths:
            if path.exists():
                path.unlink()
        wiki_index.reload()
