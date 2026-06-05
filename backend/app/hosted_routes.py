"""Hosted multi-tenant routes: GitHub OAuth + signup + onboarding.

These routes are only meaningful when ``SINGLE_TENANT_MODE=0``. In
single-tenant mode they 404 cleanly so the OSS self-host path is
unaffected.

Auth model
----------

* GitHub OAuth App authentication. A user clicks "Sign in with GitHub"
  on the landing page, we redirect to ``github.com/login/oauth/authorize``,
  they consent, GitHub redirects back to ``/auth/github/callback?code=...``,
  we exchange the code for an access token, then create-or-update the
  matching :class:`~app.tenants.Tenant` and set a session cookie.
* The session cookie is a signed JWT-ish blob managed by Starlette's
  :class:`~starlette.middleware.sessions.SessionMiddleware`. It carries
  the tenant id (= GitHub login) and user metadata. The GitHub OAuth
  token itself lives on the tenant record on disk — we never put a token
  in a cookie.

Onboarding model
----------------

After sign-in we redirect to ``/welcome``. The frontend wizard collects:

1. Pasted bio / resume / about text, OR
2. A URL to scrape (LinkedIn About page, personal site, etc.)

…and POSTs to ``/onboarding/import-text`` or ``/onboarding/import-url``.
The backend writes a ``raw/imports/<id>.md`` file inside the current
tenant's wiki root, then kicks off the Puppetmaster orchestrator (or
falls back to a synchronous LLM draft if Puppetmaster is unavailable).
"""

from __future__ import annotations

import os
import re
import secrets
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Cookie, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import github_api, persistence, tenants, url_scrape
from .config import settings


router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_hosted_mode() -> None:
    """All hosted routes 404 in single-tenant mode so OSS deploys don't
    accidentally expose half-configured OAuth endpoints."""
    if settings.single_tenant_mode:
        raise HTTPException(status_code=404, detail="hosted routes disabled in single-tenant mode")


def _require_oauth_config() -> None:
    """The OAuth endpoints fail loudly if env is missing."""
    if not settings.github_oauth_client_id or not settings.github_oauth_client_secret:
        raise HTTPException(
            status_code=500,
            detail=(
                "GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID, "
                "GITHUB_OAUTH_CLIENT_SECRET, and GITHUB_OAUTH_REDIRECT_URL "
                "in the backend env."
            ),
        )


def _session_user(request: Request) -> Optional[dict]:
    """Read the current session's user dict (if any).

    Resilient against malformed or stale session cookies: Starlette's
    SessionMiddleware will raise ``BadSignature`` (or related) when the
    cookie was signed with a different ``SESSION_SECRET`` than the one
    currently in use, which would otherwise turn /auth/me into a 500
    until the client clears cookies. Treat any cookie-deserialization
    failure as "not signed in".
    """
    try:
        if not hasattr(request, "session"):
            return None
        user = request.session.get("user")
    except Exception:  # noqa: BLE001 — corrupt/forged cookie ⇒ treat as anon
        return None
    if isinstance(user, dict) and user.get("tenant_id"):
        return user
    return None


def _require_session_user(request: Request) -> dict:
    u = _session_user(request)
    if u is None:
        raise HTTPException(status_code=401, detail="not signed in")
    return u


def _default_return_to() -> str:
    """Where to send the user when ``return_to`` is missing or rejected.

    In hosted mode the frontend lives on a different host than the API
    (``portablellm.wiki`` vs ``api.portablellm.wiki``), so a bare
    relative ``/welcome`` would resolve against the API host and 404.
    Anchor to ``PUBLIC_BASE_URL`` when set.
    """
    base = (settings.public_base_url or "").rstrip("/")
    return f"{base}/welcome" if base else "/welcome"


def _trusted_origins() -> list[str]:
    """Origins ``_safe_redirect`` will let an absolute return_to point at.

    The hosted product runs both an apex and a www variant of the
    frontend domain (Vercel hosts them, and the apex 307s to www). At
    runtime ``window.location.origin`` resolves to whichever the user
    is actually on, which is then passed to us as ``return_to``. If we
    only allow PUBLIC_BASE_URL verbatim we reject the legitimate
    variant — the bug that caused the post-signout "sign-in problem"
    page in the wild, because PUBLIC_BASE_URL was apex but the user
    was on www, the safe-redirect rejected ``https://www.portablellm.
    wiki``, and the fallback dumped them at ``/welcome`` (anon =
    "cookie didn't make it back" error). So we accept the apex/www
    variant of whichever public_base_url is configured.
    """
    base = (settings.public_base_url or "").rstrip("/")
    if not base:
        return []
    origins = [base]
    if "://" in base:
        scheme, rest = base.split("://", 1)
        if rest.startswith("www."):
            origins.append(f"{scheme}://{rest[len('www.'):]}")
        else:
            origins.append(f"{scheme}://www.{rest}")
    return origins


def _safe_redirect(target: str) -> str:
    """Avoid open-redirect attacks while still allowing legitimate
    cross-host redirects to the frontend.

    Accepts:
      * relative paths (``/welcome``, ``/cary``, …) — resolved against the
        current host.
      * absolute URLs whose origin matches ``settings.public_base_url``
        OR its apex/www twin (see ``_trusted_origins`` for the why).
        The backend is on a different host (``api.portablellm.wiki``),
        and the OAuth flow bounces between them, so we MUST allow the
        frontend origin or ``/welcome`` would resolve against the API
        host and 404.

    Rejects everything else and falls back to the default landing on
    the frontend.
    """
    if not target:
        return _default_return_to()

    # Allow same-host relative paths. Reject protocol-relative URLs
    # (``//evil.com/x``) which the browser would interpret as cross-origin.
    if target.startswith("/") and not target.startswith("//"):
        return target

    # Allow absolute URLs whose origin is one of our trusted variants.
    for origin in _trusted_origins():
        if (
            target == origin
            or target.startswith(origin + "/")
            or target.startswith(origin + "?")
            or target.startswith(origin + "#")
        ):
            return target

    return _default_return_to()


# ---------------------------------------------------------------------------
# Auth: GitHub OAuth
# ---------------------------------------------------------------------------


@router.get("/auth/github/login")
def github_login(request: Request, return_to: str = "/welcome") -> RedirectResponse:
    """Kick off the GitHub OAuth flow."""
    _require_hosted_mode()
    _require_oauth_config()
    state = secrets.token_urlsafe(24)
    request.session["oauth_state"] = state
    request.session["oauth_return_to"] = _safe_redirect(return_to)
    url = github_api.authorize_url(
        client_id=settings.github_oauth_client_id,
        redirect_uri=settings.github_oauth_redirect_url,
        state=state,
    )
    return RedirectResponse(url, status_code=302)


# The convention name we look for at cold-start auto-bind, and the
# default we pre-fill in the "create new repo" flow.
#
# Deliberately DIFFERENT from the product source repo name
# ("portable-llm-wiki"). Earlier versions used the same string and the
# collision bit a real user: GitHub's POST /user/repos is idempotent, so
# a fork of the product source named "portable-llm-wiki" + a "Create new
# wiki repo" click silently returned the product fork — and the next
# push committed tenant.json (with a live OAuth token) into a repo full
# of TypeScript and Python. See commit 879f45b for the security writeup.
#
# The runtime guard at ``_check_not_product_source`` catches the
# collision NOW even if some future bug brings back a same-name default.
# This rename is defense-in-depth: with the convention names distinct,
# the bad path can't even be reached without the user manually typing
# the colliding name.
_CONVENTIONAL_WIKI_REPO_NAME = "my-portable-llm-wiki"

# Older deploys used "portable-llm-wiki" as the convention. We still
# auto-bind to it on cold start for backwards compatibility — the
# product-source guard rejects it if it turns out to be a product fork,
# so honoring the legacy name is safe.
_LEGACY_CONVENTIONAL_WIKI_REPO_NAMES = ("portable-llm-wiki",)


# ---------------------------------------------------------------------------
# Product-source-repo guard
# ---------------------------------------------------------------------------
#
# A user can OAuth in, accept the GitHub repo list, and accidentally pick
# the portable-llm-wiki PRODUCT source itself (e.g. a fork of
# professorpalmer/portable-llm-wiki) as their wiki backing repo. Once
# bound:
#   1. Every wiki edit gets pushed as a commit to a repo full of Python +
#      TypeScript source code, polluting both worlds (the wiki ends up
#      living next to backend/app/main.py; commits look insane on
#      GitHub's commit log).
#   2. tenant.json (containing the user's OAuth access token) sits in
#      a working tree alongside the application source. We added a
#      tenant.json gitignore to prevent leaking the token via push, but
#      the broader hygiene is still bad — the user can't tell which
#      directory tree is "their wiki" anymore.
#   3. Force-reset against the product remote nukes their wiki content
#      and replaces it with the application source. Recovery is hard.
#
# The signature we detect: both a `backend/` directory AND a `frontend/`
# directory at the repo root. The product has both. Random wikis don't.
# Cheap (one Trees API call), unambiguous, no false positives we care
# about (a hypothetical user wiki with both a `backend/` and `frontend/`
# directory at root is so vanishingly rare that erring on the side of
# refusing it is the right trade — we can always loosen later).

_PRODUCT_SOURCE_MARKERS = ("backend", "frontend")


def _entries_look_like_product_source(entries: list[dict]) -> bool:
    """Predicate over the root entry list returned by
    ``github_api.get_repo_root_entries``. Returns True iff every marker
    in :data:`_PRODUCT_SOURCE_MARKERS` is present as a directory
    (``type == "tree"``) at the repo root."""
    if not entries:
        return False
    dirs = {
        e.get("path", "")
        for e in entries
        if isinstance(e, dict) and e.get("type") == "tree"
    }
    return all(marker in dirs for marker in _PRODUCT_SOURCE_MARKERS)


