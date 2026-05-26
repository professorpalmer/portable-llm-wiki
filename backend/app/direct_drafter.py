"""Direct-LLM drafter — bootstrap a starter wiki from raw input.

This is the hosted-mode replacement for the Puppetmaster orchestrator
path used in ``hosted_routes.onboarding_import_text`` /
``onboarding_import_url``. The orchestrator was designed for a self-
hosted install with the Cursor ``puppetmaster`` CLI on PATH — that
binary doesn't exist on Render, so the hosted onboarding flow used to
fall through to "Orchestrator was unavailable — raw saved at .." and
produce zero pages, leaving new users with empty wikis.

Approach here: a single structured-output LLM call that turns the raw
material (resume / bio / scraped URL / pasted blob) into 6–12 starter
pages, validated, then written directly to ``tenant.wiki_root/wiki/``.
Cross-page wikilinks land in the same call so the graph is connected
from the first paint.

Auth: uses the same ``ANTHROPIC_API_KEY`` / ``OPENAI_API_KEY`` we
already use for ``/wiki/chat``. No additional secrets. If neither key
is set we raise :class:`NoLLMConfigured` so the caller can surface a
clean "you need to add an API key" error instead of a silent hang.

This is intentionally NOT agentic: one prompt, one response, parsed
deterministically. Trade-off: less sophisticated than Puppetmaster's
multi-step exploration, but reliable enough for the cold-start case
where the goal is "get *some* useful pages on screen in 60 seconds."
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx

from .config import settings
from .llm import (
    ANTHROPIC_FALLBACK_CHAIN,
    OPENAI_FALLBACK_CHAIN,
    LLMProviderError,
    ModelNotFoundError,
    _anthropic_error_kind,
    _build_chain,
    _truncate,
)
from .tenants import Tenant

logger = logging.getLogger(__name__)

VALID_SECTIONS = {"entities", "concepts", "decisions", "projects", "queries"}
SECTION_TO_TYPE = {
    "entities": "entity",
    "concepts": "concept",
    "decisions": "decision",
    "projects": "project",
    "queries": "query",
}

# How many pages to ask the LLM for. The frontmatter + body adds up
# fast; 6–12 keeps us well under the 4k-token output cap for both
# providers without forcing absurdly terse pages.
TARGET_PAGE_COUNT = (6, 12)

# Hard size limits we enforce after parsing.
MAX_BODY_CHARS = 8000  # ~1500 words
MAX_SLUG_LEN = 100
MAX_TITLE_LEN = 200
MAX_TAGS = 10


class NoLLMConfigured(RuntimeError):
    """Raised when neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set.

    Distinct from :class:`LLMProviderError` because the fix is a deploy
    config change (add a key), not a code bug or a transient provider
    issue. Onboarding handlers translate this to a 503 with a hint.
    """


@dataclass
class DraftedPage:
    slug: str
    title: str
    section: str
    page_type: str
    tier: str
    tags: list[str]
    body: str
    written_to: str = ""  # rel path under tenant.wiki_root, filled after write


@dataclass
class DraftResult:
    pages: list[DraftedPage] = field(default_factory=list)
    backend: str = ""  # "anthropic" | "openai"
    model: str = ""
    raw_llm_output: str = ""  # debugging aid; not shown to users
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "page_count": len(self.pages),
            "pages": [
                {
                    "slug": p.slug,
                    "title": p.title,
                    "section": p.section,
                    "written_to": p.written_to,
                }
                for p in self.pages
            ],
            "backend": self.backend,
            "model": self.model,
            "warnings": list(self.warnings),
        }


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


_SYSTEM_PROMPT = """You are a draftsperson for a personal LLM wiki.

You read raw source material about ONE person — their bio, resume,
portfolio site, About page, freeform notes — and produce a starter
set of wiki pages about THAT specific person.

Hard rules:
- Output is a single JSON object. No prose before or after.
- Every page is grounded in the source material. Do NOT invent facts,
  jobs, projects, dates, or relationships that aren't in the source.
  If the source is sparse, write fewer pages, not made-up ones.
- Cross-reference pages with [[Page Title]] wikilinks. The graph must
  connect — a page about a project should wikilink to the company,
  the relevant skills, and the person.
- The pages are about the SUBJECT of the source. Pages titled with
  the subject's name go in ``entities``. Skills/methodologies go in
  ``concepts``. Specific things they've built go in ``projects``.
  Pivotal choices they made go in ``decisions``.
