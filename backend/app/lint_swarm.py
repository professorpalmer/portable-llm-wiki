"""Semantic lint as a Puppetmaster swarm.

This is the missing third pillar from the Karpathy concept: ingest, query,
**lint**. The existing `/owner/lint` is structural (orphans, stale dates,
broken provenance) — what a regex can do. This module ships *semantic* lint:
parallel Puppetmaster Cursor agents that read the wiki's prose and find:

  - contradictions between pages
  - stale claims that newer sources may have superseded
  - concepts mentioned ≥3 times that deserve their own page

Each worker is its own Puppetmaster `cursor` invocation (so it tracks as a
regular Job in `.jobs.json`), but they all share a `swarm_id` and write
JSON findings to `<WIKI_ROOT>/.lint/<swarm_id>/<worker>.json`. The swarm
record itself lives in `backend/.lint-swarms.json`.

Why subprocess and not direct API calls: the user explicitly framed
Puppetmaster as the "god orchestrator." Keeping lint on the same code path
as ingest means one consistent observability story (live logs, status,
artifacts) and lets each worker have full filesystem access to read every
page if it wants.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings
from . import orchestrator
from .orchestrator import (
    TrackedJob,
    _stream_logs,
    _load_jobs,
    _save_jobs,
    _lock,
    build_worker_cmd,
)


SWARMS_FILE = Path(__file__).resolve().parent.parent / ".lint-swarms.json"


@dataclass
class LintSwarmRecord:
    swarm_id: str
    started_at: str
    artifacts_dir: str
    worker_tracking_ids: list[str] = field(default_factory=list)
    worker_kinds: dict[str, str] = field(default_factory=dict)  # tracking_id -> kind
    status: str = "running"  # running | done | error
    ended_at: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


_swarm_lock = threading.RLock()


def _load_swarms() -> dict[str, LintSwarmRecord]:
    if not SWARMS_FILE.exists():
        return {}
    try:
        data = json.loads(SWARMS_FILE.read_text(encoding="utf-8"))
        return {k: LintSwarmRecord(**v) for k, v in data.items()}
    except Exception:
        return {}


def _save_swarms(swarms: dict[str, LintSwarmRecord]) -> None:
    SWARMS_FILE.write_text(
        json.dumps({k: v.to_dict() for k, v in swarms.items()}, indent=2),
        encoding="utf-8",
    )


def _update_swarm(swarm_id: str, **fields) -> None:
    with _swarm_lock:
        swarms = _load_swarms()
        if swarm_id not in swarms:
            return
        rec = swarms[swarm_id]
        for k, v in fields.items():
            setattr(rec, k, v)
        swarms[swarm_id] = rec
        _save_swarms(swarms)


# ---------------------------------------------------------------------------
# Worker prompts
# ---------------------------------------------------------------------------
#
# Each prompt is intentionally tight: tell the Cursor SDK agent exactly which
# JSON shape to write, and exactly where. Don't ask for prose narration.


def _common_preamble(artifacts_dir_abs: str, worker_name: str, output_file: str) -> str:
    return f"""You are operating inside a personal LLM Wiki at `{settings.wiki_root}`.

You are one of several parallel lint workers. Your worker name is `{worker_name}`.

The wiki is a structured set of markdown files under `wiki/` with these sections:
- `wiki/index.md` and `wiki/log.md` at the root
- `wiki/entities/<slug>.md` — people, companies, products, teams
- `wiki/concepts/<slug>.md` — ideas, principles, frameworks
- `wiki/decisions/YYYY-MM-DD-<topic>.md` — decisions + rationale
- `wiki/sources/YYYY-MM-DD-<slug>.md` — digests of raw sources
- `wiki/projects/<slug>.md` — per-project pages
- `wiki/queries/YYYY-MM-DD-<topic>.md` — saved Q&A
- `wiki/overview.md` — global synthesis

Each page has YAML frontmatter (type, title, created, updated, sources, tags, tier).
Cross-references use `[[Page Title]]` Obsidian-style wikilinks.