async def _check_not_product_source(
    token: str, full_name: str, branch: str = ""
) -> None:
    """Raise HTTPException 400 if the repo looks like the
    portable-llm-wiki product source. Silent on any GitHub error — we
    deliberately FAIL OPEN here because a transient 5xx shouldn't block
    a legitimate user from connecting their personal repo. The
    downside (a determined user could connect during a GitHub outage)
    is worth it for the upside (no false-positive failure mode that
    looks like 'GitHub is broken' to the user)."""
    try:
        entries = await github_api.get_repo_root_entries(
            token, full_name, branch
        )
    except github_api.GitHubAPIError:
        return
    if _entries_look_like_product_source(entries):
        raise HTTPException(
            status_code=400,
            detail=(
                f"That repo ({full_name}) looks like the portable-llm-wiki "
                "product source code, not a personal wiki — it has both a "
                "`backend/` and `frontend/` directory at the root. Pick a "
                "DIFFERENT repo (or create a fresh one) to back your wiki. "
                "Your wiki content shouldn't live alongside the application "
                "source code — they get pushed as commits, and reset-to-remote "
                "would replace your wiki with the app code."
            ),
        )


async def _hydrate_tenant_from_github(tenant: tenants.Tenant) -> None:
    """Best-effort: clone or auto-connect this tenant's wiki on cold start.

    Two cases this helper handles:

    1. Tenant already has ``gh_repo`` set but ``wiki_root`` is empty (or
       not a git repo). The disk got wiped (Render free-tier cold start,
       redeploy, etc). Bootstrap from the remote.

    2. Tenant has no ``gh_repo`` set, but the user has a
       ``<login>/portable-llm-wiki`` repo on their account. Auto-connect
       and bootstrap so the user doesn't have to walk through /welcome
       again every time the container restarts.

    Never raises — callers should ignore failures and let the user
    reconnect manually via the owner console / welcome wizard. The
    last-error field on the tenant record surfaces failures to the UI.
    """
    if not tenant.gh_token:
        return

    # Case 1: explicit connection, just make sure the local clone is healthy.
    if tenant.gh_repo:
        wiki_empty = not tenant.wiki_root.exists() or not any(
            tenant.wiki_root.glob("**/*.md")
        )
        is_repo = (tenant.wiki_root / ".git").exists()
        if wiki_empty or not is_repo:
            persistence.bootstrap_tenant(tenant)
        else:
            # Already cloned and populated. Try a best-effort pull so
            # edits made on github.com (or another device, or a webhook)
            # since the user's last visit show up immediately. We use
            # the safe pull path — diverged / dirty state is left alone
            # for the user to resolve manually via the owner console.
            try:
                pull_result = persistence.pull_tenant_now(tenant)
                if pull_result.get("ok") and pull_result.get("action") == "pulled":
                    try:
                        tenant.reload_index()
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                # Login should never fail because of a pull issue —
                # surfaces on the owner panel via last_error instead.
                pass
        return

    # Case 2: nothing connected yet — try the convention(s).
    #
    # We try the current convention first (``my-portable-llm-wiki``),
    # then fall back to legacy names (``portable-llm-wiki``) so existing
    # users from before the 2026-05 rename still auto-bind cleanly.
    # First match wins; we stop checking after a successful bind.
    if not tenant.gh_login:
        return
    candidate_names = (_CONVENTIONAL_WIKI_REPO_NAME, *_LEGACY_CONVENTIONAL_WIKI_REPO_NAMES)
    for candidate in candidate_names:
        full_name = f"{tenant.gh_login}/{candidate}"
        try:
            repo_data = await github_api.get_repo(tenant.gh_token, full_name)
        except github_api.GitHubAPIError:
            continue  # this candidate doesn't exist or no access — try next
        default_branch = repo_data.get("default_branch") or "main"
        # Refuse to auto-bind if the conventionally-named repo turns out
        # to be a product fork — i.e. the user forked portable-llm-wiki
        # and the legacy fallback name happens to match. Without this
        # guard the cold-start auto-bind would silently re-attach to the
        # product source on every login, defeating the explicit refusal
        # in onboarding_connect_repo.
        try:
            entries = await github_api.get_repo_root_entries(
                tenant.gh_token, full_name, default_branch
            )
        except github_api.GitHubAPIError:
            entries = []
        if _entries_look_like_product_source(entries):
            # Skip this candidate — owner console / welcome flow will
            # offer the real choice.
            continue
        tenant.gh_repo = full_name
        tenant.gh_default_branch = default_branch
        tenants.manager().upsert(tenant)
        persistence.bootstrap_tenant(tenant)
        return


@router.get("/auth/github/callback")
async def github_callback(
    request: Request,
    code: Optional[str] = Query(default=None),
    state: Optional[str] = Query(default=None),
    error: Optional[str] = Query(default=None),
) -> RedirectResponse:
    """Exchange the OAuth code for a token, create/update tenant, set session."""
    _require_hosted_mode()
    _require_oauth_config()

    if error:
        base = (settings.public_base_url or "").rstrip("/")
        return RedirectResponse(
            f"{base}/signin?error={error}" if base else f"/signin?error={error}",
            status_code=302,
        )
    if not code or not state:
        raise HTTPException(400, detail="missing code or state")

    expected_state = request.session.pop("oauth_state", None)
    requested_return_to = request.session.pop("oauth_return_to", None)
    if not expected_state or not secrets.compare_digest(expected_state, state):
        raise HTTPException(400, detail="oauth state mismatch")

    try:
        access_token = await github_api.exchange_oauth_code(
            client_id=settings.github_oauth_client_id,
            client_secret=settings.github_oauth_client_secret,
            code=code,
            redirect_uri=settings.github_oauth_redirect_url,
        )
        gh_user = await github_api.get_user(access_token)
    except github_api.GitHubAPIError as exc:
        raise HTTPException(status_code=502, detail=f"github oauth failed: {exc.message}") from exc

    tenant_id = gh_user.login.lower()
    mgr = tenants.manager()
    tenant = mgr.get(tenant_id)
    if tenant is None:
        tenant = mgr.provision_local(
            tenant_id,
            display_name=gh_user.name or gh_user.login,
            gh_login=gh_user.login,
            gh_user_id=gh_user.id,
            gh_token=access_token,
        )
    else:
        tenant.gh_token = access_token
        tenant.gh_login = gh_user.login
        tenant.gh_user_id = gh_user.id
        if gh_user.name:
            tenant.display_name = gh_user.name
        mgr.upsert(tenant)

    # ---- Cold-start hydration / convention-based reconnect ----
    #
    # If the tenant already has a connected gh_repo but the local wiki_root
    # has been wiped (ephemeral disk on Render free tier), re-clone so the
    # user lands back on their existing content instead of a blank wiki.
    #
    # If the tenant has NO connected repo yet but the user has a
    # ``<login>/portable-llm-wiki`` repo on their GitHub account (the
    # convention we mint by default), auto-connect and clone it. This
    # makes the "log in after a cold start" experience seamless without
    # forcing every user to re-pick a repo via /welcome.
    try:
        await _hydrate_tenant_from_github(tenant)
    except Exception:  # noqa: BLE001
        # Hydration is best-effort — never block login on a clone failure.
        # The owner-console sync panel will surface the error so the user
        # can retry, but they still get into the app.
        pass

    request.session["user"] = {
        "tenant_id": tenant_id,
        "gh_login": gh_user.login,
        "gh_user_id": gh_user.id,
        "name": gh_user.name,
        "avatar_url": gh_user.avatar_url,
        "signed_in_at": datetime.now(timezone.utc).isoformat(),
    }
    # Tenant.gh_token is the trusted source of truth; the session cookie
    # only carries identity, never the token itself.

    # Stash a one-shot "fresh signup" flag the welcome wizard reads to
    # decide whether to show the import step vs. linking to the existing
    # wiki.
    is_fresh = not (tenant.wiki_dir.exists() and any(tenant.wiki_dir.rglob("*.md")))
    request.session["fresh_signup"] = is_fresh

    # Pick the redirect target:
    #   1. Honor an explicit, validated ``return_to`` if the caller passed one.
    #   2. Otherwise, send fresh signups to the welcome wizard and returning
    #      users to their own wiki — both anchored at the public frontend
    #      base so the redirect doesn't resolve against ``api.*``.
    base = (settings.public_base_url or "").rstrip("/")
    if requested_return_to:
        target = _safe_redirect(requested_return_to)
    elif is_fresh:
        target = f"{base}/welcome" if base else "/welcome"
    else:
        target = f"{base}/{tenant_id}" if base else f"/{tenant_id}"

    return RedirectResponse(target, status_code=302)


def _count_tenant_pages(tenant: Optional[tenants.Tenant]) -> int:
    """Count .md files under ``tenant.wiki_dir``. The welcome page uses
    this to decide whether to render the import wizard (page_count == 0,
    fresh signup) or bounce returning users to their existing wiki.

    Source of truth is the filesystem, not the in-memory page index, so
    the count is correct immediately after an import even before the
    index reload settles, AND correct across process restarts where the
    session's ``fresh_signup`` flag would otherwise be stale.
    """
    if tenant is None:
        return 0
    try:
        if not tenant.wiki_dir.exists():
            return 0
        return sum(1 for _ in tenant.wiki_dir.rglob("*.md"))
    except OSError:
        return 0


def _count_imported_duplicates(tenant: Optional[tenants.Tenant]) -> int:
    """Count files matching ``*-imported*.md`` under ``tenant.wiki_dir``.

    Surfaces to the welcome page so a user who accidentally re-ran the
    import wizard sees a "Clean up duplicates" CTA with the exact count.
    Without it they'd have to scan the wiki by hand to discover the
    damage.
    """
    if tenant is None or not tenant.wiki_dir.exists():
        return 0
    try:
        return sum(1 for _ in tenant.wiki_dir.rglob("*-imported*.md"))
    except OSError:
        return 0