- No promotional language ("passionate", "results-driven", "expert").
  Concrete, specific, attributed."""


_USER_PROMPT_TEMPLATE = """SOURCE MATERIAL ({source_label}):

```
{source_content}
```

TASK: Draft 6–12 starter wiki pages about the subject of the source
material. Pages live in 5 sections: entities, concepts, decisions,
projects, queries.

Return JSON in EXACTLY this shape:

```json
{{
  "pages": [
    {{
      "slug": "kebab-case-slug",
      "title": "Title Case",
      "section": "entities|concepts|decisions|projects|queries",
      "tier": "private",
      "tags": ["tag1", "tag2"],
      "body": "## H2 section\\n\\nMarkdown body. Cross-reference with [[Other Page Title]] wikilinks. 150–400 words per page."
    }}
  ]
}}
```

Requirements:
- 6–12 pages total. Skew toward 8.
- At least one ENTITY page about the subject themselves
  (slug = lowercased-name, e.g. ``jane-smith``).
- Each page body is 150–400 words.
- Use [[wikilinks]] to cross-reference between pages you're drafting.
- ``tier`` is "private" for all starter pages (user reviews + opens up later).
- Tags are lowercase, hyphen-separated, 2–5 per page.

No commentary. JSON only."""


def _build_prompt(source_label: str, source_content: str) -> str:
    # Trim absurdly long inputs — the LLM context window is finite and
    # the long tail of source material rarely improves the draft.
    capped = source_content[:30_000]
    return _USER_PROMPT_TEMPLATE.format(
        source_label=source_label or "user-supplied",
        source_content=capped,
    )


# ---------------------------------------------------------------------------
# Provider calls (structured-output variants)
# ---------------------------------------------------------------------------


async def _call_anthropic_json(
    model: str,
    user_prompt: str,
    *,
    system_prompt: str = "",
) -> str:
    """Anthropic messages API, instructed to emit JSON only. Returns
    the raw text body of the assistant turn.

    ``system_prompt`` defaults to the onboarding-tuned ``_SYSTEM_PROMPT``
    so existing callers don't break, but capture-context callers pass
    their own (a starter-wiki framing is wrong when we're appending one
    source to an existing wiki).
    """
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": settings.anthropic_api_key or "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        # Drafting needs more tokens than chat — 8 pages * ~400 tokens
        # each = ~3200, plus frontmatter / JSON overhead.
        "max_tokens": 4096,
        "system": system_prompt or _SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            body = None
        kind, msg = _anthropic_error_kind(resp.status_code, body)
        truncated = _truncate(msg)
        if kind == "model_not_found":
            raise ModelNotFoundError(f"anthropic[{model}]: {truncated}")
        raise LLMProviderError(
            f"anthropic[{model}] http {resp.status_code}: {truncated}"
        )
    data = resp.json()
    blocks = data.get("content") or []
    parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    return ("\n".join(p for p in parts if p)).strip()


async def _call_openai_json(
    model: str,
    user_prompt: str,
    *,
    system_prompt: str = "",
) -> str:
    """OpenAI chat completions with JSON-mode requested. Returns raw
    text body of the assistant message.

    ``system_prompt`` defaults to the onboarding-tuned ``_SYSTEM_PROMPT``;
    capture-context callers override with their own framing."""
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": 4096,
        # JSON mode coerces the response to valid JSON; saves us from
        # fragile prose-then-JSON-block parsing.
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt or _SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        msg = _truncate(resp.text)
        # Crude model-not-found detection on OpenAI — they 404 with
        # "model_not_found" code in the error body.
        if resp.status_code == 404 and "model" in resp.text.lower():
            raise ModelNotFoundError(f"openai[{model}]: {msg}")
        raise LLMProviderError(f"openai[{model}] http {resp.status_code}: {msg}")
    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        return ""
    return choices[0].get("message", {}).get("content", "").strip()


# ---------------------------------------------------------------------------
# JSON parsing + validation
# ---------------------------------------------------------------------------


def _slugify(s: str) -> str:
    out = s.lower().strip()
    out = re.sub(r"[^a-z0-9\s-]", "", out)
    out = re.sub(r"\s+", "-", out)
    out = re.sub(r"-+", "-", out)
    return out.strip("-") or "untitled"


def _extract_json(text: str) -> Any:
    """Pull a JSON object out of LLM output that might or might not be
    fenced in a ```json``` block. We try the cheap path first
    (json.loads on the whole string) and fall back to extracting the
    first {...} balanced substring."""
    text = text.strip()
    # Direct parse — OpenAI JSON mode always gets here.
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        pass
    # Strip ``` fences if present.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except Exception:  # noqa: BLE001
            pass
    # Last resort: greedy match on outermost braces.
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        return json.loads(brace.group(0))
    raise json.JSONDecodeError("no JSON object found in LLM output", text, 0)


def _validate_page_dict(raw: dict, warnings: list[str]) -> Optional[DraftedPage]:
    """Coerce an LLM page dict into a DraftedPage. Skips (returns None)
    on missing required fields, accumulating a warning so the caller
    can surface it. Never raises."""
    title = str(raw.get("title") or "").strip()
    body = str(raw.get("body") or "").strip()
    if not title:
        warnings.append("skipped a page with no title")
        return None
    if not body:
        warnings.append(f"skipped {title!r}: empty body")
        return None
    if len(body) > MAX_BODY_CHARS:
        body = body[:MAX_BODY_CHARS] + "\n\n_(truncated)_"
        warnings.append(f"truncated {title!r} body to {MAX_BODY_CHARS} chars")

    section = str(raw.get("section") or "").strip().lower()
    if section not in VALID_SECTIONS:
        warnings.append(f"unknown section for {title!r}; defaulting to concepts")
        section = "concepts"

    page_type = SECTION_TO_TYPE[section]

    slug = str(raw.get("slug") or "").strip().lower()
    if not slug:
        slug = _slugify(title)
    slug = _slugify(slug)
    if section == "decisions" and not re.match(r"^\d{4}-\d{2}-\d{2}-", slug):
        # Decision pages follow YYYY-MM-DD-<slug>.md per the Karpathy
        # schema. Backfill today's date if the LLM forgot.
        slug = f"{date.today().isoformat()}-{slug}"
    slug = slug[:MAX_SLUG_LEN]

    tier = str(raw.get("tier") or "private").strip().lower()
    if tier not in {"public", "recruiter", "friend", "private"}:
        tier = "private"

    tags_raw = raw.get("tags") or []
    tags: list[str] = []
    if isinstance(tags_raw, list):
        for t in tags_raw[:MAX_TAGS]:
            if isinstance(t, str) and t.strip():
                tags.append(_slugify(t)[:40])

    title = title[:MAX_TITLE_LEN]

    return DraftedPage(
        slug=slug,
        title=title,
        section=section,
        page_type=page_type,
        tier=tier,
        tags=tags,
        body=body,
    )


def _parse_pages(raw_llm_output: str, warnings: list[str]) -> list[DraftedPage]:
    try:
        data = _extract_json(raw_llm_output)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"could not parse JSON from LLM: {exc}")
        return []
    if not isinstance(data, dict):
        warnings.append(f"LLM returned non-object JSON: {type(data).__name__}")
        return []
    pages_raw = data.get("pages")
    if not isinstance(pages_raw, list):
        warnings.append("LLM response missing 'pages' array")
        return []

    out: list[DraftedPage] = []
    seen_slugs: set[str] = set()
    for entry in pages_raw:
        if not isinstance(entry, dict):
            warnings.append(f"skipped non-object page entry: {type(entry).__name__}")
            continue
        page = _validate_page_dict(entry, warnings)
        if page is None:
            continue
        # De-dupe slugs within this draft (suffix collisions).
        base = page.slug
        i = 2
        while page.slug in seen_slugs:
            page.slug = f"{base}-{i}"
            i += 1
        seen_slugs.add(page.slug)
        out.append(page)
    return out


# ---------------------------------------------------------------------------
# Filesystem writes
# ---------------------------------------------------------------------------


def _render_page_md(page: DraftedPage, source_label: str) -> str:
    """Render the page as markdown with frontmatter following the
    wiki's existing schema (see wiki-demo for examples)."""
    today = date.today().isoformat()
    tags_yaml = "[" + ", ".join(page.tags) + "]" if page.tags else "[]"
    sources_yaml = f'["{source_label}"]' if source_label else "[]"
    fm = (
        f"---\n"
        f"type: {page.page_type}\n"
        f"title: {page.title}\n"
        f"created: {today}\n"
        f"updated: {today}\n"
        f"tier: {page.tier}\n"
        f"sources: {sources_yaml}\n"
        f"tags: {tags_yaml}\n"
        f"draft: true\n"
        f"---\n\n"
    )
    return fm + page.body.strip() + "\n"


