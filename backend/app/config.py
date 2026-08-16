"""Runtime configuration loaded from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

VALID_TIERS = ("public", "recruiter", "friend", "private")
TIER_ORDER = {tier: i for i, tier in enumerate(VALID_TIERS)}


def _origin_of(url: str) -> str:
    """Return the scheme://host[:port] origin of a URL, or "" if unparseable.

    Used to derive the API host from the OAuth redirect URL so the GitHub
    webhook callback can be built without a dedicated env var.
    """
    if not url:
        return ""
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return ""
    return f"{parts.scheme}://{parts.netloc}"


@dataclass(frozen=True)
class _BaseSettings:
    """Process-wide settings loaded from env. The path-related properties
    (wiki_root, wiki_dir, raw_dir) are intentionally exposed through the
    Settings proxy below so they can become tenant-aware at request time
    without touching the 80+ call sites that read them.
    """

    default_wiki_root: Path  # single-tenant root; also the root for the "default" tenant
    tenants_root: Path  # base dir under which per-tenant wikis live (multi-tenant mode)
    single_tenant_mode: bool
    owner_token: str
    default_tier: str
    anthropic_api_key: str | None
    anthropic_model: str
    openai_api_key: str | None
    openai_model: str
    cors_origins: list[str]
    public_base_url: str
    # GitHub OAuth (hosted/multi-tenant mode only)
    github_oauth_client_id: str
    github_oauth_client_secret: str
    github_oauth_redirect_url: str
    # Public origin of the API host (e.g. https://api.portablellm.wiki).
    # Used to build the GitHub push-webhook callback URL. Defaults to the
    # origin of github_oauth_redirect_url (which already lives on the API
    # host) so it's correct without a separate env var in most deploys.
    public_api_base_url: str
    # Session cookie name for the hosted product
    session_cookie_name: str
    session_secret: str
    # Optional cookie Domain attribute. When set (e.g. ".portablellm.wiki")
    # the session cookie is shared across all subdomains of the registrable
    # domain, so the API host (api.portablellm.wiki) and the frontend host
    # (portablellm.wiki / www.portablellm.wiki) read the same first-party
    # cookie. Without this, browsers under 3P-cookie phaseout (Chrome,
    # Brave, Safari ITP) block the cross-host AJAX cookie even on shared
    # eTLD+1. Empty = host-only (legacy behavior).
    session_cookie_domain: str


class Settings:
    """Public settings interface. In single-tenant mode the path properties
    return the global default. In multi-tenant mode they return the current
    tenant's paths (resolved via contextvar)."""

    def __init__(self, base: _BaseSettings) -> None:
        self._base = base

    def __getattr__(self, name: str):  # type: ignore[override]
        # Path properties become tenant-aware in multi-tenant mode.
        if name in ("wiki_root", "wiki_dir", "raw_dir"):
            return self._resolve_path(name)
        return getattr(self._base, name)

    def _resolve_path(self, name: str) -> Path:
        # Defer import to avoid circular: tenants -> wiki -> config -> tenants.
        try:
            from . import tenants as _tenants

            tenant = _tenants.current_tenant_or_none()
        except Exception:  # noqa: BLE001
            tenant = None

        if tenant is not None:
            root = tenant.wiki_root
        else:
            root = self._base.default_wiki_root

        if name == "wiki_root":
            return root
        if name == "wiki_dir":
            return root / "wiki"
        if name == "raw_dir":
            return root / "raw"
        raise AttributeError(name)


_PLACEHOLDER_OWNER_TOKENS = frozenset({"change-me-to-a-long-random-string"})


def _load_owner_token(single_tenant_mode: bool) -> str:
    """Read OWNER_TOKEN. Refuse the documented example placeholder in OSS."""
    token = os.environ.get("OWNER_TOKEN", "").strip()
    if single_tenant_mode and token in _PLACEHOLDER_OWNER_TOKENS:
        raise RuntimeError(
            "OWNER_TOKEN is still the example placeholder. Generate a real "
            "token with: openssl rand -hex 32"
        )
    return token


def _load_settings() -> Settings:
    raw_root = os.environ.get("WIKI_ROOT", "").strip()
    if not raw_root:
        raise RuntimeError(
            "WIKI_ROOT is not set. Copy backend/.env.example to backend/.env and edit it."
        )
    root = Path(raw_root).expanduser().resolve()
    if not root.exists():
        # On cold-start with git-backed persistence, WIKI_ROOT doesn't exist
        # yet — the startup hook will clone it from WIKI_GIT_REMOTE. Tolerate
        # the gap by ensuring the parent dir exists so `git clone <root>`
        # has somewhere to land.
        if os.environ.get("WIKI_GIT_REMOTE", "").strip():
            root.parent.mkdir(parents=True, exist_ok=True)
        else:
            raise RuntimeError(f"WIKI_ROOT does not exist: {root}")

    default_tier = os.environ.get("DEFAULT_TIER", "private").strip().lower()
    if default_tier not in VALID_TIERS:
        raise RuntimeError(
            f"DEFAULT_TIER must be one of {VALID_TIERS}, got {default_tier!r}"
        )

    cors = [
        o.strip()
        for o in os.environ.get(
            "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
        ).split(",")
        if o.strip()
    ]

    # Multi-tenant mode is opt-in. Default is single-tenant (matches every
    # existing OSS / self-host installation).
    single_tenant_mode = os.environ.get("SINGLE_TENANT_MODE", "1").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }

    # Tenants root: where per-tenant wiki dirs live in multi-tenant mode.
    # Each tenant gets <tenants_root>/<tenant_id>/wiki|raw.
    raw_tenants_root = os.environ.get("TENANTS_ROOT", "").strip()
    if raw_tenants_root:
        tenants_root = Path(raw_tenants_root).expanduser().resolve()
    else:
        tenants_root = root.parent / "tenants"
    if not single_tenant_mode:
        tenants_root.mkdir(parents=True, exist_ok=True)

    base = _BaseSettings(
        default_wiki_root=root,
        tenants_root=tenants_root,
        single_tenant_mode=single_tenant_mode,
        owner_token=_load_owner_token(single_tenant_mode),
        default_tier=default_tier,
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        # Default to the top of ANTHROPIC_FALLBACK_CHAIN in llm.py. If this
        # model is later deprecated, the provider call will cycle to the next
        # entry in the chain at request time — no redeploy needed.
        anthropic_model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
        openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
        openai_model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        cors_origins=cors,
        public_base_url=os.environ.get("PUBLIC_BASE_URL", "http://localhost:3000"),
        github_oauth_client_id=os.environ.get("GITHUB_OAUTH_CLIENT_ID", "").strip(),
        github_oauth_client_secret=os.environ.get("GITHUB_OAUTH_CLIENT_SECRET", "").strip(),
        github_oauth_redirect_url=os.environ.get(
            "GITHUB_OAUTH_REDIRECT_URL", ""
        ).strip(),
        public_api_base_url=(
            os.environ.get("PUBLIC_API_BASE_URL", "").strip()
            or _origin_of(os.environ.get("GITHUB_OAUTH_REDIRECT_URL", "").strip())
        ),
        session_cookie_name=os.environ.get("SESSION_COOKIE_NAME", "plw_session").strip()
        or "plw_session",
        session_secret=os.environ.get("SESSION_SECRET", "").strip(),
        session_cookie_domain=os.environ.get("SESSION_COOKIE_DOMAIN", "").strip(),
    )

    return Settings(base)


settings = _load_settings()