@router.get("/auth/me")
def auth_me(request: Request) -> dict:
    """Return the current session's identity (or { authenticated: false })."""
    _require_hosted_mode()
    user = _session_user(request)
    if user is None:
        return {"authenticated": False}
    tenant = tenants.manager().get(user["tenant_id"])
    page_count = _count_tenant_pages(tenant)
    return {
        "authenticated": True,
        "user": {
            "tenant_id": user["tenant_id"],
            "login": user.get("gh_login", ""),
            "name": user.get("name", ""),
            "avatar_url": user.get("avatar_url", ""),
        },
        "tenant": tenant.to_dict() if tenant else None,
        # Live count of markdown pages in the user's wiki — the welcome
        # page reads this to decide whether to show the import wizard
        # (page_count == 0) or bounce returning users to their existing
        # wiki (page_count > 0). NOTE: derived from the filesystem on
        # each call, not from the session, so it's accurate across
        # process restarts and across re-signin events.
        "page_count": page_count,
        # Same flag as before, but now derived from the live disk count
        # so we can't lie about it on a re-signin where the user already
        # has content. ``fresh_signup`` stays for back-compat with
        # existing frontend code that hasn't switched to ``page_count``
        # yet.
        "fresh_signup": page_count == 0,
        # Files left over from an accidental duplicate re-import. The
        # welcome page surfaces a "Clean up duplicates" button when
        # this is > 0 so the user can self-heal in one click.
        "duplicate_imports_count": _count_imported_duplicates(tenant),
        # Is the tenant's wiki connected to a GitHub repo? Controls
        # whether /welcome routes to the "connect a repo" step or jumps
        # straight to import. Owner console reads this for the sync panel.
        "github_sync": {
            "connected": bool(tenant and tenant.gh_repo and tenant.gh_token),
            "repo": tenant.gh_repo if tenant else "",
            "branch": tenant.gh_default_branch if tenant else "main",
            "html_url": (
                f"https://github.com/{tenant.gh_repo}"
                if tenant and tenant.gh_repo
                else ""
            ),
            "last_synced_at": tenant.git_last_synced_at if tenant else 0,
            "last_error": tenant.git_last_error if tenant else "",
            "pushes_made": tenant.git_pushes_made if tenant else 0,
        },
    }


@router.post("/auth/logout")
def auth_logout(request: Request) -> dict:
    """Clear the session cookie (API path, JSON response)."""
    _require_hosted_mode()
    if hasattr(request, "session"):
        request.session.clear()
    return {"ok": True}


@router.get("/auth/logout")
def auth_logout_redirect(request: Request, return_to: str = "") -> RedirectResponse:
    """Clear the session cookie and bounce back to the frontend.

    Same effect as POST /auth/logout but reachable from a plain
    ``<a href>`` so the nav menu "Sign out" works without JavaScript.
    ``return_to`` is validated against the same allow-list OAuth uses,
    so this can't be abused as an open redirect.

    Landing-page choice: the fallback target is the frontend ROOT (``/``),
    not ``/welcome``. The welcome page is fundamentally a signed-in
    onboarding step — if it gets visited anonymously (which signing out
    produces), it renders a "we can't finish signing you in / cookie
    didn't make it back" error that's both wrong and alarming for the
    user who just deliberately signed out. Landing on the public
    homepage instead reads as a clean sign-off.
    """
    _require_hosted_mode()
    if hasattr(request, "session"):
        request.session.clear()
    # _safe_redirect returns _default_return_to() (= /welcome) when the
    # given target fails the allow-list, which is the WRONG default for
    # logout. So we resolve sign-out's own default first (root), then
    # only run _safe_redirect when an explicit return_to was passed.
    if return_to:
        target = _safe_redirect(return_to)
        # _safe_redirect's "rejected" sentinel is _default_return_to()
        # (= /welcome). If we got that back from a return_to that the
        # caller bothered to specify, it was probably the www/apex
        # mismatch — but either way, prefer root over /welcome for
        # the post-logout case.
        if target == _default_return_to():
            target = _logout_default_landing()
    else:
        target = _logout_default_landing()
    # Reanchor onto PUBLIC_BASE_URL if the caller passed a bare path —
    # /auth/logout lives on api.portablellm.wiki, but the user wants to
    # land back on portablellm.wiki.
    if target.startswith("/") and settings.public_base_url:
        target = settings.public_base_url.rstrip("/") + target
    return RedirectResponse(url=target, status_code=302)


def _logout_default_landing() -> str:
    """Where to send a user we've just logged out (no return_to, or a
    rejected one). Frontend root, not /welcome — see auth_logout_redirect
    for the rationale.
    """
    base = (settings.public_base_url or "").rstrip("/")
    return f"{base}/" if base else "/"


