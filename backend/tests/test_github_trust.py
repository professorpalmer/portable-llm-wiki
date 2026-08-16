"""GitHub-trust slice: honest ``repo`` consent, App-token scaffold, private default.

Locks in:

1. OAuth fallback — when GitHub App env is unset, ``resolve_access_token``
   returns the user OAuth token unchanged (no HTTP).
2. App token path — when App env is set, minting is mocked and the
   installation token is preferred. The App does not have to exist.
3. ``create_new`` wiki repos default ``private=True`` on both
   ``create_repo`` and ``ConnectRepoRequest``.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from dataclasses import dataclass
from typing import Any

import httpx

from app import github_api, github_app
from app.github_api import DEFAULT_SCOPES, REPO_SCOPE_CONSENT
from app.hosted_routes import ConnectRepoRequest


@dataclass
class _AppSettings:
    github_app_id: str = ""
    github_app_private_key: str = ""
    github_app_install_url: str = ""
    github_app_installation_id: str = ""


class _FakeResponse:
    def __init__(self, status_code: int, body: Any, text: str | None = None) -> None:
        self.status_code = status_code
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self) -> Any:
        return self._body


class _FakeAsyncClient:
    """Records the POST that mints an installation token."""

    last: dict[str, Any] | None = None
    reply: _FakeResponse = _FakeResponse(201, {"token": "ghs_install_mock"})

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def post(self, url: str, headers: dict | None = None, json: Any = None) -> _FakeResponse:
        type(self).last = {"url": url, "headers": headers or {}, "json": json}
        return self.reply


def test_oauth_scope_stays_repo_not_public_repo():
    """Live OAuth must keep ``repo``. ``public_repo`` cannot import/push a private wiki."""
    assert DEFAULT_SCOPES == "read:user,repo"
    assert "public_repo" not in DEFAULT_SCOPES
    assert "repo" in DEFAULT_SCOPES.split(",")
    assert "GitHub App" in REPO_SCOPE_CONSENT
    assert "one wiki" in REPO_SCOPE_CONSENT


def test_oauth_fallback_when_app_env_unset(monkeypatch):
    """Unset App env is a no-op: the OAuth user token is returned as-is."""
    unset = _AppSettings()
    assert github_app.is_configured(unset) is False

    minted_calls: list[Any] = []

    async def _should_not_mint(**kwargs: Any) -> str:
        minted_calls.append(kwargs)
        raise AssertionError("mint_installation_token must not run when App env is unset")

    monkeypatch.setattr(github_app, "mint_installation_token", _should_not_mint)
    token = asyncio.run(
        github_api.resolve_access_token("oauth-user-token", settings=unset)
    )
    assert token == "oauth-user-token"
    assert minted_calls == []


def test_oauth_fallback_when_app_set_but_no_installation():
    """App credentials without an installation still use OAuth (user has not installed)."""
    configured = _AppSettings(
        github_app_id="12345",
        github_app_private_key="-----BEGIN FAKE-----\nxx\n-----END FAKE-----",
    )
    assert github_app.is_configured(configured) is True
    token = asyncio.run(
        github_api.resolve_access_token("oauth-user-token", settings=configured)
    )
    assert token == "oauth-user-token"


def test_app_token_path_when_env_set_mocked(monkeypatch):
    """Configured App + installation id prefers a mocked installation token."""
    configured = _AppSettings(
        github_app_id="12345",
        github_app_private_key="-----BEGIN FAKE-----\nxx\n-----END FAKE-----",
        github_app_install_url="https://github.com/apps/portable-llm-wiki/installations/new",
        github_app_installation_id="99",
    )

    async def fake_mint(*, installation_id: str | int, settings: object | None = None, **_: Any) -> str:
        assert str(installation_id) == "99"
        assert settings is configured
        return "ghs_installation_token"

    monkeypatch.setattr(github_app, "mint_installation_token", fake_mint)
    token = asyncio.run(
        github_api.resolve_access_token("oauth-user-token", settings=configured)
    )
    assert token == "ghs_installation_token"


def test_mint_installation_token_posts_to_app_api(monkeypatch):
    """Mint hits GitHub's installation-token endpoint with the App JWT (mocked signer)."""
    configured = _AppSettings(
        github_app_id="12345",
        github_app_private_key="-----BEGIN FAKE-----\nxx\n-----END FAKE-----",
    )
    _FakeAsyncClient.last = None
    _FakeAsyncClient.reply = _FakeResponse(201, {"token": "ghs_from_github"})
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)

    token = asyncio.run(
        github_app.mint_installation_token(
            installation_id=42,
            settings=configured,
            jwt_token="header.payload.sig",
        )
    )
    assert token == "ghs_from_github"
    assert _FakeAsyncClient.last is not None
    assert _FakeAsyncClient.last["url"].endswith("/app/installations/42/access_tokens")
    assert _FakeAsyncClient.last["headers"]["Authorization"] == "Bearer header.payload.sig"


def test_create_new_defaults_private():
    """create_new wikis are private unless the user explicitly asks public."""
    sig = inspect.signature(github_api.create_repo)
    assert sig.parameters["private"].default is True

    fields = ConnectRepoRequest.model_fields
    assert fields["private"].default is True

    implied = ConnectRepoRequest(create_new=True)
    assert implied.private is True

    explicit_public = ConnectRepoRequest(create_new=True, private=False)
    assert explicit_public.private is False


def test_create_repo_posts_private_true_by_default(monkeypatch):
    """The GitHub POST body is private unless the caller overrides."""
    captured: dict[str, Any] = {}

    class _CreateClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_CreateClient":
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

        async def post(self, url: str, json: Any = None, headers: Any = None) -> _FakeResponse:
            captured["url"] = url
            captured["json"] = json
            return _FakeResponse(
                201,
                {
                    "full_name": "alice/my-portable-llm-wiki",
                    "default_branch": "main",
                    "private": True,
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", _CreateClient)
    monkeypatch.setattr(github_app, "is_configured", lambda settings=None: False)
    repo = asyncio.run(github_api.create_repo("oauth-user-token", name="my-portable-llm-wiki"))
    assert captured["json"]["private"] is True
    assert captured["json"]["name"] == "my-portable-llm-wiki"
    assert repo["full_name"] == "alice/my-portable-llm-wiki"


def test_create_repo_uses_oauth_token_when_app_unset(monkeypatch):
    """create_repo keeps the OAuth token when App env is unset."""
    seen_auth: list[str] = []

    class _CreateClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_CreateClient":
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

        async def post(self, url: str, json: Any = None, headers: Any = None) -> _FakeResponse:
            seen_auth.append((headers or {}).get("Authorization", ""))
            return _FakeResponse(201, {"full_name": "alice/wiki", "default_branch": "main"})

    monkeypatch.setattr(httpx, "AsyncClient", _CreateClient)
    monkeypatch.setattr(github_app, "is_configured", lambda settings=None: False)
    asyncio.run(github_api.create_repo("oauth-user-token"))
    assert seen_auth == ["Bearer oauth-user-token"]