Raw source files referenced by `sources:` live under `raw/conversations/`,
`raw/articles/`, `raw/meetings/`, and `raw/assets/`.

YOUR DELIVERABLE:
Write a JSON file at exactly this absolute path:
  {output_file}

The file must be a single JSON object matching the schema described below.
Output ONLY that JSON file. Do not print findings to stdout. Do not modify
any wiki page or raw source.

The `{Path(artifacts_dir_abs).name}/` directory already exists. If your
analysis turns up no findings, write `{{"findings": []}}` so the orchestrator
knows you ran successfully.
"""


CONTRADICTIONS_PROMPT = """
TASK: Find contradictions and unresolved tensions between pages.

Read every page in `wiki/` (do NOT read raw/ for this pass). For each pair of
pages that make contradictory or tension-laden claims about the same entity,
concept, or decision, emit one finding.

Be conservative. Do NOT flag:
- Pages that elaborate on each other (different scope is not contradiction)
- Stylistic differences in how the same fact is described
- Genuine evolution over time where the newer page supersedes the older one
- Aspirational vs current-state distinctions

DO flag:
- Two pages asserting opposite truths about the same entity/concept
- A decision page whose reasoning contradicts the concept it cites
- A source digest whose claims contradict an entity page derived from it

JSON SCHEMA (write to the output file):
{
  "findings": [
    {
      "page_a": "wiki/concepts/<slug>.md",
      "page_b": "wiki/decisions/<file>.md",
      "title_a": "Human title of page A",
      "title_b": "Human title of page B",
      "claim_a": "<= 240 char quote or paraphrase of the claim from page A",
      "claim_b": "<= 240 char quote or paraphrase of the claim from page B",
      "conflict": "one-sentence explanation of why these are in tension",
      "severity": "low" | "medium" | "high",
      "suggested_resolution": "one-sentence proposed fix"
    }
  ]
}

If zero contradictions exist, emit {"findings": []}.

False positives are worse than false negatives — only flag what you'd defend
out loud. Aim for high precision over high recall.
"""


STALE_PROMPT = """
TASK: Find stale claims that newer sources may have superseded.

Read every page in `wiki/`. For pages with `updated:` older than 30 days,
check whether newer source files in `raw/` (created after the page's
`updated` date) discuss the same topic with different framing.

Be conservative. Do NOT flag pages that have stable, evergreen content
(e.g. a concept definition, a historical decision). DO flag pages where
specific factual claims may have changed (status updates, employment
situations, project status, opinions in flux).

JSON SCHEMA:
{
  "findings": [
    {
      "page": "wiki/<section>/<slug>.md",
      "title": "Human title",
      "age_days": 35,
      "stale_claim": "<=240 char quote or paraphrase of the at-risk claim",
      "evidence": ["raw/conversations/2026-05-23-foo.md"],
      "suggested_action": "reingest" | "manually update" | "investigate" | "leave alone",
      "rationale": "one sentence on why this might be stale"
    }
  ]
}

If zero stale claims exist, emit {"findings": []}.
"""


MISSING_PAGES_PROMPT = """
TASK: Find concepts, entities, or decisions that are mentioned in 3+ pages
as plain prose (not as `[[wikilinks]]`) but don't have their own page yet.

Read every page in `wiki/`. Track plain-text references to proper nouns,
named concepts, and named decisions. If something is mentioned in 3+ pages
without its own page existing, that's a missing-page finding.

Be conservative. DO NOT flag:
- Common nouns ("the meeting", "the project")
- Things only mentioned 1-2 times
- Things that already have a page (check by searching wiki/ for a file
  matching the slug)
- Trivial references in passing (e.g. "I used Python") — only things that
  are recurring conceptual anchors

