"""Regression tests for direct-LLM semantic-lint fallback (`direct_linter`).

What's pinned down:

1.  Fallback wiring. When `start_lint_swarm` calls subprocess.Popen and
    PUPPETMASTER_BIN doesn't exist, the swarm transparently switches to
    the direct-LLM path. The swarm record + tracked jobs end up in the
    same files (`.jobs.json`, `.lint-swarms.json`) so `swarm_status()`
    reads the result without branching.

2.  Artifact format. Direct-LLM workers write the same JSON shape
    puppetmaster workers do, at the same path
    (`<wiki_root>/.lint/<swarm_id>/<worker>.json`). The polling
    endpoint can't tell which backend produced an artifact.

3.  NoLLMConfigured branch. When neither puppetmaster nor any LLM key
    is configured, we surface a SPECIFIC error pointing the operator at
    both fixes (install puppetmaster OR add an API key), not the
    generic "puppetmaster not found" that confused hosted users.

4.  Wiki-dump budget. A pathologically large wiki must NOT silently
    truncate mid-page (which would corrupt the LLM's reading of any
    chopped page) — instead lowest-priority pages get dropped wholesale
    and a warning surfaces.

5.  Parallel execution. Multiple workers complete concurrently, not
    sequentially, so a 4-worker swarm runs in ~one worker's latency,
    not 4× that.

6.  Per-worker error isolation. If one worker's LLM call fails, peers
    must complete and surface their findings. A swarm where 1/4 workers
    crashes is still 3/4 useful.

7.  Draft endpoints (`draft_missing_page_direct`,
    `draft_contradiction_direct`). End-to-end: LLM JSON → parsed page
    → markdown file written under tenant.wiki_root.

8.  Per-tenant isolation. When the request runs inside a tenant
    context, the artifact + drafted page land under that tenant's
    wiki_root, not the global one.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import time
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def fresh_app(tmp_path, monkeypatch):
    """Reload app modules with a temp WIKI_ROOT so each test gets an
    isolated filesystem. Returns the reloaded ``direct_linter`` +
    ``lint_swarm`` modules.

    Why we reload: ``settings`` is computed at import-time, and
    ``direct_linter`` captures references to ``settings.wiki_root`` via
    the ``orchestrator`` module's globals. Reloading ensures every test
    sees its own tmp_path."""
    wiki_root = tmp_path / "wiki-root"
    (wiki_root / "wiki").mkdir(parents=True)
    (wiki_root / "raw").mkdir(parents=True)
    # Seed a tiny wiki so _gather_wiki_pages returns something.
    (wiki_root / "wiki" / "index.md").write_text(
        "---\ntype: index\ntitle: Index\ntier: public\n---\n# Index\nWelcome.\n",
        encoding="utf-8",
    )
    (wiki_root / "wiki" / "entities").mkdir()
    (wiki_root / "wiki" / "entities" / "avery.md").write_text(
        "---\ntype: entity\ntitle: Avery\ntier: public\n---\n# Avery\nThe owner.\n",
        encoding="utf-8",
    )

    monkeypatch.setenv("WIKI_ROOT", str(wiki_root))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-anthropic-key")
    # Force a stable model so chain logic is predictable.
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-test-model")
    # Make sure puppetmaster is "not found" by default in tests.
    monkeypatch.setenv("PUPPETMASTER_BIN", "/no/such/path/puppetmaster-xyz")

    import app.config

    importlib.reload(app.config)

    import app.orchestrator
    import app.lint_swarm
    import app.direct_linter

    importlib.reload(app.orchestrator)
    importlib.reload(app.lint_swarm)
    importlib.reload(app.direct_linter)

    return {
        "wiki_root": wiki_root,
        "direct_linter": app.direct_linter,
        "lint_swarm": app.lint_swarm,
        "orchestrator": app.orchestrator,
    }


def _run_async(coro):
    """Run an async coroutine to completion AND restore a usable event
    loop on the main thread afterward.

    Why this exists: ``_run_async()`` closes the event loop it
    creates AND leaves the policy's stored loop pointing at the
    closed one. The next ``asyncio.get_event_loop()`` call in the
    same process then raises 'There is no current event loop in
    thread MainThread' — which silently breaks any unrelated test
    that runs after this one and uses the legacy get_event_loop API
    (e.g. test_hosted_multitenant via httpx). Without this helper the
    test suite passes only when test ordering puts direct_linter
    last, which is a flaky-CI footgun.

    The fix: install a fresh, open event loop after we close the
    one we ran the coroutine on, so the policy's stored loop is
    always usable when the next test starts.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        # Restore a fresh, open loop so later tests in the same
        # process see the same state they would have at module load.
        asyncio.set_event_loop(asyncio.new_event_loop())


