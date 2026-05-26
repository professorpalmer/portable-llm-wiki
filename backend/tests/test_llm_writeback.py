"""Tests for the LLM writeback path.

These cover the round-trip that closes the loop between a user's
chat with ChatGPT / Claude and their wiki:

    user shares wiki URL  →  chats with LLM  →  LLM produces JSON
    matching /llm-writeback-spec  →  user pastes JSON into
    /capture's "from LLM" tab  →  POST /owner/capture/structured
    →  pages written to disk under wiki/<section>/<slug>.md

The receiving endpoint is deliberately NOT another LLM call. The LLM
the user was chatting with already shaped the content; the server's
job is validation, conflict handling, and provenance enforcement.

What we lock down here:

* the spec endpoint is public + machine-readable (any LLM with web
  fetch should be able to read it without auth)
* validation rejects malformed payloads with helpful errors
* `tier: public` from the LLM is forced down to `private` (no LLM
  hallucination ever lands on a public surface accidentally)
* `session_label` is required and ends up in every imported page's
  ``sources:`` frontmatter (provenance can never drift)
* slug conflicts produce ``-from-llm-<date>`` suffixed files so
  hand-written pages are never overwritten
* the index reloads so new pages are immediately visible
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path


# ---------------------------------------------------------------------------
# /llm-writeback-spec
# ---------------------------------------------------------------------------


def test_writeback_spec_is_public(client):
    """The spec endpoint MUST be reachable without auth — any external
    LLM (ChatGPT browse, Claude tools, Cursor agents) needs to be able
    to fetch it to learn the schema. If we ever require auth here, the
    writeback loop silently breaks for everyone."""
    r = client.get("/llm-writeback-spec")
    assert r.status_code == 200
    body = r.text
    # Schema essentials must be present so the LLM can parse + produce.
    assert "session_label" in body
    assert '"pages"' in body
    for section in ("entities", "concepts", "decisions", "projects", "queries"):
        assert section in body
    # Document the quality guards (these are commitments to the user).
    assert "tier: private" in body
    assert "from-llm" in body


def test_writeback_spec_is_plain_markdown(client):
    """Content-type should be readable by both LLMs and humans."""
    r = client.get("/llm-writeback-spec")
    assert r.status_code == 200
    ctype = r.headers.get("content-type", "").lower()
    # PlainTextResponse defaults to text/plain; either flavor is fine
    # as long as it isn't application/json (which would be misleading
    # since the body is markdown).
    assert "text/" in ctype


# ---------------------------------------------------------------------------
# /owner/capture/structured — auth + validation
# ---------------------------------------------------------------------------


_MIN_VALID_PAGE = {
    "slug": "writeback-smoke",
    "title": "Writeback Smoke",
    "section": "concepts",
    "tags": ["test"],
    "body": (
        "## Header\n\nA paragraph long enough to look like a real wiki "
        "page body so we exercise the rendering path with realistic input."
    ),
}


def test_structured_requires_owner(client):
    """No bearer / session → 401-or-403. Confirms the endpoint is
    behind ``require_owner`` like the rest of /owner/*."""
    r = client.post(
        "/owner/capture/structured",
        json={"session_label": "anon-attempt", "pages": [_MIN_VALID_PAGE]},
    )
    assert r.status_code in (401, 403)


def test_structured_rejects_missing_session_label(client, owner_headers):
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={"pages": [_MIN_VALID_PAGE]},
    )
    assert r.status_code == 400
    assert "session_label" in r.json()["detail"]


def test_structured_rejects_short_session_label(client, owner_headers):
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={"session_label": "ab", "pages": [_MIN_VALID_PAGE]},
    )
    assert r.status_code == 400


def test_structured_rejects_missing_pages(client, owner_headers):
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={"session_label": "chatgpt-2026-05-24-smoke"},
    )
    assert r.status_code == 400


def test_structured_rejects_empty_pages_list(client, owner_headers):
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={"session_label": "chatgpt-2026-05-24-smoke", "pages": []},
    )
    assert r.status_code == 400


def test_structured_rejects_too_many_pages(client, owner_headers):
    pages = []
    for i in range(60):
        p = dict(_MIN_VALID_PAGE)
        p["slug"] = f"bulk-{i}"
        p["title"] = f"Bulk {i}"
        pages.append(p)
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={"session_label": "chatgpt-2026-05-24-bulk", "pages": pages},
    )
    assert r.status_code == 400
    assert "50" in r.json()["detail"]


def test_structured_400_when_every_page_invalid(client, owner_headers):
    """If validation eats every page (missing title/body), we 400 with
    a structured detail object so the UI can show specifics."""
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-garbage",
            "pages": [
                {"title": "", "body": "x", "section": "concepts"},
                {"title": "x", "body": "", "section": "concepts"},
            ],
        },
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert isinstance(detail, dict)
    assert detail.get("code") == "no_valid_pages"
    assert detail.get("warnings")


# ---------------------------------------------------------------------------
# /owner/capture/structured — happy path + quality guards
# ---------------------------------------------------------------------------


def test_structured_happy_path_writes_pages(client, owner_headers, wiki_root):
    """A clean payload should produce a 201, write the pages to the
    expected paths, and include them in the response."""
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-happy",
            "pages": [
                {
                    "slug": "writeback-happy",
                    "title": "Writeback Happy",
                    "section": "concepts",
                    "tags": ["writeback", "test"],
                    "body": (
                        "## Why\n\nThis is a happy-path test page. "
                        "It cross-references [[Public Entity]] to "
                        "make sure wikilinks survive the round-trip."
                    ),
                }
            ],
        },
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["ok"] is True
    assert data["page_count"] == 1
    assert data["session_label"] == "chatgpt-2026-05-24-happy"
    assert len(data["written"]) == 1
    assert data["written"][0]["section"] == "concepts"
    assert data["written"][0]["slug"] == "writeback-happy"

    # File actually lands on disk in the expected location.
    on_disk = wiki_root / "wiki" / "concepts" / "writeback-happy.md"
    assert on_disk.exists()
    body = on_disk.read_text(encoding="utf-8")
    assert "title: Writeback Happy" in body
    # Provenance: session_label appears in the page's sources frontmatter.
    assert "chatgpt-2026-05-24-happy" in body
    # Wikilinks preserved.
    assert "[[Public Entity]]" in body


def test_structured_forces_tier_private(client, owner_headers, wiki_root):
    """Even if the LLM tries to ship ``tier: public``, the receiving
    endpoint clamps it down to private. The user reviews + promotes
    by hand; nothing the LLM produces auto-publishes."""
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-tier-test",
            "pages": [
                {
                    "slug": "tier-clamp",
                    "title": "Tier Clamp",
                    "section": "concepts",
                    "tier": "public",  # LLM tries to publish
                    "body": "Body text long enough to pass validation.",
                }
            ],
        },
    )
    assert r.status_code == 201
    written = r.json()["written"]
    assert written[0]["tier"] == "private"
    on_disk = wiki_root / "wiki" / "concepts" / "tier-clamp.md"
    assert on_disk.exists()
    assert "tier: private" in on_disk.read_text(encoding="utf-8")


def test_structured_conflict_writes_suffixed_file(
    client, owner_headers, wiki_root
):
    """Slug collision: the existing hand-written page must survive
    untouched. The LLM's version lands at ``<slug>-from-llm-<date>.md``.
    Reported in the response under ``conflicts``."""
    # Seed a hand-written page that the LLM happens to collide with.
    existing = wiki_root / "wiki" / "concepts" / "writeback-conflict.md"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_text(
        "---\ntype: concept\ntitle: Existing\ntier: private\n---\n\nDo not overwrite me.\n",
        encoding="utf-8",
    )
    original = existing.read_text(encoding="utf-8")

    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-conflict",
            "pages": [
                {
                    "slug": "writeback-conflict",
                    "title": "Conflicting Title",
                    "section": "concepts",
                    "body": "New body that should NOT clobber the existing file.",
                }
            ],
        },
    )
    assert r.status_code == 201
    data = r.json()
    assert len(data["conflicts"]) == 1
    assert data["conflicts"][0]["slug"] == "writeback-conflict"
    assert "from-llm-" in data["conflicts"][0]["wrote_as"]

    # Existing file is untouched.
    assert existing.read_text(encoding="utf-8") == original

    # The from-LLM copy lives alongside it.
    today = date.today().isoformat()
    pattern = re.compile(rf"^writeback-conflict-from-llm-{today}(-\d+)?\.md$")
    siblings = list(existing.parent.iterdir())
    assert any(pattern.match(p.name) for p in siblings), [
        p.name for p in siblings
    ]


def test_structured_decisions_get_date_prefix(client, owner_headers, wiki_root):
    """Decision pages follow the wiki's existing ``YYYY-MM-DD-<slug>``
    convention. The validator (shared with ``direct_drafter``) should
    backfill the date if the LLM forgot it."""
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-decision",
            "pages": [
                {
                    "slug": "go-with-postgres",  # no date prefix
                    "title": "Go With Postgres",
                    "section": "decisions",
                    "body": "Long enough body to clear validation.",
                }
            ],
        },
    )
    assert r.status_code == 201
    slug = r.json()["written"][0]["slug"]
    today = date.today().isoformat()
    assert slug.startswith(f"{today}-")
    on_disk = wiki_root / "wiki" / "decisions" / f"{slug}.md"
    assert on_disk.exists()


def test_structured_dedupes_repeated_slugs_in_one_batch(
    client, owner_headers, wiki_root
):
    """If the LLM emits two pages with the same slug in the same
    payload, we suffix the dupes (-2, -3...) instead of writing one
    over the other. Verifies we don't silently lose pages from a single
    batch."""
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-dedupe",
            "pages": [
                {
                    "slug": "dupe",
                    "title": "Dupe A",
                    "section": "concepts",
                    "body": "First body, long enough to pass validation.",
                },
                {
                    "slug": "dupe",
                    "title": "Dupe B",
                    "section": "concepts",
                    "body": "Second body, also long enough to pass validation.",
                },
            ],
        },
    )
    assert r.status_code == 201
    written = r.json()["written"]
    assert len(written) == 2
    slugs = {p["slug"] for p in written}
    assert "dupe" in slugs
    assert "dupe-2" in slugs


def test_structured_tolerates_unknown_section(client, owner_headers, wiki_root):
    """An LLM that invents a section ("musings") should produce a
    warning, not a 500. The page lands under ``concepts`` (the
    fallback chosen by ``direct_drafter._validate_page_dict``)."""
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-unknown-section",
            "pages": [
                {
                    "slug": "musing-page",
                    "title": "Musing Page",
                    "section": "musings",  # not in VALID_SECTIONS
                    "body": "Body that is long enough to pass validation.",
                }
            ],
        },
    )
    assert r.status_code == 201
    data = r.json()
    assert data["written"][0]["section"] == "concepts"
    # Warning surfaced so the UI can tell the user "we coerced this".
    assert any("unknown section" in e.lower() for e in data["errors"])


def test_structured_reloads_index_so_pages_are_immediately_visible(
    client, owner_headers
):
    """The wiki index is in-memory; after a writeback the new pages
    should be reachable via the public manifest right away. This is
    what makes "commit, then click through to your new page" feel
    instant."""
    slug = "instant-visibility"
    r = client.post(
        "/owner/capture/structured",
        headers=owner_headers,
        json={
            "session_label": "chatgpt-2026-05-24-visibility",
            "pages": [
                {
                    "slug": slug,
                    "title": "Instant Visibility",
                    "section": "concepts",
                    "tier": "private",
                    "body": "Body long enough to clear the validator.",
                }
            ],
        },
    )
    assert r.status_code == 201

    # Owner manifest sees private pages.
    m = client.get("/wiki/manifest.json", headers=owner_headers)
    assert m.status_code == 200
    slugs = {p["slug"] for p in m.json()["pages"]}
    assert slug in slugs
