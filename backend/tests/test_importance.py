"""Hermetic tests for Selective Forgetting-style importance scoring."""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from types import SimpleNamespace

from app import importance, lint
from app.importance import (
    AccessRecord,
    exponential_decay,
    load_access,
    record_access,
    score_page,
    score_pages,
)
from app.wiki import Page


NOW = datetime(2026, 9, 2, tzinfo=timezone.utc)


def _ns(
    slug: str,
    *,
    created: str | None = None,
    updated: str | None = None,
    links_in: list[str] | None = None,
    links_out: list[str] | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        slug=slug,
        created=created,
        updated=updated,
        links_in=links_in or [],
        links_out=links_out or [],
    )


def _pg(
    slug: str,
    title: str,
    *,
    section: str = "entities",
    created: str | None = "2018-01-01",
    updated: str | None = "2018-01-01",
    tags: list[str] | None = None,
    links_in: list[str] | None = None,
    links_out: list[str] | None = None,
) -> Page:
    return Page(
        slug=slug,
        title=title,
        rel_path=f"wiki/{section}/{slug}.md",
        section=section,
        page_type="entity",
        tier="public",
        created=created,
        updated=updated,
        sources=[],
        tags=tags or [],
        body="",
        excerpt="",
        links_in=links_in or [],
        links_out=links_out or [],
    )


def test_exponential_decay_zero_one_half_life_and_huge():
    assert exponential_decay(0, 90) == 1.0
    assert exponential_decay(90, 90) == 0.5
    assert exponential_decay(1e9, 90) < 1e-12


def test_missing_timestamps_zero_recency_and_freshness():
    page = _ns("bare")
    breakdown = score_page(page, None, max_hits=0, max_degree=0, now=NOW)
    assert breakdown.recency == 0.0
    assert breakdown.freshness == 0.0


def test_frequency_zero_hits_and_sole_max():
    cold = _ns("cold")
    hot = _ns("hot")
    scores = score_pages(
        [cold, hot],
        {"hot": AccessRecord(hits=7), "cold": AccessRecord(hits=0)},
        now=NOW,
    )
    assert scores["cold"].frequency == 0.0
    assert scores["hot"].frequency == 1.0


def test_centrality_isolated_and_max_degree():
    isolated = _ns("iso")
    hub = _ns("hub", links_in=["a"], links_out=["b", "c"])
    scores = score_pages([isolated, hub], {}, now=NOW)
    assert scores["iso"].centrality == 0.0
    assert scores["hub"].centrality == 1.0


def test_paper_weights_centrality_cannot_outrank_recency_frequency():
    central_only = _ns("hub", links_in=["a", "b", "c"], links_out=["d", "e"])
    recent_frequent = _ns("hot")
    scores = score_pages(
        [central_only, recent_frequent],
        {
            "hot": AccessRecord(
                hits=10, last_accessed_at="2026-09-02T00:00:00+00:00"
            )
        },
        now=NOW,
    )
    assert scores["hub"].centrality == 1.0
    assert scores["hot"].recency == 1.0
    assert scores["hot"].frequency == 1.0
    assert scores["hot"].score > scores["hub"].score
    assert math.isclose(scores["hub"].score, 0.20)
    assert math.isclose(scores["hot"].score, 0.60)


def test_last_write_wins_newer_updated_scores_higher():
    older = _ns(
        "old",
        created="2020-01-01",
        updated="2020-01-01",
        links_out=["x"],
    )
    newer = _ns(
        "new",
        created="2020-01-01",
        updated="2026-08-01",
        links_out=["x"],
    )
    access = {
        "old": AccessRecord(hits=5, last_accessed_at="2026-08-01T00:00:00+00:00"),
        "new": AccessRecord(hits=5, last_accessed_at="2026-08-01T00:00:00+00:00"),
    }
    scores = score_pages([older, newer], access, now=NOW)
    assert scores["new"].freshness > scores["old"].freshness
    assert scores["new"].score > scores["old"].score


def test_sidecar_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(importance, "settings", SimpleNamespace(wiki_root=tmp_path))
    stamp = datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc)
    record_access(["alpha", "beta"], now=stamp)
    loaded = load_access()
    assert loaded["alpha"].hits == 1
    assert loaded["beta"].hits == 1
    assert loaded["alpha"].last_accessed_at == stamp.isoformat()
    record_access(["alpha"], now=stamp)
    assert load_access()["alpha"].hits == 2
    raw = json.loads((tmp_path / ".page-access.json").read_text(encoding="utf-8"))
    assert raw["alpha"]["hits"] == 2
    gi = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert any(line.strip() == ".page-access.json" for line in gi.splitlines())


def test_corrupt_sidecar_loads_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(importance, "settings", SimpleNamespace(wiki_root=tmp_path))
    (tmp_path / ".page-access.json").write_text("{not-json", encoding="utf-8")
    assert load_access() == {}


def test_record_access_never_raises_on_replace_error(tmp_path, monkeypatch):
    monkeypatch.setattr(importance, "settings", SimpleNamespace(wiki_root=tmp_path))

    def _boom(*_args, **_kwargs):
        raise OSError("denied")

    monkeypatch.setattr(importance.os, "replace", _boom)
    record_access(["x"])


def test_dormant_old_isolated_yes_hot_hub_and_catalogs_no():
    old = _pg("old-iso", "Old Isolated")
    hot = _pg(
        "hot-hub",
        "Hot Hub",
        created="2026-09-01",
        updated="2026-09-01",
        links_in=["a", "b", "c"],
        links_out=["d", "e"],
    )
    idx = _pg("index", "Index", section="root")
    log = _pg("log", "Log", section="entities")
    foundational = _pg("found", "Foundational Old", tags=["Foundational"])
    query = _pg("q", "Old Query", section="queries")
    access = {
        "hot-hub": AccessRecord(
            hits=50, last_accessed_at="2026-09-02T00:00:00+00:00"
        )
    }
    out = lint._dormant_pages(
        [old, hot, idx, log, foundational, query], access, now=NOW
    )
    assert [row["slug"] for row in out] == ["old-iso"]
    row = out[0]
    assert row["hits"] == 0
    assert row["degree"] == 0
    assert row["score"] < 0.10
    assert row["last_dated"] == "2018-01-01"
    assert row["last_accessed_at"] is None


def test_lint_wiki_includes_dormant_key(client):
    report = lint.lint_wiki()
    assert "dormant" in report
    assert isinstance(report["dormant"], list)
    slugs = {row["slug"] for row in report["dormant"]}
    assert "index" not in slugs
    assert "log" not in slugs


def test_get_page_records_access(client):
    r = client.get("/wiki/page/public-entity")
    assert r.status_code == 200
    access = load_access()
    assert access["public-entity"].hits == 1
    assert access["public-entity"].last_accessed_at


def test_graph_listing_does_not_record_access(client, wiki_root):
    assert client.get("/wiki/graph").status_code == 200
    assert client.get("/wiki/graph/public-entity").status_code == 200
    assert not (wiki_root / ".page-access.json").exists()