def _wait_for_jobs_done(direct_linter_mod, swarm_id: str, *, timeout: float = 10.0):
    """Poll the daemon thread until all jobs in this swarm are
    terminal. The tests run the LLM call via a mock, so completion
    should be near-instant — timeout is generous to absorb CI flake."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with direct_linter_mod._lock:
            jobs = direct_linter_mod._load_jobs()
        # Filter to jobs for THIS swarm — _load_jobs returns globals.
        in_flight = [
            j
            for j in jobs.values()
            if j.note and swarm_id in j.note and j.status == "running"
        ]
        if not in_flight:
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for swarm {swarm_id} workers to finish")


# ---------------------------------------------------------------------------
# Mock LLM helpers
# ---------------------------------------------------------------------------


def _install_fake_anthropic(direct_linter_mod, monkeypatch, *, findings_by_worker=None):
    """Replace ``_call_anthropic_json`` with a deterministic stub that
    inspects the user prompt for the worker name and returns canned
    findings for that worker. Lets each test assert against specific
    finding shapes without an actual network call."""
    findings_by_worker = findings_by_worker or {}

    async def fake(model, prompt, *, system_prompt=""):
        # Identify worker from the prompt body. Each lint_swarm worker
        # prompt has a distinctive TASK: line.
        if "contradiction" in prompt.lower() and "tension" in prompt.lower():
            worker = "contradictions"
        elif "stale claim" in prompt.lower():
            worker = "stale"
        elif "missing-pages" in prompt.lower() or "missing page" in prompt.lower():
            worker = "missing-pages"
        elif "public-tier leak" in prompt.lower() or "public-tier" in prompt.lower():
            worker = "public-leak"
        else:
            worker = "contradictions"
        return json.dumps(
            {"findings": findings_by_worker.get(worker, [])}
        )

    monkeypatch.setattr(direct_linter_mod, "_call_anthropic_json", fake)


# ---------------------------------------------------------------------------
# 1. Fallback wiring
# ---------------------------------------------------------------------------


def test_lint_swarm_falls_back_to_direct_when_puppetmaster_missing(
    fresh_app, monkeypatch
):
    """The user-reported bug: clicking 'Semantic lint (SWARM)' on
    Render returned '500 puppetmaster CLI not found'. After this
    commit the swarm should transparently switch to direct-LLM mode
    and complete successfully without ever surfacing that error."""
    direct_linter_mod = fresh_app["direct_linter"]
    lint_swarm_mod = fresh_app["lint_swarm"]

    _install_fake_anthropic(
        direct_linter_mod,
        monkeypatch,
        findings_by_worker={
            "contradictions": [
                {
                    "page_a": "wiki/concepts/a.md",
                    "page_b": "wiki/concepts/b.md",
                    "claim_a": "x is true",
                    "claim_b": "x is false",
                    "conflict": "direct contradiction",
                    "severity": "high",
                    "suggested_resolution": "investigate",
                }
            ],
            "missing-pages": [],
        },
    )

    record = lint_swarm_mod.start_lint_swarm(
        workers=["contradictions", "missing-pages"]
    )

    assert record.status == "running"
    assert len(record.worker_tracking_ids) == 2
    assert set(record.worker_kinds.values()) == {"contradictions", "missing-pages"}

    _wait_for_jobs_done(direct_linter_mod, record.swarm_id)

    # Artifacts on disk at the canonical path.
    artifacts_dir = Path(record.artifacts_dir)
    contradictions_artifact = artifacts_dir / "contradictions.json"
    missing_artifact = artifacts_dir / "missing-pages.json"
    assert contradictions_artifact.exists()
    assert missing_artifact.exists()
    c = json.loads(contradictions_artifact.read_text())
    assert len(c["findings"]) == 1
    assert c["findings"][0]["claim_a"] == "x is true"
    m = json.loads(missing_artifact.read_text())
    assert m["findings"] == []

    # swarm_status sees workers as "done", aggregates findings.
    status = lint_swarm_mod.swarm_status(record.swarm_id)
    assert status is not None
    assert status["status"] == "done"
    assert status["total_findings"] == 1


# ---------------------------------------------------------------------------
# 2. NoLLMConfigured branch — neither puppetmaster nor LLM key
# ---------------------------------------------------------------------------


def test_lint_swarm_errors_clearly_when_neither_puppetmaster_nor_llm_key(
    fresh_app, monkeypatch
):
    """If neither puppetmaster nor an LLM key is configured, the
    failure must point at BOTH fixes — not the generic "puppetmaster
    not found" that confused hosted users into thinking they needed
    to install puppetmaster when the actual fix was adding an API
    key."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    # IMPORTANT reload order: config first (settings rebound), then
    # every downstream module that captured a reference to the OLD
    # settings object at its own import time. direct_linter holds
    # ``from .config import settings`` so without reloading it the
    # no-key branch still sees the fixture's pre-test ANTHROPIC_API_KEY.
    import app.config
    import app.direct_linter
    import app.lint_swarm

    importlib.reload(app.config)
    importlib.reload(app.direct_linter)
    importlib.reload(app.lint_swarm)

    with pytest.raises(RuntimeError) as exc_info:
        app.lint_swarm.start_lint_swarm(workers=["contradictions"])
    msg = str(exc_info.value).lower()
    assert "puppetmaster" in msg
    assert "api key" in msg or "anthropic" in msg