@router.delete("/owner/account")
async def owner_delete_account(request: Request) -> JSONResponse:
    """Self-service tenant deletion.

    Wipes everything our service stores about the caller:

    * the tenant directory under ``<tenants_root>/<tenant_id>/`` —
      working tree, ``tenant.json`` (which holds the OAuth token),
      ``.share-tokens.json``, raw imports, the search index, all of it.
    * the in-memory tenant registry entry.
    * the session cookie.

    Best-effort, then proceeds regardless:

    * invalidates the stored GitHub OAuth token via GitHub's
      ``DELETE /applications/{client_id}/token``. If GitHub is down or
      the token was already revoked, we still want to wipe local state
      — we will not trap the user in our service waiting on a flaky
      third party.

    What we *don't* touch: the user's GitHub repository. Their content
    is theirs. They keep the repo and can self-host or fork later.
    That asymmetry is the whole point of portability — the user owns
    durable storage; the hosted service is a thin layer on top.

    The endpoint is idempotent: a second DELETE after the first one
    succeeded returns 404 (no such tenant), which is the correct shape
    for a delete that has nothing left to delete. The frontend treats
    that as "already gone, you're done".
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant_id = user.get("tenant_id", "")
    tenant = tenants.manager().get(tenant_id) if tenant_id else None
    if tenant is None or tenant.id == "default":
        # Either the cookie points at a tenant that no longer exists
        # (already deleted in a previous call) or someone is trying to
        # delete the unused single-tenant "default" record. Both map
        # to "nothing to do".
        if hasattr(request, "session"):
            request.session.clear()
        raise HTTPException(status_code=404, detail="no tenant to delete")

    # 1) Try to revoke the stored OAuth token. Best-effort.
    token_was_revoked = False
    if tenant.gh_token:
        try:
            token_was_revoked = await github_api.revoke_oauth_token(
                client_id=settings.github_oauth_client_id,
                client_secret=settings.github_oauth_client_secret,
                token=tenant.gh_token,
            )
        except Exception:  # noqa: BLE001  — best-effort, swallow & proceed
            token_was_revoked = False

    # 2) Wipe the tenant directory and the in-memory record. The
    #    manager guards path-resolution; we won't escape tenants_root.
    deleted_on_disk = tenants.manager().delete(tenant.id)

    # 3) Clear the session cookie so the next request from this browser
    #    isn't authenticated as the just-deleted tenant.
    if hasattr(request, "session"):
        request.session.clear()

    return JSONResponse(
        {
            "ok": True,
            "tenant_id": tenant.id,
            "github_token_revoked": token_was_revoked,
            "tenant_deleted_on_disk": deleted_on_disk,
            # Frontend uses this to construct the goodbye-page link
            # pointing at the user's portable repo (which still exists
            # on GitHub).
            "github_repo": tenant.gh_repo or "",
        }
    )


@router.get("/auth/switch-account")
def auth_switch_account(
    request: Request, return_to: str = ""
) -> RedirectResponse:
    """Clear our session and immediately kick off the GitHub OAuth flow.

    UX: the nav's "Switch GitHub account" menu action lands here. We
    can't drive GitHub itself to ``prompt=select_account`` (the GitHub
    OAuth provider doesn't support it the way Google's does), so the
    real switch happens at github.com — whichever account the user is
    currently signed in there with is the one OAuth will use. If they
    want a different one, they sign out of github.com first or open
    incognito; the menu copy explains this.

    Implementation note: we used to drive this from the client with a
    two-hop chain (``/auth/logout?return_to=<encoded /auth/github/login
    URL>``), but ``_safe_redirect`` rightly rejects API-origin return
    targets to keep itself a tight open-redirect guard. Doing the
    clear+redirect server-side is both cleaner and immune to that.
    """
    _require_hosted_mode()
    _require_oauth_config()
    if hasattr(request, "session"):
        request.session.clear()
    # Pass the original return_to through to /auth/github/login. The
    # login handler will validate it before stashing in session.
    target = "/auth/github/login"
    if return_to:
        from urllib.parse import quote

        target += f"?return_to={quote(return_to, safe='')}"
    return RedirectResponse(url=target, status_code=302)


# ---------------------------------------------------------------------------
# Onboarding: turn bio / URL into a seeded wiki
# ---------------------------------------------------------------------------


class ImportTextRequest(BaseModel):
    kind: str = Field(
        default="bio",
        description="bio | resume | about | freeform — labels the source for the LLM",
    )
    content: str = Field(..., min_length=20, max_length=200_000)
    label: str = Field(default="", description="optional human-readable name for the source")
    run_orchestrator: bool = Field(
        default=True,
        description="if true, kick off Puppetmaster to draft pages; if false, just save the raw file",
    )


class ImportURLRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2000)
    label: str = Field(default="", description="optional human-readable name for the source")
    run_orchestrator: bool = True


class ImportWikiRequest(BaseModel):
    """Bring-your-own-wiki: import a pre-existing markdown notes repo
    from GitHub.

    Two modes:

    * ``verbatim`` (default) — the source is already a portable-llm-wiki:
      a top-level ``wiki/`` directory containing markdown pages with
      frontmatter. We copy the files unchanged. Frontmatter (tiers,
      sections, sources, IDs) carries through.
    * ``standardize`` — the source is *any* markdown layout (Obsidian
      vault, Logseq, a ``notes/`` folder, root-level ``*.md`` files,
      a hand-rolled Karpathy-style wiki under a different directory
      name, …). We walk every ``*.md`` in the repo (depth- and
      size-capped), concatenate the content, and pass it to the same
      LLM drafter used for onboarding bio imports. The output is a
      Karpathy-schema wiki the user can immediately publish.

    The search index is rebuilt before the endpoint responds.
    """

    github_url: str = Field(..., min_length=4, max_length=300)
    branch: Optional[str] = Field(
        default=None,
        description="git branch to clone; defaults to the repo's default branch",
        max_length=120,
    )
    # If the tenant's wiki already contains pages, the import is rejected
    # with a 409 by default. The user has to opt in to merging via this
    # flag (or clean up the existing content first). Without this guard a
    # returning user who lands on /welcome a second time would silently
    # double-import their entire wiki with ``-imported`` suffixes — which
    # is the exact bug that prompted this rewrite.
    force_overwrite: bool = Field(
        default=False,
        description=(
            "When true, merge the imported pages into a non-empty tenant. "
            "Conflicting slugs still get a -imported suffix. When false "
            "(default), the endpoint 409s if the tenant already has any "
            "pages."
        ),
    )
    mode: str = Field(
        default="verbatim",
        description=(
            "Either 'verbatim' (default — repo must have a top-level "
            "wiki/ directory; copy files as-is) or 'standardize' "
            "(walk any markdown layout, run content through the LLM "
            "drafter to produce a Karpathy-schema wiki)."
        ),
        max_length=20,
    )


# Caps for the standardize-mode walk. The drafter has its own token
# budget; these are coarse pre-filters to avoid OOMing on an Obsidian
# vault with 10,000 notes.
_STANDARDIZE_MAX_FILES = 200
_STANDARDIZE_MAX_FILE_BYTES = 64 * 1024  # 64 KB per file
_STANDARDIZE_MAX_TOTAL_BYTES = 512 * 1024  # 512 KB total
_STANDARDIZE_MAX_DEPTH = 6  # skip very deeply nested files
# Common "non-content" subtrees in repos that happen to contain *.md
# (changelogs, generated docs, dependency manifests, …).
_STANDARDIZE_SKIP_DIRS = {
    ".git",
    ".github",
    "node_modules",
    "vendor",
    ".obsidian",
    ".trash",
    "dist",
    "build",
    "site-packages",
    "__pycache__",
    ".next",
    ".venv",
    "venv",
}


def _collect_markdown_for_standardize(clone_dir: Path) -> tuple[str, list[str]]:
    """Walk a cloned repo and return (concatenated_markdown, file_list).

    Selection rules:

    * ``*.md`` and ``*.markdown`` files only.
    * Skip directories in :data:`_STANDARDIZE_SKIP_DIRS`.
    * Skip files deeper than :data:`_STANDARDIZE_MAX_DEPTH` levels
      from the repo root.
    * Skip files larger than :data:`_STANDARDIZE_MAX_FILE_BYTES`.
    * Stop once either :data:`_STANDARDIZE_MAX_FILES` or
      :data:`_STANDARDIZE_MAX_TOTAL_BYTES` is exceeded.

    The concatenated output uses each file's repo-relative path as a
    header, which lets the drafter attribute outputs back to the
    user's original notes if it wants to. (Empty files are skipped
    silently — they'd just confuse the model.)
    """
    chunks: list[str] = []
    files_included: list[str] = []
    total_bytes = 0
    clone_root = clone_dir.resolve()
    for path in sorted(clone_dir.rglob("*")):
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        if suffix not in (".md", ".markdown"):
            continue
        try:
            relative = path.relative_to(clone_root)
        except ValueError:
            continue
        parts = relative.parts
        if any(p in _STANDARDIZE_SKIP_DIRS for p in parts[:-1]):
            continue
        if len(parts) > _STANDARDIZE_MAX_DEPTH:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size == 0 or size > _STANDARDIZE_MAX_FILE_BYTES:
            continue
        if len(files_included) >= _STANDARDIZE_MAX_FILES:
            break
        if total_bytes + size > _STANDARDIZE_MAX_TOTAL_BYTES:
            break
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not content.strip():
            continue
        rel_str = str(relative).replace("\\", "/")
        chunks.append(f"## From `{rel_str}`\n\n{content.rstrip()}\n")
        files_included.append(rel_str)
        total_bytes += size
    return ("\n---\n\n".join(chunks), files_included)


def _write_raw_import(tenant: tenants.Tenant, kind: str, label: str, body: str) -> str:
    """Write raw/imports/<timestamp>-<kind>.md inside the tenant root.

    Returns the rel_path (relative to ``tenant.wiki_root``) the orchestrator
    will be pointed at.
    """
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    slug = f"{today}-{kind}"
    raw_dir = tenant.wiki_root / "raw" / "imports"
    raw_dir.mkdir(parents=True, exist_ok=True)
    path = raw_dir / f"{slug}.md"
    header = f"# Profile import: {kind} ({today})\n\n"
    if label:
        header += f"Source: {label}\n\n"
    path.write_text(header + body, encoding="utf-8")
    rel = path.relative_to(tenant.wiki_root)
    return str(rel).replace("\\", "/")


async def _draft_from_raw_with_fallback(
    *,
    tenant: tenants.Tenant,
    raw_rel: str,
    kind: str,
    source_label: str,
    source_content: str,
    run_orchestrator: bool,
) -> dict:
    """Try Puppetmaster (self-host fast path) first, fall back to a
    direct-LLM JSON drafter (hosted / Render path) on unavailable.

    Returns the dict to merge into the onboarding response. Keeps the
    historical ``orchestrator_started`` / ``tracking_id`` fields when
    Puppetmaster fires so the existing /owner/jobs polling UI keeps
    working on self-hosters, AND adds ``pages_created`` /
    ``draft_warnings`` for the direct-LLM path so the welcome page
    can stop saying "Orchestrator was unavailable" when in fact we
    drafted N pages.
    """
    out: dict = {"raw_path": raw_rel}

    if run_orchestrator:
        try:
            from .orchestrator import start_import_job

            job = start_import_job(
                raw_rel, kind=kind, note=source_label or "onboarding paste"
            )
            out["orchestrator_started"] = True
            out["tracking_id"] = job.tracking_id
            # On a self-host with Puppetmaster, we're done — the
            # orchestrator runs async and the user polls /owner/jobs.
            return out
        except Exception as orch_exc:  # noqa: BLE001
            # Puppetmaster missing (Render doesn't ship it). Fall
            # through to the direct LLM drafter; we keep the original
            # error string only as a debug breadcrumb.
            out["orchestrator_started"] = False
            out["orchestrator_error"] = str(orch_exc)[:300]

    # Direct-LLM drafter path. This is the hosted default.
    try:
        from .direct_drafter import (
            DraftResult,
            NoLLMConfigured,
            draft_starter_pages,
        )

        draft: DraftResult = await draft_starter_pages(
            source_label=source_label or f"{kind} import",
            source_content=source_content,
            tenant=tenant,
        )
        out["pages_created"] = len(draft.pages)
        out["pages"] = [
            {"slug": p.slug, "title": p.title, "section": p.section}
            for p in draft.pages
        ]
        out["draft_backend"] = draft.backend
        out["draft_model"] = draft.model
        out["draft_warnings"] = draft.warnings
    except NoLLMConfigured as exc:
        # The server has no LLM key. Bubble a 503 so the welcome page
        # surfaces a real reason instead of saying "live" misleadingly.
        raise HTTPException(
            status_code=503,
            detail=(
                f"{exc} The raw input was saved at {raw_rel} — once a key "
                "is configured, re-run import from /owner."
            ),
        )
    except Exception as draft_exc:  # noqa: BLE001
        # LLM call failed (auth, rate-limit, network blip, parse error).
        # Don't 500 the onboarding flow — the raw is saved, surface the
        # error and let the welcome page communicate it.
        out["pages_created"] = 0
        out["draft_error"] = str(draft_exc)[:300]
    return out


@router.post("/onboarding/import-text")
async def onboarding_import_text(
    request: Request, req: ImportTextRequest = Body(...)
) -> dict:
    """Save the pasted text into raw/imports/ AND draft starter pages.

    Two execution paths:
      1. **Self-host with Puppetmaster installed**: kick off the
         Cursor-agent orchestrator (existing behavior). Returns a
         tracking id; the user polls /owner/jobs.
      2. **Hosted / Render (no Puppetmaster)**: fall through to a
         direct-LLM JSON drafter that produces pages synchronously
         using the same ANTHROPIC_API_KEY / OPENAI_API_KEY we already
         use for /wiki/chat. Returns ``pages_created`` in the
         response so the welcome page can show "N pages drafted"
         instead of the previous "Orchestrator was unavailable" dead
         end.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])

    kind = req.kind.strip().lower() or "bio"

    with tenants.set_current_tenant(tenant):
        rel = _write_raw_import(tenant, kind, req.label.strip(), req.content)
        draft_info = await _draft_from_raw_with_fallback(
            tenant=tenant,
            raw_rel=rel,
            kind=kind,
            source_label=req.label.strip() or kind,
            source_content=req.content,
            run_orchestrator=req.run_orchestrator,
        )
        return {
            "ok": True,
            "tenant_id": tenant.id,
            **draft_info,
        }


