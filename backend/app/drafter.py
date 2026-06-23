"""Close the lint → ingest loop.

The semantic lint swarm (`lint_swarm.py`) finds gaps: missing pages,
contradictions, stale claims. The drafter takes a finding + acts on it by
spawning a fresh Puppetmaster Cursor agent that drafts the actual wiki page.

This is what makes "self-maintaining" literal — lint identifies a hole,
drafter writes a candidate page filling it, owner reviews, next lint pass
checks the new state. The loop closes.

Implementation: same Puppetmaster subprocess pattern as ingest. The drafter
just builds a different prompt and registers a different `kind` on the
TrackedJob so the UI can label it.
"""
from __future__ import annotations

import re
import subprocess
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings
from .orchestrator import (
    TrackedJob,
    _stream_logs,
    _load_jobs,
    _save_jobs,
    _lock,
    build_worker_cmd,
)


# ---------------------------------------------------------------------------
# Slugify (the same rules wiki pages already follow)
# ---------------------------------------------------------------------------


def _slugify(title: str) -> str:
    s = title.lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------


def _build_missing_page_prompt(
    proposed_title: str,
    proposed_section: str,
    bootstrap_summary: str,
    evidence: list[dict],
    mentioned_in: list[str],
) -> tuple[str, str]:
    """Returns (prompt, target_rel_path)."""
    section = proposed_section.lower().strip()
    if section not in {"entities", "concepts", "decisions", "projects", "queries"}:
        section = "concepts"
    slug = _slugify(proposed_title)
    if section == "decisions":
        # Decision filenames are YYYY-MM-DD-<slug>.md per Karpathy schema.
        slug = f"{date.today().isoformat()}-{slug}"
    target_rel = f"wiki/{section}/{slug}.md"

    # Map section → frontmatter type.
    type_map = {
        "entities": "entity",
        "concepts": "concept",
        "decisions": "decision",
        "projects": "project",
        "queries": "query",
    }
    page_type = type_map[section]

    evidence_block = "\n".join(
        f'  - `{e.get("page", "?")}`: "{e.get("quote", "")}"' for e in evidence
    )
    mentioned_block = "\n".join(f"  - `{p}`" for p in mentioned_in)

    prompt = f"""You are operating inside a personal LLM Wiki at `{settings.wiki_root}`.
Follow the schema in `.cursor/rules/wiki.mdc` exactly.

The semantic lint pass identified a MISSING PAGE. Your job is to draft it.

PROPOSED PAGE:
- Title: {proposed_title}
- Section: {section}
- Target path: {target_rel}
- Type: {page_type}

BOOTSTRAP SUMMARY (lint worker's proposed scope):
> {bootstrap_summary}

EVIDENCE QUOTES (these existing pages already reference this entity/concept):
{evidence_block}

ALSO MENTIONED IN:
{mentioned_block}

INSTRUCTIONS:

1. Read each of the evidence pages and the mentioned-in pages in full
   (those are the only sources of truth for this draft). Do NOT read
   anything in raw/ for this task — only use what's already in wiki/.

2. Create exactly one new file at `{target_rel}` with frontmatter:

```yaml
---
type: {page_type}
title: {proposed_title}
created: {date.today().isoformat()}
updated: {date.today().isoformat()}
tier: private
sources: []
tags: []
---
```

   Pick `tags` based on what's in the evidence (lowercase, hyphen-separated, 3-6 tags).
   Leave `sources:` empty — this is derived from existing wiki pages,
   not from a raw source.

3. Body (300-500 words):
   - Open with a 1-2 sentence definition / framing of what this is.
   - Synthesize what the evidence pages say about it. Use direct quotes
     where helpful, attributed via `[[wikilink]]` to the source page.
   - Cross-reference back to EVERY evidence page with `[[Page Title]]`
     wikilinks. The graph must connect.
   - Do NOT invent facts. If the evidence is sparse, write a shorter page.
   - Hard cap: 600 words.

4. Update `wiki/index.md` to list the new page alphabetically in its
   `{section}` section. Preserve the existing format and ordering.

5. Append a one-line entry to `wiki/log.md` with today's date noting:
   "drafted from lint missing-page finding: {proposed_title}"

6. Do NOT modify any other page. The evidence pages are read-only for
   this task.

When finished, print a brief summary of what you wrote (just the new file
path and the wikilinks you added).
"""
    return prompt, target_rel


