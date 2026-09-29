"""full_graph must scale linearly with page count."""
import time

from app.wiki import Page, WikiIndex


def _index(n):
    pages = {
        f"p{i}": Page(slug=f"p{i}", title=f"P{i}", rel_path="x", section="concepts", page_type="concept",
                      tier="public", created=None, updated=None, sources=[], tags=[], body="", excerpt="",
                      links_out=[f"p{(i + 1) % n}"])
        for i in range(n)
    }
    idx = WikiIndex()
    idx._pages_by_slug = pages
    idx.visible_pages = lambda tier: list(pages.values())
    return idx


def _best_of(idx, runs=3):
    best = float("inf")
    for _ in range(runs):
        t = time.perf_counter()
        graph = idx.full_graph("public")
        best = min(best, time.perf_counter() - t)
    return best, graph


def test_full_graph_is_linear_not_quadratic():
    small, _ = _best_of(_index(1500))
    large, graph = _best_of(_index(6000))
    assert len(graph["nodes"]) == 6000 and all(n["is_anchor"] for n in graph["nodes"])
    # 4x the pages: linear is ~4x, the old list membership was ~16x.
    assert large / small < 9, (small, large)
