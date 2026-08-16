"""Tests for /owner/import (the cold-start Bootstrap-your-wiki page).

Same shape as test_capture_ingest.py but for the broader-input starter
wiki path. Endpoint contract:

  * Self-host w/ Puppetmaster on PATH → returns ``orchestrator.tracking_id``
    that the wizard polls.
  * Hosted (Render, vanilla Docker) → Puppetmaster fails, we fall back to
    ``direct_drafter.draft_starter_pages`` and return ``drafted.pages``
    synchronously. Before this fix the page just said "Orchestrator
    could not start: puppetmaster binary not found" and dead-ended,
    even though the same drafter is what powers the welcome wizard.
  * Either path failing → 201 with raw saved + an actionable error in
    the drafted field (kind: no_llm_configured, draft_failed).
"""
from __future__ import annotations

from app import direct_drafter as _dd
from app import main as _main
from app import orchestrator as _orchestrator


_PROFILE_BODY = (
    "Jane Doe — Founding Engineer at Strand Bio\n\n"
    "Experience:\n"
    "  - Strand Bio (2024–present): Built the genomic data pipeline; "
    "owns the eventing service.\n"
    "  - MedAxis (2018–2024): Senior engineer; led the migration off "
    "Postgres to Snowflake.\n\n"
    "Values: calibrated honesty, boring tools, shipping things that "
    "compound. Currently building portable LLM-native context tooling."
)


def _orchestrator_always_fails(monkeypatch):
    def boom(_rel_path, _kind, _label=""):
        raise _orchestrator.OrchestratorUnavailable(
            "puppetmaster binary not found"
        )

    monkeypatch.setattr(_orchestrator, "start_import_job", boom)
    monkeypatch.setattr(_main, "start_import_job", boom)


def _stub_starter_drafter_returns(monkeypatch, pages: list[dict]):
    """Replace the LLM call for the starter (onboarding) prompt. Distinct
    from the capture-prompt stub in test_capture_ingest.py because this
    one asserts the broader system prompt is in play."""
    import json

    canned = json.dumps({"pages": pages})

    async def _fake_anthropic(
        _model: str, _prompt: str, *, system_prompt: str = ""
    ) -> str:
        # ``_call_anthropic_json`` applies the default _SYSTEM_PROMPT
        # internally when system_prompt is "", so the starter path
        # arrives here with system_prompt == "" (default-applied later).
        # The capture path explicitly passes _CAPTURE_SYSTEM_PROMPT. We
        # use the capture sentinel's ABSENCE to assert we're not on the
        # wrong code path.
        assert "extending an existing wiki" not in system_prompt, (
            "starter path must NOT use _CAPTURE_SYSTEM_PROMPT; got it: "
            f"{system_prompt[:120]}"
        )
        return canned

    monkeypatch.setattr(_dd, "_call_anthropic_json", _fake_anthropic)
    monkeypatch.setattr(_dd.settings, "anthropic_api_key", "test-key")


