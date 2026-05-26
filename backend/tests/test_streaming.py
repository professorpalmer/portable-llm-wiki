"""Tests for the streaming chat parser.

We can't make real Anthropic/OpenAI calls in CI, so these tests mock
httpx.AsyncClient.stream to return a canned SSE response and verify
that `_stream_anthropic` / `_stream_openai` correctly extract text
fragments and that `stream_chat` translates them to our unified event
protocol.

The keyword-fallback path is exercised by test_chat_and_bulk.py's
existing SSE smoke test (which runs with no API keys configured); these
tests cover the LLM-backed paths that test can't reach.

We use anyio (already a transitive dep via FastAPI) instead of
pytest-asyncio to keep the test stack lean. The `anyio_backend` fixture
restricts these tests to asyncio (we don't ship a trio variant).
"""
from __future__ import annotations

from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend() -> str:
    """Force asyncio. Without this, anyio runs each test twice (asyncio +
    trio) and trio isn't installed."""
    return "asyncio"


@pytest.fixture
def llm_settings(monkeypatch):
    """Settings is a frozen dataclass so we can't mutate its attributes
    directly. Instead, swap the whole `settings` object referenced from
    `app.llm` with a MagicMock that has the keys we test against.

    Tests configure this fixture by mutating the returned object's
    attrs, e.g. `llm_settings.anthropic_api_key = "x"`.
    """
    mock_settings = MagicMock()
    mock_settings.anthropic_api_key = None
    mock_settings.openai_api_key = None
    mock_settings.anthropic_model = "claude-sonnet-4-5"
    mock_settings.openai_model = "gpt-4o-mini"
    monkeypatch.setattr("app.llm.settings", mock_settings)
    return mock_settings


# ---------------------------------------------------------------------------
# httpx.AsyncClient.stream returns an async context manager whose `aiter_lines`
# is an async iterator of strings. We synthesize that shape.
# ---------------------------------------------------------------------------


class _FakeStreamResponse:
    """Minimal stand-in for httpx.Response used inside `client.stream(...)`."""

    def __init__(
        self,
        status_code: int = 200,
        lines: list[str] | None = None,
        body: bytes = b"",
    ) -> None:
        self.status_code = status_code
        self._lines = lines or []
        self._body = body

    async def aiter_lines(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line

    async def aread(self) -> bytes:
        return self._body


class _FakeStreamCtx:
    """Context manager protocol that yields a FakeStreamResponse."""

    def __init__(self, response: _FakeStreamResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeStreamResponse:
        return self._response

    async def __aexit__(self, *_exc) -> None:
        return None


def _patch_stream(response: _FakeStreamResponse):
    """Patch httpx.AsyncClient so .stream() yields the canned response."""
    mock_client = MagicMock()
    mock_client.stream = MagicMock(return_value=_FakeStreamCtx(response))
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    return patch("app.llm.httpx.AsyncClient", return_value=mock_client)


# ---------------------------------------------------------------------------
# Anthropic protocol
# ---------------------------------------------------------------------------


ANTHROPIC_SSE_HAPPY = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_01"}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
]


@pytest.mark.anyio
async def test_anthropic_stream_extracts_text_deltas(llm_settings):
    llm_settings.anthropic_api_key = "test-key"

    from app.llm import _stream_anthropic

    fake = _FakeStreamResponse(status_code=200, lines=ANTHROPIC_SSE_HAPPY)
    with _patch_stream(fake):
        out = []
        async for fragment in _stream_anthropic(
            question="hi", context_block="", history=None
        ):
            out.append(fragment)

    assert out == ["Hello", " world"]


@pytest.mark.anyio
async def test_anthropic_stream_ignores_non_text_events(llm_settings):
    """ping events and content_block_delta with non-text deltas should
    not yield anything."""
    llm_settings.anthropic_api_key = "test-key"
    from app.llm import _stream_anthropic

    noisy = [
        'data: {"type":"ping"}',
        "",
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}',
        "",
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}',
    ]
    fake = _FakeStreamResponse(status_code=200, lines=noisy)
    with _patch_stream(fake):
        out = [f async for f in _stream_anthropic("hi", "", None)]

    assert out == ["OK"]