def _write_pages(
    pages: list[DraftedPage],
    tenant: Tenant,
    source_label: str,
    warnings: list[str],
) -> None:
    """Write each page to ``<tenant.wiki_root>/wiki/<section>/<slug>.md``.

    Skips (with a warning) any page whose target path already exists,
    so the user's existing content is never overwritten. Mutates each
    page's ``written_to`` field with the rel path actually written.
    """
    wiki_root = tenant.wiki_root / "wiki"
    for page in pages:
        target_dir = wiki_root / page.section
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{page.slug}.md"
        if target.exists():
            # Conflict: don't overwrite. Suffix with -draft so the user
            # can review both versions side-by-side.
            target = target_dir / f"{page.slug}-draft.md"
            i = 2
            while target.exists():
                target = target_dir / f"{page.slug}-draft-{i}.md"
                i += 1
            warnings.append(
                f"{page.slug}.md already existed; wrote draft to {target.name}"
            )
        target.write_text(_render_page_md(page, source_label), encoding="utf-8")
        page.written_to = str(target.relative_to(tenant.wiki_root)).replace("\\", "/")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def _draft_with_prompt(
    *,
    prompt: str,
    source_label: str,
    tenant: Tenant,
    system_prompt: str = "",
    force_tier: Optional[str] = None,
) -> DraftResult:
    """Shared core: send ``prompt`` to the configured LLM provider(s),
    parse the JSON response into pages, write them to disk under the
    tenant's wiki root, and reload the tenant index.

    Used by both :func:`draft_starter_pages` (onboarding: 6–12 broad
    biographical pages) and :func:`draft_capture_pages` (single capture:
    1–5 focused pages). The only difference between the two is the
    prompt — everything else (provider fallback, validation, writing,
    index reload) is identical.

    Raises :class:`NoLLMConfigured` when no keys are configured. Bubbles
    the underlying provider error if every model in the configured
    chain fails. Never silently returns an empty result.
    """
    if not settings.anthropic_api_key and not settings.openai_api_key:
        raise NoLLMConfigured(
            "No LLM API key configured on the server. Set ANTHROPIC_API_KEY "
            "or OPENAI_API_KEY in the backend env so the wiki can draft "
            "pages from your captures and imports."
        )

    result = DraftResult()
    warnings: list[str] = []
    last_exc: Optional[Exception] = None

    if settings.anthropic_api_key:
        chain = _build_chain(settings.anthropic_model, ANTHROPIC_FALLBACK_CHAIN)
        for model in chain:
            try:
                raw = await _call_anthropic_json(
                    model, prompt, system_prompt=system_prompt
                )
                result.backend = "anthropic"
                result.model = model
                result.raw_llm_output = raw
                last_exc = None
                break
            except ModelNotFoundError as exc:
                last_exc = exc
                logger.warning("direct_drafter.anthropic_model_404 model=%s", model)
                continue
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                break  # non-404 error — don't cycle, fall through to OpenAI

    if not result.backend and settings.openai_api_key:
        chain = _build_chain(settings.openai_model, OPENAI_FALLBACK_CHAIN)
        for model in chain:
            try:
                raw = await _call_openai_json(
                    model, prompt, system_prompt=system_prompt
                )
                result.backend = "openai"
                result.model = model
                result.raw_llm_output = raw
                last_exc = None
                break
            except ModelNotFoundError as exc:
                last_exc = exc
                logger.warning("direct_drafter.openai_model_404 model=%s", model)
                continue
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                break

    if not result.backend:
        if last_exc is not None:
            raise last_exc
        raise LLMProviderError("no LLM provider succeeded")

    result.pages = _parse_pages(result.raw_llm_output, warnings)
    if not result.pages:
        warnings.append(
            "LLM returned no usable pages — the raw input was saved but "
            "no draft pages were created. Try again with more detail."
        )

    # Capture-context callers pass ``force_tier="private"`` so any
    # tier the LLM ships gets clamped before write. Same protection
    # the writeback endpoint provides — nothing the LLM produces
    # lands on a public surface without the user explicitly promoting.
    if force_tier and result.pages:
        for p in result.pages:
            if p.tier != force_tier:
                p.tier = force_tier

    if result.pages:
        _write_pages(result.pages, tenant, source_label, warnings)
        try:
            tenant.reload_index()
        except Exception as exc:  # noqa: BLE001
            warnings.append(
                f"page-index reload failed (will catch up on next restart): {exc}"
            )

    result.warnings = warnings
    return result


