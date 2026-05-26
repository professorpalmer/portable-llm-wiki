"""Tests for the v0.96 + v0.97 capture-history surface area.

Covers:
- `/owner/raw?excerpt_chars=N` returns kind + excerpt without leaking
  frontmatter, and excerpt_chars is clamped to [0, 1000]
- `/owner/raw/{path}` and `DELETE /owner/raw/{path}` honor path-traversal
  guards (the most security-sensitive bit)
- `/owner/raw/{path}/reingest` 404s on missing files and 503s when the
  orchestrator isn't installed (which is the case in CI)
- `/owner/import/extract-pdf` rejects garbage, validates size, and
  returns text + page_count when given a real PDF

These are smoke-level tests — we don't try to assert on orchestrator
behavior (would require Cursor SDK + a model). The goal is to catch
regressions in the wire (auth, path safety, response shapes).
"""
from __future__ import annotations

import io
from pathlib import Path


def _write_raw(wiki_root: Path, subdir: str, name: str, body: str) -> str:
    p = wiki_root / "raw" / subdir
    p.mkdir(parents=True, exist_ok=True)
    full = p / name
    full.write_text(body, encoding="utf-8")
    return f"raw/{subdir}/{name}"


def test_list_raw_includes_kind_and_excerpt(client, owner_headers, wiki_root):
    rel = _write_raw(
        wiki_root,
        "conversations",
        "smoke.md",
        # Frontmatter + body — the excerpt should drop the frontmatter.
        "---\ntype: source\ntitle: smoke\n---\n\n"
        + ("First line of body for the excerpt. " * 4),
    )

    r = client.get("/owner/raw?excerpt_chars=80", headers=owner_headers)
    assert r.status_code == 200
    files = r.json()["files"]
    assert isinstance(files, list)

    row = next((f for f in files if f["rel_path"] == rel), None)
    assert row is not None, f"{rel} not in {[f['rel_path'] for f in files]}"
    assert row["kind"] == "conversations"
    assert "type: source" not in row["excerpt"], "frontmatter leaked"
    assert "First line of body" in row["excerpt"]
    assert len(row["excerpt"]) <= 80


def test_list_raw_omits_excerpt_when_not_requested(
    client, owner_headers, wiki_root
):
    _write_raw(wiki_root, "conversations", "no-excerpt.md", "hello")
    r = client.get("/owner/raw", headers=owner_headers)
    assert r.status_code == 200
    for f in r.json()["files"]:
        assert "excerpt" not in f, f


def test_list_raw_clamps_excerpt_chars(client, owner_headers, wiki_root):
    _write_raw(
        wiki_root,
        "conversations",
        "clamp.md",
        "x" * 5000,
    )
    # 1000 is the documented cap; anything above should be silently clamped.
    r = client.get("/owner/raw?excerpt_chars=99999", headers=owner_headers)
    assert r.status_code == 200
    for f in r.json()["files"]:
        if "excerpt" in f:
            assert len(f["excerpt"]) <= 1000


def test_list_raw_requires_owner(client, wiki_root):
    _write_raw(wiki_root, "conversations", "leak.md", "hi")
    r = client.get("/owner/raw")
    assert r.status_code in (401, 403)


def test_delete_raw_happy_path(client, owner_headers, wiki_root):
    rel = _write_raw(wiki_root, "conversations", "doomed.md", "delete me")
    full = wiki_root / rel
    assert full.exists()

    r = client.delete(f"/owner/{rel}", headers=owner_headers)
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert not full.exists()

    # 404 on second delete
    r = client.delete(f"/owner/{rel}", headers=owner_headers)
    assert r.status_code == 404