@pytest.mark.anyio
async def test_anthropic_stream_404_raises_model_not_found(llm_settings):
    """A 404 with body.error.type == "not_found_error" raises the typed
    ModelNotFoundError so the chain can cycle. Generic 4xxs raise
    LLMProviderError instead."""
    llm_settings.anthropic_api_key = "test-key"
    from app.llm import ModelNotFoundError, _stream_anthropic

    fake = _FakeStreamResponse(
        status_code=404,
        body=b'{"error":{"type":"not_found_error","message":"model: claude-x"}}',
    )
    with _patch_stream(fake):
        with pytest.raises(ModelNotFoundError, match="model"):
            async for _ in _stream_anthropic("hi", "", None):
                pass


# ---------------------------------------------------------------------------
# OpenAI protocol
# ---------------------------------------------------------------------------


OPENAI_SSE_HAPPY = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":" there"}}]}',
    "",
    "data: [DONE]",
]


@pytest.mark.anyio
async def test_openai_stream_extracts_deltas(llm_settings):
    llm_settings.openai_api_key = "test-key"
    from app.llm import _stream_openai

    fake = _FakeStreamResponse(status_code=200, lines=OPENAI_SSE_HAPPY)
    with _patch_stream(fake):
        out = [f async for f in _stream_openai("hi", "", None)]

    assert out == ["Hello", " there"]


@pytest.mark.anyio
async def test_openai_stream_handles_empty_deltas(llm_settings):
    """Some OpenAI chunks have delta={} or role-only deltas — skip those
    instead of yielding empty strings (which would confuse the UI)."""
    llm_settings.openai_api_key = "test-key"
    from app.llm import _stream_openai

    noisy = [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        "",
        'data: {"choices":[{"delta":{}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "",
        "data: [DONE]",
    ]
    fake = _FakeStreamResponse(status_code=200, lines=noisy)
    with _patch_stream(fake):
        out = [f async for f in _stream_openai("hi", "", None)]

    assert out == ["hi"]


# ---------------------------------------------------------------------------
# Unified event protocol (stream_chat wrapper)
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_stream_chat_emits_start_then_tokens_then_done(llm_settings):
    """End-to-end: stream_chat translates upstream deltas into the public
    {start, token, done} event protocol."""
    llm_settings.anthropic_api_key = "test-key"
    from app.llm import stream_chat

    fake = _FakeStreamResponse(status_code=200, lines=ANTHROPIC_SSE_HAPPY)
    with _patch_stream(fake):
        events = []
        async for e in stream_chat(
            question="what is this wiki?",
            history=[],
            viewer_tier="public",
        ):
            events.append(e)

    assert events[0]["type"] == "start"
    assert events[0]["backend"] == "anthropic"
    assert "citations" in events[0]
    # All token events come between start and done
    token_events = [e for e in events if e["type"] == "token"]
    assert [e["text"] for e in token_events] == ["Hello", " world"]
    assert events[-1]["type"] == "done"


@pytest.mark.anyio
async def test_stream_chat_anthropic_error_falls_back_to_keyword(llm_settings):
    """If Anthropic 404s mid-stream, the user still gets a keyword answer
    plus an `error` event so the client can surface the failure."""
    llm_settings.anthropic_api_key = "test-key"
    from app.llm import stream_chat

    fake = _FakeStreamResponse(
        status_code=404,
        body=b'{"error":{"type":"not_found_error","message":"model: claude-x"}}',
    )
    with _patch_stream(fake):
        events = []
        async for e in stream_chat(
            question="hi", history=[], viewer_tier="public"
        ):
            events.append(e)

    types = [e["type"] for e in events]
    assert types[0] == "start"
    assert "error" in types  # surfaced to client
    # A token event with the keyword fallback comes after the error
    assert "token" in types
    assert types[-1] == "done"