# ---------------------------------------------------------------------------
# 3. Wiki-dump budget
# ---------------------------------------------------------------------------


def test_wiki_dump_drops_lowest_priority_pages_under_budget(fresh_app, monkeypatch):
    """A wiki larger than MAX_WIKI_CHARS must drop lowest-priority
    pages (queries before concepts before decisions) and surface a
    warning. Truncating mid-page would corrupt the LLM's reading and
    produce false positives."""
    wiki_root = fresh_app["wiki_root"]
    direct_linter_mod = fresh_app["direct_linter"]

    # Lower the cap dramatically to force the drop without writing
    # 80k chars of fixture data. Cap chosen so the fixture's index +
    # entity page PLUS our new concepts/kept.md fit, but adding the
    # queries/low.md on top blows the budget — exactly the drop we
    # want to assert.
    monkeypatch.setattr(direct_linter_mod, "MAX_WIKI_CHARS", 1000)

    # Add a big query (low priority) and a big concept (high priority).
    big_body = "y" * 400
    (wiki_root / "wiki" / "queries").mkdir()
    (wiki_root / "wiki" / "queries" / "low.md").write_text(
        f"---\ntype: query\n---\n{big_body}", encoding="utf-8"
    )
    (wiki_root / "wiki" / "concepts").mkdir()
    (wiki_root / "wiki" / "concepts" / "kept.md").write_text(
        f"---\ntype: concept\n---\n{big_body}", encoding="utf-8"
    )

    pages = direct_linter_mod._gather_wiki_pages(wiki_root)
    dump, warnings = direct_linter_mod._render_wiki_dump(pages)

    assert warnings, "expected a budget-warning when dropping pages"
    assert "low.md" in warnings[0]
    assert "kept.md" in dump
    # Critical: page bodies are not split — either a page is in the
    # dump in full or it's not.
    assert dump.count("path: wiki/queries/low.md") == 0


# ---------------------------------------------------------------------------
# 4. Parallel execution
# ---------------------------------------------------------------------------


def test_workers_run_in_parallel_not_sequentially(fresh_app, monkeypatch):
    """4 workers with a 0.4s simulated LLM call each should finish in
    well under 1.6s (the sequential lower bound). This pins down the
    asyncio.gather contract — a regression that serializes the calls
    would 4× the user-facing latency on every lint click."""
    direct_linter_mod = fresh_app["direct_linter"]
    lint_swarm_mod = fresh_app["lint_swarm"]

    call_count = {"n": 0}

    async def slow_fake(model, prompt, *, system_prompt=""):
        call_count["n"] += 1
        await asyncio.sleep(0.4)
        return json.dumps({"findings": []})

    monkeypatch.setattr(direct_linter_mod, "_call_anthropic_json", slow_fake)

    t0 = time.time()
    record = lint_swarm_mod.start_lint_swarm(
        workers=["contradictions", "stale", "missing-pages", "public-leak"]
    )
    _wait_for_jobs_done(direct_linter_mod, record.swarm_id, timeout=5.0)
    elapsed = time.time() - t0

    assert call_count["n"] == 4
    assert elapsed < 1.2, (
        f"4 workers should run in parallel; sequential would be ~1.6s, "
        f"got {elapsed:.2f}s. Regression suggests asyncio.gather "
        f"was replaced with serial awaits."
    )


