"""Tests for /owner/capture/verbatim — the no-LLM passthrough that
writes a user-authored markdown file to wiki/<section>/<slug>.md with
its frontmatter preserved exactly.

The contract we're locking down:

* Frontmatter is required. Without it we can't pick a section/slug/
  tier safely.
* ``type`` maps to ``section`` deterministically. The six canonical
  Karpathy types (entity/concept/decision/project/query/source) cover
  every section the wiki understands.
* ``tier`` is RESPECTED — verbatim is the trusted-input path. This is
  the explicit difference from /owner/capture/paste and
  /owner/capture/structured which both force-clamp to private.
* Bytes on disk match bytes submitted (plus a single trailing newline
  if the input didn't have one).
* Conflicts (existing file at target path) get a ``-verbatim-<date>``
  suffix unless the caller passes ``force_overwrite=true``.
* Path traversal in slugs is rejected.

If any of these break the user's "I wrote this exactly, save what I
wrote" mental model breaks too, and the whole reason we built this
flow as a sibling of the drafter goes away.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path


_VALID_BODY = (
    "---\n"
    "type: source\n"
    "title: 2025 Performance Review\n"
    "tier: private\n"
    "tags: [foreflight, performance-review, 2025]\n"
    "---\n"
    "\n"
    "# 2025 Performance Review\n"
    "\n"
    "Body content that the wiki should preserve verbatim. "
    "Cross-references like [[ForeFlight ML Systems]] should survive.\n"
)


# ---------------------------------------------------------------------------
# happy path
# ---------------------------------------------------------------------------


def test_verbatim_writes_to_correct_section_for_each_type(
    client, owner_headers, wiki_root
):
    """The six canonical Karpathy types each route to their canonical
    section directory. Locking this down means a frontmatter ``type:
    entity`` always lands under ``wiki/entities/``, never under
    ``wiki/concepts/`` because the LLM had a different opinion."""
    cases = [
        ("entity", "entities"),
        ("concept", "concepts"),
        ("decision", "decisions"),
        ("project", "projects"),
        ("query", "queries"),
        ("source", "sources"),
    ]
    for page_type, expected_section in cases:
        title = f"Test {page_type.title()} Page"
        body = (
            "---\n"
            f"type: {page_type}\n"
            f"title: {title}\n"
            "tier: private\n"
            "---\n\nA short body for the test.\n"
        )
        r = client.post(
            "/owner/capture/verbatim",
            headers=owner_headers,
            json={"content": body},
        )
        assert r.status_code == 201, (page_type, r.text)
        data = r.json()
        assert data["ok"] is True
        written = data["written"]
        assert written["section"] == expected_section, (page_type, written)
        assert written["page_type"] == page_type
        rel = Path(written["rel_path"])
        # Decisions auto-date-prefix; the others land at <slug>.md.
        if page_type == "decision":
            assert rel.parts[:2] == ("wiki", "decisions")
            assert rel.name.startswith(date.today().isoformat() + "-")
        else:
            assert rel.parts[:2] == ("wiki", expected_section)
        # File actually on disk.
        assert (wiki_root / rel).exists()


def test_verbatim_preserves_input_bytes_exactly(
    client, owner_headers, wiki_root
):
    """If we strip even one extra byte the user's frontmatter (custom
    fields, comments, trailing whitespace they wanted) breaks. We add
    at most a single trailing newline; never more, never less."""
    # Note absence of trailing newline in submitted content.
    payload = (
        "---\n"
        "type: concept\n"
        "title: Calibrated Honesty\n"
        "tier: friend\n"
        "tags: [meta, communication]\n"
        "employer: ForeFlight\n"  # custom field — must survive
        "---\n"
        "\n"
        "Body line 1.\n"
        "Body line 2 with a trailing-space line below.\n"
        "   \n"
        "End."
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": payload},
    )
    assert r.status_code == 201, r.text
    rel = r.json()["written"]["rel_path"]
    on_disk = (wiki_root / rel).read_text(encoding="utf-8")
    # We add exactly one trailing newline if missing. No other transforms.
    assert on_disk == payload + "\n"
    # Custom field still in the file.
    assert "employer: ForeFlight" in on_disk
    # Body lines preserved (including the deliberate whitespace-only one).
    assert "Body line 2 with a trailing-space line below.\n   \nEnd." in on_disk


def test_verbatim_respects_input_tier(client, owner_headers, wiki_root):
    """The defining difference vs. the drafter: tier comes from the
    user's frontmatter, not a hard-coded private floor. The user is
    authoring this page directly — they get the editorial call. If we
    silently clamped to private here we'd have re-introduced the same
    fragmentation/override pain the verbatim path exists to escape."""
    for tier in ("public", "recruiter", "friend", "private"):
        body = (
            "---\n"
            "type: entity\n"
            f"title: Tier Test {tier}\n"
            f"tier: {tier}\n"
            "---\n\nbody\n"
        )
        r = client.post(
            "/owner/capture/verbatim",
            headers=owner_headers,
            json={"content": body},
        )
        assert r.status_code == 201, (tier, r.text)
        written = r.json()["written"]
        assert written["tier"] == tier, (tier, written)
        on_disk = (wiki_root / written["rel_path"]).read_text(encoding="utf-8")
        assert f"tier: {tier}" in on_disk


def test_verbatim_defaults_tier_to_private_when_missing(
    client, owner_headers, wiki_root
):
    """Defense-in-depth on the no-frontmatter-tier case. Even though
    the wiki loader itself defaults missing tier to settings.default_tier,
    we want the API response (and any caller polling it) to see an
    explicit ``private`` so the UI can render an accurate preview
    without inferring from settings."""
    body = (
        "---\n"
        "type: concept\n"
        "title: No Tier Specified\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 201, r.text
    assert r.json()["written"]["tier"] == "private"


def test_verbatim_derives_slug_from_title(client, owner_headers):
    """Title -> slug derivation is the default ergonomic. Users
    shouldn't have to think about filenames."""
    body = (
        "---\n"
        "type: project\n"
        "title: My Big Idea  (Working Title!)\n"
        "tier: private\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 201, r.text
    written = r.json()["written"]
    # Slugified: lowercase, hyphenated, punctuation dropped.
    assert written["slug"] == "my-big-idea-working-title"
    assert written["rel_path"].endswith("/my-big-idea-working-title.md")


def test_verbatim_slug_override_wins(client, owner_headers):
    """When the caller passes an explicit slug, that wins over both
    the title-derived default AND any ``slug:`` in the frontmatter.
    Useful for resubmitting after a title change or for UI forms that
    let the user customize the filename."""
    body = (
        "---\n"
        "type: project\n"
        "title: My Big Idea\n"
        "slug: not-this-one\n"
        "tier: private\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body, "slug": "the-real-slug"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["written"]["slug"] == "the-real-slug"


def test_verbatim_decision_auto_dates_slug(client, owner_headers):
    """Karpathy schema convention: decisions/ filenames carry a date
    prefix so they sort chronologically. The drafter backfills today
    when the LLM forgets; verbatim mirrors that to stay consistent."""
    body = (
        "---\n"
        "type: decision\n"
        "title: Switch To Postgres\n"
        "tier: private\n"
        "---\n\nWhy we picked Postgres over ClickHouse.\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 201, r.text
    slug = r.json()["written"]["slug"]
    assert slug.startswith(date.today().isoformat() + "-"), slug
    assert slug.endswith("-switch-to-postgres")


def test_verbatim_decision_with_existing_date_prefix_preserved(
    client, owner_headers
):
    """If the user already date-prefixed the slug, we don't double-prefix."""
    body = (
        "---\n"
        "type: decision\n"
        "title: Old Decision\n"
        "slug: 2025-01-15-old-decision\n"
        "tier: private\n"
        "---\n\nWhy.\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 201, r.text
    assert r.json()["written"]["slug"] == "2025-01-15-old-decision"


# ---------------------------------------------------------------------------
# conflicts
# ---------------------------------------------------------------------------


def test_verbatim_conflict_appends_verbatim_date_suffix(
    client, owner_headers, wiki_root
):
    """When the target slug already exists (e.g. user resubmits), we
    don't overwrite. We write a sibling file with ``-verbatim-<today>``
    suffix and report the new filename so the UI can show "you already
    had one of these; we saved this as ...". Mirrors the writeback
    endpoint's ``-from-llm-<today>`` pattern."""
    # Seed an existing file.
    seed_path = wiki_root / "wiki" / "concepts" / "calibrated-honesty.md"
    seed_path.write_text(
        "---\ntype: concept\ntitle: Calibrated Honesty\ntier: public\n---\n\noriginal\n",
        encoding="utf-8",
    )

    body = (
        "---\n"
        "type: concept\n"
        "title: Calibrated Honesty\n"  # same title -> same slug
        "tier: private\n"
        "---\n\nnew body, second submission\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 201, r.text
    data = r.json()

    # Original was NOT clobbered.
    assert seed_path.read_text(encoding="utf-8").strip().endswith("original")

    # New file written under suffix.
    written_rel = data["written"]["rel_path"]
    assert "-verbatim-" in Path(written_rel).name
    assert (wiki_root / written_rel).exists()
    # Response surfaces the conflict so UI can render an explainer.
    assert data["conflict"] is not None
    assert data["conflict"]["wrote_as"].endswith(".md")


def test_verbatim_force_overwrite_replaces_existing(
    client, owner_headers, wiki_root
):
    """The escape hatch for "I'm iterating on the same page, just save
    over the last version." Only fires with explicit
    ``force_overwrite: true`` so accidental clobbers stay impossible."""
    target = wiki_root / "wiki" / "entities" / "iter-test.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "---\ntype: entity\ntitle: Iter Test\ntier: private\n---\n\nv1\n",
        encoding="utf-8",
    )

    body = (
        "---\n"
        "type: entity\n"
        "title: Iter Test\n"
        "tier: private\n"
        "---\n\nv2 (the new one)\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body, "force_overwrite": True},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["overwrote_existing"] is True
    assert data["conflict"] is None
    # File at the canonical path now has the new content.
    assert target.read_text(encoding="utf-8").endswith("v2 (the new one)\n")


# ---------------------------------------------------------------------------
# validation failures (400)
# ---------------------------------------------------------------------------


def test_verbatim_rejects_content_without_frontmatter(
    client, owner_headers
):
    """The whole contract pivots on parsing frontmatter. If the user
    sent plain text without it we can't pick section/slug/tier and
    silently defaulting all three would be worse than a clear error."""
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": "Just some text. No frontmatter."},
    )
    assert r.status_code == 400
    assert "frontmatter" in r.text.lower()


def test_verbatim_rejects_empty_content(client, owner_headers):
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": "   \n  "},
    )
    assert r.status_code == 400
    assert "empty" in r.text.lower()


def test_verbatim_rejects_missing_type(client, owner_headers):
    body = (
        "---\n"
        "title: No Type Here\n"
        "tier: private\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 400
    assert "type" in r.text.lower()


def test_verbatim_rejects_invalid_type(client, owner_headers):
    body = (
        "---\n"
        "type: rumor\n"  # not a real type
        "title: Whatever\n"
        "tier: private\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 400
    # Error message lists the valid options so the user can self-fix.
    detail = r.text.lower()
    assert "invalid type" in detail
    for valid in ("entity", "concept", "decision", "project", "query", "source"):
        assert valid in detail


def test_verbatim_rejects_missing_title(client, owner_headers):
    body = (
        "---\n"
        "type: concept\n"
        "tier: private\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 400
    assert "title" in r.text.lower()


def test_verbatim_rejects_blank_title(client, owner_headers):
    body = (
        "---\n"
        "type: concept\n"
        'title: "   "\n'
        "tier: private\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 400
    assert "title" in r.text.lower()


def test_verbatim_rejects_invalid_tier(client, owner_headers):
    """Tier strings outside the four canonical values aren't silently
    defaulted — the user explicitly typed something we can't honor and
    we surface that so they can fix it."""
    body = (
        "---\n"
        "type: concept\n"
        "title: Bad Tier\n"
        "tier: top-secret\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 400
    assert "tier" in r.text.lower()


def test_verbatim_rejects_empty_body(client, owner_headers):
    body = (
        "---\n"
        "type: concept\n"
        "title: Just Frontmatter\n"
        "tier: private\n"
        "---\n\n  \n  \n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 400
    assert "body" in r.text.lower() or "empty" in r.text.lower()


def test_verbatim_rejects_oversized_content(client, owner_headers):
    """Hard cap defends against accidental novel-paste / megabyte
    transcripts that would bloat git history. The error tells the user
    what to do (split the input)."""
    huge = (
        "---\n"
        "type: concept\n"
        "title: Huge\n"
        "tier: private\n"
        "---\n\n" + ("x" * (300 * 1024))
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": huge},
    )
    assert r.status_code == 400
    assert "kb" in r.text.lower() or "cap" in r.text.lower()


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------


def test_verbatim_requires_owner_token(client):
    """No token, no write. Same surface as every other /owner/* route."""
    r = client.post(
        "/owner/capture/verbatim",
        json={"content": _VALID_BODY},
    )
    assert r.status_code in (401, 403)


def test_verbatim_rejects_wrong_token(client):
    r = client.post(
        "/owner/capture/verbatim",
        headers={"Authorization": "Bearer not-the-owner-token"},
        json={"content": _VALID_BODY},
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# index reload
# ---------------------------------------------------------------------------


def test_verbatim_reloads_index_so_page_is_immediately_visible(
    client, owner_headers
):
    """After a verbatim write the page should be queryable through the
    normal wiki manifest without waiting for a separate reload call.
    The endpoint calls ``tenant.reload_index()`` exactly for this."""
    body = (
        "---\n"
        "type: project\n"
        "title: Indexed Immediately\n"
        "tier: public\n"
        "---\n\nbody\n"
    )
    r = client.post(
        "/owner/capture/verbatim",
        headers=owner_headers,
        json={"content": body},
    )
    assert r.status_code == 201, r.text

    # Public-tier manifest as an anonymous viewer should now see the
    # new page (we wrote tier: public above, so no auth header needed).
    manifest = client.get("/wiki/manifest.json").json()
    titles = {p["title"] for p in manifest.get("pages", [])}
    assert "Indexed Immediately" in titles
