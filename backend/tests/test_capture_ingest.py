"""Tests for /owner/capture/paste ingest behavior.

The capture flow has two paths: save the raw blob (always), and
optionally generate wiki pages from it. The "optionally" used to
mean "Puppetmaster runs on self-host, nothing happens in hosted
mode" — turning the toggle on in hosted mode was a silent no-op
because the Puppetmaster CLI isn't on Render's PATH.

This file locks down the fix: when Puppetmaster is unavailable we
fall through to the ``direct_drafter.draft_capture_pages`` path so
hosted users actually get pages from their captures, AND the
behavior on ``run_orchestrator=False`` is still "raw only, no
pages" so the opt-out is honored.
"""
from __future__ import annotations

from pathlib import Path

from app import direct_drafter as _dd
from app import main as _main
from app import orchestrator as _orchestrator


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


_MIN_BODY = (
    "Decision discussion from the team meeting on 2026-05-24. Agreed "
    "to use Postgres for the user-events table because we need joins "
    "with the existing accounts data. Considered ClickHouse but the "
    "ops overhead outweighed query speed for our volumes. Owner: "
    "Alice. Follow-up: review in Q4."
)


def _orchestrator_always_fails(monkeypatch):
    """Simulate Puppetmaster missing (the hosted reality) by raising
    OrchestratorUnavailable from start_ingest_job. We also stub the
    main module's import binding because it caches the function."""

    def boom(_rel_path, _note=""):
        raise _orchestrator.OrchestratorUnavailable(
            "puppetmaster binary not found"
        )

    monkeypatch.setattr(_orchestrator, "start_ingest_job", boom)
    monkeypatch.setattr(_main, "start_ingest_job", boom)


def _stub_drafter_returns(monkeypatch, pages: list[dict]):
    """Replace the LLM call so we don't hit Anthropic/OpenAI in tests.
    Returns the canned JSON the drafter would have gotten back."""
    import json

    canned = json.dumps({"pages": pages})

    async def _fake_anthropic(
        _model: str, _prompt: str, *, system_prompt: str = ""
    ) -> str:
        # The capture path passes its own _CAPTURE_SYSTEM_PROMPT through
        # the system_prompt kwarg. We pick a contiguous phrase unique
        # to the capture prompt (and absent from the onboarding one).
        assert "extending an existing wiki" in system_prompt, (
            f"capture path must pass _CAPTURE_SYSTEM_PROMPT, got: "
            f"{system_prompt[:200]}"
        )
        return canned

    monkeypatch.setattr(_dd, "_call_anthropic_json", _fake_anthropic)
    monkeypatch.setattr(_dd.settings, "anthropic_api_key", "test-key")


# ---------------------------------------------------------------------------
# raw-only path (toggle off) still works
# ---------------------------------------------------------------------------