# ---------------------------------------------------------------------------
# 5. Per-worker error isolation
# ---------------------------------------------------------------------------


def test_one_worker_failing_does_not_break_peers(fresh_app, monkeypatch):
    """The user's report was 'one error 500 nukes the whole panel'.
    Pin the opposite: one worker raising still lets the other three
    deliver their findings. Partial swarms are better than dead
    swarms."""
    direct_linter_mod = fresh_app["direct_linter"]
    lint_swarm_mod = fresh_app["lint_swarm"]

    async def fake(model, prompt, *, system_prompt=""):
        if "stale claim" in prompt.lower():
            raise RuntimeError("simulated stale-worker upstream 500")
        return json.dumps({"findings": [{"sample": "ok"}]})

    monkeypatch.setattr(direct_linter_mod, "_call_anthropic_json", fake)

    record = lint_swarm_mod.start_lint_swarm(
        workers=["contradictions", "stale", "missing-pages", "public-leak"]
    )
    _wait_for_jobs_done(direct_linter_mod, record.swarm_id)

    status = lint_swarm_mod.swarm_status(record.swarm_id)
    assert status is not None

    # Find the stale worker — it should have job_status=error but an
    # artifact file with `error:` set so the UI can show the failure.
    by_worker = {w["worker"]: w for w in status["workers"]}
    assert by_worker["stale"]["job_status"] == "error"
    assert by_worker["contradictions"]["job_status"] == "done"
    assert by_worker["missing-pages"]["job_status"] == "done"
    assert by_worker["public-leak"]["job_status"] == "done"

    # 3 healthy workers × 1 finding each = 3 findings, despite stale
    # blowing up.
    assert status["total_findings"] == 3


# ---------------------------------------------------------------------------
# 6. Artifact format parity
# ---------------------------------------------------------------------------


def test_direct_artifact_format_matches_puppetmaster_shape(fresh_app, monkeypatch):
    """`swarm_status` reads each worker's artifact via
    `_read_worker_artifact` which expects ``{"findings": [...]}``.
    Direct-LLM artifacts MUST match that shape — otherwise the polling
    UI shows zero findings even when the LLM returned plenty."""
    direct_linter_mod = fresh_app["direct_linter"]
    lint_swarm_mod = fresh_app["lint_swarm"]

    _install_fake_anthropic(
        direct_linter_mod,
        monkeypatch,
        findings_by_worker={"contradictions": [{"finding": 1}, {"finding": 2}]},
    )

    record = lint_swarm_mod.start_lint_swarm(workers=["contradictions"])
    _wait_for_jobs_done(direct_linter_mod, record.swarm_id)

    artifact = Path(record.artifacts_dir) / "contradictions.json"
    data = json.loads(artifact.read_text())

    # Must have a top-level "findings" list.
    assert isinstance(data.get("findings"), list)
    assert len(data["findings"]) == 2
    # Should also tag which backend produced it for debugging.
    assert "backend" in data


# ---------------------------------------------------------------------------
# 7. Draft missing page endpoint fallback
# ---------------------------------------------------------------------------


def test_draft_missing_page_direct_writes_file(fresh_app, monkeypatch):
    """End-to-end: the LLM returns a single-page JSON object, the
    direct linter parses it, writes a markdown file under the wiki
    root, and returns a result pointing at the written path."""
    direct_linter_mod = fresh_app["direct_linter"]
    wiki_root = fresh_app["wiki_root"]

    async def fake(model, prompt, *, system_prompt=""):
        return json.dumps(
            {
                "pages": [
                    {
                        "slug": "andrej-karpathy",
                        "title": "Andrej Karpathy",
                        "section": "entities",
                        "tier": "private",
                        "tags": ["ai", "person"],
                        "body": (
                            "## Background\n\nAndrej is a researcher.\n\n"
                            "## Why this page\n\nMentioned in [[Avery]] and "
                            "across several decisions. " + ("Filler. " * 60)
                        ),
                    }
                ]
            }
        )

    monkeypatch.setattr(direct_linter_mod, "_call_anthropic_json", fake)

    result = _run_async(
        direct_linter_mod.draft_missing_page_direct(
            proposed_title="Andrej Karpathy",
            proposed_section="entities",
            bootstrap_summary="A researcher mentioned in 3+ pages.",
            evidence=[{"page": "wiki/entities/cary.md", "quote": "talks about Andrej"}],
            mentioned_in=["wiki/index.md"],
        )
    )

    target = wiki_root / result.written_to
    assert target.exists()
    body = target.read_text(encoding="utf-8")
    assert "title: Andrej Karpathy" in body
    assert "tier: private" in body
    assert "## Background" in body


