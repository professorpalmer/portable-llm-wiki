"""Tests for the LLM provider fallback-chain logic in `app.llm`.

What this suite locks in:

1. Happy path — the configured model returns 200 and the answer is threaded
   straight through to `QueryResult`.
2. Model-not-found 404 cycles to the next model in the chain, and
   `QueryResult.model` reflects the model that actually answered.
3. Non-404 errors (auth/rate-limit) do NOT cycle — they short-circuit to the
   keyword digest immediately so we don't burn budget hammering a broken
   account.
4. When every model in the chain returns 404, the answer is the keyword
   digest prefixed with `_LLM unavailable_` so the UI can style it.
5. A configured model that's already in the hardcoded chain is tried exactly
   once (no double-call from the dedup).
6. OpenAI cycles the same way Anthropic does — confirms the abstraction
   generalizes across providers.

We mock httpx by monkeypatching `httpx.AsyncClient.post` per-test. The
existing conftest doesn't enable pytest-asyncio, so async coroutines are
driven by `asyncio.run` inside otherwise-sync tests. `settings` is a frozen
dataclass so we can't mutate its attributes in place; instead we swap
`app.llm.settings` with a lightweight stub via `monkeypatch.setattr`.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from app import llm


# ---------------------------------------------------------------------------
# Test infrastructure
# ---------------------------------------------------------------------------


@dataclass
class _StubSettings:
    """Stand-in for `app.config.Settings` that we can mutate per-test.

    Only the attributes `app.llm` reaches into matter; the real Settings
    object is frozen, which is why we substitute the module-level
    `app.llm.settings` reference instead of patching its fields."""

    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-5"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"


class _FakeResponse:
    """Minimal httpx.Response duck-type. We only need `status_code`, `.json()`
    and `.text` because that's all the provider call code touches."""

    def __init__(self, status_code: int, body: Any, text: str | None = None) -> None:
        self.status_code = status_code
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self) -> Any:
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


@dataclass
class _MockPost:
    """A scripted reply table keyed by model ID.

    Each entry maps model_id -> (status_code, body_dict). Calls to other
    model IDs raise so tests catch typos / unintended chain steps.
    """

    replies: dict[str, tuple[int, dict]]
    calls: list[dict] = field(default_factory=list)

    async def __call__(
        self,
        url: str,
        *,
        headers: dict | None = None,
        json: dict | None = None,
    ) -> _FakeResponse:
        # `_MockPost` is patched onto the class as a non-function callable,
        # so it does NOT get bound as a method. That means we receive
        # `url` directly — no implicit `self` (the AsyncClient) in front.
        model = (json or {}).get("model")
        self.calls.append(
            {
                "url": url,
                "model": model,
                "messages_len": len((json or {}).get("messages", [])),
                # Don't store headers (they contain the API key) or the
                # full payload (could be huge); just enough to assert on.
            }
        )
        if model not in self.replies:
            raise AssertionError(
                f"unexpected call with model={model!r}; "
                f"scripted models were {list(self.replies)}"
            )
        status, body = self.replies[model]
        return _FakeResponse(status, body)


def _install_mock(monkeypatch: pytest.MonkeyPatch, mock: _MockPost) -> None:
    """Patch httpx.AsyncClient.post for the duration of a test."""
    monkeypatch.setattr(httpx.AsyncClient, "post", mock)


def _install_settings(monkeypatch: pytest.MonkeyPatch, **fields: Any) -> _StubSettings:
    stub = _StubSettings(**fields)
    monkeypatch.setattr(llm, "settings", stub)
    return stub


# Pre-canned response bodies that mirror the real provider shapes.

