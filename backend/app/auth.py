"""Bearer-token + session-cookie auth, plus tier resolution.

Two auth models live side-by-side:

1. **OSS / single-tenant** — the original protocol. A static
   ``OWNER_TOKEN`` env var unlocks ``/owner/*``. Visitors paste the
   token into the owner console, it lives in their localStorage, and
   every owner request includes ``Authorization: Bearer <token>``.

2. **Hosted multi-tenant** (portablellm.wiki) — GitHub OAuth mints a
   signed session cookie carrying the user's ``tenant_id``. When a
   request hits ``/t/<tenant_id>/owner/...`` the TenantPrefixMiddleware
   sets a ``current_tenant_var`` contextvar. If the signed-in user's
   ``tenant_id`` matches the current tenant, they ARE the owner of
   this wiki — no bearer token required.

The OSS bearer-token path is checked first so behavior is unchanged
for self-hosters. The session-cookie path only kicks in in hosted
mode and only when there's no valid bearer token.

Other tier paths (public, share tokens, X-Preview-As) are unchanged.
"""
from __future__ import annotations

import hmac
import os
from dataclasses import dataclass
from typing import Optional

from fastapi import Header, HTTPException, Request, status

from .config import VALID_TIERS, settings


@dataclass(frozen=True)
class Viewer:
    tier: str
    is_owner: bool
    label: str  # human-readable: "owner", "public", "recruiter (token)"


PUBLIC_VIEWER = Viewer(tier="public", is_owner=False, label="public")


def _share_tokens() -> dict[str, str]:
    raw = os.environ.get("SHARE_TOKENS", "").strip()
    if not raw:
        return {}
    out: dict[str, str] = {}
    for entry in raw.split(","):
        if ":" not in entry:
            continue
        tok, tier = entry.split(":", 1)
        tok = tok.strip()
        tier = tier.strip().lower()
        if tok and tier in VALID_TIERS:
            out[tok] = tier
    return out


def _session_owner_viewer(request: Request | None) -> Optional[Viewer]:
    """Return an owner Viewer iff the request's session cookie identifies
    the owner of the current tenant.

    Only meaningful in hosted multi-tenant mode. Returns None if:
      * single-tenant mode is active (no session middleware to read from)
      * no session cookie / no signed-in user
      * the signed-in user's ``tenant_id`` doesn't match the tenant
        contextvar set by ``TenantPrefixMiddleware`` for this request
      * any exception occurs reading the session cookie (corrupt /
        forged / signed with a rotated secret) — fail closed, never
        elevate on a malformed cookie

    The cross-module imports (``tenants``) are local to keep
    ``auth.py`` importable without dragging in the multi-tenant
    machinery for OSS deployments.
    """
    if request is None or settings.single_tenant_mode:
        return None
    try:
        if not hasattr(request, "session"):
            return None
        user = request.session.get("user")
    except Exception:  # noqa: BLE001 — corrupt cookie ⇒ no auth
        return None
    if not isinstance(user, dict):
        return None
    user_tenant = user.get("tenant_id")
    if not user_tenant:
        return None

    # Compare the user's tenant_id with the *current request's* tenant
    # (set by TenantPrefixMiddleware from the URL prefix). Both must
    # match. Without this check, a signed-in user could call
    # ``/t/<other-tenant>/owner/...`` and the session cookie would
    # incorrectly elevate them on a wiki they don't own.
    try:
        from . import tenants as _tenants  # local: avoid hosted-mode import on OSS path

        current_tenant = _tenants.current_tenant_var.get(None)
    except Exception:  # noqa: BLE001
        return None
    if current_tenant is None or current_tenant.id != user_tenant:
        return None

    login = (
        user.get("gh_login")
        or user.get("github_user", {}).get("login")
        or user.get("login")
        or "owner"
    )
    return Viewer(tier="private", is_owner=True, label=f"@{login}")


def _viewer_from_share_tier(tier: str) -> Viewer:
    """Map a resolved share-token tier to a Viewer.

    ``private`` share tokens are the hosted **Personal LLM URL** credential
    (minted only from PersonalLlmUrlPanel — the Share Tokens UI does not
    offer private). Hosted users paste that ``?t=`` token into Cursor /
    ChatGPT / Marionette; it is the headless owner key for their tenant.
    Recruiter/friend tokens stay read-only at their tier.

    The static OSS ``OWNER_TOKEN`` env var is a separate path (label
    ``"owner"``) and is unaffected.
    """
    if tier == "private":
        return Viewer(
            tier="private",
            is_owner=True,
            label="private (personal LLM)",
        )
    return Viewer(tier=tier, is_owner=False, label=f"{tier} (share)")