def test_draft_missing_page_direct_does_not_overwrite_existing(
    fresh_app, monkeypatch
):
    """If a page at the proposed slug already exists, the draft must
    land on a `-draft` suffix path so the user can compare both
    versions side-by-side. Critical for the lint→draft loop: re-running
    a lint after a manual fix mustn't clobber the manual version."""
    direct_linter_mod = fresh_app["direct_linter"]
    wiki_root = fresh_app["wiki_root"]

    # Pre-exist a page at the slug the LLM will pick.
    existing_dir = wiki_root / "wiki" / "entities"
    existing_dir.mkdir(exist_ok=True)
    (existing_dir / "existing-person.md").write_text(
        "---\ntype: entity\ntitle: Existing Person\ntier: private\n---\noriginal body\n",
        encoding="utf-8",
    )

    async def fake(model, prompt, *, system_prompt=""):
        return json.dumps(
            {
                "pages": [
                    {
                        "slug": "existing-person",
                        "title": "Existing Person",
                        "section": "entities",
                        "tier": "private",
                        "tags": [],
                        "body": "## New body\n\n" + ("Filler. " * 40),
                    }
                ]
            }
        )

    monkeypatch.setattr(direct_linter_mod, "_call_anthropic_json", fake)

    result = _run_async(
        direct_linter_mod.draft_missing_page_direct(
            proposed_title="Existing Person",
            proposed_section="entities",
            bootstrap_summary="...",
            evidence=[],
            mentioned_in=[],
        )
    )

    assert result.written_to.endswith("-draft.md"), (
        f"expected -draft suffix to avoid clobbering existing page; "
        f"got {result.written_to!r}"
    )
    # Original page is unchanged.
    assert "original body" in (existing_dir / "existing-person.md").read_text()


# ---------------------------------------------------------------------------
# 8. Draft contradiction endpoint fallback
# ---------------------------------------------------------------------------


def test_draft_contradiction_direct_writes_query_page(fresh_app, monkeypatch):
    """Contradiction drafts always land in wiki/queries/ with a
    YYYY-MM-DD- slug prefix. Mirrors the puppetmaster path's filename
    convention so subsequent lint passes can recognize reconciliation
    pages."""
    direct_linter_mod = fresh_app["direct_linter"]
    wiki_root = fresh_app["wiki_root"]

    async def fake(model, prompt, *, system_prompt=""):
        return json.dumps(
            {
                "pages": [
                    {
                        "slug": "reconcile-page-a-vs-b",
                        "title": "Reconciling A vs B",
                        "section": "queries",
                        "tier": "private",
                        "tags": ["reconciliation"],
                        "body": (
                            "## The tension\n\nA and B disagree on x.\n\n"
                            "## Resolution\n\nBoth true at different scopes.\n\n"
                            "## Suggested page edits\n\n- edit A\n- edit B"
                        ),
                    }
                ]
            }
        )

    monkeypatch.setattr(direct_linter_mod, "_call_anthropic_json", fake)

    result = _run_async(
        direct_linter_mod.draft_contradiction_direct(
            page_a="wiki/concepts/a.md",
            page_b="wiki/concepts/b.md",
            title_a="A",
            title_b="B",
            claim_a="x is true",
            claim_b="x is false",
            conflict="direct contradiction",
            suggested_resolution=None,
        )
    )

    target = wiki_root / result.written_to
    assert target.exists()
    assert "wiki/queries/" in result.written_to
    # Slug must start with today's date so chronological listing groups
    # all reconciliations together.
    fname = Path(result.written_to).name
    assert fname[:10].count("-") == 2  # YYYY-MM-DD-...