@pytest.mark.anyio
async def test_stream_chat_cycles_through_fallback_chain(llm_settings):
    """The streaming path inherits the same fallback chain as run_chat:
    if the configured Anthropic model 404s, the next model in
    ANTHROPIC_FALLBACK_CHAIN is tried before falling back to keyword."""
    llm_settings.anthropic_api_key = "test-key"
    llm_settings.anthropic_model = "claude-deprecated-foo"  # forces a 404 first
    from app.llm import ANTHROPIC_FALLBACK_CHAIN, stream_chat

    # First open: 404 (model_not_found). Second open: success.
    fake_404 = _FakeStreamResponse(
        status_code=404,
        body=b'{"error":{"type":"not_found_error","message":"model: claude-deprecated-foo"}}',
    )
    fake_ok = _FakeStreamResponse(status_code=200, lines=ANTHROPIC_SSE_HAPPY)

    call_count = {"n": 0}

    def stream_factory(*_args, **_kwargs):
        call_count["n"] += 1
        return _FakeStreamCtx(fake_404 if call_count["n"] == 1 else fake_ok)

    mock_client = MagicMock()
    mock_client.stream = MagicMock(side_effect=stream_factory)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.llm.httpx.AsyncClient", return_value=mock_client):
        events = []
        async for e in stream_chat(
            question="hi", history=[], viewer_tier="public"
        ):
            events.append(e)

    # Two stream opens — one 404'd, one succeeded.
    assert call_count["n"] == 2
    # Start event reflects the model that actually answered (the 2nd in
    # the chain after the deprecated configured one was skipped).
    start = [e for e in events if e["type"] == "start"][0]
    assert start["backend"] == "anthropic"
    assert start["model"] in ANTHROPIC_FALLBACK_CHAIN
    assert start["model"] != "claude-deprecated-foo"
    # Token text is from the happy-path SSE.
    token_text = "".join(
        e["text"] for e in events if e["type"] == "token"
    )
    assert "Hello world" in token_text
    assert events[-1]["type"] == "done"


@pytest.mark.anyio
async def test_stream_chat_all_models_in_chain_404_falls_back(llm_settings):
    """When every model in the chain returns 404 model_not_found, the
    stream surfaces an error event + the keyword digest as the final
    answer (so the user never sees a totally-empty assistant bubble)."""
    llm_settings.anthropic_api_key = "test-key"
    from app.llm import stream_chat

    # Every call returns 404 model_not_found.
    fake_404 = _FakeStreamResponse(
        status_code=404,
        body=b'{"error":{"type":"not_found_error","message":"model: x"}}',
    )

    def stream_factory(*_args, **_kwargs):
        return _FakeStreamCtx(fake_404)

    mock_client = MagicMock()
    mock_client.stream = MagicMock(side_effect=stream_factory)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.llm.httpx.AsyncClient", return_value=mock_client):
        events = []
        async for e in stream_chat(
            question="hi", history=[], viewer_tier="public"
        ):
            events.append(e)

    types = [e["type"] for e in events]
    # Started, errored (chain exhausted), got a keyword token, done.
    assert types[0] == "start"
    assert "error" in types
    assert "token" in types
    assert types[-1] == "done"
    # Start event's backend reverts to "keyword" since no LLM model answered.
    assert events[0]["backend"] == "keyword"


@pytest.mark.anyio
async def test_stream_chat_keyword_only_when_no_keys(llm_settings):
    # Defaults from llm_settings fixture: both keys are None
    from app.llm import stream_chat

    events = []
    async for e in stream_chat(
        question="hi", history=[], viewer_tier="public"
    ):
        events.append(e)

    assert events[0]["type"] == "start"
    assert events[0]["backend"] == "keyword"
    assert events[0]["model"] is None
    # Keyword path emits exactly ONE token (the whole digest) + done.
    assert sum(1 for e in events if e["type"] == "token") == 1
    assert events[-1]["type"] == "done"