def _build_contradiction_prompt(
    page_a: str,
    page_b: str,
    title_a: Optional[str],
    title_b: Optional[str],
    claim_a: str,
    claim_b: str,
    conflict: str,
    suggested_resolution: Optional[str],
) -> tuple[str, str]:
    """Returns (prompt, target_rel_path).

    Drafts a `wiki/queries/<date>-reconcile-<slug>.md` page that records the
    tension and proposes a resolution. Does NOT modify the source pages.
    """
    slug_a = Path(page_a).stem
    slug_b = Path(page_b).stem
    slug = _slugify(f"reconcile {slug_a} vs {slug_b}")
    target_rel = f"wiki/queries/{date.today().isoformat()}-{slug}.md"

    prompt = f"""You are operating inside a personal LLM Wiki at `{settings.wiki_root}`.

The semantic lint pass flagged an UNRESOLVED TENSION between two pages.
Your job is to draft a query page that records the tension and proposes
a resolution.

PAGE A: `{page_a}` ({title_a or "untitled"})
  Claim A: "{claim_a}"

PAGE B: `{page_b}` ({title_b or "untitled"})
  Claim B: "{claim_b}"

CONFLICT (lint worker's summary): {conflict}
LINT'S SUGGESTED RESOLUTION: {suggested_resolution or "(none)"}

INSTRUCTIONS:

1. Read both source pages (`{page_a}` and `{page_b}`) in full. Verify the
   claims as quoted above. Do NOT modify either page.

2. Create one new file at `{target_rel}` with frontmatter:

```yaml
---
type: query
title: Reconciling {title_a or slug_a} vs {title_b or slug_b}
created: {date.today().isoformat()}
updated: {date.today().isoformat()}
tier: private
sources: []
tags: [reconciliation, lint-resolution]
---
```

3. Body (200-400 words), in this structure:

   ## The tension
   One paragraph stating the conflict in your own words, citing both
   pages with `[[wikilinks]]`.

   ## Page A says
   Quote/paraphrase the specific claim from page A.

   ## Page B says
   Quote/paraphrase the specific claim from page B.

   ## Resolution
   Concrete proposal for how to resolve the tension. Pick one of:
   - "Both true at different scopes" (explain the scopes)
   - "One supersedes the other" (which, and why)
   - "Genuine open question" (what evidence would resolve it)
   - "Wording confusion" (the underlying claim is the same — propose a
      consistent phrasing)

   ## Suggested page edits
   Bullet list of concrete edits to page A and/or page B that would
   eliminate the tension. Do not perform the edits — only describe them.

4. Update `wiki/index.md` to list the new page in its `queries` section.

5. Append a one-line entry to `wiki/log.md` noting the reconciliation.

6. Do NOT modify {page_a} or {page_b}. The owner reviews the resolution
   before any edits happen.

When finished, print a one-line summary.
"""
    return prompt, target_rel


# ---------------------------------------------------------------------------
# Spawning
# ---------------------------------------------------------------------------


def _spawn_drafter_job(
    *,
    kind: str,
    prompt: str,
    target_rel: str,
    note: str,
) -> TrackedJob:
    tracking_id = uuid.uuid4().hex[:12]
    log_dir = Path(__file__).resolve().parent.parent / ".job-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{tracking_id}.log"

    cwd = str(settings.wiki_root)
    cmd = build_worker_cmd(prompt, cwd, timeout_seconds=600)

    job = TrackedJob(
        tracking_id=tracking_id,
        kind=kind,
        raw_path=target_rel,
        note=note,
        started_at=datetime.now(timezone.utc).isoformat(),
        cwd=cwd,
        log_path=str(log_path),
        artifacts_path=target_rel,
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


def start_draft_missing_page(
    proposed_title: str,
    proposed_section: str,
    bootstrap_summary: str,
    evidence: list[dict],
    mentioned_in: list[str],
) -> TrackedJob:
    prompt, target_rel = _build_missing_page_prompt(
        proposed_title=proposed_title,
        proposed_section=proposed_section,
        bootstrap_summary=bootstrap_summary,
        evidence=evidence,
        mentioned_in=mentioned_in,
    )
    return _spawn_drafter_job(
        kind="draft-missing-page",
        prompt=prompt,
        target_rel=target_rel,
        note=f"draft missing page: {proposed_title}",
    )


def start_draft_contradiction(
    page_a: str,
    page_b: str,
    title_a: Optional[str],
    title_b: Optional[str],
    claim_a: str,
    claim_b: str,
    conflict: str,
    suggested_resolution: Optional[str],
) -> TrackedJob:
    prompt, target_rel = _build_contradiction_prompt(
        page_a=page_a,
        page_b=page_b,
        title_a=title_a,
        title_b=title_b,
        claim_a=claim_a,
        claim_b=claim_b,
        conflict=conflict,
        suggested_resolution=suggested_resolution,
    )
    return _spawn_drafter_job(
        kind="draft-reconciliation",
        prompt=prompt,
        target_rel=target_rel,
        note=f"reconcile: {title_a or page_a} vs {title_b or page_b}",
    )