async def draft_starter_pages(
    *,
    source_label: str,
    source_content: str,
    tenant: Tenant,
) -> DraftResult:
    """Generate + write 6–12 starter wiki pages from biographical source
    material (resume, bio, scraped portfolio, About page).

    Used during onboarding when a user lands with no wiki yet. The
    prompt targets a broad cross-section of pages so the graph is
    connected from the first paint."""
    if not source_content.strip():
        raise ValueError("source_content is empty")
    prompt = _build_prompt(source_label, source_content)
    return await _draft_with_prompt(
        prompt=prompt,
        source_label=source_label,
        tenant=tenant,
    )


# ---------------------------------------------------------------------------
# Capture-context drafting
# ---------------------------------------------------------------------------
#
# The capture flow is fundamentally different from onboarding:
#
#   onboarding  : "here's the user's entire bio — draft a starter wiki"
#   capture     : "here's ONE specific thing — extract pages from it"
#
# Forcing 6–12 pages from a single Slack thread or screenshot is wrong:
# the LLM either pads with low-signal content or invents detail to hit
# the count. So the capture prompt explicitly targets 1–5 pages and tells
# the model to skew low ("fewer, sharper pages over more, vaguer ones").
# Everything else — schema, wikilinks, no-promotional-language guardrails
# — is the same as ``draft_starter_pages``.