def test_import_falls_back_to_direct_drafter_when_puppetmaster_missing(
    client, owner_headers, wiki_root, monkeypatch
):
    """The fix: paste a resume on the hosted service, get back pages.

    Before this regression test landed, the Bootstrap wizard returned
    ``orchestrator.error = "puppetmaster binary not found"`` and the
    frontend rendered "Import failed — Orchestrator could not start"
    in red, full stop. There was no fallback even though the welcome
    flow uses the same drafter and works fine. New users hit this on
    day one and assumed the product was broken.
    """
    _orchestrator_always_fails(monkeypatch)
    _stub_starter_drafter_returns(
        monkeypatch,
        pages=[
            {
                "slug": "jane-doe",
                "title": "Jane Doe",
                "section": "entities",
                "tier": "private",
                "tags": ["self"],
                "body": "## Who\n\nFounding engineer at [[Strand Bio]].",
            },
            {
                "slug": "strand-bio",
                "title": "Strand Bio",
                "section": "entities",
                "tier": "private",
                "tags": ["work"],
                "body": "## Where\n\nGenomics startup. See also [[Jane Doe]].",
            },
            {
                "slug": "calibrated-honesty",
                "title": "Calibrated Honesty",
                "section": "concepts",
                "tier": "private",
                "tags": ["values"],
                "body": "## What\n\nOne of [[Jane Doe]]'s operating principles.",
            },
        ],
    )

    r = client.post(
        "/owner/import",
        headers=owner_headers,
        json={"kind": "resume", "content": _PROFILE_BODY, "label": "jane-resume"},
    )
    assert r.status_code == 201, r.text
    body = r.json()

    # Orchestrator path tried + failed (binary missing) — fine.
    assert body["orchestrator"]["error"]

    # The new fallback ran and produced 3 starter pages.
    assert body["drafted"] is not None, body
    drafted = body["drafted"]
    assert drafted.get("pages_created") == 3, drafted
    slugs = {p["slug"] for p in drafted["pages"]}
    assert slugs == {"jane-doe", "strand-bio", "calibrated-honesty"}

    # Files actually landed on disk so the wizard's "new pages" diff can
    # pick them up. This is what new users actually see on success.
    wiki = wiki_root / "wiki"
    assert (wiki / "entities" / "jane-doe.md").exists()
    assert (wiki / "entities" / "strand-bio.md").exists()
    assert (wiki / "concepts" / "calibrated-honesty.md").exists()


def test_import_with_no_llm_configured_returns_actionable_error(
    client, owner_headers, monkeypatch
):
    """When BOTH paths fail (Puppetmaster missing AND no LLM keys), the
    Bootstrap wizard still 201s, the raw is saved, and the drafted
    field surfaces ``kind: no_llm_configured`` so the UI can hint
    "set an Anthropic or OpenAI key in your Render env vars".

    The alternative — a 500 or a generic error — was strictly worse for
    self-hosters who haven't wired up an LLM yet; they got "Orchestrator
    could not start" and assumed the whole product was broken, when in
    reality they just needed a config var.
    """
    _orchestrator_always_fails(monkeypatch)
    monkeypatch.setattr(_dd.settings, "anthropic_api_key", "")
    monkeypatch.setattr(_dd.settings, "openai_api_key", "")

    r = client.post(
        "/owner/import",
        headers=owner_headers,
        json={"kind": "bio", "content": _PROFILE_BODY},
    )
    assert r.status_code == 201
    body = r.json()
    # Raw saved regardless — the user's content is never thrown away.
    assert body["ok"] is True
    assert body["rel_path"]
    # The drafted field communicates the reason.
    assert body["drafted"] is not None
    assert body["drafted"].get("kind") == "no_llm_configured"


def test_import_uses_starter_prompt_not_capture_prompt():
    """Guard against future refactors: /owner/import handles broad
    biographical inputs and should always invoke draft_starter_pages
    (which targets 6-12 pages), never draft_capture_pages (which
    targets 1-5 focused pages). If someone wires the wrong one up,
    new users get 2-page wikis that look like a misfire.
    """
    # The two functions are siblings in direct_drafter and must remain
    # distinct entry points. The starter prompt template asks for the
    # broader page count.
    assert _dd.draft_starter_pages is not _dd.draft_capture_pages
    assert "6" in _dd._USER_PROMPT_TEMPLATE
    # The capture prompt's disambiguating phrase is absent from the
    # starter prompt — that asymmetry is what keeps the page-count
    # behavior different.
    assert "extending an existing wiki" not in _dd._SYSTEM_PROMPT


def test_draft_starter_pages_forces_private(monkeypatch):
    """Starter drafts clamp to private, same as capture-context pages."""
    captured = {}

    async def fake_draft(**kwargs):
        captured.update(kwargs)
        return _dd.DraftResult(backend="test", model="x")

    monkeypatch.setattr(_dd, "_draft_with_prompt", fake_draft)

    import asyncio

    from app.tenants import Tenant

    tenant = Tenant(id="t", wiki_root=__import__("pathlib").Path("/tmp/unused"))
    asyncio.run(
        _dd.draft_starter_pages(
            source_label="bio",
            source_content="hello world",
            tenant=tenant,
        )
    )
    assert captured.get("force_tier") == "private"
