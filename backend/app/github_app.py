"""Optional GitHub App installation-token path.

A GitHub OAuth App cannot be limited to a single repository, so hosted
sign-in currently asks for the ``repo`` scope — enough to create/push
ONE wiki repo and import a private wiki the user already has. The
narrower trust path is a GitHub App the user installs on just that
repo. This module mints installation tokens when the operator has
created that App and set env; it does nothing when env is unset.

Env (all optional — empty keeps today's OAuth path):

* ``GITHUB_APP_ID``
* ``GITHUB_APP_PRIVATE_KEY`` (PEM; ``\\n`` escaped newlines are ok)
* ``GITHUB_APP_INSTALL_URL`` (user-facing install link)
* ``GITHUB_APP_INSTALLATION_ID`` (single-install deploys only)

Tests mock :func:`mint_installation_token` / the HTTP + JWT signer so
the App does not have to exist for CI to pass.
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any, Callable

import httpx

GITHUB_API = "https://api.github.com"


class GitHubAppError(RuntimeError):
    """GitHub App JWT or installation-token failure."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"GitHub App error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


def _settings_value(settings: object | None, name: str) -> str:
    if settings is not None:
        return str(getattr(settings, name, "") or "").strip()
    try:
        from .config import settings as _loaded

        return str(getattr(_loaded, name, "") or "").strip()
    except Exception:  # noqa: BLE001
        env_name = {
            "github_app_id": "GITHUB_APP_ID",
            "github_app_private_key": "GITHUB_APP_PRIVATE_KEY",
            "github_app_install_url": "GITHUB_APP_INSTALL_URL",
            "github_app_installation_id": "GITHUB_APP_INSTALLATION_ID",
        }.get(name, name.upper())
        return os.environ.get(env_name, "").strip()


def is_configured(settings: object | None = None) -> bool:
    """True when both App id and private key are present."""
    return bool(
        _settings_value(settings, "github_app_id")
        and _settings_value(settings, "github_app_private_key")
    )


def install_url(settings: object | None = None) -> str:
    """Operator-supplied install URL, or empty when the App is not live."""
    return _settings_value(settings, "github_app_install_url")


def _normalize_pem(raw: str) -> str:
    key = raw.strip()
    if "\\n" in key and "\n" not in key:
        key = key.replace("\\n", "\n")
    return key


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _sign_rs256(message: bytes, pem: str) -> bytes:
    """RS256-sign ``message`` with a PEM private key.

    Tries PyJWT's cryptography backend, then ``cryptography`` directly,
    then ``openssl``. Tests inject their own signer and never hit this.
    """
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding

        key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
        return key.sign(message, padding.PKCS1v15(), hashes.SHA256())
    except ImportError:
        pass

    import subprocess
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".pem")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(pem)
            if not pem.endswith("\n"):
                handle.write("\n")
        os.chmod(path, 0o600)
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", path],
            input=message,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            err = (result.stderr or b"").decode("utf-8", errors="replace")[:200]
            raise GitHubAppError(500, f"openssl RS256 sign failed: {err}")
        return result.stdout
    except FileNotFoundError as exc:
        raise GitHubAppError(
            500,
            "GitHub App JWT signing needs the cryptography package or openssl.",
        ) from exc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def build_app_jwt(
    *,
    app_id: str,
    private_key_pem: str,
    now: int | None = None,
    sign: Callable[[bytes, str], bytes] | None = None,
) -> str:
    """Mint a short-lived GitHub App JWT (RS256, iss=app id)."""
    issued = int(now if now is not None else time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {"iat": issued - 60, "exp": issued + 9 * 60, "iss": str(app_id)}
    signing_input = (
        f"{_b64url(json.dumps(header, separators=(',', ':')).encode('utf-8'))}."
        f"{_b64url(json.dumps(payload, separators=(',', ':')).encode('utf-8'))}"
    )
    signer = sign or _sign_rs256
    signature = signer(signing_input.encode("ascii"), _normalize_pem(private_key_pem))
    return f"{signing_input}.{_b64url(signature)}"


async def mint_installation_token(
    *,
    installation_id: str | int,
    settings: object | None = None,
    jwt_token: str | None = None,
    sign: Callable[[bytes, str], bytes] | None = None,
) -> str:
    """POST /app/installations/{id}/access_tokens — short-lived token."""
    if not is_configured(settings):
        raise GitHubAppError(
            500,
            "GitHub App is not configured. Set GITHUB_APP_ID and "
            "GITHUB_APP_PRIVATE_KEY, or keep using OAuth.",
        )
    install_id = str(installation_id).strip()
    if not install_id:
        raise GitHubAppError(400, "installation_id is required to mint an App token")

    token = jwt_token
    if not token:
        token = build_app_jwt(
            app_id=_settings_value(settings, "github_app_id"),
            private_key_pem=_settings_value(settings, "github_app_private_key"),
            sign=sign,
        )

    url = f"{GITHUB_API}/app/installations/{install_id}/access_tokens"
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    if response.status_code not in (200, 201):
        raise GitHubAppError(response.status_code, response.text[:200])
    payload: Any = response.json()
    minted = str((payload or {}).get("token") or "").strip()
    if not minted:
        raise GitHubAppError(502, "GitHub App token response missing token")
    return minted


async def resolve_access_token(
    oauth_token: str,
    *,
    installation_id: str | int | None = None,
    settings: object | None = None,
) -> str:
    """Prefer an installation token when the App is configured.

    If App env is unset, or no installation id is available, return
    ``oauth_token`` unchanged so today's OAuth path keeps working.
    """
    if not is_configured(settings):
        return oauth_token
    resolved_id = (
        str(installation_id).strip()
        if installation_id is not None
        else _settings_value(settings, "github_app_installation_id")
    )
    if not resolved_id:
        return oauth_token
    return await mint_installation_token(
        installation_id=resolved_id,
        settings=settings,
    )