@router.post("/onboarding/import-url")
async def onboarding_import_url(
    request: Request, req: ImportURLRequest = Body(...)
) -> dict:
    """Scrape the URL, save the resulting markdown to raw/imports/, then
    run the same orchestrator-or-direct-drafter chain as the text
    import. See ``_draft_from_raw_with_fallback`` for the fall-through
    logic.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])

    scraped = await url_scrape.scrape(req.url)
    if not scraped.title and not scraped.content and scraped.errors:
        # Total scrape failure — nothing usable. Don't even attempt
        # the draft; tell the user we couldn't read the URL.
        return {
            "ok": False,
            "scraped": scraped.to_dict(),
            "tenant_id": tenant.id,
        }

    body = scraped.to_markdown()
    label = req.label or scraped.final_url or req.url
    with tenants.set_current_tenant(tenant):
        rel = _write_raw_import(tenant, kind="url", label=label, body=body)
        draft_info = await _draft_from_raw_with_fallback(
            tenant=tenant,
            raw_rel=rel,
            kind="url",
            source_label=label,
            # Feed the scraped markdown into the LLM drafter (not the
            # raw HTML) — same shape the orchestrator would have read.
            source_content=body,
            run_orchestrator=req.run_orchestrator,
        )
        return {
            "ok": True,
            "scraped": scraped.to_dict(),
            "tenant_id": tenant.id,
            **draft_info,
        }


# ---------------------------------------------------------------------------
# Onboarding: guided assembly — answer some questions + paste a few things
# ---------------------------------------------------------------------------
#
# The first-signup path. Instead of asking the user to pick ONE source and
# generate a starter wiki from it, /onboarding/assemble collects a small
# bundle:
#
#   * Interview answers — 4–6 lightweight questions the welcome wizard
#     poses ("who are you", "what are you working on", "what should LLMs
#     know about how you work", "links worth remembering"). All optional.
#   * Text sources — pasted resume, LinkedIn About, freeform notes,
#     copied GitHub profile READMEs. All optional.
#   * URL sources — personal site, blog, GitHub profile, portfolio.
#     Scraped server-side with the existing url_scrape helper. All
#     optional, and individual URL failures don't fail the whole bundle.
#
# Why one endpoint and not N calls to /onboarding/import-text or
# /onboarding/import-url: calling those repeatedly produces N independent
# starter-wiki drafts, each padded to 6–12 pages off a thin source —
# which yields duplicate "About <user>" pages, contradictory facts, and
# a graph that doesn't connect. Bundling means the drafter sees the
# whole picture in one prompt and picks 6–12 pages once.


class AssembleAnswer(BaseModel):
    """A single question/answer pair from the onboarding interview.

    The frontend posts the literal prompt text alongside the answer so the
    backend doesn't need to know the question catalog. That keeps the
    prompt list editable in the UI without a backend deploy.
    """

    question: str = Field(..., min_length=1, max_length=300)
    answer: str = Field(..., min_length=1, max_length=20_000)


class AssembleTextSource(BaseModel):
    """A pasted text source: resume, LinkedIn About, GitHub README, notes."""

    # Free-form label used by the drafter to attribute the section.
    # Mirrors ImportTextRequest.kind so the same prompt families are
    # reachable via the assembly flow.
    kind: str = Field(
        default="freeform",
        max_length=40,
        description=(
            "bio | resume | linkedin | about | github-readme | notes | "
            "freeform — labels the source for the LLM"
        ),
    )
    label: str = Field(default="", max_length=200)
    content: str = Field(..., min_length=1, max_length=200_000)


class AssembleUrlSource(BaseModel):
    """A URL we'll scrape into markdown server-side."""

    url: str = Field(..., min_length=8, max_length=2000)
    label: str = Field(default="", max_length=200)


class AssembleRequest(BaseModel):
    """Full onboarding assembly payload — everything we collected from the
    guided wizard.

    Every list is optional; we require at least one meaningful entry
    somewhere before drafting.
    """

    answers: list[AssembleAnswer] = Field(default_factory=list)
    text_sources: list[AssembleTextSource] = Field(default_factory=list)
    urls: list[AssembleUrlSource] = Field(default_factory=list)
    # Same toggle the existing text/URL onboarding endpoints expose. Self-
    # hosters with Puppetmaster get the agentic path; the hosted product
    # falls through to the direct-LLM drafter inside the same helper.
    run_orchestrator: bool = True


@router.post("/onboarding/assemble")
async def onboarding_assemble(
    request: Request, req: AssembleRequest = Body(...)
) -> dict:
    """Assemble interview answers + pasted sources + scraped URLs into one
    starter wiki draft.

    Flow:

      1. Validate at least one non-empty input is present.
      2. Scrape any URLs in parallel-ish (await each in order — the
         existing scrape helper is async but we keep ordering stable so
         the markdown dossier is deterministic). Individual failures
         don't bail the whole bundle.
      3. Concatenate everything into a single labeled markdown body.
      4. Write the body to ``raw/imports/<timestamp>-starter-bundle.md``
         so the dossier lives on disk (and gets pushed to the user's
         GitHub repo by the persistence layer).
      5. Hand off to ``_draft_from_raw_with_fallback`` which tries the
         Puppetmaster orchestrator first and falls back to the direct
         LLM drafter — same path the existing /onboarding/import-text
         flow uses.

    The response is a superset of the existing import-text response, so
    the welcome page can reuse its current progress/done UI; new fields
    (``answers_count``, ``text_count``, ``urls[]``) are additive.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])

    answers = [a for a in req.answers if a.answer.strip()]
    text_sources = [s for s in req.text_sources if s.content.strip()]
    url_sources = [u for u in req.urls if u.url.strip()]

    if not answers and not text_sources and not url_sources:
        # Fail fast so the UI keeps the "add a source" prompt up instead
        # of bottoming out in the LLM with a blank corpus.
        raise HTTPException(
            status_code=422,
            detail=(
                "Add at least one answer, pasted source, or URL before "
                "assembling your starter wiki."
            ),
        )

    # ---- 1. Scrape URL sources (best-effort, partial failures OK) ----
    scraped_entries: list[dict] = []
    for url_src in url_sources:
        url = url_src.url.strip()
        scraped = await url_scrape.scrape(url)
        if not scraped.title and not scraped.content and scraped.errors:
            status = "failed"
        elif scraped.errors:
            status = "partial"
        else:
            status = "ok"
        scraped_entries.append(
            {
                "input": url_src,
                "scraped": scraped,
                "status": status,
            }
        )

    # ---- 2. Build the labeled markdown dossier ----
    parts: list[str] = []

    if answers:
        parts.append("# Onboarding questions")
        parts.append("")
        for a in answers:
            q = a.question.strip() or "Question"
            parts.append(f"## {q}")
            parts.append("")
            parts.append(a.answer.strip())
            parts.append("")

    for text_src in text_sources:
        label = text_src.label.strip() or text_src.kind or "Pasted source"
        kind = (text_src.kind or "freeform").strip() or "freeform"
        parts.append(f"# {label} ({kind})")
        parts.append("")
        parts.append(text_src.content.strip())
        parts.append("")

    usable_url_count = 0
    for entry in scraped_entries:
        if entry["status"] == "failed":
            # Note the attempt in the dossier so the LLM doesn't try to
            # synthesize content for a URL that we couldn't read, but
            # don't pipe an empty body through.
            continue
        scraped = entry["scraped"]
        input_label = entry["input"].label.strip()
        src_label = input_label or scraped.title or scraped.url
        parts.append(f"# {src_label} (url)")
        parts.append("")
        parts.append(scraped.to_markdown())
        parts.append("")
        usable_url_count += 1

    combined = "\n".join(parts).strip()

    if not combined:
        # Edge case: only failed URL scrapes, nothing else. Surface a
        # clean 422 so the UI can prompt the user to add a paste.
        raise HTTPException(
            status_code=422,
            detail=(
                "We couldn't read any of the URLs you provided and there "
                "was no other content to assemble. Add a paste or answer "
                "and try again."
            ),
        )

    # ---- 3. Persist the dossier + 4. draft pages ----
    with tenants.set_current_tenant(tenant):
        raw_rel = _write_raw_import(
            tenant,
            kind="starter-bundle",
            label="onboarding assembly",
            body=combined,
        )
        draft_info = await _draft_from_raw_with_fallback(
            tenant=tenant,
            raw_rel=raw_rel,
            kind="starter-bundle",
            source_label="onboarding assembly",
            source_content=combined,
            run_orchestrator=req.run_orchestrator,
        )

    return {
        "ok": True,
        "tenant_id": tenant.id,
        "answers_count": len(answers),
        "text_count": len(text_sources),
        "urls": [
            {
                "url": entry["input"].url,
                "label": entry["input"].label,
                "status": entry["status"],
                "scraped": entry["scraped"].to_dict(),
            }
            for entry in scraped_entries
        ],
        "usable_url_count": usable_url_count,
        **draft_info,
    }


# ---------------------------------------------------------------------------
# Repo discovery — list the signed-in user's GitHub repos for the picker
# ---------------------------------------------------------------------------


@router.get("/onboarding/my-repos")
async def onboarding_my_repos(request: Request) -> dict:
    """Return the signed-in user's GitHub repos (owner-affiliation only).

    The "Import existing wiki" tab in /welcome uses this to populate a
    dropdown so the user doesn't have to remember + paste their repo
    URL. The dropdown shows private repos too (most personal wikis are
    private), assuming the stored OAuth token has the ``repo`` scope.

    If the token was minted under an older, narrower scope
    (``public_repo`` only — historical), we still return the public
    repos but flag ``needs_reauth=true`` so the frontend can surface a
    "Re-authorize to see private repos" prompt that bounces the user
    back through the OAuth dance with the bumped scope.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])

    token = (tenant.gh_token or "").strip()
    if not token:
        # We dropped the token at some point (rotated, manual edit,
        # whatever). User has to re-authorize to recover.
        return {
            "ok": False,
            "needs_reauth": True,
            "reason": "no_token",
            "repos": [],
            "scopes": [],
            "has_repo_scope": False,
        }

    try:
        listing = await github_api.list_user_repos(token)
    except github_api.GitHubAPIError as exc:
        if exc.status_code in (401, 403):
            # Token revoked, expired, or scope-rejected — same UX as
            # never having one: prompt re-auth.
            return {
                "ok": False,
                "needs_reauth": True,
                "reason": "token_rejected",
                "repos": [],
                "scopes": [],
                "has_repo_scope": False,
            }
        raise HTTPException(
            status_code=502,
            detail=f"GitHub API error listing repos: {exc.message[:200]}",
        )

    return {
        "ok": True,
        "needs_reauth": not listing.has_repo_scope,
        "reason": "" if listing.has_repo_scope else "needs_repo_scope",
        "repos": [r.to_dict() for r in listing.repos],
        "scopes": listing.scopes,
        "has_repo_scope": listing.has_repo_scope,
    }


