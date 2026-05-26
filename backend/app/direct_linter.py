"""Direct-LLM semantic lint — hosted-mode replacement for the Puppetmaster
swarm in ``lint_swarm.py``.

Why this exists
---------------
The original ``lint_swarm.start_lint_swarm`` spawns N Puppetmaster
``cursor`` subprocesses in parallel; each one is a full Cursor SDK agent
that reads the wiki, runs analysis, and writes a JSON findings file. On
self-host that's the right architecture — durable state, real agent
exploration, full filesystem access. On the hosted Render instance the
puppetmaster CLI doesn't exist, so the spawn raises ``FileNotFoundError``
and the user sees a confusing 500.

Approach here mirrors what we already shipped for ``direct_drafter``:
one structured-output LLM call per worker, sent the wiki content inline.
Trade-offs vs Puppetmaster:

* CHEAPER. One LLM call per worker (4 total per swarm) instead of four
  Cursor SDK agents each making their own internal calls.
* FASTER for small wikis (5-50 pages) since there's no subprocess
  startup overhead and no multi-step exploration round-trips.
* LESS POWERFUL on huge wikis — at ~150+ pages the inlined wiki dump
  pushes the LLM context budget. Self-host with Puppetmaster's agentic
  read-on-demand is the right tool for those. We surface this honestly
  in the warnings list.
* NO DURABLE STATE. Each lint pass is a fresh LLM call; we don't have
  Puppetmaster's SQLite-backed replay. The hosted instance's filesystem
  is ephemeral anyway, so this matches the actual storage shape.

Per-worker output lives at the same ``<wiki_root>/.lint/<swarm_id>/<
worker>.json`` path puppetmaster workers would write to, so
``lint_swarm.swarm_status()`` reads the artifacts transparently — no
caller needs to know which path produced them.

The asyncio.gather call inside a background thread keeps the HTTP
handler's response time bounded: ``start_lint_swarm_direct`` returns
the swarm record immediately, and the frontend polls
``/owner/lint/swarm/{id}`` for progress. Same UX as puppetmaster.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from . import lint_swarm as _lint_swarm
from .config import settings
from .direct_drafter import (
    NoLLMConfigured,
    _call_anthropic_json,
    _call_openai_json,
    _extract_json,
)
from .llm import (
    ANTHROPIC_FALLBACK_CHAIN,
    OPENAI_FALLBACK_CHAIN,
    LLMProviderError,
    ModelNotFoundError,
    _build_chain,
)
from .orchestrator import (
    TrackedJob,
    _load_jobs,
    _lock,
    _save_jobs,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Size budgets
# ---------------------------------------------------------------------------
#
# Anthropic + OpenAI both happily accept 100k+ chars of context, but
# rate-limit and latency get bad fast above ~40k chars. We cap the
# inlined wiki dump so a sprawling wiki doesn't silently degrade the
# lint quality (the LLM starts missing pages from the end of the
# context). When we hit the cap we surface a warning AND drop the
# lowest-priority pages (queries → projects → concepts) rather than
# truncating mid-page.

MAX_WIKI_CHARS = 80_000  # ~16k words; covers ~50-80 typical pages.
MAX_BODY_PER_PAGE = 6_000  # one outlier page can't blow the budget.


# Worker prompt prefix that frames the inlined wiki dump for the LLM.
# Mirrors lint_swarm.WORKERS but rephrased for "you already have the
# content inline" rather than "go read files yourself".
_DIRECT_PREAMBLE = """You are a semantic-lint worker for a personal LLM wiki.

The wiki's full markdown content is included inline below under the
======== WIKI BEGIN ======== / ======== WIKI END ======== markers.

Each page is delimited by a `# path: <rel-path>` line and is followed by
its YAML frontmatter and markdown body. Cross-page references use
[[Wikilinks]] (Obsidian-style).