def _anthropic_ok(text: str = "Synthesized answer.") -> tuple[int, dict]:
    return (
        200,
        {
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    )


def _anthropic_model_not_found(model: str) -> tuple[int, dict]:
    return (
        404,
        {
            "type": "error",
            "error": {
                "type": "not_found_error",
                "message": f"model: {model}",
            },
        },
    )


def _anthropic_auth_error() -> tuple[int, dict]:
    return (
        401,
        {
            "type": "error",
            "error": {
                "type": "authentication_error",
                "message": "invalid x-api-key",
            },
        },
    )


def _openai_ok(text: str = "Synthesized answer.") -> tuple[int, dict]:
    return (
        200,
        {
            "id": "chatcmpl-test",
            "choices": [
                {"index": 0, "message": {"role": "assistant", "content": text}}
            ],
        },
    )


def _openai_model_not_found(model: str) -> tuple[int, dict]:
    return (
        404,
        {
            "error": {
                "message": f"The model `{model}` does not exist",
                "type": "invalid_request_error",
                "param": None,
                "code": "model_not_found",
            },
        },
    )


def _openai_rate_limit() -> tuple[int, dict]:
    return (
        429,
        {
            "error": {
                "message": "Rate limit exceeded",
                "type": "rate_limit_error",
                "code": "rate_limit_exceeded",
            },
        },
    )


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


def test_anthropic_happy_path_returns_configured_model(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """Configured model returns 200 → answer threaded through unchanged,
    chain never cycles, response.model echoes the configured value."""
    _install_settings(
        monkeypatch,
        anthropic_api_key="test-key",
        anthropic_model="claude-sonnet-4-5",
    )
    mock = _MockPost({"claude-sonnet-4-5": _anthropic_ok("Hello from sonnet.")})
    _install_mock(monkeypatch, mock)

    result = asyncio.run(llm.run_chat("hi", [], "public"))

    assert result.backend == "anthropic"
    assert result.model == "claude-sonnet-4-5"
    assert result.answer == "Hello from sonnet."
    assert len(mock.calls) == 1
    assert mock.calls[0]["model"] == "claude-sonnet-4-5"
    assert mock.calls[0]["url"] == "https://api.anthropic.com/v1/messages"


def test_anthropic_model_not_found_cycles_to_next(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """Configured model 404s → backend cycles to next chain entry that
    returns 200. The response's model field reflects what actually
    answered, not the configured value."""
    _install_settings(
        monkeypatch,
        anthropic_api_key="test-key",
        anthropic_model="claude-sonnet-4-5",
    )
    mock = _MockPost(
        {
            "claude-sonnet-4-5": _anthropic_model_not_found("claude-sonnet-4-5"),
            "claude-opus-4-1": _anthropic_ok("Hello from opus."),
        }
    )
    _install_mock(monkeypatch, mock)

    result = asyncio.run(llm.run_chat("hi", [], "public"))

    assert result.backend == "anthropic"
    assert result.model == "claude-opus-4-1"
    assert result.answer == "Hello from opus."
    assert [c["model"] for c in mock.calls] == [
        "claude-sonnet-4-5",
        "claude-opus-4-1",
    ]


def test_anthropic_non_404_does_not_cycle(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """A 401 from the first model raises immediately — we do not try other
    models because the fault is the account, not the model ID. The answer
    falls through to the keyword digest tagged with `_LLM unavailable_`."""
    _install_settings(
        monkeypatch,
        anthropic_api_key="bad-key",
        anthropic_model="claude-sonnet-4-5",
    )
    mock = _MockPost({"claude-sonnet-4-5": _anthropic_auth_error()})
    _install_mock(monkeypatch, mock)

    result = asyncio.run(llm.run_chat("hi", [], "public"))

    assert result.backend == "keyword"
    assert result.model is None
    assert "_LLM unavailable_" in result.answer
    assert "Anthropic error" in result.answer
    # Crucially: only ONE upstream call, not the whole chain.
    assert len(mock.calls) == 1
    assert mock.calls[0]["model"] == "claude-sonnet-4-5"
    # The API key must not leak into the answer text.
    assert "bad-key" not in result.answer


def test_anthropic_all_models_404_falls_back_to_keyword(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """Every model in the chain returns model-not-found → keyword digest
    prefixed with `_LLM unavailable_`, and the chain is exhausted with
    each model tried exactly once."""
    _install_settings(
        monkeypatch,
        anthropic_api_key="test-key",
        anthropic_model="claude-sonnet-4-5",
    )
    chain = llm.ANTHROPIC_FALLBACK_CHAIN
    mock = _MockPost(
        {m: _anthropic_model_not_found(m) for m in chain}
    )
    _install_mock(monkeypatch, mock)

    result = asyncio.run(llm.run_chat("Tell me about the Public Entity", [], "public"))

    assert result.backend == "keyword"
    assert result.model is None
    assert result.answer.startswith("_LLM unavailable_")
    assert "every Anthropic model" in result.answer
    # Each chain model called exactly once (dedup of configured-vs-chain).
    called_models = [c["model"] for c in mock.calls]
    assert called_models == chain
    assert len(called_models) == len(set(called_models))


def test_anthropic_configured_model_already_in_chain_not_called_twice(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """When the user pins a model that's also in ANTHROPIC_FALLBACK_CHAIN,
    the chain dedup ensures it's tried exactly once. Catches regressions
    where the configured model gets prepended without dedup."""
    pinned = "claude-3-5-sonnet-20241022"  # already in the hardcoded chain
    assert pinned in llm.ANTHROPIC_FALLBACK_CHAIN, "test fixture stale"

    _install_settings(
        monkeypatch,
        anthropic_api_key="test-key",
        anthropic_model=pinned,
    )
    chain = llm.ANTHROPIC_FALLBACK_CHAIN
    mock = _MockPost(
        {m: _anthropic_model_not_found(m) for m in chain}
    )
    _install_mock(monkeypatch, mock)

    asyncio.run(llm.run_chat("hi", [], "public"))

    called_models = [c["model"] for c in mock.calls]
    # `pinned` appears exactly once even though it is also in the chain.
    assert called_models.count(pinned) == 1
    # First call IS the pinned model (configured-first ordering preserved).
    assert called_models[0] == pinned
    # Total calls equals chain length (no duplicates).
    assert len(called_models) == len(llm.ANTHROPIC_FALLBACK_CHAIN)


def test_anthropic_error_message_is_truncated(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """A pathologically long upstream error must NOT bloat the user-facing
    answer. The truncation cap is _MAX_ERR_LEN."""
    _install_settings(
        monkeypatch,
        anthropic_api_key="test-key",
        anthropic_model="claude-sonnet-4-5",
    )
    huge_body = (
        500,
        {
            "type": "error",
            "error": {
                "type": "api_error",
                "message": "x" * 5000,
            },
        },
    )
    mock = _MockPost({"claude-sonnet-4-5": huge_body})
    _install_mock(monkeypatch, mock)

    result = asyncio.run(llm.run_chat("hi", [], "public"))

    assert result.backend == "keyword"
    # The 200-char cap applies twice (provider helper + run_chat wrapper)
    # but the answer is still bounded — assert no untrimmed payload leak.
    assert "x" * 500 not in result.answer
    assert "_LLM unavailable_" in result.answer


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------


def test_openai_cycles_same_way_as_anthropic(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """Independent confirmation: the cycle/fallback abstraction
    generalizes — OpenAI behaves identically when its first chain entry
    is deprecated."""
    _install_settings(
        monkeypatch,
        anthropic_api_key=None,  # force the OpenAI branch
        openai_api_key="test-key",
        openai_model="gpt-4o-mini",
    )
    mock = _MockPost(
        {
            "gpt-4o-mini": _openai_model_not_found("gpt-4o-mini"),
            "gpt-4o": _openai_ok("Hello from gpt-4o."),
        }
    )
    _install_mock(monkeypatch, mock)

    result = asyncio.run(llm.run_chat("hi", [], "public"))

    assert result.backend == "openai"
    assert result.model == "gpt-4o"
    assert result.answer == "Hello from gpt-4o."
    assert [c["model"] for c in mock.calls] == ["gpt-4o-mini", "gpt-4o"]
    assert mock.calls[0]["url"] == "https://api.openai.com/v1/chat/completions"


def test_openai_rate_limit_does_not_cycle(
    monkeypatch: pytest.MonkeyPatch, client
) -> None:
    """429 is a non-recoverable provider error (the account is throttled),
    so we must NOT spend the rest of the chain trying to provoke more
    throttle errors. One call, then keyword fallback."""
    _install_settings(
        monkeypatch,
        anthropic_api_key=None,
        openai_api_key="test-key",
        openai_model="gpt-4o-mini",
    )
    mock = _MockPost({"gpt-4o-mini": _openai_rate_limit()})
    _install_mock(monkeypatch, mock)

    result = asyncio.run(llm.run_chat("hi", [], "public"))

    assert result.backend == "keyword"
    assert result.model is None
    assert "_LLM unavailable_" in result.answer
    assert "OpenAI error" in result.answer
    assert len(mock.calls) == 1


# ---------------------------------------------------------------------------
# Unit tests for helpers — small but fast guards against accidental regression
# ---------------------------------------------------------------------------


def test_build_chain_deduplicates_and_preserves_order() -> None:
    chain = llm._build_chain("foo", ["foo", "bar", "baz", "bar"])
    assert chain == ["foo", "bar", "baz"]


def test_build_chain_skips_empty_configured() -> None:
    chain = llm._build_chain(None, ["a", "b"])
    assert chain == ["a", "b"]
    chain2 = llm._build_chain("", ["a", "b"])
    assert chain2 == ["a", "b"]


def test_anthropic_error_kind_classification() -> None:
    kind, _ = llm._anthropic_error_kind(
        404,
        {"error": {"type": "not_found_error", "message": "model: foo"}},
    )
    assert kind == "model_not_found"

    # Non-404 with same body shape must NOT be classified as model_not_found.
    kind, _ = llm._anthropic_error_kind(
        500,
        {"error": {"type": "not_found_error", "message": "model: foo"}},
    )
    assert kind == "other"

    # 404 without "model" in the message → not a deprecation, just a missing
    # resource. Don't cycle.
    kind, _ = llm._anthropic_error_kind(
        404,
        {"error": {"type": "not_found_error", "message": "endpoint missing"}},
    )
    assert kind == "other"


def test_openai_error_kind_classification() -> None:
    kind, _ = llm._openai_error_kind(
        404, {"error": {"code": "model_not_found", "message": "..."}}
    )
    assert kind == "model_not_found"

    kind, _ = llm._openai_error_kind(
        400, {"error": {"code": "model_not_found", "message": "..."}}
    )
    assert kind == "model_not_found"

    kind, _ = llm._openai_error_kind(
        401, {"error": {"code": "invalid_api_key", "message": "..."}}
    )
    assert kind == "other"


def test_truncate_caps_at_limit() -> None:
    assert llm._truncate("short") == "short"
    big = "x" * 1000
    out = llm._truncate(big)
    assert len(out) <= llm._MAX_ERR_LEN
    assert out.endswith("\u2026")