_CAPTURE_SYSTEM_PROMPT = """You are a draftsperson for a personal LLM wiki.

You read ONE piece of captured material — a Slack thread, an article,
a screenshot's OCR, a meeting transcript, a pasted note — and produce
1 to 5 wiki pages capturing the specific entities, concepts, decisions,
or projects that source talks about. You are NOT drafting a starter
wiki; you are extending an existing wiki from one new source.

Hard rules:
- Output is a single JSON object. No prose before or after.
- Skew LOW. 1-2 pages is a great answer when the source is narrow.
  5 pages should only happen when the source genuinely covers 5
  distinct things. Padding the count with vague pages is worse than
  producing fewer, sharper ones.
- Every page is grounded in the captured material. Do NOT invent
  facts, dates, or relationships that aren't in the source.
- Cross-reference with [[Page Title]] wikilinks where appropriate —
  both to pages you're creating in this batch and to pages that may
  already exist in the wiki (e.g. if the source mentions a project
  name that's probably already a page).
- No promotional language ("revolutionary", "passionate", "expert").
  Concrete, specific, attributed."""

_CAPTURE_USER_PROMPT_TEMPLATE = """CAPTURED MATERIAL ({source_label}):

```
{source_content}
```

TASK: Draft 1 to 5 wiki pages extracted from the material above.
Pages live in 5 sections: entities, concepts, decisions, projects,
queries.

Return JSON in EXACTLY this shape:

```json
{{
  "pages": [
    {{
      "slug": "kebab-case-slug",
      "title": "Title Case",
      "section": "entities|concepts|decisions|projects|queries",
      "tier": "private",
      "tags": ["tag1", "tag2"],
      "body": "## H2 section\\n\\nMarkdown body. Cross-reference with [[Other Page Title]] wikilinks where appropriate. 150-400 words per page."
    }}
  ]
}}
```

Requirements:
- 1 to 5 pages. Skew low. One sharp page beats three vague ones.
- Each page body is 150-400 words.
- ``tier`` is "private" for everything (user reviews + promotes manually).
- Tags are lowercase, hyphen-separated, 2-5 per page.
- Section choice:
  * entities  - people, companies, products, teams the source names
  * concepts  - ideas, methodologies, frameworks the source explains
  * decisions - choices someone made that the source records
  * projects  - things being built / shipped that the source describes
  * queries   - open questions the source raises

No commentary. JSON only."""


async def draft_capture_pages(
    *,
    source_label: str,
    source_content: str,
    tenant: Tenant,
) -> DraftResult:
    """Generate + write 1-5 focused pages from a single captured source.

    Use this when ingesting a paste, scraped URL, screenshot, or voice
    transcript into an existing wiki. The prompt targets fewer, sharper
    pages than :func:`draft_starter_pages` so a small capture doesn't
    bloat the wiki with low-signal padding.
    """
    if not source_content.strip():
        raise ValueError("source_content is empty")
    capped = source_content[:30_000]
    prompt = _CAPTURE_USER_PROMPT_TEMPLATE.format(
        source_label=source_label or "captured",
        source_content=capped,
    )
    return await _draft_with_prompt(
        prompt=prompt,
        source_label=source_label,
        tenant=tenant,
        system_prompt=_CAPTURE_SYSTEM_PROMPT,
        # Always clamp to private — capture-context pages start as
        # drafts the user reviews + promotes manually. Same invariant
        # as the /llm-writeback-spec endpoint.
        force_tier="private",
    )
