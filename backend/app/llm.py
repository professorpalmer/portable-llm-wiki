"""LLM query backend.

Picks Anthropic if ANTHROPIC_API_KEY is set, then OpenAI if OPENAI_API_KEY is
set, then a keyword fallback that just stitches together the top-scored pages.

The /query endpoint always returns the citation list (slug + title) it used,
so the frontend can render sourced answers regardless of which backend ran.

Model-deprecation resilience (non-streaming path): each provider has an
ordered fallback chain of currently-known-good model IDs. The
user-configured model (settings.anthropic_model / settings.openai_model) is
tried FIRST and then any chain entries not already attempted are tried in
order. When a provider returns "model not found" (a deprecation 404), we
cycle to the next entry. Non-404 errors (auth, rate-limit, network) do NOT
cycle — they surface immediately as a keyword fallback so we don't burn
budget hammering a broken account. The QueryResult.model field reflects
whichever model actually answered, not the configured one. See
ANTHROPIC_FALLBACK_CHAIN / OPENAI_FALLBACK_CHAIN below.

Streaming: in addition to the synchronous `run_chat` (one-shot, returns the
complete answer), `stream_chat` yields events as they arrive from the
upstream LLM. The protocol is:

    {"type": "start", "backend", "model", "viewer_tier", "citations",
                       "used_pages", "retrieval"}
    {"type": "token", "text": "..."}
    {"type": "token", "text": "..."}
    ...
    {"type": "done"}

Errors during streaming yield {"type": "error", "message": "..."} then "done".
The keyword fallback emits the entire answer in a single token event — no
real streaming benefit, but lets the frontend use one code path. The
streaming path does NOT currently cycle through the fallback chain — it
relies on the configured model being valid. See module docstring caveat.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Iterable

import httpx

from .config import settings
from .wiki import Page, index

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Model fallback chains (preferred → last-resort)
# ---------------------------------------------------------------------------
# Publicly-documented current model IDs. The user-configured model is tried
# FIRST and then any chain entries not already attempted are tried in order.
# To update: bump the top of the chain when a new flagship ships, and drop
# entries the vendor has fully removed from the API.

ANTHROPIC_FALLBACK_CHAIN: list[str] = [
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-3-5-sonnet-20241022",  # legacy, kept for envs that pin it
    "claude-3-5-haiku-20241022",
]

OPENAI_FALLBACK_CHAIN: list[str] = [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
]

# Cap any error text we propagate into user-visible answers. Keeps secrets,
# request bodies, and stack traces from leaking into the UI even if the
# upstream provider gets chatty.
_MAX_ERR_LEN = 200


class ModelNotFoundError(Exception):
    """Provider returned a 'model not found / deprecated' response.

    The caller should cycle to the next model in the fallback chain.
    Distinct from LLMProviderError so we can be precise about which
    failures justify retrying with a different model.
    """


class LLMProviderError(Exception):
    """Non-recoverable provider error (auth, rate-limit, network, malformed
    response). The caller should NOT cycle through more models — the fault
    is with the account or the network, not the model ID."""


def _truncate(msg: str, limit: int = _MAX_ERR_LEN) -> str:
    msg = (msg or "").strip()
    if len(msg) <= limit:
        return msg
    return msg[: limit - 1] + "\u2026"


def _build_chain(configured: str | None, hardcoded: Iterable[str]) -> list[str]:
    """Deduplicated chain: configured first, then any hardcoded entries
    not already covered. Empty/None entries are silently skipped.

    The dedup is critical for the "configured model already in chain isn't
    tried twice" guarantee — e.g. if a user pins claude-3-5-sonnet-20241022
    we don't want to call it once at the front of the chain and again when
    we hit it in the hardcoded list.
    """
    seen: set[str] = set()
    out: list[str] = []
    for m in (configured, *hardcoded):
        if not m or m in seen:
            continue
        seen.add(m)
        out.append(m)
    return out


def _anthropic_error_kind(status_code: int, body: dict | None) -> tuple[str, str]:
    """Classify an Anthropic error response.

    Returns (kind, message) where kind is one of {"model_not_found", "other"}.
    The shape we look for on model deprecation is HTTP 404 with body:
        {"type":"error","error":{"type":"not_found_error","message":"model: ..."}}
    """
    err = (body or {}).get("error") or {}
    msg = err.get("message") or ""
    if (
        status_code == 404
        and err.get("type") == "not_found_error"
        and "model" in msg.lower()
    ):
        return ("model_not_found", msg)
    return ("other", msg or f"http {status_code}")


def _openai_error_kind(status_code: int, body: dict | None) -> tuple[str, str]:
    """Classify an OpenAI error response.

    OpenAI uses 404 (sometimes 400) with body:
        {"error":{"message":"...","type":"invalid_request_error",
                   "code":"model_not_found"}}
    """
    err = (body or {}).get("error") or {}
    msg = err.get("message") or ""
    if status_code in (400, 404) and err.get("code") == "model_not_found":
        return ("model_not_found", msg)
    return ("other", msg or f"http {status_code}")


async def _cycle_models(
    chain: list[str],
    call: Callable[[str], Awaitable[str]],
    provider: str,
) -> tuple[str, str]:
    """Try each model in `chain`. On ModelNotFoundError, cycle to next; on
    LLMProviderError raise immediately (do NOT cycle). When the chain is
    exhausted with only model-not-found errors, re-raise the last
    ModelNotFoundError so the caller can fall through to keyword digest.

    Returns (answer_text, model_that_succeeded).
    """
    if not chain:
        raise LLMProviderError(f"{provider}: empty model chain")
    last_not_found: ModelNotFoundError | None = None
    for idx, model in enumerate(chain):
        try:
            answer = await call(model)
        except ModelNotFoundError as exc:
            logger.warning(
                "llm.model_not_found provider=%s model=%s position=%d/%d",
                provider, model, idx + 1, len(chain),
            )
            last_not_found = exc
            continue
        if last_not_found is not None:
            logger.info(
                "llm.fallback_succeeded provider=%s model=%s after_position=%d",
                provider, model, idx,
            )
        else:
            logger.info("llm.success provider=%s model=%s", provider, model)
        return answer, model
    assert last_not_found is not None  # only reachable when every call raised
    raise last_not_found


@dataclass
class QueryResult:
    answer: str
    citations: list[dict]  # [{slug, title}]
    backend: str  # "anthropic" | "openai" | "keyword"
    model: str | None
    used_pages: list[str]  # slugs in order considered
    retrieval: dict | None = None  # {anchors, expanded, total, hops} debug info


@dataclass
class ChatTurn:
    """One turn in a multi-turn conversation.

    `role` is "user" or "assistant" — we don't currently support system turns
    in the history (system prompt is fixed). `content` is plain text; we
    don't carry citations forward as structured data because the next-turn
    LLM can re-cite from the live retrieved context.
    """

    role: str
    content: str


SYSTEM_PROMPT = """You are the assistant for a Portable LLM Wiki.

