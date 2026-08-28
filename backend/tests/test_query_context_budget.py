"""Query synthesizer must not dump catalog hubs or unbounded page bodies.

Index and Log are catalogs (they link to, or accumulate, the whole corpus).
Bidirectional 1-hop expansion therefore pulls them into almost every query.
Their full bodies are what blew a 200k-token Anthropic limit in production.
"""
from __future__ import annotations

from pathlib import Path

from app import llm
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