# ---------------------------------------------------------------------------
# GitHub sync — per-tenant push-back to user's own repo
# ---------------------------------------------------------------------------
#
# The hosted product's whole promise is "you own your data". That's only
# true if writes flow back to a repo the user controls. These endpoints
# wire up that round-trip:
#
#   POST /onboarding/connect-repo  pick or create the target repo, do
#                                  initial bootstrap (clone or seed-push).
#   GET  /owner/sync/status        owner-console panel data: connected
#                                  repo, last sync, pending writes.
#   POST /owner/sync/now           force a debounce flush (the "Sync now"
#                                  button); useful when the user wants to
#                                  see their last edit show up in GitHub
#                                  immediately.
#
# The actual push logic lives in persistence.py (flush_tenant_*). The
# tenant's OAuth token is used as basic auth in the remote URL — see
# ``persistence._tenant_remote_url``.


class ConnectRepoRequest(BaseModel):
    """Request body for POST /onboarding/connect-repo.

    Two paths:
      * ``create_new=True`` + ``name`` → POST /user/repos to mint a fresh
        repo on the user's account (idempotent — already-exists is reused).
      * ``create_new=False`` + ``repo`` ("<owner>/<name>") → attach to an
        existing repo the user already has read+write access to.

    In both cases we run ``persistence.bootstrap_tenant`` afterwards which
    either clones the remote into wiki_root (if it has content) or
    initializes wiki_root as a fresh git repo + seed-pushes the current
    wiki content. Either way the tenant ends up connected and syncing.
    """

    create_new: bool = False
    # When create_new=True: the name to give the new repo. Defaults to
    # ``my-portable-llm-wiki`` — DELIBERATELY distinct from the product
    # source repo name so the GitHub "POST /user/repos is idempotent"
    # quirk can't silently bind the user's wiki to a product fork. See
    # the ``_CONVENTIONAL_WIKI_REPO_NAME`` comment for the full story.
    # User can rename later in GitHub.
    name: str = "my-portable-llm-wiki"
    # When create_new=True: whether the new repo should be private. Most
    # personal wikis are private so we default to that.
    private: bool = True
    # When create_new=False: the repo to attach to, as "<owner>/<name>".
    repo: str = ""


@router.post("/onboarding/connect-repo")
async def onboarding_connect_repo(
    request: Request,
    req: ConnectRepoRequest = Body(...),
) -> dict:
    """Connect this tenant's wiki to a GitHub repo (create or attach).

    On success the tenant is fully connected: future writes auto-push to
    GitHub via the per-tenant persistence layer, and a cold-start reload
    will clone the repo back into place. This is THE step that makes the
    "portable DB of you" promise real — without it the hosted wiki is just
    ephemeral storage on our box.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])

    token = (tenant.gh_token or "").strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail="No GitHub token on file. Sign in again to reconnect.",
        )

    # Resolve which repo we're attaching to.
    if req.create_new:
        name = (req.name or _CONVENTIONAL_WIKI_REPO_NAME).strip()
        if not re.match(r"^[A-Za-z0-9_.\-]+$", name):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Repo name must be alphanumeric + - _ . characters. "
                    f"Got: {name!r}"
                ),
            )
        try:
            repo_data = await github_api.create_repo(
                token,
                name=name,
                private=req.private,
                auto_init=True,
            )
        except github_api.GitHubAPIError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"GitHub repo create failed: {exc.message[:200]}",
            )
        full_name = repo_data.get("full_name") or f"{tenant.gh_login}/{name}"
        default_branch = repo_data.get("default_branch") or "main"
    else:
        full_name = (req.repo or "").strip()
        if "/" not in full_name:
            raise HTTPException(
                status_code=400,
                detail="repo must be in '<owner>/<name>' form when create_new=False",
            )
        # Verify the user actually has access (and grab the default branch).
        try:
            repo_data = await github_api.get_repo(token, full_name)
        except github_api.GitHubAPIError as exc:
            if exc.status_code in (401, 403, 404):
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"Repo {full_name!r} not found or not accessible with "
                        "your current GitHub token."
                    ),
                )
            raise HTTPException(
                status_code=502,
                detail=f"GitHub API error: {exc.message[:200]}",
            )
        default_branch = repo_data.get("default_branch") or "main"

    # Product-source-repo guard. Fires for BOTH paths:
    #
    # * create_new=True: the user supplied a name like "portable-llm-wiki"
    #   that already exists as their fork of the product source —
    #   create_repo() is idempotent and silently returns the existing repo
    #   (see github_api.create_repo line 403-404). We need to catch that
    #   case here before we bind.
    # * create_new=False: the user picked the product source from the
    #   existing-repos dropdown.
    #
    # Either way: refuse with a 400 explaining why. Done BEFORE the
    # gh_repo write so a rejected repo leaves the tenant in a clean
    # disconnected state — no need for a separate rollback branch.
    await _check_not_product_source(token, full_name, default_branch)

    # Commit the choice to the tenant record BEFORE bootstrapping so a
    # mid-bootstrap crash still leaves us connected.
    tenant.gh_repo = full_name
    tenant.gh_default_branch = default_branch
    tenant.git_last_error = ""
    tenants.manager().upsert(tenant)

    # Now bootstrap: clone (if remote has content) or seed-push (if empty).
    boot = persistence.bootstrap_tenant(tenant)
    if not boot.get("ok"):
        # Surface but don't roll back — the user can retry from the owner
        # console. Tenant fields remain set so the retry knows where to push.
        tenant.git_last_error = boot.get("error", "bootstrap failed")
        tenants.manager().upsert(tenant)
        return {
            "ok": False,
            "connected": True,
            "repo": full_name,
            "branch": default_branch,
            "bootstrap": boot,
            "message": (
                "Connected but initial sync failed. Open the owner console "
                "and click 'Sync now' to retry."
            ),
        }

    # If there was preexisting local content, the bootstrap already pushed
    # it as the seed commit. Just confirm and return status.
    return {
        "ok": True,
        "connected": True,
        "repo": full_name,
        "branch": default_branch,
        "html_url": f"https://github.com/{full_name}",
        "bootstrap": boot,
        "status": persistence.get_tenant_status(tenant),
    }


@router.get("/owner/sync/status")
def owner_sync_status(request: Request) -> dict:
    """Read-only snapshot of the tenant's sync state for the owner panel."""
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])
    return persistence.get_tenant_status(tenant)


@router.post("/owner/sync/now")
def owner_sync_now(request: Request) -> dict:
    """Force a synchronous flush of pending writes to GitHub.

    Used by the 'Sync now' button in the owner console — useful for users
    who want to see their last edit show up in their repo immediately
    instead of waiting for the debounce window.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])
    if not tenant.gh_repo:
        raise HTTPException(
            status_code=409,
            detail="Tenant has no connected GitHub repo. Connect one first.",
        )
    result = persistence.flush_tenant_now(tenant, message="manual sync")
    return {"ok": "error" not in result, "result": result, "status": persistence.get_tenant_status(tenant)}


@router.get("/owner/sync/preview-force-reset")
def owner_sync_preview_force_reset(request: Request) -> dict:
    """Inspect what a force-reset would discard, BEFORE the user clicks
    the destructive button.

    This is the read-side companion to ``POST /owner/sync/pull``
    ``{force: true}``. The frontend's type-to-confirm modal hits this
    endpoint to fill the "you are about to lose X local commits and Y
    modified files" preview block — so the user sees the actual cost
    before typing the confirmation string.

    Returns the dict shape documented on ``persistence.preview_force_reset``,
    wrapped with the standard ``{ok, preview, status}`` envelope used by
    the other sync endpoints.

    Read-only. Cheap (just ``git fetch`` + a handful of ``rev-list`` and
    ``status --porcelain`` calls). Safe to poll if the UI wants to keep
    the preview live as the user types.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])
    if not tenant.gh_repo:
        raise HTTPException(
            status_code=409,
            detail=(
                "Tenant has no connected GitHub repo. Connect one first "
                "from the welcome wizard or the owner console."
            ),
        )
    preview = persistence.preview_force_reset(tenant)
    return {
        "ok": bool(preview.get("ok")),
        "preview": preview,
        "status": persistence.get_tenant_status(tenant),
    }