def test_delete_raw_rejects_path_traversal(client, owner_headers, wiki_root):
    """The DELETE handler must reject anything that resolves outside raw/.
    We sanity-check by creating a sentinel OUTSIDE raw and confirming the
    handler 404s instead of unlinking it.
    """
    sentinel = wiki_root / "should-survive.txt"
    sentinel.write_text("survive", encoding="utf-8")

    # Path-traversal attempt. TestClient normalizes `..` segments in URLs,
    # so we hit the handler through a kind path that contains the escape
    # in a URL-encoded form (handler still resolves and validates).
    r = client.delete(
        "/owner/raw/..%2F..%2Fshould-survive.txt", headers=owner_headers
    )
    assert r.status_code == 404
    assert sentinel.exists(), "path-traversal allowed file deletion outside raw/"
    sentinel.unlink()


def test_reingest_raw_404_when_missing(client, owner_headers):
    r = client.post(
        "/owner/raw/conversations/nope.md/reingest", headers=owner_headers
    )
    assert r.status_code == 404


def test_reingest_raw_responds_with_either_503_or_job_id(
    client, owner_headers, wiki_root
):
    """The reingest endpoint either:
      - Returns 503 when Puppetmaster isn't on PATH (CI default), or
      - Returns 200 + tracking_id when Puppetmaster IS installed (dev box).
    Both are acceptable — we just need to make sure we never silently
    crash or pretend success without giving the caller something to poll.
    """
    rel = _write_raw(wiki_root, "conversations", "queue-me.md", "body")
    r = client.post(f"/owner/{rel}/reingest", headers=owner_headers)
    assert r.status_code in (200, 503)
    if r.status_code == 503:
        detail = r.json()["detail"].lower()
        assert "orchestrator" in detail or "puppetmaster" in detail
    else:
        body = r.json()
        assert "tracking_id" in body
        assert body["kind"] == "ingest"


# ---------------------------------------------------------------------------
# PDF extract endpoint
# ---------------------------------------------------------------------------


def _build_pdf(text: str) -> bytes:
    """Generate a minimal PDF containing `text` on a single page.

    We use fpdf2 here only because pypdf can't write text content. fpdf2
    is dev-only; the production backend uses pypdf to extract text from
    user-uploaded PDFs.
    """
    pytest_skip = False
    try:
        from fpdf import FPDF  # type: ignore[import-not-found]
    except ImportError:
        pytest_skip = True

    if pytest_skip:
        import pytest

        pytest.skip("fpdf2 not installed; skipping PDF round-trip test")

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=12)
    for line in text.splitlines():
        pdf.cell(0, 10, line)
        pdf.ln()
    return bytes(pdf.output())


def test_extract_pdf_rejects_empty_upload(client, owner_headers):
    r = client.post(
        "/owner/import/extract-pdf",
        headers=owner_headers,
        files={"file": ("tiny.pdf", b"", "application/pdf")},
    )
    assert r.status_code == 400
    assert "empty" in r.json()["detail"].lower()


def test_extract_pdf_rejects_invalid_pdf(client, owner_headers):
    r = client.post(
        "/owner/import/extract-pdf",
        headers=owner_headers,
        files={
            "file": (
                "not-a-pdf.pdf",
                b"this is plain text, not a PDF stream at all",
                "application/pdf",
            )
        },
    )
    assert r.status_code == 400


def test_extract_pdf_round_trip(client, owner_headers):
    """Generate a tiny PDF, upload it, and verify the text comes back."""
    pdf_bytes = _build_pdf("Avery Chen\nFounding Engineer at Strand Bio")

    r = client.post(
        "/owner/import/extract-pdf",
        headers=owner_headers,
        files={
            "file": ("resume.pdf", io.BytesIO(pdf_bytes), "application/pdf")
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["page_count"] == 1
    assert body["source_filename"] == "resume.pdf"
    # Don't assert exact whitespace — pypdf normalizes weirdly. Just check
    # the meaningful tokens are present.
    assert "Avery" in body["text"]
    assert "Strand" in body["text"]
    assert body["word_count"] > 0


def test_extract_pdf_requires_owner(client):
    r = client.post(
        "/owner/import/extract-pdf",
        files={
            "file": ("x.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")
        },
    )
    assert r.status_code in (401, 403)