JSON SCHEMA:
{
  "findings": [
    {
      "proposed_title": "Title for the new page",
      "proposed_section": "entities" | "concepts" | "decisions" | "projects",
      "mentioned_in": ["wiki/concepts/<slug>.md", "wiki/decisions/<slug>.md"],
      "evidence": [
        {"page": "wiki/concepts/<slug>.md", "quote": "<=240 char quote showing the reference"}
      ],
      "bootstrap_summary": "2-3 sentence summary of what the page should cover"
    }
  ]
}

If zero missing pages exist, emit {"findings": []}.
"""


PUBLIC_LEAK_PROMPT = """
TASK: Find pages marked `tier: public` whose content references identifiers,
names, dollar amounts, or other specifics that ONLY appear in higher-tier
pages (recruiter, friend, private). These are public-tier leaks — the page
is reachable to anyone with the URL, but its content imports knowledge from
material the owner deliberately gated above public.

Read every page in `wiki/`. For each `tier: public` page, identify every
proper noun, ID-like string (e.g. "INCIDENT-1234"), dollar figure, named entity,
named project, and named decision in the body. Then check whether each such
token appears in any non-public page (`tier: recruiter`, `tier: friend`, or
`tier: private`).

If a public page contains a specific identifier that ALSO appears in a
non-public page (and the non-public page is the *only* place that specific
appears outside the public page itself), that's a leak — the public page is
de facto exposing context that the higher tier was supposed to protect.

Be conservative. DO NOT flag:
- Generic concepts ("calibrated honesty", "wiki", "markdown") — anything
  with a wiki page of its own at any tier
- Tokens that appear in raw/ but no non-public wiki page
- Common nouns and structural words

DO flag:
- A public page that names a specific person, company, or product that only
  has presence in non-public pages
- A public page that quotes a dollar amount or ID that only appears in
  non-public pages
- A public "Status" or "About" section that imports specifics from private
  pages (the most common failure mode — the one this lint exists for)

JSON SCHEMA (write to the output file):
{
  "findings": [
    {
      "public_page": "wiki/projects/<slug>.md",
      "public_page_title": "Human title",
      "leaked_token": "the specific string that's leaking (e.g. 'Acme Corp', '$200K', 'INCIDENT-1234')",
      "appears_in": ["wiki/decisions/<file>.md (tier: friend)"],
      "context_quote": "<=240 char quote from the public page showing the leak",
      "severity": "low" | "medium" | "high",
      "suggested_action": "redact this token from the public page" | "downgrade this public page to <tier>" | "promote the source page to public"
    }
  ]
}

If zero leaks exist, emit {"findings": []}.