@router.post("/owner/sync/pull")
def owner_sync_pull(request: Request, payload: Optional[dict] = None) -> dict:
    """Pull the tenant's wiki down from GitHub.

    Complements ``/owner/sync/now`` (which only pushes). Use case:
    the user edits their wiki directly on github.com (or from a local
    clone, or another device, or a webhook from elsewhere) and wants
    those edits reflected in their hosted copy.

    Body (optional): ``{ "force": true }`` discards local-uncommitted
    or diverged state and takes whatever GitHub has. The UI prompts
    for confirmation before sending ``force=true``.

    On success we reload the tenant's in-memory index so the new pages
    are reachable on the very next request — no container restart, no
    "click the refresh button N times" dance.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])
    if not tenant.gh_repo:
        raise HTTPException(
            status_code=409,
            detail=(
                "Tenant has no connected GitHub repo. Connect one first "
                "from the welcome wizard or the owner console."
            ),
        )

    force = bool((payload or {}).get("force", False))
    result = persistence.pull_tenant_now(tenant, force=force)

    # Reload the in-memory index when we actually moved local files.
    # ``up_to_date`` and ``ahead_only`` are no-ops on disk, so don't
    # waste the I/O on a reload there.
    if result.get("ok") and result.get("action") in {"pulled", "forced"}:
        try:
            tenant.reload_index()
        except Exception as exc:  # noqa: BLE001
            # Surface but don't fail the request — the pull itself
            # succeeded, the user just may need to manually reload.
            result["reload_warning"] = str(exc)[:200]

    return {
        "ok": bool(result.get("ok")),
        "result": result,
        "status": persistence.get_tenant_status(tenant),
    }


# ---------------------------------------------------------------------------
# Bring-your-own wiki (clone an existing portable-llm-wiki repo)
# ---------------------------------------------------------------------------

# Hard limits on what we'll accept from an arbitrary public repo. These
# are well above any realistic personal wiki and well below "this is a
# data-exfil attack on our disk." Tune if real users blow through them.
_WIKI_IMPORT_MAX_FILES = 500
_WIKI_IMPORT_MAX_BYTES_PER_FILE = 1_000_000  # 1 MB per markdown file
_WIKI_IMPORT_TOTAL_BYTES = 25_000_000  # 25 MB total
_WIKI_IMPORT_CLONE_TIMEOUT_S = 60


def _normalize_github_url(url: str) -> Optional[str]:
    """Accept many common ways a user might paste a GitHub repo URL and
    return a canonical HTTPS clone URL, or None if it doesn't look like a
    GitHub repo.

    Supported inputs (with or without trailing ``.git`` and/or ``/``):

      * ``https://github.com/<owner>/<repo>``
      * ``http://github.com/<owner>/<repo>``
      * ``github.com/<owner>/<repo>``
      * ``git@github.com:<owner>/<repo>``
      * ``<owner>/<repo>`` (bare ``professorpalmer/portable-llm-wiki``)

    Everything else returns None. We deliberately do NOT clone arbitrary
    git URLs — only github.com — so a hostile user can't point us at an
    internal/private git server we happen to be able to reach.
    """
    s = url.strip()
    if not s:
        return None
    s = re.sub(r"\.git/?$", "", s)
    s = s.rstrip("/")

    # ssh form
    m = re.match(r"^git@github\.com:([^/\s]+)/([^/\s]+)$", s)
    if m:
        return f"https://github.com/{m.group(1)}/{m.group(2)}.git"

    # http(s) form (with or without scheme, with or without www.)
    m = re.match(
        r"^(?:https?://)?(?:www\.)?github\.com/([^/\s]+)/([^/\s]+)$", s
    )
    if m:
        return f"https://github.com/{m.group(1)}/{m.group(2)}.git"

    # bare owner/repo form. Only ASCII identifiers — no dots/slashes.
    m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]{0,38})/([A-Za-z0-9._-]{1,100})$", s)
    if m:
        return f"https://github.com/{m.group(1)}/{m.group(2)}.git"

    return None


def _authenticated_clone_url(public_clone_url: str, token: str) -> str:
    """Splice a GitHub OAuth token into an HTTPS clone URL so ``git clone``
    can fetch private repos without prompting for credentials.

    GitHub accepts ``https://x-access-token:<token>@github.com/...`` as
    an authenticated HTTPS clone URL. The token is the OAuth access
    token we already stored on the tenant record (no PAT required from
    the user).

    Note: the URL contains a secret, so callers must NOT log it or
    surface it in error messages. ``_redact_clone_url`` below handles
    redaction for the error-summary path.
    """
    if not token:
        return public_clone_url
    if not public_clone_url.startswith("https://github.com/"):
        # Be defensive — only inject the token for our allowlisted host.
        return public_clone_url
    return public_clone_url.replace(
        "https://github.com/", f"https://x-access-token:{token}@github.com/", 1
    )


def _redact_clone_url(url: str) -> str:
    """Strip any embedded credentials from a clone URL so we can safely
    quote it back to the user in error messages."""
    return re.sub(r"https://[^@/]+@", "https://", url)


def _safe_branch(branch: Optional[str]) -> Optional[str]:
    """Reject obviously dangerous branch strings before passing to git.

    We accept conventional branch names (alnum, dot, dash, underscore,
    slash) up to 120 chars. Anything else (semicolons, backticks,
    spaces, leading dashes that could be parsed as flags) is rejected.
    """
    if branch is None:
        return None
    b = branch.strip()
    if not b:
        return None
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._/\-]{0,119}$", b):
        raise HTTPException(status_code=400, detail="invalid branch name")
    return b


def _copy_wiki_pages(src_dir: Path, dst_dir: Path) -> tuple[int, list[str], list[str]]:
    """Copy ``*.md`` files from ``src_dir`` (recursively) into ``dst_dir``
    preserving relative paths. Merge semantics: if a target already exists,
    we rename the incoming copy with a ``-imported`` suffix and record the
    conflict so the caller can show it to the user.

    Returns ``(imported_count, conflicts, skipped)`` where:
      * ``imported_count`` is the number of .md files actually written
      * ``conflicts`` is the list of relative paths that already existed
        and were therefore written with a ``-imported`` suffix
      * ``skipped`` lists files we refused (too large, or non-.md content
        slipping into a .md filename via symlink chicanery, etc.)

    Safety:
      * We resolve both ``src_dir`` and the target path and verify the
        target stays inside ``dst_dir`` (prevents ``../`` escape via
        repo-crafted filenames).
      * We refuse to follow symlinks — they could point at host files
        outside the clone (``/etc/passwd``, etc.). ``rglob`` follows
        symlinks by default so we check ``is_symlink`` explicitly.
      * Per-file and total byte limits guard against repos full of huge
        binary files renamed ``something.md``.
    """
    dst_dir.mkdir(parents=True, exist_ok=True)
    src_real = src_dir.resolve()
    dst_real = dst_dir.resolve()

    imported = 0
    conflicts: list[str] = []
    skipped: list[str] = []
    total_bytes = 0

    md_files = sorted(src_real.rglob("*.md"))
    if len(md_files) > _WIKI_IMPORT_MAX_FILES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"repo has {len(md_files)} markdown files in wiki/; the "
                f"limit is {_WIKI_IMPORT_MAX_FILES}. Split it up or open "
                "an issue if you have a legitimate use case."
            ),
        )

    for src_path in md_files:
        if src_path.is_symlink():
            skipped.append(str(src_path.relative_to(src_real)))
            continue
        try:
            rel = src_path.relative_to(src_real)
        except ValueError:
            # Shouldn't happen — rglob is rooted at src_real — but be safe.
            skipped.append(str(src_path))
            continue
        size = src_path.stat().st_size
        if size > _WIKI_IMPORT_MAX_BYTES_PER_FILE:
            skipped.append(str(rel))
            continue
        if total_bytes + size > _WIKI_IMPORT_TOTAL_BYTES:
            raise HTTPException(
                status_code=400,
                detail=(
                    "import exceeded total size limit of "
                    f"{_WIKI_IMPORT_TOTAL_BYTES} bytes"
                ),
            )

        target = (dst_real / rel).resolve()
        # Path-escape guard: target must live inside dst_dir.
        try:
            target.relative_to(dst_real)
        except ValueError:
            skipped.append(str(rel))
            continue

        if target.exists():
            new_name = target.stem + "-imported.md"
            target = target.with_name(new_name)
            conflicts.append(str(rel))

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(src_path.read_bytes())
        imported += 1
        total_bytes += size

    return imported, conflicts, skipped


@router.post("/onboarding/import-wiki")
async def onboarding_import_wiki(
    request: Request, req: ImportWikiRequest = Body(...)
) -> dict:
    """Clone a GitHub repo and import its markdown into the caller's tenant.

    Two modes (see :class:`ImportWikiRequest`):

    * ``verbatim``: repo must have a top-level ``wiki/`` directory of
      portable-llm-wiki markdown files. We copy them as-is. Frontmatter
      preserved. Conflicts are non-destructive (``-imported`` suffix).
    * ``standardize``: walks any markdown anywhere in the repo, concats
      it, and runs it through the same LLM drafter used for onboarding
      bio imports. The output is a Karpathy-schema wiki. Used by people
      bringing notes from Obsidian, Logseq, plain ``notes/`` folders,
      or hand-rolled wikis whose layout doesn't match ours.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])
    mode = (req.mode or "verbatim").strip().lower()
    if mode not in ("verbatim", "standardize"):
        raise HTTPException(
            status_code=400,
            detail="mode must be 'verbatim' or 'standardize'",
        )

    # Idempotency guard. A returning user who lands back on /welcome
    # (manually or because some other entry point doesn't yet know about
    # the smart-redirect logic) used to re-import their entire wiki and
    # end up with 21 ``-imported.md`` duplicates on top of 21 originals.
    # Require an explicit opt-in to merge into a non-empty tenant.
    if not req.force_overwrite:
        existing_pages = _count_tenant_pages(tenant)
        if existing_pages > 0:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "tenant_not_empty",
                    "message": (
                        f"Your wiki already has {existing_pages} pages. "
                        "Importing again would create duplicate "
                        "*-imported.md files. Open your existing wiki, "
                        "or pass force_overwrite=true to merge anyway."
                    ),
                    "page_count": existing_pages,
                    "tenant_id": tenant.id,
                },
            )

    public_clone_url = _normalize_github_url(req.github_url)
    if public_clone_url is None:
        raise HTTPException(
            status_code=400,
            detail=(
                "couldn't parse that as a GitHub repo. Try the full URL "
                "like https://github.com/<owner>/<repo>."
            ),
        )
    branch = _safe_branch(req.branch)

    # If the user has a stored OAuth token, splice it into the clone URL
    # so we can fetch private repos too (and we don't get rate-limited as
    # an anonymous client on public ones). The token is never written to
    # disk or echoed back in the response — _redact_clone_url() strips it
    # before any error-path string sees the user.
    token = (tenant.gh_token or "").strip()
    auth_clone_url = _authenticated_clone_url(public_clone_url, token)

    with tempfile.TemporaryDirectory(prefix="plw-import-") as tmpdir:
        clone_dir = Path(tmpdir) / "repo"
        cmd: list[str] = [
            "git",
            "clone",
            "--depth",
            "1",
            "--no-tags",
            "--single-branch",
        ]
        if branch:
            cmd += ["--branch", branch]
        cmd += [auth_clone_url, str(clone_dir)]
        try:
            subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                timeout=_WIKI_IMPORT_CLONE_TIMEOUT_S,
                # Pass an explicit env that disables credential prompts.
                # If our token is wrong, we want to fail fast with a
                # non-zero exit, not block on an interactive prompt that
                # nobody will ever answer in a server process.
                env={
                    "GIT_TERMINAL_PROMPT": "0",
                    "GIT_ASKPASS": "/bin/echo",
                    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                    "HOME": os.environ.get("HOME", str(Path(tmpdir))),
                },
            )
        except FileNotFoundError:
            # ``git`` not on PATH in the container. Our backend/Dockerfile
            # apt-installs it, so this should be unreachable in prod —
            # but a future image slimming pass could regress, and the
            # default subprocess error ("[Errno 2] No such file or
            # directory: 'git'") is opaque. Surface it as a 500 with a
            # message a human can act on.
            raise HTTPException(
                status_code=500,
                detail=(
                    "git is not installed on the server. This is a deploy "
                    "config issue — file an issue."
                ),
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=400,
                detail="git clone timed out (repo too large or network slow)",
            )
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or b"").decode("utf-8", errors="replace")
            # Redact the token before bubbling stderr back to the user.
            stderr_safe = _redact_clone_url(stderr)
            # Pick the most useful line — usually the last non-empty
            # one — and cap length so we don't dump pages of git output
            # into a JSON detail field.
            lines = [ln.strip() for ln in stderr_safe.splitlines() if ln.strip()]
            summary = lines[-1] if lines else "unknown error"
            # Translate a few common ones into something a human can act on.
            lower = summary.lower()
            if "could not read username" in lower or "authentication failed" in lower:
                summary = (
                    "GitHub rejected our credentials. If you signed in "
                    "before we asked for private-repo access, sign in "
                    "again to refresh your token."
                )
            elif "not found" in lower or "repository not found" in lower:
                summary = (
                    "repo not found. If it's private, make sure you've "
                    "re-authorized with private-repo access (sign in "
                    "again from the home page)."
                )
            raise HTTPException(
                status_code=400,
                detail=f"git clone failed: {summary[:300]}",
            )

        if mode == "verbatim":
            wiki_src = clone_dir / "wiki"
            if not wiki_src.is_dir():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "no 'wiki/' directory found at the top of that repo. "
                        "portable-llm-wiki repos keep markdown pages in wiki/. "
                        "If your notes use a different layout (Obsidian, Logseq, "
                        "root-level *.md, etc.), retry with mode='standardize'."
                    ),
                )

            # At least one .md file with frontmatter? (Sanity check — don't
            # blindly slurp a random repo that happens to have a wiki/ dir.)
            has_any = any(True for _ in wiki_src.rglob("*.md"))
            if not has_any:
                raise HTTPException(
                    status_code=400,
                    detail="repo's wiki/ directory contains no markdown files.",
                )

            with tenants.set_current_tenant(tenant):
                imported, conflicts, skipped = _copy_wiki_pages(
                    wiki_src, tenant.wiki_dir
                )
                tenant.reload_index()

            return {
                "ok": True,
                "mode": "verbatim",
                "imported_count": imported,
                "conflicts": conflicts,
                "skipped": skipped,
                "tenant_id": tenant.id,
                "source_url": _redact_clone_url(public_clone_url),
                "branch": branch,
            }

        # mode == "standardize"
        combined, files_seen = _collect_markdown_for_standardize(clone_dir)
        if not combined.strip():
            raise HTTPException(
                status_code=400,
                detail=(
                    "no usable markdown found in that repo. We walked the "
                    "tree for *.md / *.markdown files (skipping .git, "
                    "node_modules, etc.) and came up empty."
                ),
            )

        # Write the raw payload first, then draft from it. Mirrors the
        # /onboarding/import-text + /onboarding/import-url shape so the
        # drafter sees the same kind of input it sees on the bio flow.
        source_label = f"github-wiki-standardize: {_redact_clone_url(public_clone_url)}"
        raw_rel = _write_raw_import(
            tenant,
            kind="wiki-standardize",
            label=source_label,
            body=combined,
        )

        # Direct-LLM drafter path. Mirrors the onboarding-import branch
        # for pasted text — same error handling, same response shape.
        try:
            from .direct_drafter import (
                DraftResult,
                NoLLMConfigured,
                draft_starter_pages,
            )

            with tenants.set_current_tenant(tenant):
                draft: DraftResult = await draft_starter_pages(
                    source_label=source_label,
                    source_content=combined,
                    tenant=tenant,
                )
                tenant.reload_index()
            return {
                "ok": True,
                "mode": "standardize",
                "imported_count": len(draft.pages),
                "files_walked": files_seen,
                "pages_created": len(draft.pages),
                "pages": [
                    {"slug": p.slug, "title": p.title, "section": p.section}
                    for p in draft.pages
                ],
                "draft_backend": draft.backend,
                "draft_model": draft.model,
                "draft_warnings": draft.warnings,
                "raw_path": raw_rel,
                "tenant_id": tenant.id,
                "source_url": _redact_clone_url(public_clone_url),
                "branch": branch,
            }
        except NoLLMConfigured as exc:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"{exc} The walked markdown was saved at {raw_rel} — "
                    "once an LLM key is configured, the wiki can be drafted."
                ),
            )
        except Exception as draft_exc:  # noqa: BLE001
            # Don't 500 — the raw payload was saved. Surface the error so
            # the welcome page can show a real reason.
            return {
                "ok": False,
                "mode": "standardize",
                "imported_count": 0,
                "files_walked": files_seen,
                "draft_error": str(draft_exc)[:300],
                "raw_path": raw_rel,
                "tenant_id": tenant.id,
                "source_url": _redact_clone_url(public_clone_url),
                "branch": branch,
            }


