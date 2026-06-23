"""Puppetmaster orchestration layer.

This module uses Puppetmaster's CLI as a subprocess. It expects the
``puppetmaster`` binary to be on PATH (or at the path configured by
``PUPPETMASTER_BIN``) running a write-enabled worker against the wiki root.

Adapter choice: backend jobs run unattended, so they default to the
**Claude Code** adapter, which authenticates with ``ANTHROPIC_API_KEY``
(already present in the backend env). The Cursor SDK adapter needs a
separate ``CURSOR_API_KEY`` the backend doesn't carry, which silently
degraded ingest runs. Override with ``ORCHESTRATOR_ADAPTER=cursor`` where a
Cursor key is provisioned.

Why subprocess and not the MCP server: MCP is a protocol between LLM clients
and servers, not a programmable API. Subprocess is the contract for calling
Puppetmaster from server-side code.

Job lifecycle:
  1. Client POSTs /owner/ingest → backend writes raw/<file>.md
  2. Backend spawns a write-enabled worker (see ``build_worker_cmd``) in the
     background; returns immediately with a tracking_id.
  3. We track (tracking_id ↔ puppetmaster job_id ↔ pid) in jobs.json.
  4. Frontend polls /owner/jobs/{tracking_id} → we shell out to
     `puppetmaster status / show / artifacts` for the live state.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import threading
import uuid
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings


PUPPETMASTER_BIN = os.environ.get("PUPPETMASTER_BIN", "puppetmaster")
JOBS_FILE = Path(__file__).resolve().parent.parent / ".jobs.json"

# Which Puppetmaster adapter backend workers run on. Claude Code is the
# default because it authenticates with ANTHROPIC_API_KEY, which the backend
# already has; the Cursor adapter needs a CURSOR_API_KEY the backend doesn't
# carry. Optional ORCHESTRATOR_MODEL pins a specific model on the adapter.
ORCHESTRATOR_ADAPTER = os.environ.get("ORCHESTRATOR_ADAPTER", "claude").strip().lower()
ORCHESTRATOR_MODEL = os.environ.get("ORCHESTRATOR_MODEL", "").strip()


def build_worker_cmd(
    prompt: str,
    cwd: str,
    timeout_seconds: int,
    *,
    write: bool = True,
) -> list[str]:
    """Build the Puppetmaster CLI invocation for a backend worker.

    ``write`` selects a file-writing mode. Every backend job writes files —
    ingest/import create wiki pages, the drafter writes a page, the linter
    writes a findings JSON — so it defaults to True. This is the bug that made
    ingests silently produce nothing: the Cursor adapter without ``--implement``
    runs analysis-only and cannot touch the working tree, and Claude needs
    ``--permission-mode acceptEdits`` to write for real.
    """
    cmd = [
        PUPPETMASTER_BIN,
        ORCHESTRATOR_ADAPTER,
        prompt,
        "--cwd",
        cwd,
        "--timeout-seconds",
        str(timeout_seconds),
    ]
    if write:
        # The wiki root is a long-lived git repo that is usually dirty when a
        # job starts (the raw source was just written), so don't refuse on it.
        cmd.append("--allow-dirty")
        if ORCHESTRATOR_ADAPTER == "cursor":
            cmd.append("--implement")
        elif ORCHESTRATOR_ADAPTER == "claude":
            cmd += ["--permission-mode", "acceptEdits"]
    if ORCHESTRATOR_MODEL:
        cmd += ["--model", ORCHESTRATOR_MODEL]
    return cmd


class OrchestratorUnavailable(RuntimeError):
    """Raised when the Puppetmaster binary isn't installed or otherwise
    can't be spawned. Callers in main.py catch this and return a 503 so
    the UI can degrade gracefully (e.g. show "ingest queued — install
    puppetmaster to actually run") instead of 500-ing on a NameError.

    This is the only Orchestrator-specific error type we surface as a
    typed exception. Everything else (timeout, in-flight job failures,
    artifact-parse problems) is reflected in the job's stored state.
    """


@dataclass
class TrackedJob:
    tracking_id: str
    kind: str  # "ingest" | "lint" | "query" (future)
    raw_path: str  # rel_path of the source being ingested
    note: str
    started_at: str
    cwd: str  # the wiki root the job ran in
    log_path: str
    status: str = "running"  # running | done | error
    pid: Optional[int] = None
    puppetmaster_job_id: Optional[str] = None  # set when we discover it
    ended_at: Optional[str] = None
    exit_code: Optional[int] = None
    summary: Optional[str] = None
    artifacts_path: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


_lock = threading.RLock()


def _load_jobs() -> dict[str, TrackedJob]:
    if not JOBS_FILE.exists():
        return {}
    try:
        data = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
        return {k: TrackedJob(**v) for k, v in data.items()}
    except Exception:
        return {}


def _save_jobs(jobs: dict[str, TrackedJob]) -> None:
    JOBS_FILE.write_text(
        json.dumps({k: v.to_dict() for k, v in jobs.items()}, indent=2),
        encoding="utf-8",
    )


def _update(tracking_id: str, **fields) -> None:
    with _lock:
        jobs = _load_jobs()
        if tracking_id not in jobs:
            return
        job = jobs[tracking_id]
        for k, v in fields.items():
            setattr(job, k, v)
        jobs[tracking_id] = job
        _save_jobs(jobs)


def get_job(tracking_id: str) -> Optional[TrackedJob]:
    with _lock:
        return _load_jobs().get(tracking_id)


def list_jobs(limit: int = 50) -> list[TrackedJob]:
    with _lock:
        jobs = list(_load_jobs().values())
    jobs.sort(key=lambda j: j.started_at, reverse=True)
    return jobs[:limit]


def _ingest_prompt(raw_rel_path: str, note: str) -> str:
    """The goal we hand to the Cursor SDK agent. References the wiki rule
    so the agent picks up the Karpathy schema from `.cursor/rules/wiki.mdc`."""
    extra = f"\n\nThe user attached this note about the source:\n> {note}\n" if note else ""
    return f"""You are operating inside a personal LLM Wiki at `{settings.wiki_root}`.
Follow the schema defined in `.cursor/rules/wiki.mdc` exactly.

A new source has just been dropped at:
  {raw_rel_path}

Perform the full INGEST operation as documented in the wiki rule:

1. Read the source in full.
2. Identify new entities, concepts, decisions, and contradictions with existing pages.
3. Write a 200-400 word digest at `wiki/sources/<basename of source>.md` with
   frontmatter `type: source`, `title: <human title>`, `created: <today>`,
   `updated: <today>`, `sources: [<the raw path>]`, and `tier: private` (default).
4. For each new entity referenced in the source, create or update a page at
   `wiki/entities/<slug>.md` with frontmatter `type: entity, tier: private`.
5. For each new concept, create or update `wiki/concepts/<slug>.md` with
   frontmatter `type: concept, tier: private`.
6. For each decision, create or update `wiki/decisions/YYYY-MM-DD-<topic>.md`
   with frontmatter `type: decision, tier: private`.
7. Cross-reference every new page with `[[Wikilinks]]` to related pages.
8. Update `wiki/index.md` to list the new pages alphabetically within their sections.
9. Append a one-line entry to `wiki/log.md` with timestamp and a summary of what
   you did (entities created, concepts updated, decisions filed, contradictions flagged).
10. If the source contradicts existing wiki claims, DO NOT silently resolve.
    Flag the contradiction in the source digest under a `## Contradictions` section
    AND append an entry to `wiki/log.md` flagging it.

Constraints:
- Do not modify the original raw source file ({raw_rel_path}). It is immutable.
- Default `tier:` to `private` on every page you create. The owner promotes
  pages to `public/recruiter/friend` separately via the wiki UI.
- Keep pages short and quotable. Hard cap: 600 words per page.
- Use only information present in the source plus what's already in the wiki.
  Do not invent biographical or factual claims.
{extra}
When finished, print a brief summary of what you wrote so the wiki UI can show
it to the owner for approval.
"""


def _import_prompt(raw_rel_path: str, kind: str, note: str) -> str:
    """Specialized prompt for the cold-start case: the user is bootstrapping
    a brand-new wiki by pasting a profile dump (resume / LinkedIn / bio /
    long-form intro). The agent's job is to scaffold 6-12 starter pages so
    the wiki has something queryable on day one.

    Differs from `_ingest_prompt` in that it's allowed (and expected) to be
    aggressive about page creation, since there's no existing content to
    cross-reference. Conservatism is on factual claims, not on page count.
    """
    extra = f"\n\nThe user attached this note about the source:\n> {note}\n" if note else ""
    kind_hint = {
        "resume": "This is a resume — extract employment history (entities for each company, decisions for major moves, concepts for skills/specialties).",
        "linkedin": "This is a LinkedIn profile export — treat it the same as a resume but be alert for endorsements, recommendations, and group affiliations.",
        "bio": "This is a self-written bio or about-me. Focus on stated values, philosophies, current projects, and what they care about.",
        "freeform": "This is freeform content the user wants to seed their wiki with. Find the structured entities/concepts/decisions inside it.",
    }.get(kind, "Treat the source as freeform profile content.")
    return f"""You are bootstrapping a BRAND-NEW personal LLM Wiki at `{settings.wiki_root}`.
Follow the schema defined in `.cursor/rules/wiki.mdc` exactly.

A profile dump has just been saved at:
  {raw_rel_path}

{kind_hint}

This is the COLD-START flow. The wiki has little or no existing content. Your
job is to scaffold 6-12 starter pages so the owner has something queryable
on day one.

Perform the full IMPORT/INGEST operation:

1. Read the source in full.
2. Identify entities (companies, schools, products, organizations they
   reference), concepts (skills, principles, philosophies they espouse),
   decisions (major career or strategic moves with stated rationale), and
   projects (named products or initiatives they led or contributed to).
3. Write a 200-400 word digest at `wiki/sources/<basename of source>.md`.
4. Create an entity page per distinct company/school/org at
   `wiki/entities/<slug>.md` — keep each one short (3-6 sentences) and grounded
   in the source. If the source names a person, create a page too.
5. Create concept pages at `wiki/concepts/<slug>.md` for the 3-5 most
   distinctive ideas the source surfaces.
6. Create at most 1-2 decision pages at `wiki/decisions/YYYY-MM-DD-<topic>.md`
   when the source explicitly explains a major choice ("I left X because Y").
7. Create project pages at `wiki/projects/<slug>.md` for named projects.
8. Cross-reference every new page with `[[Wikilinks]]` so the graph is dense.
9. Update `wiki/index.md` to list all new pages alphabetically within sections.
10. Append a `## Import` entry to `wiki/log.md` with the timestamp and a
    list of every page you created.

Constraints:
- Do NOT modify the original raw source file ({raw_rel_path}). It is immutable.
- Default `tier: private` on every page. The owner promotes pages separately.
- Hard cap: 600 words per page.
- Only use information present in the source. DO NOT invent biographical,
  factual, or career claims. If the source is sparse, write fewer pages —
  6 well-grounded pages > 12 half-invented ones.
- If something is ambiguous in the source, write the page conservatively and
  add a `> _Note: needs owner confirmation._` block at the bottom.
{extra}
When finished, print a brief summary listing every page you created. The
wiki UI parses this to show the owner a draft list to review.
"""


def start_import_job(raw_rel_path: str, kind: str, note: str = "") -> TrackedJob:
    """Cold-start variant of `start_ingest_job`. Same machinery, different prompt.

    Used by the import wizard at /owner/import for new wikis being seeded from
    a profile dump (resume / LinkedIn / bio / freeform).
    """
    tracking_id = uuid.uuid4().hex[:12]
    log_dir = Path(__file__).resolve().parent.parent / ".job-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{tracking_id}.log"

    cwd = str(settings.wiki_root)
    prompt = _import_prompt(raw_rel_path, kind, note)

    # Imports do more work than incremental ingests, so allow more time.
    cmd = build_worker_cmd(prompt, cwd, timeout_seconds=900)

    job = TrackedJob(
        tracking_id=tracking_id,
        kind="import",
        raw_path=raw_rel_path,
        note=f"[{kind}] {note}".strip(),
        started_at=datetime.now(timezone.utc).isoformat(),
        cwd=cwd,
        log_path=str(log_path),
    )

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=cwd,
        )
    except FileNotFoundError as exc:
        # Puppetmaster binary not on PATH. Surface a typed error so
        # callers can return a clean 503 instead of leaking the FNF.
        raise OrchestratorUnavailable(
            f"puppetmaster binary not found: {PUPPETMASTER_BIN!r}. "
            "Install puppetmaster or set PUPPETMASTER_BIN to a valid "
            "path. (The wiki still works without it — only background "
            "ingest/lint jobs are disabled.)"
        ) from exc
    except OSError as exc:
        raise OrchestratorUnavailable(
            f"could not spawn orchestrator: {exc}"
        ) from exc
    job.pid = proc.pid
    with _lock:
        jobs = _load_jobs()
        jobs[tracking_id] = job
        _save_jobs(jobs)

    # Capture the current tenant id (if any) so the daemon log-streamer
    # can reload the right wiki index when the job finishes. The daemon
    # thread doesn't inherit the HTTP request's ContextVar.
    from . import tenants as _tenants

    _t = _tenants.current_tenant_or_none()
    tenant_id = _t.id if _t is not None else None

    threading.Thread(
        target=_stream_logs,
        args=(proc, log_path, tracking_id, tenant_id),
        daemon=True,
    ).start()

    return job


def _stream_logs(
    proc: subprocess.Popen,
    log_path: Path,
    tracking_id: str,
    tenant_id: Optional[str] = None,
) -> None:
    """Tail the subprocess output into a log file. Update job status on exit.

    On clean exit (returncode==0), automatically reload the in-memory wiki
    index so the new pages/edits a Puppetmaster job wrote become visible
    immediately. Without this, callers had to click 'Reload index' manually.

    ``tenant_id`` is captured at job-start time (the daemon thread doesn't
    inherit the HTTP request's tenant ContextVar, so we pass it explicitly).
    When set, we reload that specific tenant's index instead of the global one.
    """
    try:
        with log_path.open("w", encoding="utf-8") as f:
            f.write(f"# Puppetmaster ingest job {tracking_id}\n")
            f.write(f"# started_at: {datetime.now(timezone.utc).isoformat()}\n")
            f.write(f"# pid: {proc.pid}\n\n")
            assert proc.stdout is not None
            for line in iter(proc.stdout.readline, ""):
                if not line:
                    break
                f.write(line)
                f.flush()
                # Try to capture the puppetmaster job_id from log lines that mention it
                if "job_id=" in line or "Job " in line or '"job_id"' in line:
                    import re

                    m = re.search(r'job[_-]?id["\s:=]+([0-9a-fA-F-]{8,})', line)
                    if m:
                        _update(tracking_id, puppetmaster_job_id=m.group(1))
        proc.wait()
        _update(
            tracking_id,
            status="done" if proc.returncode == 0 else "error",
            ended_at=datetime.now(timezone.utc).isoformat(),
            exit_code=proc.returncode,
        )

        if proc.returncode == 0:
            # Late imports to avoid a hard import cycle at module load time.
            try:
                if tenant_id:
                    from . import tenants as _tenants

                    tenant = _tenants.manager().get(tenant_id)
                    if tenant is not None:
                        tenant.reload_index()
                else:
                    from .wiki import index as _wiki_index

                    _wiki_index.reload()
            except Exception:  # noqa: BLE001
                # Reloading is best-effort; the next /owner/reload click can fix it.
                pass
            # Push any new pages/edits to the git remote (no-op if not configured).
            try:
                from . import persistence as _persistence

                _persistence.flush_async(f"orchestrator job {tracking_id} (success)")
            except Exception:  # noqa: BLE001
                pass
    except Exception as exc:  # noqa: BLE001
        _update(
            tracking_id,
            status="error",
            ended_at=datetime.now(timezone.utc).isoformat(),
            summary=f"orchestrator exception: {exc}",
        )


def start_ingest_job(raw_rel_path: str, note: str = "") -> TrackedJob:
    """Kick off a Cursor SDK worker (via Puppetmaster) that runs the full
    Karpathy ingest sequence against the wiki at WIKI_ROOT.

    Returns immediately with a tracking record. The subprocess streams its
    output to a log file in backend/.job-logs/<tracking_id>.log; the frontend
    polls /owner/jobs/{id} for status.
    """
    tracking_id = uuid.uuid4().hex[:12]
    log_dir = Path(__file__).resolve().parent.parent / ".job-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{tracking_id}.log"

    cwd = str(settings.wiki_root)
    prompt = _ingest_prompt(raw_rel_path, note)

    cmd = build_worker_cmd(prompt, cwd, timeout_seconds=600)

    job = TrackedJob(
        tracking_id=tracking_id,
        kind="ingest",
        raw_path=raw_rel_path,
        note=note,
        started_at=datetime.now(timezone.utc).isoformat(),
        cwd=cwd,
        log_path=str(log_path),
    )

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=cwd,
        )
    except FileNotFoundError as exc:
        # Puppetmaster binary not on PATH. Surface a typed error so
        # callers can return a clean 503 instead of leaking the FNF.
        raise OrchestratorUnavailable(
            f"puppetmaster binary not found: {PUPPETMASTER_BIN!r}. "
            "Install puppetmaster or set PUPPETMASTER_BIN to a valid "
            "path. (The wiki still works without it — only background "
            "ingest/lint jobs are disabled.)"
        ) from exc
    except OSError as exc:
        raise OrchestratorUnavailable(
            f"could not spawn orchestrator: {exc}"
        ) from exc
    job.pid = proc.pid
    with _lock:
        jobs = _load_jobs()
        jobs[tracking_id] = job
        _save_jobs(jobs)

    from . import tenants as _tenants

    _t = _tenants.current_tenant_or_none()
    tenant_id = _t.id if _t is not None else None

    threading.Thread(
        target=_stream_logs,
        args=(proc, log_path, tracking_id, tenant_id),
        daemon=True,
    ).start()

    return job


def read_log_tail(tracking_id: str, max_lines: int = 200) -> str:
    job = get_job(tracking_id)
    if not job:
        return ""
    p = Path(job.log_path)
    if not p.exists():
        return ""
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
    except Exception:
        return ""
    return "\n".join(lines[-max_lines:])


def puppetmaster_status(puppetmaster_job_id: str) -> dict:
    """Shell out to `puppetmaster status` and return its JSON output."""
    try:
        out = subprocess.check_output(
            [PUPPETMASTER_BIN, "status", "--job-id", puppetmaster_job_id],
            stderr=subprocess.STDOUT,
            text=True,
            timeout=15,
        )
    except subprocess.CalledProcessError as exc:
        return {"error": exc.output.strip() if isinstance(exc.output, str) else str(exc)}
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"raw": out}


def puppetmaster_show(puppetmaster_job_id: str) -> dict:
    try:
        out = subprocess.check_output(
            [PUPPETMASTER_BIN, "show", puppetmaster_job_id],
            stderr=subprocess.STDOUT,
            text=True,
            timeout=15,
        )
    except subprocess.CalledProcessError as exc:
        return {"error": exc.output.strip() if isinstance(exc.output, str) else str(exc)}
    except subprocess.TimeoutExpired:
        return {"error": "timeout"}
    return {"summary": out}
