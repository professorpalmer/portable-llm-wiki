"""Verbatim capture — write user-authored markdown to wiki/<section>/<slug>.md
without ever running an LLM over it.

The rest of the capture surface (`paste`, `url`, `image`, `voice`,
`from-llm`) all funnel through either the orchestrator or the direct
drafter, both of which:

* fragment a single source into 1-5 LLM-decided pages,
* force ``tier: private`` regardless of what was in the input, and
* write their own frontmatter (the input frontmatter, if any, is
  discarded — only the body text is read).

That's the right default for unstructured inputs (Slack threads, voice
memos, scraped articles). It's the wrong shape for "I already drafted
a page in chat / in my editor and just want the wiki to save what I
wrote." For that case the user has already made every editorial
decision the drafter would have made — section, slug, tier, tags,
title, sources — and a second LLM pass is pure noise + cost + tier
override risk.

The verbatim endpoint closes that gap. The contract:

* Input is a complete markdown file with YAML frontmatter.
* Required frontmatter: ``type`` (one of the six canonical Karpathy
  types) and ``title``. Everything else is optional.
* ``tier`` is RESPECTED — verbatim is the one capture path where the
  user's frontmatter wins, because the user authored the bytes. The
  drafter/writeback paths exist for untrusted/LLM-shaped inputs and
  keep their private-tier floor. Verbatim is for trusted authored
  content (own writing, hand-edited LLM output you've reviewed).
* The bytes the server writes to disk are the bytes the user supplied,
  with only a trailing newline added if missing. No re-rendering, no
  re-formatting, no field reshuffling.

Compared to the drafter (``direct_drafter.draft_capture_pages``):

============  ===========================  ============================
Aspect        Verbatim                     Drafter
============  ===========================  ============================
LLM call?     None                         Yes (Anthropic/OpenAI)
Input shape   Markdown + frontmatter       Free-form text
Pages out     Exactly 1                    1-5 LLM-decided
Section       From input ``type``          LLM picks
Slug          From input or title          LLM picks (then sanitized)
Tier          From input (default private) Forced to private
Body bytes    Preserved exactly            Re-rendered from JSON
============  ===========================  ============================
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Optional

import frontmatter

from .tenants import Tenant

logger = logging.getLogger(__name__)


# Canonical type -> section mapping. Mirrors ``wiki._infer_type`` but
# inverted (we go type-to-section here, not section-to-type) and adds
# ``source`` which the LLM-driven drafter intentionally doesn't emit
# but the wiki itself understands as a first-class section.
TYPE_TO_SECTION = {
    "entity": "entities",
    "concept": "concepts",
    "decision": "decisions",
    "project": "projects",
    "query": "queries",
    "source": "sources",
}
VALID_TYPES = frozenset(TYPE_TO_SECTION.keys())
VALID_TIERS = frozenset({"public", "recruiter", "friend", "private"})

# Hard caps. The body cap matches the drafter's ``MAX_BODY_CHARS``
# floor x2 — verbatim is meant for hand-authored pages which sometimes
# legitimately run long (year-in-review-style source dumps). The page
# cap protects against accidental paste-of-entire-novel.
MAX_TITLE_LEN = 200
MAX_SLUG_LEN = 100
MAX_CONTENT_BYTES = 256 * 1024  # 256 KB
MIN_BODY_CHARS = 1  # at least one char after frontmatter

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*$")
DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-")


class VerbatimValidationError(ValueError):
    """Raised when the supplied markdown can't be written verbatim.

    All messages are user-facing — the caller (FastAPI handler) maps
    them straight to a 400 detail string. Keep them specific so the
    user can fix the input without guessing.
    """


@dataclass
class VerbatimWriteResult:
    rel_path: str
    title: str
    section: str
    slug: str
    tier: str
    page_type: str
    conflict_wrote_as: Optional[str] = None  # original slug when we suffixed
    overwrote_existing: bool = False  # True iff force_overwrite hit an existing file


def _slugify(title: str) -> str:
    """Same shape as ``direct_drafter._slugify`` — kept local instead of
    imported because the drafter module is async-LLM-flavored and we
    want this module to stay sync + dependency-light."""
    s = title.lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-") or "untitled"


def _resolve_target(
    *,
    wiki_root: Path,
    section: str,
    slug: str,
) -> Path:
    """Build + safety-check the target path.

    Defends against path traversal in either ``section`` (caller-validated
    against ``TYPE_TO_SECTION``, but defense in depth) or ``slug`` (which
    we slugify, but a malicious payload could pre-slugify to bypass).
    """
    target_dir = (wiki_root / "wiki" / section).resolve()
    base = (wiki_root / "wiki").resolve()
    try:
        target_dir.relative_to(base)
    except ValueError as exc:
        raise VerbatimValidationError(
            f"resolved section dir escaped wiki/ — refusing"
        ) from exc
    target = (target_dir / f"{slug}.md").resolve()
    try:
        target.relative_to(target_dir)
    except ValueError as exc:
        raise VerbatimValidationError(
            f"resolved slug escaped section dir — refusing"
        ) from exc
    return target


def parse_and_validate(
    *,
    content: str,
    slug_override: Optional[str] = None,
) -> tuple[dict, str, str, str, str, str]:
    """Parse the verbatim markdown and return:

        (metadata, body, page_type, section, title, slug)

    Raises ``VerbatimValidationError`` with a user-fixable message on
    any problem. The caller decides what HTTP status to map it to.

    Notes on the return tuple:
    * ``metadata`` is the parsed frontmatter dict, NOT what we write —
      we write the user's original bytes. Returned so the response
      preview can echo back what we saw.
    * ``body`` is the post-frontmatter content (trimmed). Returned for
      validation only; the on-disk bytes are still the original.
    * ``slug`` has already been normalized (lowercased, sanitized,
      date-prefixed for decisions if needed). The caller writes the
      file at ``<section>/<slug>.md``.
    """
    if not content or not content.strip():
        raise VerbatimValidationError(
            "content is empty — paste a markdown file with frontmatter"
        )

    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise VerbatimValidationError(
            f"content exceeds {MAX_CONTENT_BYTES // 1024} KB cap — "
            "split into multiple pages or trim source quotes"
        )

    # ``python-frontmatter`` is liberal: if there's no leading ``---``
    # block it silently returns a Post with empty metadata. We want a
    # hard error there because the whole point of verbatim is that the
    # user supplies a parseable frontmatter — without it we can't tell
    # what section/title/tier this page should be.
    if not content.lstrip().startswith("---"):
        raise VerbatimValidationError(
            "missing YAML frontmatter — first line must be '---' followed "
            "by 'type:', 'title:', etc. See /llm-writeback-spec for the "
            "expected fields."
        )

    try:
        post = frontmatter.loads(content)
    except Exception as exc:  # noqa: BLE001 — surface parse errors verbatim
        raise VerbatimValidationError(
            f"could not parse frontmatter: {exc}"
        ) from exc

    metadata: dict = dict(post.metadata or {})
    if not metadata:
        raise VerbatimValidationError(
            "frontmatter parsed empty — check the YAML syntax (indentation "
            "matters; quote values with colons in them)"
        )

    # --- type / section ---
    raw_type = metadata.get("type")
    if not raw_type or not isinstance(raw_type, str):
        raise VerbatimValidationError(
            "frontmatter is missing required field 'type'. Must be one of: "
            + ", ".join(sorted(VALID_TYPES))
        )
    page_type = raw_type.strip().lower()
    if page_type not in VALID_TYPES:
        raise VerbatimValidationError(
            f"invalid type {raw_type!r}. Must be one of: "
            + ", ".join(sorted(VALID_TYPES))
        )
    section = TYPE_TO_SECTION[page_type]

    # --- title ---
    raw_title = metadata.get("title")
    if not raw_title or not isinstance(raw_title, str):
        raise VerbatimValidationError(
            "frontmatter is missing required field 'title' (or it's empty/"
            "non-string)"
        )
    title = raw_title.strip()
    if not title:
        raise VerbatimValidationError("'title' is blank after trimming")
    if len(title) > MAX_TITLE_LEN:
        raise VerbatimValidationError(
            f"'title' is {len(title)} chars; cap is {MAX_TITLE_LEN}. Shorten "
            "the title; long context belongs in the body."
        )

    # --- tier (optional, defaults to private) ---
    raw_tier = metadata.get("tier")
    if raw_tier is None:
        tier = "private"
    elif not isinstance(raw_tier, str):
        raise VerbatimValidationError(
            f"'tier' must be a string, got {type(raw_tier).__name__}"
        )
    else:
        tier = raw_tier.strip().lower()
        if tier not in VALID_TIERS:
            raise VerbatimValidationError(
                f"invalid tier {raw_tier!r}. Must be one of: "
                + ", ".join(sorted(VALID_TIERS))
                + " (omit the field entirely to default to 'private')"
            )

    # --- slug ---
    # Resolution order:
    #   1. explicit slug_override (from request payload, e.g. user typed
    #      a slug in the UI form)
    #   2. ``slug`` field in the frontmatter
    #   3. derived from title
    # Then we normalize: lowercase, ascii, hyphens, leading-trailing
    # hyphens stripped, capped length.
    slug_source = (
        slug_override
        or metadata.get("slug")
        or title
    )
    if not isinstance(slug_source, str):
        raise VerbatimValidationError(
            "'slug' in frontmatter must be a string when provided"
        )
    slug = _slugify(slug_source.strip())[:MAX_SLUG_LEN]
    if not slug or not SLUG_RE.match(slug):
        raise VerbatimValidationError(
            f"could not derive a valid slug from {slug_source!r}. Provide a "
            "kebab-case slug explicitly (e.g. 'my-2025-review')."
        )

    # Decisions follow the YYYY-MM-DD-<slug>.md convention so the
    # decisions/ directory naturally sorts by date. Backfill today's
    # date if the user didn't include one (matches the drafter's
    # behavior in ``_validate_page_dict``).
    if section == "decisions" and not DATE_PREFIX_RE.match(slug):
        slug = f"{date.today().isoformat()}-{slug}"
        slug = slug[:MAX_SLUG_LEN]

    body = (post.content or "").strip()
    if len(body) < MIN_BODY_CHARS:
        raise VerbatimValidationError(
            "page body is empty (everything after the closing '---' is "
            "blank). Add at least a one-line summary."
        )

    return metadata, body, page_type, section, title, slug


def write_verbatim(
    *,
    content: str,
    tenant: Tenant,
    slug_override: Optional[str] = None,
    force_overwrite: bool = False,
) -> VerbatimWriteResult:
    """Validate + write the content to ``wiki/<section>/<slug>.md``.

    Raises ``VerbatimValidationError`` if the content can't be parsed
    or violates the schema. Returns a ``VerbatimWriteResult`` on
    success with the rel-path actually written (which may differ from
    the requested slug if a conflict suffix was applied).
    """
    metadata, _body, page_type, section, title, slug = parse_and_validate(
        content=content,
        slug_override=slug_override,
    )

    # Normalize trailing newline. Markdown convention is a single
    # trailing newline; many editors add it, many CLIs strip it. We
    # ensure exactly one so git diffs stay clean across editors.
    payload = content if content.endswith("\n") else content + "\n"

    target = _resolve_target(
        wiki_root=tenant.wiki_root,
        section=section,
        slug=slug,
    )
    target.parent.mkdir(parents=True, exist_ok=True)

    conflict_wrote_as: Optional[str] = None
    overwrote_existing = False

    if target.exists():
        if force_overwrite:
            # Caller explicitly opted in. Useful when user is iterating
            # on the same page (e.g. fixed a typo in the frontmatter
            # and is resubmitting).
            overwrote_existing = True
        else:
            # Non-destructive: suffix with ``-verbatim-<date>`` so the
            # existing file is preserved. Loop to find a free slot in
            # the rare event the user submits twice on the same day.
            today = date.today().isoformat()
            base = target.with_suffix("")
            target = target.parent / f"{base.name}-verbatim-{today}.md"
            i = 2
            while target.exists():
                target = target.parent / (
                    f"{base.name}-verbatim-{today}-{i}.md"
                )
                i += 1
            conflict_wrote_as = target.name

    target.write_text(payload, encoding="utf-8")
    rel_path = target.relative_to(tenant.wiki_root).as_posix()
    logger.info(
        "verbatim_capture.wrote tenant=%s rel=%s section=%s tier=%s "
        "conflict=%s force=%s",
        tenant.id,
        rel_path,
        section,
        metadata.get("tier") or "private",
        conflict_wrote_as is not None,
        force_overwrite,
    )
    return VerbatimWriteResult(
        rel_path=rel_path,
        title=title,
        section=section,
        slug=slug,
        tier=(metadata.get("tier") or "private").strip().lower(),
        page_type=page_type,
        conflict_wrote_as=conflict_wrote_as,
        overwrote_existing=overwrote_existing,
    )