@router.post("/onboarding/cleanup-imports")
def onboarding_cleanup_imports(request: Request) -> dict:
    """Delete every ``*-imported*.md`` file from the caller's tenant
    wiki. Self-heal for the duplicate-re-import case.

    Idempotent — running it twice when there are no duplicates is a
    no-op. Path-bounded — only deletes files under the tenant's own
    ``wiki/`` directory (resolved real-path), so a misbehaving caller
    can't escape into another tenant's content via symlink tricks.

    Returns the list of paths deleted so the frontend can show the user
    exactly what was cleaned up.
    """
    _require_hosted_mode()
    user = _require_session_user(request)
    tenant = tenants.manager().require(user["tenant_id"])

    wiki_dir = tenant.wiki_dir
    if not wiki_dir.exists():
        return {"ok": True, "deleted": [], "deleted_count": 0, "tenant_id": tenant.id}

    # Real-path the tenant root so any symlink within can't trick us
    # into deleting a file outside the tenant's content directory.
    try:
        tenant_real = wiki_dir.resolve(strict=True)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(500, detail=f"could not resolve tenant wiki dir: {exc}")

    deleted: list[str] = []
    for path in sorted(wiki_dir.rglob("*-imported*.md")):
        try:
            real = path.resolve(strict=True)
        except (FileNotFoundError, OSError):
            continue
        # Path-escape guard. Even though rglob descends only under
        # wiki_dir, a symlink could in theory point at a file in a
        # sibling tenant. Refuse to delete anything outside our own
        # real-path tenant root.
        try:
            real.relative_to(tenant_real)
        except ValueError:
            continue
        try:
            real.unlink()
            deleted.append(str(path.relative_to(wiki_dir)).replace("\\", "/"))
        except OSError:
            # If a file is gone-mid-iteration or read-only, skip it
            # rather than 500ing the whole cleanup.
            continue

    if deleted:
        # Refresh the in-memory page index so the deleted files don't
        # linger as zombie entries in /browse and /graph.
        try:
            with tenants.set_current_tenant(tenant):
                tenant.reload_index()
        except Exception as exc:  # noqa: BLE001
            # Index reload failure is annoying but not fatal — the
            # files ARE gone, and the next manual /owner reload will
            # catch up. Surface it as a warning, not an error.
            return {
                "ok": True,
                "deleted": deleted,
                "deleted_count": len(deleted),
                "tenant_id": tenant.id,
                "warning": f"page index reload failed: {exc}",
            }

    return {
        "ok": True,
        "deleted": deleted,
        "deleted_count": len(deleted),
        "tenant_id": tenant.id,
    }


# ---------------------------------------------------------------------------
# Public tenant discovery
# ---------------------------------------------------------------------------


@router.get("/tenants")
def list_tenants() -> dict:
    """Public list of tenants whose ``visibility`` is ``public`` or ``unlisted``.

    Used by the landing page to show ``portablellm.wiki/<user>`` examples and
    by the demo experience to discover Avery.
    """
    if settings.single_tenant_mode:
        return {"tenants": []}
    out = []
    for t in tenants.manager().all_tenants():
        if t.visibility not in ("public", "unlisted"):
            continue
        out.append(
            {
                "id": t.id,
                "display_name": t.display_name,
                "is_demo": t.is_demo,
                "gh_login": t.gh_login,
                "visibility": t.visibility,
            }
        )
    return {"tenants": out}


@router.get("/tenants/{tenant_id}")
def get_tenant_public(tenant_id: str) -> dict:
    """Read-only public metadata for one tenant. Used by ``/<tenant>`` pages
    so the frontend can render the wiki without elevated privileges."""
    if settings.single_tenant_mode:
        raise HTTPException(404, detail="tenant routes disabled in single-tenant mode")
    t = tenants.manager().get(tenant_id)
    if t is None:
        raise HTTPException(404, detail=f"tenant {tenant_id!r} not found")
    if t.visibility == "private":
        raise HTTPException(404, detail="tenant is private")
    return {
        "id": t.id,
        "display_name": t.display_name,
        "is_demo": t.is_demo,
        "gh_login": t.gh_login,
        "created_at": t.created_at,
        "visibility": t.visibility,
    }