def viewer_from_header(authorization: str | None) -> Viewer:
    if not authorization:
        return PUBLIC_VIEWER
    parts = authorization.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return PUBLIC_VIEWER
    token = parts[1].strip()
    if settings.owner_token and hmac.compare_digest(token, settings.owner_token):
        return Viewer(tier="private", is_owner=True, label="owner")
    # Static SHARE_TOKENS env var (legacy v0 mechanism)
    tiers = _share_tokens()
    if token in tiers:
        return _viewer_from_share_tier(tiers[token])
    # Persistent mintable share tokens
    try:
        from .share_tokens import resolve as resolve_persistent

        persistent_tier = resolve_persistent(token)
    except Exception:  # noqa: BLE001 — never let auth fail closed on store errors
        persistent_tier = None
    if persistent_tier:
        return _viewer_from_share_tier(persistent_tier)
    return PUBLIC_VIEWER


def current_viewer(
    request: Request,
    authorization: str | None = Header(default=None),
    x_preview_as: str | None = Header(default=None),
    x_share_token: str | None = Header(default=None),
) -> Viewer:
    """Resolve the effective viewer for a request.

    Resolution order (first match wins):
      1. ``Authorization: Bearer <OWNER_TOKEN>`` — canonical OSS path.
      2. Session cookie (hosted mode) — if the signed-in user owns the
         current tenant, they're seen as the owner. Bearer-share-token
         tier is still preferred over session-elevation for reads when
         the user explicitly passed a share token (uncommon, but lets
         an owner audit their wiki from inside a logged-in browser).
      3. ``X-Share-Token: <token>`` — fallback for clients/proxies
         that strip or rewrite the Authorization header. Resolved the
         same way as a bearer share token. Private personal-LLM tokens
         elevate to owner; the static OSS ``OWNER_TOKEN`` does not via
         this header.

    Supports ``X-Preview-As: public|recruiter|friend`` for audit
    preview — honored only when the resolved viewer is the actual owner.
    """
    real = viewer_from_header(authorization)

    # Session-cookie elevation: only kicks in when the bearer path
    # didn't already return owner. In hosted mode this is the *normal*
    # path for an owner browsing their own wiki — no token in
    # localStorage required.
    if not real.is_owner:
        session_owner = _session_owner_viewer(request)
        if session_owner is not None:
            real = session_owner

    # X-Share-Token fallback: only consult if NO non-public viewer
    # resolved above. Personal-LLM private tokens (is_owner via share
    # tier) are allowed — that is the headless hosted write path.
    # The static OSS OWNER_TOKEN (label ``"owner"``) is still rejected
    # on this header so a misconfigured proxy cannot smuggle it.
    if real.tier == "public" and not real.is_owner and x_share_token:
        candidate = viewer_from_header(f"Bearer {x_share_token.strip()}")
        if candidate.label != "owner":
            real = candidate

    if not real.is_owner or not x_preview_as:
        return real
    target = x_preview_as.strip().lower()
    if target == "owner":
        return real
    if target not in VALID_TIERS:
        return real
    return Viewer(
        tier=target,
        is_owner=False,
        label=f"owner -> preview as {target}",
    )


def require_owner(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Viewer:
    """Gate for write operations.

    Owner-only routes accept these auth signals, checked in order:

      1. ``Authorization: Bearer <OWNER_TOKEN>`` — the OSS / self-host
         path (static env-var token).
      2. ``Authorization: Bearer <private personal-LLM token>`` — the
         hosted headless path. Tokens minted from PersonalLlmUrlPanel
         (``?t=`` on ``/<tenant>/llm``) resolve to owner so Cursor /
         ChatGPT / Marionette can ingest without the platform env var.
      3. Session cookie pointing at this tenant — the hosted browser
         path. GitHub-authenticated users are owners of their own
         tenant; no bearer token in localStorage required.

    Any of these produces an owner ``Viewer``. ``X-Preview-As`` is
    ignored — preview never grants write access, and it never blocks
    a real owner from doing owner-only operations.
    """
    v = viewer_from_header(authorization)
    if v.is_owner:
        return v
    session_owner = _session_owner_viewer(request)
    if session_owner is not None:
        return session_owner
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Owner token required",
        headers={"WWW-Authenticate": "Bearer"},
    )