Answer the user's question using ONLY the wiki pages provided as CONTEXT
below. Each page is delimited by "===== PAGE: <title> (slug: <slug>) =====".

Hard rules:
- Cite specific pages inline by their title in brackets, e.g. [[Calibrated Honesty]].
- If the wiki does not contain enough information to answer, say so explicitly
  and suggest what source the user could ingest to close the gap.
- Do not invent biographical or factual claims that are not in the context.
- Keep the answer focused. 2-6 short paragraphs is usually right.
- Do not include disclaimers about being an AI.
- In follow-up turns, treat earlier turns as conversation history. Stay
  consistent with prior claims unless the context contradicts them, in
  which case prefer the context and explicitly note the correction.
"""


# Index and Log are catalogs: a hop from any leaf includes them. Never dump
# those bodies into the synthesizer; they stay available via read_page.
CATALOG_SLUGS = frozenset({"index", "log"})
MAX_PAGE_CHARS = 8_000
MAX_CONTEXT_PAGES = 12
_TRUNCATION_NOTE = "\n\n[truncated]"


def _is_catalog_slug(slug: str) -> bool:
    return slug in CATALOG_SLUGS


def _select_context_pages(
    question: str,
    viewer_tier: str,
    max_anchors: int = 3,
    hops: int = 1,
    max_total: int = MAX_CONTEXT_PAGES,
) -> tuple[list[Page], dict]:
    """Graph-aware retrieval.

    Strategy:
      1. Keyword-score visible pages → take top `max_anchors` as ANCHORS,
         skipping catalog hubs (index, log).
      2. Expand each anchor `hops` steps along wikilinks (in/out) → SUBGRAPH,
         still skipping catalog hubs.
      3. If subgraph is thin (<3 pages), backfill with foundational pages
         (tagged 'foundational' or in projects/overview).
      4. Hard-cap at `max_total` pages so we don't blow the LLM context.

    Returns (pages_in_order, retrieval_debug_dict). Anchors come first.
    """
    scored = index.keyword_search(
        question, viewer_tier=viewer_tier, limit=max_anchors * 8
    )
    score_by_slug = {p.slug: score for p, score in scored}
    anchors: list[Page] = []
    for p, _score in scored:
        if _is_catalog_slug(p.slug):
            continue
        anchors.append(p)
        if len(anchors) >= max_anchors:
            break
    anchor_slugs = [p.slug for p in anchors]

    if anchors:
        subgraph = index.subgraph(
            anchor_slugs=anchor_slugs, viewer_tier=viewer_tier, hops=hops
        )
        expanded_slugs = [
            n["slug"]
            for n in subgraph["nodes"]
            if n["slug"] not in anchor_slugs and not _is_catalog_slug(n["slug"])
        ]
    else:
        subgraph = {"nodes": [], "edges": [], "anchors": []}
        expanded_slugs = []

    ordered_slugs: list[str] = anchor_slugs + expanded_slugs

    if len(ordered_slugs) < 3:
        for page in index.visible_pages(viewer_tier):
            if page.slug in ordered_slugs or _is_catalog_slug(page.slug):
                continue
            tags_lower = [t.lower() for t in page.tags]
            if (
                "foundational" in tags_lower
                or page.section in ("projects", "overview")
                or page.slug == "overview"
            ):
                ordered_slugs.append(page.slug)
            if len(ordered_slugs) >= max_total:
                break

    chosen: list[Page] = []
    for s in ordered_slugs[:max_total]:
        p = index.get(s)
        if p is not None:
            chosen.append(p)

    subgraph_slugs = {n["slug"] for n in subgraph.get("nodes", [])}
    omitted_catalog: list[dict] = []
    for slug in sorted(CATALOG_SLUGS):
        if slug not in score_by_slug and slug not in subgraph_slugs:
            continue
        hit = index.get(slug)
        omitted_catalog.append(
            {"slug": slug, "title": hit.title if hit is not None else slug}
        )

    retrieval_debug = {
        "strategy": (
            "graph-aware (keyword anchors + N-hop expansion; catalog hubs omitted)"
        ),
        "hops": hops,
        "anchors": [
            {
                "slug": p.slug,
                "title": p.title,
                "score": round(score_by_slug.get(p.slug, 0.0), 2),
            }
            for p in anchors
        ],
        "expanded": [
            {"slug": p.slug, "title": p.title}
            for p in chosen
            if p.slug not in anchor_slugs
        ],
        "omitted_catalog": omitted_catalog,
        "total_pages_in_context": len(chosen),
        "edge_count": len(subgraph.get("edges", [])),
    }
    return chosen, retrieval_debug


def _page_body_for_context(page: Page) -> str:
    body = page.body.strip()
    if len(body) <= MAX_PAGE_CHARS:
        return body
    return body[:MAX_PAGE_CHARS].rstrip() + _TRUNCATION_NOTE


def _build_context_block(pages: Iterable[Page]) -> str:
    chunks: list[str] = []
    for p in pages:
        chunks.append(
            f"===== PAGE: {p.title} (slug: {p.slug}, section: {p.section}, tier: {p.tier}) =====\n"
            f"{_page_body_for_context(p)}\n"
        )
    return "\n".join(chunks)


def _citations_from_pages(pages: Iterable[Page]) -> list[dict]:
    return [{"slug": p.slug, "title": p.title} for p in pages]


def _fallback_keyword_answer(question: str, pages: list[Page]) -> str:
    if not pages:
        return (
            "I couldn't find anything in this wiki that's clearly relevant to your "
            "question. If you're the owner, try ingesting a source that covers this topic."
        )
    lines: list[str] = [
        "**Keyword-only answer** (no LLM API key configured — set `ANTHROPIC_API_KEY` "
        "or `OPENAI_API_KEY` in `backend/.env` for synthesized answers).",
        "",
        f"Top matches for {question!r}:",
        "",
    ]
    for p in pages[:5]:
        lines.append(f"- [[{p.title}]] — {p.excerpt}")
    return "\n".join(lines)


def _retrieval_query(question: str, history: list[ChatTurn]) -> str:
    """Build a single string used for keyword retrieval.

    Follow-up questions like "tell me more about that" carry no useful
    keywords on their own. We concatenate the last few user turns so
    retrieval has signal even when the latest message is anaphoric.
    """
    if not history:
        return question
    recent_user_turns = [
        t.content for t in history[-4:] if t.role == "user"
    ]
    return " ".join(recent_user_turns + [question])


def _format_anthropic_history(history: list[ChatTurn]) -> list[dict]:
    """Convert ChatTurn history to Anthropic messages format.

    Anthropic expects alternating user/assistant. We trust the caller to
    pass clean alternation; if not, the API will reject — which is the
    right behavior since silent re-shaping would hide bugs.
    """
    out: list[dict] = []
    for turn in history:
        if turn.role in ("user", "assistant"):
            out.append({"role": turn.role, "content": turn.content})
    return out


async def _call_anthropic(
    model: str,
    question: str,
    context_block: str,
    history: list[ChatTurn] | None = None,
) -> str:
    """Call Anthropic messages API with an explicit model ID.

    Raises ModelNotFoundError if the provider reports the model is
    unknown/deprecated (signal for the caller to cycle to the next model);
    raises LLMProviderError for any other 4xx/5xx (auth, rate-limit, etc.)
    so the caller falls through to the keyword digest without burning
    additional requests.
    """
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": settings.anthropic_api_key or "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    messages = list(_format_anthropic_history(history or []))
    messages.append(
        {
            "role": "user",
            "content": (
                f"CONTEXT:\n{context_block}\n\n"
                f"QUESTION: {question}\n\n"
                "Answer using only the context above. Cite pages by [[Title]]."
            ),
        }
    )
    payload = {
        "model": model,
        "max_tokens": 1024,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        try:
            body: dict | None = resp.json()
        except Exception:  # noqa: BLE001 — defensive: provider could return HTML
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
    return ("\n".join(p for p in parts if p)).strip() or "(empty Anthropic response)"


async def _call_openai(
    model: str,
    question: str,
    context_block: str,
    history: list[ChatTurn] | None = None,
) -> str:
    """Call OpenAI chat completions with an explicit model ID. Error
    handling mirrors `_call_anthropic`: ModelNotFoundError → cycle,
    LLMProviderError → keyword fallback, no retries."""
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in history or []:
        if turn.role in ("user", "assistant"):
            messages.append({"role": turn.role, "content": turn.content})
    messages.append(
        {
            "role": "user",
            "content": (
                f"CONTEXT:\n{context_block}\n\n"
                f"QUESTION: {question}\n\n"
                "Answer using only the context above. Cite pages by [[Title]]."
            ),
        }
    )
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        try:
            body: dict | None = resp.json()
        except Exception:  # noqa: BLE001
            body = None
        kind, msg = _openai_error_kind(resp.status_code, body)
        truncated = _truncate(msg)
        if kind == "model_not_found":
            raise ModelNotFoundError(f"openai[{model}]: {truncated}")
        raise LLMProviderError(
            f"openai[{model}] http {resp.status_code}: {truncated}"
        )
    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError):
        raise LLMProviderError(
            f"openai[{model}] unexpected response shape: "
            f"{_truncate(json.dumps(data))}"
        )


async def run_query(question: str, viewer_tier: str) -> QueryResult:
    """One-shot query (no history). Thin wrapper over run_chat for legacy
    callers; new code should prefer run_chat directly."""
    return await run_chat(question=question, history=[], viewer_tier=viewer_tier)


async def run_chat(
    question: str,
    history: list[ChatTurn],
    viewer_tier: str,
) -> QueryResult:
    """Multi-turn chat with the wiki. Retrieval uses recent user turns +
    the current question (so "tell me more" doesn't lose context), and the
    LLM call threads the full conversation history.

    The provider call cycles through the model fallback chain on
    model-not-found errors (see module docstring). The returned `model`
    field is the model that actually answered, not the configured one.
    On non-recoverable provider errors (or chain exhaustion) the answer
    is the keyword digest prefixed with `_LLM unavailable_` so the UI
    can style the degraded path distinctly.
    """
    retrieval_q = _retrieval_query(question, history)
    pages, retrieval_debug = _select_context_pages(retrieval_q, viewer_tier)
    context_block = _build_context_block(pages)

    backend = "keyword"
    model: str | None = None
    answer: str

    if settings.anthropic_api_key:
        chain = _build_chain(settings.anthropic_model, ANTHROPIC_FALLBACK_CHAIN)
        try:
            answer, model_used = await _cycle_models(
                chain,
                lambda m: _call_anthropic(m, question, context_block, history),
                "anthropic",
            )
            backend = "anthropic"
            model = model_used
        except ModelNotFoundError as exc:
            logger.error(
                "llm.chain_exhausted provider=anthropic tried=%s last=%s",
                chain, exc,
            )
            answer = (
                "_LLM unavailable_ \u2014 every Anthropic model in the fallback "
                f"chain returned not-found ({_truncate(str(exc))}). "
                "Showing keyword digest below.\n\n"
                + _fallback_keyword_answer(question, pages)
            )
        except LLMProviderError as exc:
            answer = (
                f"_LLM unavailable_ \u2014 Anthropic error: {_truncate(str(exc))}."
                "\n\n"
                + _fallback_keyword_answer(question, pages)
            )
        except Exception as exc:  # noqa: BLE001 — last-resort safety net
            answer = (
                f"_LLM unavailable_ \u2014 Anthropic call failed: "
                f"{_truncate(repr(exc))}.\n\n"
                + _fallback_keyword_answer(question, pages)
            )
    elif settings.openai_api_key:
        chain = _build_chain(settings.openai_model, OPENAI_FALLBACK_CHAIN)
        try:
            answer, model_used = await _cycle_models(
                chain,
                lambda m: _call_openai(m, question, context_block, history),
                "openai",
            )
            backend = "openai"
            model = model_used
        except ModelNotFoundError as exc:
            logger.error(
                "llm.chain_exhausted provider=openai tried=%s last=%s",
                chain, exc,
            )
            answer = (
                "_LLM unavailable_ \u2014 every OpenAI model in the fallback "
                f"chain returned not-found ({_truncate(str(exc))}). "
                "Showing keyword digest below.\n\n"
                + _fallback_keyword_answer(question, pages)
            )
        except LLMProviderError as exc:
            answer = (
                f"_LLM unavailable_ \u2014 OpenAI error: {_truncate(str(exc))}."
                "\n\n"
                + _fallback_keyword_answer(question, pages)
            )
        except Exception as exc:  # noqa: BLE001
            answer = (
                f"_LLM unavailable_ \u2014 OpenAI call failed: "
                f"{_truncate(repr(exc))}.\n\n"
                + _fallback_keyword_answer(question, pages)
            )
    else:
        answer = _fallback_keyword_answer(question, pages)

    return QueryResult(
        answer=answer,
        citations=_citations_from_pages(pages),
        backend=backend,
        model=model,
        used_pages=[p.slug for p in pages],
        retrieval=retrieval_debug,
    )


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------


async def _stream_anthropic(
    question: str,
    context_block: str,
    history: list[ChatTurn] | None,
    model: str | None = None,
) -> AsyncIterator[str]:
    """Yield raw text fragments from the Anthropic streaming API.

    Anthropic's SSE protocol delimits events with `event:`/`data:` lines.
    We only care about `content_block_delta` events whose delta is a
    `text_delta` — everything else (ping, message_start, etc.) is
    bookkeeping we don't need to surface.

    On 4xx error, raises ModelNotFoundError for deprecation 404s (so the
    caller can cycle through the fallback chain) or LLMProviderError for
    anything else.
    """
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": settings.anthropic_api_key or "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    messages = list(_format_anthropic_history(history or []))
    messages.append(
        {
            "role": "user",
            "content": (
                f"CONTEXT:\n{context_block}\n\n"
                f"QUESTION: {question}\n\n"
                "Answer using only the context above. Cite pages by [[Title]]."
            ),
        }
    )
    payload = {
        "model": model or settings.anthropic_model,
        "max_tokens": 1024,
        "system": SYSTEM_PROMPT,
        "messages": messages,
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST", url, headers=headers, json=payload
        ) as resp:
            if resp.status_code >= 400:
                body_bytes = await resp.aread()
                try:
                    body_json = json.loads(body_bytes.decode("utf-8", "replace"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    body_json = None
                kind, msg = _anthropic_error_kind(resp.status_code, body_json)
                msg = _truncate(msg, 200)
                if kind == "model_not_found":
                    raise ModelNotFoundError(
                        f"anthropic model {payload['model']} not found: {msg}"
                    )
                raise LLMProviderError(
                    f"anthropic stream {resp.status_code}: {msg}"
                )
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text_delta":
                        text = delta.get("text") or ""
                        if text:
                            yield text


async def _stream_openai(
    question: str,
    context_block: str,
    history: list[ChatTurn] | None,
    model: str | None = None,
) -> AsyncIterator[str]:
    """Yield text fragments from OpenAI streaming chat completions.

    Same fallback-chain semantics as `_stream_anthropic`: 4xx with
    `code: "model_not_found"` raises ModelNotFoundError so the caller
    can cycle; everything else raises LLMProviderError.
    """
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in history or []:
        if turn.role in ("user", "assistant"):
            messages.append({"role": turn.role, "content": turn.content})
    messages.append(
        {
            "role": "user",
            "content": (
                f"CONTEXT:\n{context_block}\n\n"
                f"QUESTION: {question}\n\n"
                "Answer using only the context above. Cite pages by [[Title]]."
            ),
        }
    )
    payload = {
        "model": model or settings.openai_model,
        "messages": messages,
        "temperature": 0.2,
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST", url, headers=headers, json=payload
        ) as resp:
            if resp.status_code >= 400:
                body_bytes = await resp.aread()
                try:
                    body_json = json.loads(body_bytes.decode("utf-8", "replace"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    body_json = None
                kind, msg = _openai_error_kind(resp.status_code, body_json)
                msg = _truncate(msg, 200)
                if kind == "model_not_found":
                    raise ModelNotFoundError(
                        f"openai model {payload['model']} not found: {msg}"
                    )
                raise LLMProviderError(
                    f"openai stream {resp.status_code}: {msg}"
                )
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    return
                if not raw:
                    continue
                try:
                    chunk = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                text = delta.get("content")
                if text:
                    yield text


async def stream_chat(
    question: str,
    history: list[ChatTurn],
    viewer_tier: str,
) -> AsyncIterator[dict]:
    """Stream a chat turn as a sequence of dict events.

    The first event is always `start` with the retrieval metadata so the
    UI can render citations + which-pages-were-used before any tokens
    arrive (great for perceived latency). Subsequent events are `token`
    deltas. The terminator is always `done`.

    Errors mid-stream are surfaced as `error` events followed by `done`
    so the consumer can release its buffer and re-prompt the user.
    """
    retrieval_q = _retrieval_query(question, history)
    pages, retrieval_debug = _select_context_pages(retrieval_q, viewer_tier)
    context_block = _build_context_block(pages)

    backend = "keyword"
    model: str | None = None
    if settings.anthropic_api_key:
        backend = "anthropic"
        model = settings.anthropic_model
    elif settings.openai_api_key:
        backend = "openai"
        model = settings.openai_model

    # Build the per-provider model chain so the streaming path gets the
    # same deprecation resilience as run_chat / run_query. We resolve the
    # ACTUAL model that succeeds before sending the `start` event so the
    # citations panel reflects reality (e.g. if claude-sonnet-4-5 404s
    # and we cycle to claude-opus-4-1, the UI shows opus). To do that
    # without "double-pinging" the LLM, we use a small helper that opens
    # the stream, peels off the first token (or 404), then replays the
    # event stream.
    if backend == "anthropic":
        chain = _build_chain(settings.anthropic_model, ANTHROPIC_FALLBACK_CHAIN)
        async for event in _stream_with_chain(
            chain=chain,
            opener=lambda m: _stream_anthropic(
                question, context_block, history, model=m
            ),
            provider="anthropic",
            start_event_base={
                "type": "start",
                "backend": "anthropic",
                "viewer_tier": viewer_tier,
                "citations": _citations_from_pages(pages),
                "used_pages": [p.slug for p in pages],
                "retrieval": retrieval_debug,
            },
            keyword_fallback=lambda: _fallback_keyword_answer(question, pages),
        ):
            yield event
    elif backend == "openai":
        chain = _build_chain(settings.openai_model, OPENAI_FALLBACK_CHAIN)
        async for event in _stream_with_chain(
            chain=chain,
            opener=lambda m: _stream_openai(
                question, context_block, history, model=m
            ),
            provider="openai",
            start_event_base={
                "type": "start",
                "backend": "openai",
                "viewer_tier": viewer_tier,
                "citations": _citations_from_pages(pages),
                "used_pages": [p.slug for p in pages],
                "retrieval": retrieval_debug,
            },
            keyword_fallback=lambda: _fallback_keyword_answer(question, pages),
        ):
            yield event
    else:
        # Keyword fallback only path: emit start + one token + done.
        yield {
            "type": "start",
            "backend": "keyword",
            "model": None,
            "viewer_tier": viewer_tier,
            "citations": _citations_from_pages(pages),
            "used_pages": [p.slug for p in pages],
            "retrieval": retrieval_debug,
        }
        yield {
            "type": "token",
            "text": _fallback_keyword_answer(question, pages),
        }
        yield {"type": "done"}


async def _stream_with_chain(
    *,
    chain: list[str],
    opener: Callable[[str], AsyncIterator[str]],
    provider: str,
    start_event_base: dict,
    keyword_fallback: Callable[[], str],
) -> AsyncIterator[dict]:
    """Iterate `chain` of models, trying each until one streams successfully.

    The challenge with streaming: we want the `start` event to reflect the
    model that actually succeeds (so the UI shows the right model name in
    citations). But we can't know which model will succeed until we've
    opened the stream. Solution:

    1. Open the stream for the next model in chain.
    2. Wait for the first text fragment OR a ModelNotFoundError.
    3. On ModelNotFoundError: log + cycle to the next model.
    4. On first successful fragment: emit `start` (with this model) +
       `token` + continue streaming the rest.
    5. If all models 404: emit start (backend=keyword fallback note) +
       keyword answer token + done.

    Non-404 errors (auth, rate limit, network) do NOT cycle — they fall
    through to the keyword fallback immediately, matching run_chat.
    """
    last_error: Exception | None = None

    for idx, model in enumerate(chain):
        agen = opener(model)
        try:
            # Peel off the first fragment to confirm the stream is alive.
            first = await agen.__anext__()
        except StopAsyncIteration:
            # Provider returned an empty stream. Treat like model_not_found
            # so we cycle but don't surface a confusing error.
            last_error = ModelNotFoundError(
                f"{provider} model {model} returned empty stream"
            )
            logger.warning("llm.stream.empty provider=%s model=%s", provider, model)
            continue
        except ModelNotFoundError as exc:
            last_error = exc
            logger.warning(
                "llm.stream.model_not_found provider=%s model=%s position=%d/%d",
                provider, model, idx + 1, len(chain),
            )
            continue
        except LLMProviderError as exc:
            # Hard error: surface immediately, fall back to keyword.
            yield {**start_event_base, "model": None, "backend": "keyword"}
            yield {"type": "error", "message": str(exc)}
            yield {"type": "token", "text": keyword_fallback()}
            yield {"type": "done"}
            return
        except Exception as exc:  # noqa: BLE001 — network/timeouts
            yield {**start_event_base, "model": None, "backend": "keyword"}
            yield {
                "type": "error",
                "message": f"{provider} stream failed before first token: {exc}",
            }
            yield {"type": "token", "text": keyword_fallback()}
            yield {"type": "done"}
            return

        # Got first fragment from `model`. Lock in the start event with the
        # model that actually answered, then replay first + remaining frags.
        yield {**start_event_base, "model": model}
        yield {"type": "token", "text": first}
        try:
            async for fragment in agen:
                yield {"type": "token", "text": fragment}
        except Exception as exc:  # noqa: BLE001 — mid-stream upstream blip
            # Already past `start`; emit error + keyword tail so the user
            # gets *something* useful instead of a half-completed sentence.
            yield {"type": "error", "message": f"{provider} mid-stream: {exc}"}
            yield {"type": "token", "text": "\n\n" + keyword_fallback()}
        yield {"type": "done"}
        return

    # Chain exhausted with only model-not-found errors.
    yield {**start_event_base, "model": None, "backend": "keyword"}
    yield {
        "type": "error",
        "message": (
            f"all {provider} models in fallback chain returned model_not_found"
            f" (last: {last_error})"
        ),
    }
    yield {"type": "token", "text": keyword_fallback()}
    yield {"type": "done"}