Aim for high precision. A false-positive public-leak finding wastes the
owner's attention more than a false-negative — the owner already has a
'preview as anonymous' UI for the catch-all case.
"""


WORKERS: dict[str, str] = {
    "contradictions": CONTRADICTIONS_PROMPT,
    "stale": STALE_PROMPT,
    "missing-pages": MISSING_PAGES_PROMPT,
    "public-leak": PUBLIC_LEAK_PROMPT,
}


def _build_worker_prompt(worker_name: str, artifacts_dir_abs: str) -> tuple[str, str]:
    """Returns (prompt_text, output_file_abs_path)."""
    output_file = str(Path(artifacts_dir_abs) / f"{worker_name}.json")
    preamble = _common_preamble(artifacts_dir_abs, worker_name, output_file)
    body = WORKERS[worker_name]
    return preamble + body, output_file


# ---------------------------------------------------------------------------
# Spawning + tracking
# ---------------------------------------------------------------------------


def _spawn_worker(
    worker_name: str,
    swarm_id: str,
    artifacts_dir_abs: str,
    log_dir: Path,
) -> TrackedJob:
    tracking_id = uuid.uuid4().hex[:12]
    log_path = log_dir / f"{tracking_id}.log"

    prompt, output_file = _build_worker_prompt(worker_name, artifacts_dir_abs)

    cwd = str(settings.wiki_root)
    # Lint workers write a findings JSON to .lint/<swarm>/<worker>.json, so
    # they need a write-enabled worker like every other backend job.
    cmd = build_worker_cmd(prompt, cwd, timeout_seconds=600)

    job = TrackedJob(
        tracking_id=tracking_id,
        kind=f"lint-{worker_name}",
        raw_path=f".lint/{swarm_id}/{worker_name}.json",
        note=f"lint swarm {swarm_id} worker: {worker_name}",
        started_at=datetime.now(timezone.utc).isoformat(),
        cwd=cwd,
        log_path=str(log_path),
        artifacts_path=output_file,
    )

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=cwd,
    )
    job.pid = proc.pid

    with _lock:
        jobs = _load_jobs()
        jobs[tracking_id] = job
        _save_jobs(jobs)

    threading.Thread(
        target=_stream_logs,
        args=(proc, log_path, tracking_id),
        daemon=True,
    ).start()

    return job


def start_lint_swarm(workers: Optional[list[str]] = None) -> LintSwarmRecord:
    """Spawn N Puppetmaster Cursor workers in parallel.

    Each worker writes findings to `<WIKI_ROOT>/.lint/<swarm_id>/<worker>.json`.
    Returns the swarm record immediately; the frontend polls
    `/owner/lint/swarm/{swarm_id}` for progress + aggregated findings.

    Falls back transparently to ``direct_linter.start_lint_swarm_direct``
    (a parallel asyncio.gather of structured-output LLM calls) when the
    puppetmaster CLI isn't on PATH — that's the hosted-Render deploy
    shape. Self-host installs with puppetmaster installed continue to
    get the real Cursor SDK swarm. The artifact format on disk is
    identical between the two backends so ``swarm_status()`` reads
    either transparently.
    """
    selected = workers or list(WORKERS.keys())
    invalid = [w for w in selected if w not in WORKERS]
    if invalid:
        raise ValueError(f"unknown lint workers: {invalid}")

    swarm_id = uuid.uuid4().hex[:12]
    artifacts_dir = settings.wiki_root / ".lint" / swarm_id
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    log_dir = Path(__file__).resolve().parent.parent / ".job-logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    record = LintSwarmRecord(
        swarm_id=swarm_id,
        started_at=datetime.now(timezone.utc).isoformat(),
        artifacts_dir=str(artifacts_dir),
        worker_tracking_ids=[],
        worker_kinds={},
    )

    use_direct_fallback = False
    for worker_name in selected:
        try:
            job = _spawn_worker(worker_name, swarm_id, str(artifacts_dir), log_dir)
            record.worker_tracking_ids.append(job.tracking_id)
            record.worker_kinds[job.tracking_id] = worker_name
        except FileNotFoundError:
            # puppetmaster binary missing — switch the entire swarm
            # over to the direct-LLM path. We don't try to mix: a
            # partial puppetmaster + partial direct-LLM swarm would
            # be a debugging nightmare and the failure case is binary
            # (either PATH has it or it doesn't), so flip the whole
            # swarm in one shot. Any jobs we already created above
            # belong to a swarm_id we're about to reuse for the
            # direct workers — discard them so the record reflects
            # only the direct workers.
            use_direct_fallback = True
            with _lock:
                jobs = _load_jobs()
                for tid in record.worker_tracking_ids:
                    jobs.pop(tid, None)
                _save_jobs(jobs)
            record.worker_tracking_ids = []
            record.worker_kinds = {}
            break

    if use_direct_fallback:
        # Lazy import to avoid a hard dependency on direct_linter for
        # users who never need it (self-host with puppetmaster
        # installed).
        from . import direct_linter

        try:
            jobs, worker_kinds = direct_linter.start_lint_swarm_direct(
                workers=selected,
                swarm_id=swarm_id,
                artifacts_dir=artifacts_dir,
                log_dir=log_dir,
            )
        except direct_linter.NoLLMConfigured as exc:
            # No API key + no puppetmaster = dead end. Surface a
            # specific error so the operator knows which lever to
            # pull (vs the generic "puppetmaster not found" which
            # was a dead end for hosted users).
            record.status = "error"
            record.ended_at = datetime.now(timezone.utc).isoformat()
            with _swarm_lock:
                swarms = _load_swarms()
                swarms[swarm_id] = record
                _save_swarms(swarms)
            raise RuntimeError(
                "Semantic lint needs either Puppetmaster (self-host) or an "
                "LLM API key (hosted). Neither is configured: "
                + str(exc)
            ) from exc
        for job in jobs:
            record.worker_tracking_ids.append(job.tracking_id)
        record.worker_kinds = worker_kinds

    with _swarm_lock:
        swarms = _load_swarms()
        swarms[swarm_id] = record
        _save_swarms(swarms)

    return record


# ---------------------------------------------------------------------------
# Status + aggregation
# ---------------------------------------------------------------------------


def get_swarm(swarm_id: str) -> Optional[LintSwarmRecord]:
    with _swarm_lock:
        return _load_swarms().get(swarm_id)


def list_swarms(limit: int = 25) -> list[LintSwarmRecord]:
    with _swarm_lock:
        recs = list(_load_swarms().values())
    recs.sort(key=lambda r: r.started_at, reverse=True)
    return recs[:limit]


def _read_worker_artifact(artifacts_dir: Path, worker_name: str) -> dict:
    """Return {"status": "pending"|"ok"|"bad-json"|"empty", "findings": [...], "raw": "..."} ."""
    f = artifacts_dir / f"{worker_name}.json"
    if not f.exists():
        return {"status": "pending", "findings": []}
    try:
        text = f.read_text(encoding="utf-8").strip()
    except Exception as exc:
        return {"status": "bad-json", "findings": [], "error": str(exc)}
    if not text:
        return {"status": "empty", "findings": []}
    # Tolerate Cursor SDK wrapping the JSON in a ```json fence.
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return {
            "status": "bad-json",
            "findings": [],
            "error": f"json error: {exc}",
            "raw": text[:400],
        }
    findings = data.get("findings", []) if isinstance(data, dict) else []
    return {"status": "ok", "findings": findings}


def swarm_status(swarm_id: str) -> Optional[dict]:
    """Returns the swarm record + worker statuses + aggregated findings."""
    rec = get_swarm(swarm_id)
    if not rec:
        return None

    with _lock:
        all_jobs = _load_jobs()

    worker_states: list[dict] = []
    artifacts_dir = Path(rec.artifacts_dir)
    any_running = False
    for tid in rec.worker_tracking_ids:
        job = all_jobs.get(tid)
        worker_name = rec.worker_kinds.get(tid, "unknown")
        if job is None:
            worker_states.append(
                {
                    "tracking_id": tid,
                    "worker": worker_name,
                    "status": "missing",
                    "findings": [],
                }
            )
            continue
        if job.status == "running":
            any_running = True
        artifact = _read_worker_artifact(artifacts_dir, worker_name)
        worker_states.append(
            {
                "tracking_id": tid,
                "worker": worker_name,
                "job_status": job.status,
                "exit_code": job.exit_code,
                "started_at": job.started_at,
                "ended_at": job.ended_at,
                "log_path": job.log_path,
                "artifact_status": artifact["status"],
                "artifact_error": artifact.get("error"),
                "findings": artifact.get("findings", []),
            }
        )

    # Auto-close swarm when all workers are terminal.
    if rec.status == "running" and not any_running:
        any_error = any(
            (all_jobs.get(tid).status if all_jobs.get(tid) else "missing") == "error"
            for tid in rec.worker_tracking_ids
        )
        _update_swarm(
            swarm_id,
            status="error" if any_error else "done",
            ended_at=datetime.now(timezone.utc).isoformat(),
        )
        rec = get_swarm(swarm_id) or rec

    total_findings = sum(len(ws["findings"]) for ws in worker_states)

    return {
        "swarm_id": rec.swarm_id,
        "started_at": rec.started_at,
        "ended_at": rec.ended_at,
        "status": rec.status,
        "artifacts_dir": rec.artifacts_dir,
        "workers": worker_states,
        "total_findings": total_findings,
    }
