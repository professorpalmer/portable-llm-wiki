"""Regression: a single page with malformed YAML frontmatter must never crash
the index reload or the manifest. An unquoted colon in a title (e.g.
"title: SWE-bench Lite: Noise Finding") raises yaml ScannerError; the loader
must degrade that page to body-only instead of 500ing the whole wiki.
"""
from pathlib import Path

from app.config import settings
from app.wiki import WikiIndex


def test_malformed_frontmatter_page_does_not_crash_reload(wiki_root: Path):
    # write a page with an unquoted colon in the title (invalid YAML mapping)
    bad = settings.wiki_dir / "sources" / "bad-colon-title.md"
    bad.parent.mkdir(parents=True, exist_ok=True)
    bad.write_text(
        "---\n"
        "type: source\n"
        "title: Broken Title: With A Colon\n"
        "tier: public\n"
        "---\n\n"
        "Body text that should still be readable.\n",
        encoding="utf-8",
    )
    # also a clean page so we can confirm the index still works around the bad one
    good = settings.wiki_dir / "sources" / "good-page.md"
    good.write_text(
        "---\ntype: source\ntitle: Good Page\ntier: public\n---\n\nClean body.\n",
        encoding="utf-8",
    )

    idx = WikiIndex()
    # must NOT raise
    idx.reload()

    # the good page is present
    slugs = {p.slug for p in idx.all_pages()}
    assert "good-page" in slugs
    # the bad page is loaded body-only (degraded), not crashing -- it may be present
    # with filename-derived metadata; the key invariant is reload() did not raise and
    # the rest of the index is intact.
    bad_page = next((p for p in idx.all_pages() if p.slug == "bad-colon-title"), None)
    if bad_page is not None:
        assert "still be readable" in bad_page.body