def test_paste_without_run_orchestrator_is_raw_only(
    client, owner_headers, wiki_root
):
    """The opt-out path: ``run_orchestrator: false`` saves raw and
    explicitly does NOT call any LLM. Important so the "save raw only"
    button is a real escape hatch (cost control, batch review, etc.)."""
    r = client.post(
        "/owner/capture/paste",
        headers=owner_headers,
        json={
            "content": _MIN_BODY,
            "label": "raw-only-paste",
            "run_orchestrator": False,
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ok"] is True
    # No ingest fields populated.
    assert body.get("orchestrator") is None
    assert body.get("drafted") is None
    # Raw IS saved (the always-happens half of capture).
    rel = body["rel_path"]
    assert (wiki_root / rel).exists()


def test_paste_omitting_run_orchestrator_treats_as_raw_only(
    client, owner_headers
):
    """Omitting the flag entirely is the same as setting it to false —
    backwards compat with any older API clients out there that don't
    know about the toggle."""
    r = client.post(
        "/owner/capture/paste",
        headers=owner_headers,
        json={"content": _MIN_BODY, "label": "no-flag-paste"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body.get("orchestrator") is None
    assert body.get("drafted") is None


# ---------------------------------------------------------------------------
# orchestrator-unavailable + LLM available -> direct_drafter fallback
# ---------------------------------------------------------------------------


def test_paste_with_ingest_falls_back_to_direct_drafter(
    client, owner_headers, wiki_root, monkeypatch
):
    """The whole reason this fix exists. When the user opts INTO ingest
    but Puppetmaster isn't on PATH (the hosted Render reality), we
    must fall through to direct_drafter and actually produce pages.
    Before the fix this was a silent no-op."""
    _orchestrator_always_fails(monkeypatch)
    _stub_drafter_returns(
        monkeypatch,
        pages=[
            {
                "slug": "use-postgres-for-events",
                "title": "Use Postgres For Events",
                "section": "decisions",
                "tier": "private",
                "tags": ["data", "infra"],
                "body": (
                    "## Why Postgres\n\nThe events table needs joins with "
                    "accounts. ClickHouse was faster on raw scans but the "
                    "ops overhead didn't pencil. See [[Accounts]]."
                ),
            },
            {
                "slug": "events-table",
                "title": "Events Table",
                "section": "projects",
                "tier": "private",
                "tags": ["data"],
                "body": (
                    "## Schema\n\nLog of user actions, joined with the "
                    "[[Use Postgres For Events]] decision."
                ),
            },
        ],
    )

    r = client.post(
        "/owner/capture/paste",
        headers=owner_headers,
        json={
            "content": _MIN_BODY,
            "label": "team-meeting-2026-05-24",
            "subdir": "meetings",
            "run_orchestrator": True,
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()

    # Orchestrator path tried + failed (binary missing) — fine.
    assert body["orchestrator"] is not None
    assert "error" in body["orchestrator"]

    # The new fallback ran and produced pages.
    assert body["drafted"] is not None, body
    drafted = body["drafted"]
    assert "pages_created" in drafted, drafted
    assert drafted["pages_created"] == 2, drafted
    assert {p["section"] for p in body["drafted"]["pages"]} == {
        "decisions",
        "projects",
    }

    # Pages actually landed on disk (this is the user-facing promise).
    wiki = wiki_root / "wiki"
    # Decision pages auto-prefix with today's date per the existing
    # ``_validate_page_dict`` rule — we don't pin the exact slug here,
    # just confirm a decision file with our title was written.
    decisions = list((wiki / "decisions").glob("*use-postgres-for-events.md"))
    assert decisions, list((wiki / "decisions").iterdir())
    assert (wiki / "projects" / "events-table.md").exists()


def test_paste_drafted_pages_default_to_private_tier(
    client, owner_headers, wiki_root, monkeypatch
):
    """Defense-in-depth on the writeback invariant: even if the LLM
    tries to ship ``tier: public``, the drafter validator clamps to
    private. Capture path inherits this through the shared validator,
    so we verify it end-to-end here."""
    _orchestrator_always_fails(monkeypatch)
    _stub_drafter_returns(
        monkeypatch,
        pages=[
            {
                "slug": "leak-attempt",
                "title": "Leak Attempt",
                "section": "concepts",
                "tier": "public",  # LLM tries to publish
                "tags": ["test"],
                "body": "## Hi\n\nThis page tried to go public but should be private.",
            }
        ],
    )

    r = client.post(
        "/owner/capture/paste",
        headers=owner_headers,
        json={
            "content": _MIN_BODY,
            "label": "tier-clamp-test",
            "run_orchestrator": True,
        },
    )
    assert r.status_code == 201
    on_disk = wiki_root / "wiki" / "concepts" / "leak-attempt.md"
    assert on_disk.exists()
    # Tier on the rendered page is private — matches the writeback
    # contract documented at /llm-writeback-spec.
    assert "tier: private" in on_disk.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# orchestrator-unavailable + no LLM keys -> clean error
# ---------------------------------------------------------------------------


def test_paste_with_ingest_no_llm_returns_clean_error(
    client, owner_headers, monkeypatch
):
    """If BOTH paths are unavailable (Puppetmaster missing + no LLM
    keys configured) we still 201 with the raw saved, but the
    ``drafted`` field surfaces the reason so the UI can show
    "configure an LLM key to enable ingest" instead of leaving the
    user wondering why their toggle did nothing."""
    _orchestrator_always_fails(monkeypatch)
    # No anthropic / openai keys.
    monkeypatch.setattr(_dd.settings, "anthropic_api_key", "")
    monkeypatch.setattr(_dd.settings, "openai_api_key", "")

    r = client.post(
        "/owner/capture/paste",
        headers=owner_headers,
        json={
            "content": _MIN_BODY,
            "label": "no-keys",
            "run_orchestrator": True,
        },
    )
    assert r.status_code == 201
    body = r.json()
    # Raw still saved — the user's content is never lost just because
    # ingest can't run.
    assert body["ok"] is True
    assert body["rel_path"]
    # The drafted field communicates the reason.
    assert body["drafted"] is not None
    assert body["drafted"].get("kind") == "no_llm_configured"


# ---------------------------------------------------------------------------
# capture vs onboarding prompts must not drift
# ---------------------------------------------------------------------------


def test_capture_uses_different_system_prompt_than_onboarding():
    """The capture prompt explicitly says "1 to 5 pages" and "you are
    NOT drafting a starter wiki". Onboarding prompt says "starter set"
    and targets 6-12. They MUST be distinct so a single capture doesn't
    silently bloat the wiki with a dozen padded pages — that was the
    quality concern behind keeping the toggle around."""
    assert _dd._CAPTURE_SYSTEM_PROMPT != _dd._SYSTEM_PROMPT
    assert "1 to 5" in _dd._CAPTURE_USER_PROMPT_TEMPLATE
    assert "6" in _dd._USER_PROMPT_TEMPLATE  # onboarding asks for ~6-12
    # Capture prompt disavows starter-wiki framing (line-wrap-safe phrase).
    assert "extending an existing wiki" in _dd._CAPTURE_SYSTEM_PROMPT