Your job is to analyze the inlined content and emit a JSON findings file
matching the schema below. Be CONSERVATIVE — false positives waste the
owner's review attention more than false negatives.

Output a SINGLE JSON object, no prose, no markdown fence. If your
analysis turns up no findings, emit `{"findings": []}`.

"""


# ---------------------------------------------------------------------------
# Wiki content gathering
# ---------------------------------------------------------------------------


@dataclass
class _WikiPage:
    rel_path: str
    body: str
    section: str  # "entities" | "concepts" | "decisions" | "projects" | "queries" | "sources" | "root"


# Priority for drop order when we exceed MAX_WIKI_CHARS. Lower is
# kept-longest. Mirrors the handshake's "notable pages" priority so the
# direct linter has access to the same high-signal pages a Puppetmaster
# worker would have prioritized.
_SECTION_PRIORITY = {
    "entities": 0,
    "decisions": 1,
    "root": 2,  # index.md, overview.md, log.md
    "concepts": 3,
    "projects": 4,
    "sources": 5,
    "queries": 6,
}


def _classify_section(rel_path: str) -> str:
    parts = rel_path.replace("\\", "/").split("/")
    if len(parts) < 2:
        return "root"
    section = parts[1]
    if section in _SECTION_PRIORITY:
        return section
    if len(parts) == 2:
        return "root"
    return "root"


def _gather_wiki_pages(wiki_root: Path) -> list[_WikiPage]:
    """Read every .md file under ``wiki_root/wiki``. Returns pages in
    deterministic order: ``index.md`` first, then by section priority,
    then lexicographic within each section. The order matters because
    it's also the drop order if we exceed the byte budget."""
    base = wiki_root / "wiki"
    if not base.exists():
        return []
    pages: list[_WikiPage] = []
    for md in sorted(base.rglob("*.md")):
        try:
            body = md.read_text(encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            logger.warning("direct_linter.read_failed path=%s err=%s", md, exc)
            continue
        rel = md.relative_to(wiki_root).as_posix()
        section = _classify_section(rel)
        # Truncate pathologically long pages so one outlier can't blow
        # the budget alone.
        if len(body) > MAX_BODY_PER_PAGE:
            body = body[:MAX_BODY_PER_PAGE] + "\n\n<!-- ...truncated for lint... -->\n"
        pages.append(_WikiPage(rel_path=rel, body=body, section=section))
    # Stable sort: priority first, then alphabetic within section.
    pages.sort(key=lambda p: (_SECTION_PRIORITY.get(p.section, 99), p.rel_path))
    return pages


def _render_wiki_dump(pages: list[_WikiPage]) -> tuple[str, list[str]]:
    """Build the inlined-wiki block for the LLM prompt. Drops pages
    from the end (lowest priority) until under MAX_WIKI_CHARS.

    Returns (dump_text, warnings). Warnings flag dropped pages so the
    UI can surface "ran on N of M pages; X dropped due to size".
    """
    warnings: list[str] = []
    chunks: list[str] = []
    used = 0
    dropped: list[str] = []
    for page in pages:
        block = f"\n# path: {page.rel_path}\n{page.body.strip()}\n"
        if used + len(block) > MAX_WIKI_CHARS and chunks:
            dropped.append(page.rel_path)
            continue
        chunks.append(block)
        used += len(block)
    if dropped:
        warnings.append(
            f"inlined-wiki budget hit ({MAX_WIKI_CHARS} chars); "
            f"{len(dropped)} lower-priority page(s) excluded from this lint: "
            + ", ".join(dropped[:10])
            + ("…" if len(dropped) > 10 else "")
        )
    return "\n".join(chunks), warnings


# ---------------------------------------------------------------------------
# Per-worker LLM call
# ---------------------------------------------------------------------------


async def _call_one_worker(
    worker_name: str,
    worker_prompt: str,
    wiki_dump: str,
) -> tuple[list[dict], str]:
    """Send the lint prompt + wiki dump to an LLM. Returns
    ``(findings, backend_label)`` where backend_label is e.g.
    ``"anthropic:claude-sonnet-4"`` for diagnostics.

    Tries Anthropic first (its tool-calling JSON tends to be cleaner
    for structured-output tasks), falls back to OpenAI if Anthropic
    fails or isn't configured. Mirrors the provider-chain logic in
    ``direct_drafter._draft_with_prompt``.
    """
    if not settings.anthropic_api_key and not settings.openai_api_key:
        raise NoLLMConfigured(
            "No LLM API key configured. Set ANTHROPIC_API_KEY or "
            "OPENAI_API_KEY so semantic lint can run on the hosted "
            "instance (or install Puppetmaster + Cursor SDK for "
            "self-host)."
        )

    full_prompt = (
        _DIRECT_PREAMBLE
        + worker_prompt.strip()
        + "\n\n======== WIKI BEGIN ========\n"
        + wiki_dump
        + "\n======== WIKI END ========\n"
    )

    raw: Optional[str] = None
    backend_label = ""
    last_exc: Optional[Exception] = None

    if settings.anthropic_api_key:
        chain = _build_chain(settings.anthropic_model, ANTHROPIC_FALLBACK_CHAIN)
        for model in chain:
            try:
                raw = await _call_anthropic_json(
                    model,
                    full_prompt,
                    system_prompt=(
                        "You are a precise JSON-emitting semantic-lint "
                        "tool. Output exactly one JSON object matching "
                        "the schema in the user prompt. No prose, no "
                        "markdown fence."
                    ),
                )
                backend_label = f"anthropic:{model}"
                last_exc = None
                break
            except ModelNotFoundError as exc:
                last_exc = exc
                continue
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                break

    if raw is None and settings.openai_api_key:
        chain = _build_chain(settings.openai_model, OPENAI_FALLBACK_CHAIN)
        for model in chain:
            try:
                raw = await _call_openai_json(
                    model,
                    full_prompt,
                    system_prompt=(
                        "You are a precise JSON-emitting semantic-lint "
                        "tool. Output exactly one JSON object."
                    ),
                )
                backend_label = f"openai:{model}"
                last_exc = None
                break
            except ModelNotFoundError as exc:
                last_exc = exc
                continue
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                break

    if raw is None:
        if last_exc is not None:
            raise last_exc
        raise LLMProviderError(
            f"direct_linter[{worker_name}]: no LLM provider succeeded"
        )

    findings = _parse_findings(raw)
    return findings, backend_label


def _parse_findings(raw: str) -> list[dict]:
    """Parse the LLM response into a list of finding dicts. Returns
    ``[]`` on any parse error — partial findings beat hard crashes,
    and the artifact-status reader already labels empty results as
    "no findings" which is the right framing.
    """
    try:
        data = _extract_json(raw)
    except Exception as exc:  # noqa: BLE001
        logger.warning("direct_linter.parse_failed raw=%r exc=%s", raw[:200], exc)
        return []
    if not isinstance(data, dict):
        return []
    findings = data.get("findings", [])
    if not isinstance(findings, list):
        return []
    # Defensive type coercion: each finding must be a dict.
    return [f for f in findings if isinstance(f, dict)]


# ---------------------------------------------------------------------------
# TrackedJob bridge
# ---------------------------------------------------------------------------
#
# The puppetmaster path creates real TrackedJob entries in .jobs.json so
# the swarm-status endpoint can read each worker's job state. We do the
# same here so swarm_status() doesn't need to branch on backend — to
# the polling client a direct-linter run looks identical to a
# puppetmaster swarm, just (usually) much faster.


def _create_running_job(worker_name: str, swarm_id: str, log_path: Path) -> TrackedJob:
    import uuid

    tracking_id = uuid.uuid4().hex[:12]
    job = TrackedJob(
        tracking_id=tracking_id,
        kind=f"lint-{worker_name}",
        raw_path=f".lint/{swarm_id}/{worker_name}.json",
        note=f"direct-LLM lint swarm {swarm_id} worker: {worker_name}",
        started_at=datetime.now(timezone.utc).isoformat(),
        cwd=str(settings.wiki_root),
        log_path=str(log_path),
        artifacts_path=str(
            settings.wiki_root / ".lint" / swarm_id / f"{worker_name}.json"
        ),
    )
    job.status = "running"
    with _lock:
        jobs = _load_jobs()
        jobs[tracking_id] = job
        _save_jobs(jobs)
    return job


def _mark_job_terminal(
    tracking_id: str, *, status: str, exit_code: Optional[int] = 0
) -> None:
    """Update a TrackedJob to status='done'/'error' and stamp ended_at.
    Mirrors what orchestrator._stream_logs does when a subprocess exits."""
    with _lock:
        jobs = _load_jobs()
        job = jobs.get(tracking_id)
        if job is None:
            return
        job.status = status
        job.exit_code = exit_code
        job.ended_at = datetime.now(timezone.utc).isoformat()
        jobs[tracking_id] = job
        _save_jobs(jobs)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def start_lint_swarm_direct(
    workers: list[str],
    swarm_id: str,
    artifacts_dir: Path,
    log_dir: Path,
) -> tuple[list[TrackedJob], dict[str, str]]:
    """Spawn the direct-LLM equivalent of a puppetmaster lint swarm.

    Creates one TrackedJob per worker (status="running"), spawns a
    daemon thread that runs all workers concurrently via
    ``asyncio.gather``, and returns immediately with the job list +
    a tracking_id → worker_name map.

    The caller (``lint_swarm.start_lint_swarm``) wires those into the
    LintSwarmRecord exactly as if puppetmaster had spawned them. The
    polling endpoint then sees workers transition from "running" to
    "done"/"error" as the LLM calls complete.

    Args:
        workers: Worker names from ``lint_swarm.WORKERS`` keys
            (e.g. ["contradictions", "stale", "missing-pages",
            "public-leak"]).
        swarm_id: The swarm id assigned by ``start_lint_swarm``; we
            reuse it so artifact paths match.
        artifacts_dir: Pre-created
            ``<wiki_root>/.lint/<swarm_id>/`` directory.
        log_dir: Directory under which to write per-worker logs
            (parity with puppetmaster's log placement).

    Returns:
        (jobs, worker_kinds) — jobs is the list of TrackedJob records
        already persisted to ``.jobs.json``; worker_kinds maps each
        job's tracking_id to its worker name.

    Raises:
        ValueError: if any worker name is unknown.
        NoLLMConfigured: if no LLM API key is set.
    """
    invalid = [w for w in workers if w not in _lint_swarm.WORKERS]
    if invalid:
        raise ValueError(f"unknown lint workers: {invalid}")
    if not settings.anthropic_api_key and not settings.openai_api_key:
        raise NoLLMConfigured(
            "No LLM API key configured. Set ANTHROPIC_API_KEY or "
            "OPENAI_API_KEY to enable direct-LLM lint on hosted "
            "deploys, or install puppetmaster + Cursor SDK for the "
            "self-host swarm path."
        )

    log_dir.mkdir(parents=True, exist_ok=True)

    jobs: list[TrackedJob] = []
    worker_kinds: dict[str, str] = {}
    job_by_worker: dict[str, TrackedJob] = {}
    for worker_name in workers:
        log_path = log_dir / f"direct-{swarm_id}-{worker_name}.log"
        job = _create_running_job(worker_name, swarm_id, log_path)
        jobs.append(job)
        worker_kinds[job.tracking_id] = worker_name
        job_by_worker[worker_name] = job

    # Gather wiki content ONCE for all workers — they all need the
    # same dump, no point re-reading + re-rendering 4 times.
    pages = _gather_wiki_pages(settings.wiki_root)
    wiki_dump, gather_warnings = _render_wiki_dump(pages)

    # Spawn the background runner. Using a thread (not a task on the
    # FastAPI event loop) keeps the HTTP handler's response time
    # bounded and avoids leaking lint work into the request lifecycle.
    runner = threading.Thread(
        target=_run_workers_thread,
        args=(workers, wiki_dump, gather_warnings, artifacts_dir, job_by_worker),
        name=f"direct-lint-{swarm_id}",
        daemon=True,
    )
    runner.start()

    return jobs, worker_kinds


def _run_workers_thread(
    workers: list[str],
    wiki_dump: str,
    gather_warnings: list[str],
    artifacts_dir: Path,
    job_by_worker: dict[str, TrackedJob],
) -> None:
    """Thread target: build a fresh event loop, run all workers via
    asyncio.gather, write artifacts, update job states. Any exception
    inside a single worker is caught and surfaced as that worker's
    ``status="error"`` — peers continue. A swarm-wide blow-up is
    impossible by construction (we catch BaseException at the loop
    level)."""
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        tasks = [
            _run_one_worker_with_artifact(
                worker_name=name,
                wiki_dump=wiki_dump,
                gather_warnings=gather_warnings,
                artifacts_dir=artifacts_dir,
                tracking_id=job_by_worker[name].tracking_id,
            )
            for name in workers
        ]
        loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
    except BaseException as exc:  # noqa: BLE001
        logger.error("direct_linter.swarm_crashed exc=%s", exc)
        # Defensive: mark everything not yet terminal as error so the
        # status endpoint stops reporting "running" forever.
        for name, job in job_by_worker.items():
            _mark_job_terminal(job.tracking_id, status="error", exit_code=1)
    finally:
        loop.close()


async def _run_one_worker_with_artifact(
    *,
    worker_name: str,
    wiki_dump: str,
    gather_warnings: list[str],
    artifacts_dir: Path,
    tracking_id: str,
) -> None:
    """Single-worker pipeline: call LLM → parse findings → write
    artifact → mark job terminal. Exceptions are caught and recorded
    as worker status="error" so the swarm-level gather() never sees
    a raise."""
    worker_prompt = _lint_swarm.WORKERS[worker_name]
    artifact_path = artifacts_dir / f"{worker_name}.json"
    try:
        findings, backend_label = await _call_one_worker(
            worker_name, worker_prompt, wiki_dump
        )
        payload: dict[str, Any] = {
            "findings": findings,
            "backend": backend_label,
        }
        if gather_warnings:
            payload["warnings"] = gather_warnings
        artifact_path.write_text(
            json.dumps(payload, indent=2), encoding="utf-8"
        )
        _mark_job_terminal(tracking_id, status="done", exit_code=0)
        logger.info(
            "direct_linter.worker_done worker=%s findings=%d backend=%s",
            worker_name,
            len(findings),
            backend_label,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("direct_linter.worker_failed worker=%s", worker_name)
        # Surface the error in the artifact so the UI can show it
        # rather than just an empty findings list.
        try:
            artifact_path.write_text(
                json.dumps(
                    {
                        "findings": [],
                        "error": f"{type(exc).__name__}: {exc}",
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        except Exception:  # noqa: BLE001
            pass
        _mark_job_terminal(tracking_id, status="error", exit_code=1)


# ---------------------------------------------------------------------------
# Draft fallbacks (missing-page + contradiction)
# ---------------------------------------------------------------------------
#
# When the user clicks "draft this missing page" or "draft a
# reconciliation" from a lint finding, the puppetmaster path spawns a
# Cursor agent to write the new file. Same Render-can't-find-the-binary
# problem; same direct-LLM workaround.
#
# These are simpler than the lint swarm because they're single-page
# drafts with a fixed schema (frontmatter + body). We reuse
# direct_drafter's prompt-and-parse infrastructure but with a custom
# system prompt scoped to the missing-page / contradiction case.


def _build_draft_missing_page_prompt(
    proposed_title: str,
    proposed_section: str,
    bootstrap_summary: str,
    evidence: list[dict],
    mentioned_in: list[str],
    wiki_dump: str,
) -> str:
    """Build the user prompt for a direct-LLM missing-page draft."""
    evidence_block = (
        "\n".join(
            f"  - `{e.get('page', '?')}`: \"{e.get('quote', '')}\""
            for e in evidence
        )
        or "  (none provided)"
    )
    mentioned_block = "\n".join(f"  - `{p}`" for p in mentioned_in) or "  (none provided)"
    return f"""TASK: draft ONE new wiki page from a lint missing-page finding.

PROPOSED PAGE:
- Title: {proposed_title}
- Section: {proposed_section}

BOOTSTRAP SUMMARY:
> {bootstrap_summary}

EVIDENCE QUOTES (existing pages that reference this entity/concept):
{evidence_block}

ALSO MENTIONED IN:
{mentioned_block}

The wiki's existing content is inlined below the schema. Use the evidence
and mentioned-in pages as the SOLE source of truth — do not invent facts
not present in those pages.

RETURN: a single JSON object, no prose, no markdown fence, matching:

```json
{{
  "pages": [
    {{
      "slug": "kebab-case-slug",
      "title": "{proposed_title}",
      "section": "{proposed_section}",
      "tier": "private",
      "tags": ["lowercase", "tags"],
      "body": "## H2 sections...\\n\\n300-500 words. Cross-reference with [[Wikilinks]] to the evidence pages."
    }}
  ]
}}
```

Hard rules:
- Exactly 1 page in `pages` (this is a single-draft endpoint).
- 300-500 word body.
- Cross-reference EVERY evidence page with a [[Wikilink]].
- No promotional language; concrete and attributed.

======== WIKI BEGIN ========
{wiki_dump}
======== WIKI END ========
"""


def _build_draft_contradiction_prompt(
    page_a: str,
    page_b: str,
    title_a: Optional[str],
    title_b: Optional[str],
    claim_a: str,
    claim_b: str,
    conflict: str,
    suggested_resolution: Optional[str],
    wiki_dump: str,
) -> str:
    """Build the user prompt for a direct-LLM contradiction-reconciliation page."""
    return f"""TASK: draft ONE new query-section wiki page that records a
detected contradiction between two pages and proposes a resolution.

PAGE A: `{page_a}` ({title_a or 'untitled'})
  Claim A: "{claim_a}"

PAGE B: `{page_b}` ({title_b or 'untitled'})
  Claim B: "{claim_b}"

CONFLICT: {conflict}
SUGGESTED RESOLUTION (from lint): {suggested_resolution or '(none)'}

The wiki's existing content is inlined below the schema. Verify both
claims against the actual pages — do NOT modify either source page in
this draft (the JSON output describes a NEW reconciliation page).

RETURN: a single JSON object, no prose, no markdown fence, matching:

```json
{{
  "pages": [
    {{
      "slug": "{date_today_slug()}-reconcile-...",
      "title": "Reconciling {title_a or page_a} vs {title_b or page_b}",
      "section": "queries",
      "tier": "private",
      "tags": ["reconciliation", "lint-resolution"],
      "body": "## The tension\\n\\n... \\n\\n## Page A says\\n\\n... \\n\\n## Page B says\\n\\n...\\n\\n## Resolution\\n\\nPick ONE of: 'Both true at different scopes' / 'One supersedes the other' / 'Genuine open question' / 'Wording confusion'. Explain. \\n\\n## Suggested page edits\\n\\nBullet list of edits to A and/or B."
    }}
  ]
}}
```

Hard rules:
- Exactly 1 page in `pages`.
- 200-400 word body.
- Cross-reference both source pages with [[Wikilinks]].
- The resolution must explicitly pick one of the four categories.

======== WIKI BEGIN ========
{wiki_dump}
======== WIKI END ========
"""


def date_today_slug() -> str:
    """ISO date prefix used in decision/query slug filenames."""
    return datetime.now(timezone.utc).date().isoformat()


_DRAFTER_SYSTEM = (
    "You draft single wiki pages in JSON form. Output exactly one "
    "JSON object matching the schema in the user prompt. No prose, "
    "no markdown fence around the JSON."
)


@dataclass
class DirectDraftResult:
    """Public result type for a direct-LLM draft. Mirrors the parts of
    ``direct_drafter.DraftResult`` we actually need downstream — the
    written page path, backend label, and any warnings."""

    written_to: str = ""
    title: str = ""
    section: str = ""
    backend: str = ""
    warnings: list[str] = None  # type: ignore[assignment]

    def to_dict(self) -> dict:
        return {
            "written_to": self.written_to,
            "title": self.title,
            "section": self.section,
            "backend": self.backend,
            "warnings": list(self.warnings or []),
        }


async def draft_missing_page_direct(
    *,
    proposed_title: str,
    proposed_section: str,
    bootstrap_summary: str,
    evidence: list[dict],
    mentioned_in: list[str],
) -> DirectDraftResult:
    """One-shot LLM call that writes a single missing-page draft to
    disk under the current tenant's wiki root.

    Raises NoLLMConfigured if no key is set. Raises LLMProviderError
    if every model in the chain fails. Returns a DirectDraftResult
    pointing at the written file otherwise.
    """
    # Lazy import to avoid a circular dep (direct_drafter imports llm
    # which imports tenants, etc.).
    from .direct_drafter import (
        _parse_pages,
        _render_page_md,
    )
    from .tenants import current_tenant_var

    tenant = current_tenant_var.get(None)  # type: ignore[arg-type]
    if tenant is None:
        # Single-tenant fallback: tenant abstraction not active, write
        # straight to settings.wiki_root.
        target_root = settings.wiki_root
    else:
        target_root = tenant.wiki_root

    pages = _gather_wiki_pages(target_root)
    wiki_dump, gather_warnings = _render_wiki_dump(pages)
    prompt = _build_draft_missing_page_prompt(
        proposed_title=proposed_title,
        proposed_section=proposed_section,
        bootstrap_summary=bootstrap_summary,
        evidence=evidence,
        mentioned_in=mentioned_in,
        wiki_dump=wiki_dump,
    )
    raw = await _call_llm_chain_for_draft(prompt)
    warnings = list(gather_warnings)
    drafted = _parse_pages(raw, warnings)
    if not drafted:
        raise LLMProviderError(
            "direct_linter.missing_page: LLM returned no usable page"
        )
    page = drafted[0]
    # Force section + tier — the lint UI is unambiguous about both.
    page.section = (
        proposed_section
        if proposed_section in {"entities", "concepts", "decisions", "projects", "queries"}
        else page.section
    )
    page.tier = "private"
    md_text = _render_page_md(page, source_label="")
    target_dir = target_root / "wiki" / page.section
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{page.slug}.md"
    if target_path.exists():
        # Don't overwrite existing files; suffix as -draft so review is
        # side-by-side. Same logic as direct_drafter._write_pages.
        target_path = target_dir / f"{page.slug}-draft.md"
        i = 2
        while target_path.exists():
            target_path = target_dir / f"{page.slug}-draft-{i}.md"
            i += 1
        warnings.append(
            f"{page.slug}.md already existed; wrote draft to {target_path.name}"
        )
    target_path.write_text(md_text, encoding="utf-8")
    if tenant is not None:
        try:
            tenant.reload_index()
        except Exception as exc:  # noqa: BLE001
            warnings.append(
                f"page-index reload failed (will catch up on next restart): {exc}"
            )

    rel_to_root = (
        target_path.relative_to(target_root).as_posix()
        if tenant is None
        else target_path.relative_to(target_root).as_posix()
    )
    return DirectDraftResult(
        written_to=rel_to_root,
        title=page.title,
        section=page.section,
        backend="direct-llm",
        warnings=warnings,
    )


async def draft_contradiction_direct(
    *,
    page_a: str,
    page_b: str,
    title_a: Optional[str],
    title_b: Optional[str],
    claim_a: str,
    claim_b: str,
    conflict: str,
    suggested_resolution: Optional[str],
) -> DirectDraftResult:
    """One-shot LLM call that writes a contradiction-reconciliation
    query page. Same shape as ``draft_missing_page_direct``."""
    from .direct_drafter import _parse_pages, _render_page_md
    from .tenants import current_tenant_var

    tenant = current_tenant_var.get(None)  # type: ignore[arg-type]
    target_root = tenant.wiki_root if tenant is not None else settings.wiki_root

    pages = _gather_wiki_pages(target_root)
    wiki_dump, gather_warnings = _render_wiki_dump(pages)
    prompt = _build_draft_contradiction_prompt(
        page_a=page_a,
        page_b=page_b,
        title_a=title_a,
        title_b=title_b,
        claim_a=claim_a,
        claim_b=claim_b,
        conflict=conflict,
        suggested_resolution=suggested_resolution,
        wiki_dump=wiki_dump,
    )
    raw = await _call_llm_chain_for_draft(prompt)
    warnings = list(gather_warnings)
    drafted = _parse_pages(raw, warnings)
    if not drafted:
        raise LLMProviderError(
            "direct_linter.contradiction: LLM returned no usable page"
        )
    page = drafted[0]
    page.section = "queries"
    page.tier = "private"
    md_text = _render_page_md(page, source_label="")
    target_dir = target_root / "wiki" / "queries"
    target_dir.mkdir(parents=True, exist_ok=True)
    # Reconciliation slugs follow YYYY-MM-DD-reconcile-<...> convention.
    today = date_today_slug()
    base = page.slug
    if not re.match(r"^\d{4}-\d{2}-\d{2}-", base):
        base = f"{today}-{base}"
    target_path = target_dir / f"{base}.md"
    page.slug = base
    if target_path.exists():
        i = 2
        while (target_dir / f"{base}-{i}.md").exists():
            i += 1
        target_path = target_dir / f"{base}-{i}.md"
        warnings.append(
            f"{base}.md already existed; wrote alternate to {target_path.name}"
        )
    target_path.write_text(md_text, encoding="utf-8")
    if tenant is not None:
        try:
            tenant.reload_index()
        except Exception as exc:  # noqa: BLE001
            warnings.append(
                f"page-index reload failed (will catch up on next restart): {exc}"
            )

    return DirectDraftResult(
        written_to=target_path.relative_to(target_root).as_posix(),
        title=page.title,
        section="queries",
        backend="direct-llm",
        warnings=warnings,
    )


async def _call_llm_chain_for_draft(prompt: str) -> str:
    """Provider-fallback chain for direct drafts. Returns the raw
    response text. Raises LLMProviderError if every model fails."""
    last_exc: Optional[Exception] = None

    if settings.anthropic_api_key:
        chain = _build_chain(settings.anthropic_model, ANTHROPIC_FALLBACK_CHAIN)
        for model in chain:
            try:
                return await _call_anthropic_json(
                    model, prompt, system_prompt=_DRAFTER_SYSTEM
                )
            except ModelNotFoundError as exc:
                last_exc = exc
                continue
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                break

    if settings.openai_api_key:
        chain = _build_chain(settings.openai_model, OPENAI_FALLBACK_CHAIN)
        for model in chain:
            try:
                return await _call_openai_json(
                    model, prompt, system_prompt=_DRAFTER_SYSTEM
                )
            except ModelNotFoundError as exc:
                last_exc = exc
                continue
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                break

    if last_exc is not None:
        raise last_exc
    raise LLMProviderError("direct_linter: no LLM provider succeeded")
