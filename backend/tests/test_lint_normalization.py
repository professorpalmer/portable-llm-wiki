"""Lint wikilink resolution must tolerate slug-vs-title and date-prefix forms.

Regression guard for the "linter cries wolf on every dated decision/source"
bug: dated pages (decisions, sources) have a ``YYYY-MM-DD`` slug but are
linked by a human ``[[YYYY-MM-DD Title Form]]`` display string, and slug-form
links like ``[[project-compass]]`` don't match a title. The linter must treat
all these as resolved while still flagging genuinely dangling links.
"""
from __future__ import annotations

from pathlib import Path

from app import lint
from app.wiki import Page


def _pg(slug: str, title: str, body: str = "") -> Page:
    return Page(
        slug=slug,
        title=title,
        rel_path=f"wiki/decisions/{slug}.md",
        section="decisions",
        page_type="decision",
        tier="private",
        created="2026-07-01",
        updated="2026-07-01",
        sources=[],
        tags=[],
        body=body,
        excerpt="",
    )


def _linker(slug: str, body: str) -> Page:
    """A page in another section that links out via `body`."""
    p = _pg(slug, slug.replace("-", " ").title(), body)
    p.section = "entities"
    p.page_type = "entity"
    return p


def test_dated_display_link_resolves_to_dated_slug():
    """`[[2026-07-01 Marionette Public Repo for Auto-Update]]` must resolve to
    the page whose slug is `2026-07-01-marionette-public-repo-auto-update`."""
    target = _pg(
        "2026-07-01-marionette-public-repo-auto-update",
        "Marionette Public Repo for Auto-Update",
    )
    linker = _linker(
        "index-ish", "See [[2026-07-01 Marionette Public Repo for Auto-Update]]. " * 3
    )
    missing = lint._missing_pages([target, linker])
    assert missing == []


def test_slug_form_link_resolves():
    """`[[project-compass]]` resolves to the page even though the title is
    `Project Compass` (space, not hyphen)."""
    target = _pg("project-compass", "Project Compass")
    target.section = "projects"
    linker = _linker("refs", "[[project-compass]] " * 3)
    assert lint._missing_pages([target, linker]) == []


def test_title_with_punctuation_resolves_via_slugify():
    """`[[Jeppesen ForeFlight]]` resolves to slug `jeppesen-foreflight`."""
    target = _pg("jeppesen-foreflight", "Jeppesen ForeFlight")
    target.section = "entities"
    linker = _linker("refs", "[[Jeppesen ForeFlight]] " * 3)
    assert lint._missing_pages([target, linker]) == []


def test_genuinely_dangling_link_is_still_reported():
    """A link with no matching page under any normalization stays flagged —
    the true signal must survive."""
    real = _pg("something-real", "Something Real")
    linker = _linker("refs", "[[Hermes Agent]] and [[Docker]] and [[Hermes Agent]] "
                     "[[Hermes Agent]] [[Docker]] [[Docker]]")
    missing = {m["title"] for m in lint._missing_pages([real, linker])}
    assert "Hermes Agent" in missing
    assert "Docker" in missing


def test_below_threshold_not_reported():
    linker = _linker("refs", "[[Ghost Page]]")  # 1 mention < min 3
    assert lint._missing_pages([linker]) == []


def test_strip_date_prefix():
    assert lint._strip_date_prefix("2026-07-01 Marionette Foo") == "Marionette Foo"
    assert lint._strip_date_prefix("2026-07-01-marionette-foo") == "marionette-foo"
    assert lint._strip_date_prefix("No Date Here") == "No Date Here"


class _FakeSettings:
    def __init__(self, wiki_dir: Path):
        self.wiki_dir = wiki_dir


def test_missing_index_entries_accepts_dated_form(tmp_path, monkeypatch):
    """A page listed in index.md under its dated display form is NOT reported
    missing, but a page absent in every form IS."""
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    (wiki / "index.md").write_text(
        "# Index\n"
        "- [[2026-07-01 Marionette Public Repo for Auto-Update]]\n"
        "- [[Project Compass]]\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(lint, "settings", _FakeSettings(wiki))

    listed_dated = _pg(
        "2026-07-01-marionette-public-repo-auto-update",
        "Marionette Public Repo for Auto-Update",
    )
    listed_plain = _pg("project-compass", "Project Compass")
    listed_plain.section = "projects"
    absent = _pg("2026-07-01-not-in-index", "Not In Index")

    missing = {m["slug"] for m in lint._missing_index_entries(
        [listed_dated, listed_plain, absent]
    )}
    assert missing == {"2026-07-01-not-in-index"}
