"""Smoke test for multi-tenant mode.

The bulk of the existing test suite runs in single-tenant mode (the default
behavior that OSS deploys rely on). These tests spin the app up in
multi-tenant mode and verify:

* ``/auth/me`` returns ``authenticated: false`` when no session is set.
* Tenant prefix middleware routes ``/t/<tenant>/wiki/manifest.json`` to
  the right tenant's index.
* Hosted routes 404 when ``SINGLE_TENANT_MODE=1`` is in effect (the OSS
  self-host case).

We don't test the actual GitHub OAuth roundtrip because that requires a
live network call to github.com; that path is exercised in production
and via manual smoke after deploy.
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
from pathlib import Path

import pytest


@pytest.fixture()
def multi_tenant_app(tmp_path, monkeypatch):
    """Spin up a fresh app instance in multi-tenant mode, with a temp
    tenants_root containing two seeded tenants (alice + bob).

    Restoring single-tenant mode in teardown is tricky: the conftest's
    session-wide SESSION_TMP env var must be restored *and* the module
    state must be reloaded with single-tenant config so subsequent tests
    (which use the shared ``client`` fixture from conftest.py) get a
    correctly-configured app. We capture WIKI_ROOT *before* applying any
    overrides and restore from that snapshot.
    """
    pre_wiki_root = os.environ.get("WIKI_ROOT", "")

    # Seed two tenants on disk. Pages are explicitly public so the
    # anonymous viewer in the test client can see them, with explicit titles.
    tenants_root = tmp_path / "tenants"
    for tid, body, is_demo in (
        (
            "alice",
            "---\ntitle: Alice Index\ntier: public\n---\n# Alice\n\nAlice loves portable wikis.\n",
            False,
        ),
        (
            "bob",
            "---\ntitle: Bob Index\ntier: public\n---\n# Bob\n\nBob runs a homelab.\n",
            False,
        ),
        (
            "avery",
            "---\ntitle: Avery Index\ntier: public\n---\n# Avery\n\nPublic demo wiki.\n",
            True,
        ),
    ):
        wiki = tenants_root / tid / "wiki"
        wiki.mkdir(parents=True, exist_ok=True)
        (wiki / "index.md").write_text(body, encoding="utf-8")
        (tenants_root / tid / "raw").mkdir(parents=True, exist_ok=True)
        meta = tenants_root / tid / "tenant.json"
        meta.write_text(
            json.dumps(
                {
                    "id": tid,
                    "display_name": tid.title(),
                    "gh_login": tid,
                    "gh_user_id": 0,
                    "gh_token": "",
                    "gh_repo": "",
                    "gh_default_branch": "main",
                    "created_at": "2026-05-24T00:00:00Z",
                    "updated_at": "2026-05-24T00:00:00Z",
                    "is_demo": is_demo,
                    "visibility": "public",
                }
            ),
            encoding="utf-8",
        )

    # WIKI_ROOT still has to exist (the global default tenant uses it).
    default_root = tmp_path / "default_wiki"
    (default_root / "wiki").mkdir(parents=True, exist_ok=True)
    (default_root / "raw").mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("WIKI_ROOT", str(default_root))
    monkeypatch.setenv("TENANTS_ROOT", str(tenants_root))
    monkeypatch.setenv("SINGLE_TENANT_MODE", "0")
    monkeypatch.setenv("SESSION_SECRET", "test-secret-do-not-use-in-prod")
    monkeypatch.setenv("OWNER_TOKEN", "")
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "0")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setenv(
        "GITHUB_OAUTH_REDIRECT_URL",
        "http://localhost:8000/auth/github/callback",
    )
    # Pin PUBLIC_BASE_URL to a deterministic value. Without this the
    # fixture inherits whatever the developer has in their shell
    # (e.g. a cloudflared tunnel URL), and tests that assert against
    # public-facing URLs in handshake/llms.txt output become flaky.
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://localhost:3000")

    # Reload all the modules that read settings at import-time. ``main``
    # builds the FastAPI app + middleware stack at import time so it has
    # to be reloaded *after* config + tenants.
    import app.config as _config
    import app.tenants as _tenants
    import app.wiki as _wiki
    import app.auth as _auth
    import app.hosted_routes as _hosted
    import app.main as _main

    importlib.reload(_config)
    importlib.reload(_tenants)
    importlib.reload(_wiki)
    # auth caches the ``settings`` reference at import time + reads the
    # tenants ``current_tenant_var`` for session-cookie ownership. Reload
    # it AFTER config + tenants so it picks up the fresh references.
    importlib.reload(_auth)
    importlib.reload(_hosted)
    importlib.reload(_main)

    from fastapi.testclient import TestClient

    client = TestClient(_main.app)
    try:
        yield client
    finally:
        client.close()
        # Re-reload modules in single-tenant mode so subsequent tests in
        # this session (which expect the global conftest's env) see a
        # clean state. monkeypatch teardown runs AFTER this finally
        # block, so we have to pop the env vars manually before
        # reloading or we'd just rebuild the multi-tenant app again.
        for k in (
            "SINGLE_TENANT_MODE",
            "TENANTS_ROOT",
            "SESSION_SECRET",
            "GITHUB_OAUTH_CLIENT_ID",
            "GITHUB_OAUTH_CLIENT_SECRET",
            "GITHUB_OAUTH_REDIRECT_URL",
        ):
            os.environ.pop(k, None)
        # Restore the pre-test WIKI_ROOT. Critically, we do NOT do
        # ``from tests.conftest import SESSION_TMP`` here — pytest loads
        # conftest as a plugin, so re-importing the module path would
        # create a fresh tempdir and lose the seeded wiki.
        if pre_wiki_root:
            os.environ["WIKI_ROOT"] = pre_wiki_root
        # monkeypatch.setenv("OWNER_TOKEN", "") above wiped the session-
        # wide OWNER_TOKEN. monkeypatch.undo() runs AFTER this fixture's
        # finally (pytest teardown order), so we'd reload config + auth
        # below with an empty OWNER_TOKEN and break every subsequent test
        # in the session that depends on owner-bearer auth. Restore
        # explicitly from the conftest constant so the reload picks up
        # the correct token immediately.
        try:
            from tests.conftest import OWNER_TOKEN as _CONFTEST_OWNER_TOKEN

            os.environ["OWNER_TOKEN"] = _CONFTEST_OWNER_TOKEN
        except Exception:  # noqa: BLE001
            pass
        importlib.reload(_config)
        importlib.reload(_tenants)
        importlib.reload(_wiki)
        importlib.reload(_auth)
        importlib.reload(_hosted)
        importlib.reload(_main)


def test_auth_me_returns_unauthenticated_without_session(multi_tenant_app):
    r = multi_tenant_app.get("/auth/me")
    assert r.status_code == 200
    assert r.json() == {"authenticated": False}


def test_tenant_prefix_routes_to_correct_wiki(multi_tenant_app):
    r = multi_tenant_app.get("/t/alice/wiki/manifest.json")
    assert r.status_code == 200, r.text
    payload = r.json()
    titles = [p["title"] for p in payload["pages"]]
    assert any("alice" in t.lower() for t in titles)

    r = multi_tenant_app.get("/t/bob/wiki/manifest.json")
    assert r.status_code == 200, r.text
    payload = r.json()
    titles = [p["title"] for p in payload["pages"]]
    assert any("bob" in t.lower() for t in titles)


def test_unknown_tenant_returns_404(multi_tenant_app):
    r = multi_tenant_app.get("/t/nobody/wiki/manifest.json")
    assert r.status_code == 404


def test_unknown_tenant_404_carries_cors_headers(multi_tenant_app):
    """Regression: TenantPrefixMiddleware sits outside CORSMiddleware, so
    when it short-circuits with a 404 the response used to lack CORS
    headers. The frontend's /share preview fetch would then throw a
    network error in the browser and surface a useless "couldn't load
    preview" message instead of the actual JSON detail. The middleware
    now attaches CORS headers manually for unknown-tenant 404s so the
    body actually reaches client JS.

    Origin is set to the test conftest's allowed frontend origin
    (http://localhost:3000); in prod the same logic echoes back the
    real frontend origin (e.g. https://www.portablellm.wiki) when it
    matches settings.cors_origins."""
    origin = "http://localhost:3000"
    r = multi_tenant_app.get(
        "/t/nobody/wiki/manifest.json",
        headers={"Origin": origin},
    )
    assert r.status_code == 404
    # Allowed origin must echo back (CORSMiddleware uses the same
    # echo-on-match convention; we match it for parity).
    assert r.headers.get("access-control-allow-origin") == origin
    assert r.headers.get("access-control-allow-credentials") == "true"
    # Vary: Origin so shared caches don't conflate responses across origins.
    assert "Origin" in (r.headers.get("vary") or "")
    # The actual error body must still be present.
    assert r.json()["detail"] == "tenant 'nobody' not found"


def test_unknown_tenant_404_no_origin_skips_cors(multi_tenant_app):
    """Sanity: when the request has no Origin header (e.g. a curl from a
    terminal), we don't fabricate one. Allow-origin is omitted entirely;
    we still set Vary: Origin so the response isn't cached cross-origin."""
    r = multi_tenant_app.get("/t/nobody/wiki/manifest.json")
    assert r.status_code == 404
    assert "access-control-allow-origin" not in r.headers
    assert "Origin" in (r.headers.get("vary") or "")


def test_llm_handshake_uses_tenant_scoped_base_url(multi_tenant_app):
    """Regression: in hosted multi-tenant mode the /llm handshake used
    to emit ``Base URL: <public_base>/api/backend`` — the SINGLE-TENANT
    apex path. Any LLM that followed up by calling
    ``GET /api/backend/wiki/manifest.json`` would land on the apex
    backend with no tenant context and get a 404 (or, worse, the wrong
    tenant's data on a misconfigured deploy).

    The handshake must instead emit ``Base URL: <public_base>/<tenant>``
    so follow-up calls hit ``/<tenant>/wiki/manifest.json`` (which the
    frontend rewrites to ``/t/<tenant>/wiki/manifest.json`` on the
    backend). Tested against both seeded tenants to confirm the value
    actually varies per-tenant, not just statically picked from env."""
    for tenant_id in ("alice", "bob"):
        r = multi_tenant_app.get(f"/t/{tenant_id}/llm")
        assert r.status_code == 200, r.text
        body = r.text
        # The base URL line is rendered as ``Base URL: `<url>``` in the
        # markdown. We check for the exact tenant-prefixed form.
        expected = f"Base URL: `http://localhost:3000/{tenant_id}`"
        assert expected in body, (
            f"Expected handshake to advertise tenant-scoped base URL "
            f"for {tenant_id!r}, got body:\n{body[:800]}"
        )
        # And — critically — must NOT contain the apex single-tenant
        # /api/backend path, which would route to the wrong place.
        assert "/api/backend" not in body, (
            f"Tenant {tenant_id!r} handshake leaked apex /api/backend "
            f"path; LLM follow-up calls would hit the wrong host."
        )


def test_llms_txt_uses_tenant_scoped_links(multi_tenant_app):
    """Same bug class as the handshake test above: /llms.txt must point
    AT the per-tenant /llm handshake and the per-tenant .well-known
    manifest, otherwise an LLM that follows the llms.txt convention
    lands on the apex (which is 404 in hosted mode)."""
    r = multi_tenant_app.get("/t/alice/llms.txt")
    assert r.status_code == 200, r.text
    body = r.text
    assert "http://localhost:3000/alice/llm" in body
    assert "http://localhost:3000/alice/.well-known/llm-wiki.json" in body
    # Apex paths must not leak.
    assert "/api/backend" not in body


def test_unknown_tenant_404_disallowed_origin_skips_cors(multi_tenant_app):
    """Origins outside the allowlist (e.g. evil.example.com) get the
    error body but no allow-origin header. The browser will then refuse
    to expose the response to attacker JS — same as CORSMiddleware on
    its happy path. This keeps the helper from accidentally turning the
    /llm endpoint into a fully open API."""
    r = multi_tenant_app.get(
        "/t/nobody/wiki/manifest.json",
        headers={"Origin": "https://evil.example.com"},
    )
    assert r.status_code == 404
    assert "access-control-allow-origin" not in r.headers
    assert "Origin" in (r.headers.get("vary") or "")


def test_tenants_public_list_excludes_default(multi_tenant_app):
    r = multi_tenant_app.get("/tenants")
    assert r.status_code == 200
    payload = r.json()
    ids = {t["id"] for t in payload["tenants"]}
    assert "alice" in ids
    assert "bob" in ids
    assert "default" not in ids


def test_healthz_reports_tenant_volume(multi_tenant_app):
    r = multi_tenant_app.get("/healthz")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert data["disk_total_bytes"] > 0
    assert data["disk_free_bytes"] >= 0
    assert data["disk_used_bytes"] >= 0
    for leaked in (
        "wiki_root",
        "indexed_tenant_ids",
        "indexed_tenants",
        "tenant_count",
        "tenant_dir_count",
        "preexisting_dir_count",
    ):
        assert leaked not in data, leaked


def test_tenant_metadata_endpoint(multi_tenant_app):
    r = multi_tenant_app.get("/tenants/alice")
    assert r.status_code == 200
    payload = r.json()
    assert payload["id"] == "alice"
    assert payload["display_name"] == "Alice"
    assert payload["is_demo"] is False


def test_oauth_login_redirects_to_github(multi_tenant_app):
    r = multi_tenant_app.get(
        "/auth/github/login?return_to=/welcome",
        follow_redirects=False,
    )
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://github.com/login/oauth/authorize")
    assert "client_id=test-client-id" in loc
    # Scope was bumped from public_repo → repo so the onboarding
    # "Import existing wiki" flow can list + clone private repos.
    assert "scope=read%3Auser%2Crepo" in loc or "scope=read:user,repo" in loc


def test_onboarding_requires_session(multi_tenant_app):
    r = multi_tenant_app.post(
        "/onboarding/import-text",
        json={"kind": "bio", "content": "x" * 30},
    )
    assert r.status_code == 401


def test_import_wiki_requires_session(multi_tenant_app):
    r = multi_tenant_app.post(
        "/onboarding/import-wiki",
        json={"github_url": "https://github.com/test/repo"},
    )
    assert r.status_code == 401


def test_import_wiki_rejects_non_github_urls(multi_tenant_app):
    # Even without a session, malformed-URL validation runs first. We
    # actually want the session check to land first (so it 401s), but
    # explicitly testing the URL parser is more useful — call the helper
    # directly.
    import app.hosted_routes as hr

    assert hr._normalize_github_url("https://gitlab.com/foo/bar") is None
    assert hr._normalize_github_url("git://internal.example.com/foo") is None
    assert hr._normalize_github_url("not a url at all") is None
    assert hr._normalize_github_url("") is None
    assert hr._normalize_github_url("..") is None


def test_import_wiki_accepts_various_github_shapes():
    """Users paste GitHub repo URLs in many shapes — make sure we parse
    them all into a canonical clone URL."""
    import app.hosted_routes as hr

    expected = "https://github.com/professorpalmer/portable-llm-wiki.git"
    assert (
        hr._normalize_github_url(
            "https://github.com/professorpalmer/portable-llm-wiki"
        )
        == expected
    )
    assert (
        hr._normalize_github_url(
            "https://github.com/professorpalmer/portable-llm-wiki.git"
        )
        == expected
    )
    assert (
        hr._normalize_github_url(
            "https://github.com/professorpalmer/portable-llm-wiki/"
        )
        == expected
    )
    assert (
        hr._normalize_github_url(
            "github.com/professorpalmer/portable-llm-wiki"
        )
        == expected
    )
    assert (
        hr._normalize_github_url(
            "git@github.com:professorpalmer/portable-llm-wiki.git"
        )
        == expected
    )
    assert (
        hr._normalize_github_url("professorpalmer/portable-llm-wiki")
        == expected
    )


def test_import_wiki_rejects_dangerous_branch_names():
    """Branch names get passed to git as CLI args; refuse anything that
    isn't a conservative branch identifier so we can't be tricked into
    parsing it as a git flag or a shell injection."""
    import app.hosted_routes as hr
    from fastapi import HTTPException

    # Acceptable
    assert hr._safe_branch("main") == "main"
    assert hr._safe_branch("feature/multi-tenant") == "feature/multi-tenant"
    assert hr._safe_branch("v1.0") == "v1.0"
    assert hr._safe_branch(None) is None
    assert hr._safe_branch("   ") is None

    # Each of these should raise. (Pure-whitespace inputs are normalized
    # to "no branch" and return None, so they're not in this list.)
    for bad in ("--upload-pack=foo", "; rm -rf /", "$(whoami)", "a b"):
        try:
            hr._safe_branch(bad)
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError(f"branch {bad!r} should have raised")


def test_copy_wiki_pages_merges_with_suffix_on_conflict(tmp_path):
    """Existing target files don't get overwritten — they get an
    ``-imported`` sibling and the conflict is reported."""
    import app.hosted_routes as hr

    src = tmp_path / "src" / "wiki"
    dst = tmp_path / "dst" / "wiki"
    src.mkdir(parents=True)
    dst.mkdir(parents=True)

    (src / "intro.md").write_text("---\ntitle: Intro\n---\nhello\n")
    (src / "decisions" / "join-strand.md").parent.mkdir(parents=True)
    (src / "decisions" / "join-strand.md").write_text(
        "---\ntitle: Join Strand\n---\ndecision\n"
    )
    # Pre-existing conflict on the target side
    (dst / "intro.md").write_text("# already here\n")

    imported, conflicts, skipped = hr._copy_wiki_pages(src, dst)

    assert imported == 2
    assert "intro.md" in conflicts
    assert skipped == []
    # Original target intact, new copy lives alongside.
    assert (dst / "intro.md").read_text() == "# already here\n"
    assert (dst / "intro-imported.md").exists()
    assert (dst / "decisions" / "join-strand.md").exists()


def _set_session_user(client, tenant_id: str, login: str = "alice") -> None:
    """Stuff a fake user dict into the session cookie of a TestClient.

    Starlette's ``itsdangerous``-backed SessionMiddleware accepts a
    signed cookie; the SecretsManager dances aren't worth re-implementing
    in tests, so we reach inside the TestClient session jar and mint a
    cookie the same way SessionMiddleware would.
    """
    import json
    import base64
    import itsdangerous

    payload = {
        "user": {
            "tenant_id": tenant_id,
            "gh_login": login,
            "gh_user_id": 1,
        }
    }
    data = base64.b64encode(json.dumps(payload).encode("utf-8"))
    signer = itsdangerous.TimestampSigner("test-secret-do-not-use-in-prod")
    signed = signer.sign(data).decode("utf-8")
    # Cookie name comes from SESSION_COOKIE_NAME env (default ``plw_session``);
    # NOT Starlette's default ``session``.
    client.cookies.set("plw_session", signed)


def test_session_cookie_grants_owner_on_own_tenant(multi_tenant_app):
    """Hosted-mode owner ops MUST work when the signed-in user owns
    the tenant in the URL — no bearer token in the request.

    This is the core "you become the owner when you log in" guarantee
    that lets the /owner page drop the OWNER_TOKEN paste UX in hosted
    mode. If this regresses, the hosted owner console silently breaks.
    """
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/t/alice/owner/reload")
    assert r.status_code == 200, r.text


def test_session_cookie_does_not_grant_owner_on_other_tenant(multi_tenant_app):
    """A session cookie for tenant X must NOT unlock tenant Y's owner
    routes. Cross-tenant elevation would be a critical multi-tenant
    isolation bug; pin it explicitly.
    """
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/t/bob/owner/reload")
    assert r.status_code == 401, r.text


def test_owner_routes_still_require_some_auth(multi_tenant_app):
    """With no session and no bearer token, owner ops must 401."""
    r = multi_tenant_app.post("/t/alice/owner/reload")
    assert r.status_code == 401, r.text


def test_logout_get_does_not_clear_session(multi_tenant_app):
    """GET /auth/logout must not clear the session (logout CSRF).

    Nav must POST. GET returns 405 and leaves the cookie intact.
    """
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/auth/me")
    assert r.status_code == 200
    assert r.json().get("authenticated") is True

    r = multi_tenant_app.get(
        "/auth/logout?return_to=/welcome", follow_redirects=False
    )
    assert r.status_code == 405
    assert "POST" in r.json().get("detail", "")

    r = multi_tenant_app.get("/auth/me")
    assert r.json().get("authenticated") is True


def test_switch_account_get_does_not_clear_session(multi_tenant_app):
    """GET /auth/switch-account must not clear the session. Nav must POST."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/auth/switch-account", follow_redirects=False)
    assert r.status_code == 405
    assert "POST" in r.json().get("detail", "")
    r = multi_tenant_app.get("/auth/me")
    assert r.json().get("authenticated") is True


def test_switch_account_post_clears_session_then_kicks_oauth(multi_tenant_app):
    """POST /auth/switch-account clears the session and 302s into OAuth."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/auth/switch-account", follow_redirects=False)
    assert r.status_code == 302
    location = r.headers.get("Location", "")
    assert "/auth/github/login" in location, location

    r = multi_tenant_app.get(location, follow_redirects=False)
    assert r.status_code == 302
    assert "github.com/login/oauth/authorize" in r.headers.get("Location", "")


def test_direct_drafter_parses_well_formed_json():
    """Pin the JSON-parsing layer of the direct drafter — independent
    of any LLM call. Anything the LLM emits gets coerced through
    ``_parse_pages``, so this is the surface that decides whether the
    user lands on N pages or 0 pages.
    """
    import json

    from app.direct_drafter import _parse_pages

    raw = json.dumps(
        {
            "pages": [
                {
                    "slug": "jane-smith",
                    "title": "Jane Smith",
                    "section": "entities",
                    "tier": "private",
                    "tags": ["founder", "biology"],
                    "body": "## Background\n\nJane is the founder of [[Acme Bio]].",
                },
                {
                    "slug": "acme-bio",
                    "title": "Acme Bio",
                    "section": "entities",
                    "tier": "private",
                    "tags": ["company"],
                    "body": "## Overview\n\nAcme Bio is Jane's startup.",
                },
            ]
        }
    )
    warnings: list = []
    pages = _parse_pages(raw, warnings)
    assert len(pages) == 2
    assert pages[0].slug == "jane-smith"
    assert pages[0].section == "entities"
    assert pages[0].page_type == "entity"
    assert pages[1].title == "Acme Bio"
    assert not warnings


def test_direct_drafter_handles_fenced_json():
    """LLMs sometimes wrap JSON in ```json fences. Parser must
    unwrap."""
    from app.direct_drafter import _parse_pages

    raw = """Here's the JSON:
```json
{"pages": [{"slug": "x", "title": "X", "section": "concepts", "body": "## H\\n\\nbody"}]}
```
"""
    warnings: list = []
    pages = _parse_pages(raw, warnings)
    assert len(pages) == 1
    assert pages[0].title == "X"


def test_direct_drafter_skips_bad_pages_with_warnings():
    """Missing title or body → skip (with a warning), don't crash the
    whole import. The wiki seeds with the good pages and the warnings
    surface on /welcome so the user knows."""
    import json

    from app.direct_drafter import _parse_pages

    raw = json.dumps(
        {
            "pages": [
                {"slug": "ok", "title": "Ok", "section": "concepts", "body": "## h\n\nbody"},
                {"title": "no body", "section": "entities"},
                {"slug": "no-title", "body": "## h\n\nbody"},
                "this is not even a dict",
            ]
        }
    )
    warnings: list = []
    pages = _parse_pages(raw, warnings)
    assert len(pages) == 1
    assert pages[0].title == "Ok"
    assert len(warnings) >= 2  # missing-body + missing-title + non-dict


def test_direct_drafter_unknown_section_defaults_to_concepts():
    """LLM hallucinates ``section: "thoughts"`` — we don't 500, we
    bucket it into ``concepts`` and warn."""
    import json

    from app.direct_drafter import _parse_pages

    raw = json.dumps(
        {
            "pages": [
                {"slug": "x", "title": "X", "section": "thoughts", "body": "## H\n\nbody"}
            ]
        }
    )
    warnings: list = []
    pages = _parse_pages(raw, warnings)
    assert len(pages) == 1
    assert pages[0].section == "concepts"
    assert pages[0].page_type == "concept"
    assert any("section" in w.lower() for w in warnings)


def test_draft_from_raw_with_fallback_uses_direct_drafter_when_orchestrator_missing(
    multi_tenant_app, monkeypatch
):
    """Critical regression guard: when Puppetmaster isn't installed
    (the Render reality), onboarding MUST fall through to the direct-
    LLM drafter and actually write pages — not just save the raw and
    return ``orchestrator_started: false`` with no content.

    We mock both providers so the test doesn't hit the network. The
    important thing is that ``_draft_from_raw_with_fallback`` returns
    pages_created>0 and the files land on disk.
    """
    import json
    import asyncio

    import app.hosted_routes as hr
    import app.direct_drafter as dd
    import app.orchestrator as orch
    import app.tenants as _tenants

    # Force Puppetmaster lookup to fail so we exercise the fallback.
    monkeypatch.setattr(orch, "PUPPETMASTER_BIN", "/no/such/binary-pllmw")

    # Mock the anthropic call so no network IO happens.
    canned = json.dumps(
        {
            "pages": [
                {
                    "slug": "jane-smith",
                    "title": "Jane Smith",
                    "section": "entities",
                    "tier": "private",
                    "tags": ["founder"],
                    "body": "## Background\n\nJane is the founder of [[Acme Bio]].",
                },
                {
                    "slug": "acme-bio",
                    "title": "Acme Bio",
                    "section": "entities",
                    "tier": "private",
                    "tags": ["company"],
                    "body": "## Overview\n\nA biotech.",
                },
            ]
        }
    )

    async def _fake_anthropic(
        _model: str, _prompt: str, *, system_prompt: str = ""
    ) -> str:
        # ``system_prompt`` is the new kwarg added when capture-context
        # drafting needed a different framing than onboarding. The
        # provider call now passes it through; tests accept + ignore.
        return canned

    monkeypatch.setattr(dd, "_call_anthropic_json", _fake_anthropic)
    monkeypatch.setattr(dd.settings, "anthropic_api_key", "test-key")

    tenant = _tenants.manager().require("alice")

    # Seed a raw file (the drafter doesn't read it — it reads the
    # source_content arg — but the dispatcher writes one for parity).
    raw_dir = tenant.wiki_root / "raw" / "imports"
    raw_dir.mkdir(parents=True, exist_ok=True)
    rel = "raw/imports/2026-05-24-test.md"
    (tenant.wiki_root / rel).write_text("body", encoding="utf-8")

    result = asyncio.get_event_loop().run_until_complete(
        hr._draft_from_raw_with_fallback(
            tenant=tenant,
            raw_rel=rel,
            kind="bio",
            source_label="test import",
            source_content="Jane Smith is the founder of Acme Bio.",
            run_orchestrator=True,
        )
    )
    # Puppetmaster path tried and failed (binary missing).
    assert result["orchestrator_started"] is False
    # Direct drafter path picked up the slack and produced pages.
    assert result["pages_created"] == 2, result
    assert result["draft_backend"] == "anthropic"
    # And the page files actually exist on disk.
    jane = tenant.wiki_root / "wiki" / "entities" / "jane-smith.md"
    acme = tenant.wiki_root / "wiki" / "entities" / "acme-bio.md"
    assert jane.exists() and acme.exists()
    assert "Acme Bio" in jane.read_text(encoding="utf-8")


def test_draft_from_raw_with_fallback_503s_when_no_llm_key(
    multi_tenant_app, monkeypatch
):
    """If puppetmaster ISN'T installed AND no LLM key is set, surface
    a clean 503 so the welcome page can tell the user what to fix
    instead of "orchestrator was unavailable — raw saved at ." dead
    ending them on an empty wiki."""
    import asyncio

    from fastapi import HTTPException

    import app.hosted_routes as hr
    import app.direct_drafter as dd
    import app.orchestrator as orch
    import app.tenants as _tenants

    monkeypatch.setattr(orch, "PUPPETMASTER_BIN", "/no/such/binary-pllmw")
    monkeypatch.setattr(dd.settings, "anthropic_api_key", "")
    monkeypatch.setattr(dd.settings, "openai_api_key", "")

    tenant = _tenants.manager().require("alice")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.get_event_loop().run_until_complete(
            hr._draft_from_raw_with_fallback(
                tenant=tenant,
                raw_rel="raw/imports/x.md",
                kind="bio",
                source_label="bio",
                source_content="some text about someone",
                run_orchestrator=True,
            )
        )
    assert exc_info.value.status_code == 503
    assert "ANTHROPIC_API_KEY" in str(exc_info.value.detail) or "OPENAI_API_KEY" in str(
        exc_info.value.detail
    )


# ---------------------------------------------------------------------------
# /onboarding/assemble — guided first-signup bundle
# ---------------------------------------------------------------------------
#
# Pins the contract the welcome page depends on:
#   * requires a session (401 anonymous)
#   * rejects empty bundles (422)
#   * scrapes each URL once and reports per-URL status
#   * concatenates answers + pastes + scrapes into ONE raw import
#   * calls draft_starter_pages ONCE on the bundled body
#   * partial URL failures don't bail the whole call


def _stub_scrape(monkeypatch, results: dict):
    """Patch url_scrape.scrape so tests don't hit the network.

    ``results`` maps URL → dict of ScrapedPage kwargs. Unknown URLs land
    on the empty-with-errors default so we exercise the "failed" branch.
    """

    from app import hosted_routes as _hr
    from app import url_scrape as _url_scrape

    async def fake_scrape(url: str):
        spec = results.get(url)
        if spec is None:
            page = _url_scrape.ScrapedPage(url=url)
            page.errors.append("stubbed: unknown URL")
            return page
        page = _url_scrape.ScrapedPage(url=url)
        page.final_url = spec.get("final_url", url)
        page.title = spec.get("title", "")
        page.content = spec.get("content", "")
        page.description = spec.get("description", "")
        page.word_count = spec.get("word_count", len(page.content.split()))
        if spec.get("errors"):
            page.errors.extend(spec["errors"])
        return page

    # The endpoint imports url_scrape at module top — patch the rebound
    # reference too so the substitution is actually picked up.
    monkeypatch.setattr(_url_scrape, "scrape", fake_scrape)
    monkeypatch.setattr(_hr.url_scrape, "scrape", fake_scrape)


def _stub_assemble_drafter(monkeypatch, pages: list[dict] | None = None):
    """Patch the direct-LLM drafter so /onboarding/assemble tests don't
    hit Anthropic/OpenAI and don't try to start Puppetmaster.

    Also captures the source_content the drafter was invoked with so
    tests can assert the bundled dossier really did contain answers +
    pastes + scrapes.
    """
    import json

    from app import direct_drafter as _dd
    from app import orchestrator as _orch

    # Make the Puppetmaster path fail fast so /onboarding/assemble
    # exercises the direct-drafter fallback. The fake binary path means
    # the orchestrator subprocess invocation errors out cleanly.
    monkeypatch.setattr(_orch, "PUPPETMASTER_BIN", "/no/such/binary-pllmw")

    canned_pages = pages if pages is not None else [
        {
            "slug": "the-user",
            "title": "The User",
            "section": "entities",
            "tier": "private",
            "tags": ["self"],
            "body": "## Who\n\nFrom the assembled bundle.",
        },
        {
            "slug": "current-projects",
            "title": "Current Projects",
            "section": "projects",
            "tier": "private",
            "tags": ["work"],
            "body": "## Active work\n\n[[The User]] is shipping things.",
        },
    ]
    canned = json.dumps({"pages": canned_pages})

    captured: dict = {}

    async def fake_anthropic(_model: str, prompt: str, *, system_prompt: str = "") -> str:
        captured["prompt"] = prompt
        captured["system_prompt"] = system_prompt
        return canned

    monkeypatch.setattr(_dd, "_call_anthropic_json", fake_anthropic)
    monkeypatch.setattr(_dd.settings, "anthropic_api_key", "test-key")
    return captured


def test_assemble_requires_session(multi_tenant_app):
    """Anonymous POST to /onboarding/assemble must 401 — same gate as
    every other onboarding endpoint."""
    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={"answers": [{"question": "who", "answer": "me"}]},
    )
    assert r.status_code == 401


def test_assemble_rejects_empty_bundle(multi_tenant_app):
    """An empty bundle (no answers, no pastes, no URLs) must 422 with a
    clear hint — never silently call the LLM on an empty corpus."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/onboarding/assemble", json={})
    assert r.status_code == 422, r.text
    assert "at least one" in r.json()["detail"].lower()


def test_assemble_ignores_whitespace_only_inputs(multi_tenant_app):
    """All-blank answers / pastes / URLs are not a meaningful bundle.
    Whitespace-only values should be filtered like missing ones (422),
    so we can't bypass the empty-bundle guard by submitting `"   "`."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "answers": [{"question": "who", "answer": "   "}],
            "text_sources": [{"kind": "resume", "content": "\n\n"}],
            "urls": [{"url": "   "}],
        },
    )
    assert r.status_code == 422, r.text


def test_assemble_drafts_from_answers_alone(multi_tenant_app, monkeypatch):
    """Answers-only bundle should produce a starter wiki — questions are
    the lowest-friction path so we must support it explicitly. The
    backend should pass the literal question text to the drafter so
    the LLM sees the prompt + answer pair.
    """
    captured = _stub_assemble_drafter(monkeypatch)
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "answers": [
                {
                    "question": "Who are you?",
                    "answer": "Staff engineer at Strand Bio. Python + TS.",
                },
                {
                    "question": "What are you working on?",
                    "answer": "Genomic data pipelines.",
                },
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["answers_count"] == 2
    assert body["text_count"] == 0
    assert body["urls"] == []
    assert body["usable_url_count"] == 0
    assert body["pages_created"] == 2
    # Bundled dossier contains both questions + answers so the LLM had
    # full context — guard against a future regression that drops one.
    assert "Who are you?" in captured["prompt"]
    assert "Strand Bio" in captured["prompt"]
    assert "Genomic data pipelines" in captured["prompt"]


def test_assemble_concatenates_answers_pastes_and_urls(
    multi_tenant_app, monkeypatch
):
    """Bundle path: answers + resume paste + 1 URL scrape land in ONE
    raw import and ONE drafter call. The captured prompt must contain
    fragments from all three inputs.
    """
    _stub_scrape(
        monkeypatch,
        {
            "https://example.com/about": {
                "title": "About Alice",
                "content": "Alice runs a homelab and writes Python.",
                "word_count": 8,
            },
        },
    )
    captured = _stub_assemble_drafter(monkeypatch)
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "answers": [
                {"question": "Who are you?", "answer": "I am Alice."}
            ],
            "text_sources": [
                {
                    "kind": "resume",
                    "label": "Resume",
                    "content": "Resume body — Staff Eng @ Acme since 2024.",
                }
            ],
            "urls": [
                {"url": "https://example.com/about", "label": "Portfolio"}
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["answers_count"] == 1
    assert body["text_count"] == 1
    assert len(body["urls"]) == 1
    assert body["urls"][0]["status"] == "ok"
    assert body["usable_url_count"] == 1
    # ONE call into the drafter — content carries all three sources.
    prompt = captured["prompt"]
    assert "I am Alice." in prompt
    assert "Staff Eng @ Acme since 2024" in prompt
    assert "Alice runs a homelab" in prompt


def test_assemble_partial_url_failure_reported_but_continues(
    multi_tenant_app, monkeypatch
):
    """If ONE URL fails to scrape but the bundle still has a paste,
    the call MUST succeed and surface the failure in ``urls[]`` so the
    UI can show "we couldn't read X but did read Y".

    This is the partial-failure-doesn't-bail-the-whole-bundle invariant
    the welcome wizard relies on.
    """
    _stub_scrape(
        monkeypatch,
        {
            "https://example.com/good": {
                "title": "Good Page",
                "content": "Some content.",
                "word_count": 2,
            },
            "https://example.com/bad": {
                "errors": ["http 404: not found"],
            },
        },
    )
    _stub_assemble_drafter(monkeypatch)
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "text_sources": [
                {"kind": "freeform", "content": "Some notes."},
            ],
            "urls": [
                {"url": "https://example.com/good"},
                {"url": "https://example.com/bad"},
            ],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    statuses = {entry["url"]: entry["status"] for entry in body["urls"]}
    assert statuses == {
        "https://example.com/good": "ok",
        "https://example.com/bad": "failed",
    }
    # usable_url_count counts non-failed URLs.
    assert body["usable_url_count"] == 1


def test_assemble_all_urls_failed_with_no_other_content_returns_422(
    multi_tenant_app, monkeypatch
):
    """If the user only submitted URLs and ALL of them failed to scrape,
    we have nothing to feed the drafter. Surface a 422 telling them to
    add a paste or answer instead of bottoming out in the LLM with an
    empty body.
    """
    _stub_scrape(
        monkeypatch,
        {
            "https://example.com/x": {"errors": ["http 500"]},
        },
    )
    _stub_assemble_drafter(monkeypatch)
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={"urls": [{"url": "https://example.com/x"}]},
    )
    assert r.status_code == 422, r.text
    assert "couldn't read" in r.json()["detail"].lower()


def test_assemble_writes_raw_import_and_returns_path(multi_tenant_app, monkeypatch):
    """The dossier MUST land under ``raw/imports/`` on the tenant's disk
    so the GitHub-sync layer commits it alongside the drafted pages.

    Mirrors the existing /onboarding/import-text + /onboarding/import-url
    promise: nothing the user submits is thrown away even if the LLM
    later flakes.
    """
    import app.tenants as _tenants

    _stub_assemble_drafter(monkeypatch)
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "answers": [
                {"question": "Who?", "answer": "Alice."}
            ]
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    raw_rel = body["raw_path"]
    assert raw_rel.startswith("raw/imports/")
    tenant = _tenants.manager().require("alice")
    raw_file = tenant.wiki_root / raw_rel
    assert raw_file.exists()
    body_text = raw_file.read_text(encoding="utf-8")
    assert "Alice." in body_text


def test_direct_drafter_decision_pages_get_date_prefix():
    """Decision pages follow YYYY-MM-DD-<slug>.md. If the LLM forgets
    the date prefix, the validator must backfill today's date."""
    import json

    from app.direct_drafter import _parse_pages

    raw = json.dumps(
        {
            "pages": [
                {
                    "slug": "leaving-grad-school",
                    "title": "Leaving Grad School",
                    "section": "decisions",
                    "body": "## Background\n\nLeft Stanford.",
                }
            ]
        }
    )
    warnings: list = []
    pages = _parse_pages(raw, warnings)
    assert len(pages) == 1
    assert pages[0].slug.startswith("20")  # 20XX-MM-DD prefix
    assert "leaving-grad-school" in pages[0].slug


def test_git_binary_is_available_for_import_wiki():
    """The /onboarding/import-wiki endpoint shells out to ``git clone``.

    The prod backend/Dockerfile apt-installs git, but if anyone ever
    slims the image without thinking, the import flow silently breaks
    in a way that's hard to debug from the frontend (we'd raise a 500
    with a FileNotFoundError detail). Pin git's presence as a deploy
    invariant so CI catches that regression immediately.
    """
    import shutil

    assert shutil.which("git") is not None, (
        "git binary is required for /onboarding/import-wiki — make sure "
        "the backend Docker image apt-installs git."
    )


def test_authenticated_clone_url_injects_token():
    """Splicing an OAuth token into an HTTPS GitHub URL must use
    GitHub's documented ``x-access-token:<token>@`` form so git clone
    accepts it as basic-auth."""
    import app.hosted_routes as hr

    spliced = hr._authenticated_clone_url(
        "https://github.com/professorpalmer/cary-wiki.git", "ghp_abc123"
    )
    assert (
        spliced
        == "https://x-access-token:ghp_abc123@github.com/professorpalmer/cary-wiki.git"
    )


def test_authenticated_clone_url_no_token_is_unchanged():
    """If we have no token, we still return a valid public clone URL
    (anonymous clone) rather than a malformed one."""
    import app.hosted_routes as hr

    public = "https://github.com/professorpalmer/cary-wiki.git"
    assert hr._authenticated_clone_url(public, "") == public
    assert hr._authenticated_clone_url(public, "   ".strip()) == public


def test_authenticated_clone_url_only_injects_for_github():
    """Don't inject the GitHub OAuth token into a non-github URL — the
    URL parser blocks non-github inputs upstream but this is a final
    belt-and-suspenders guard."""
    import app.hosted_routes as hr

    other = "https://gitlab.example.com/foo/bar.git"
    assert hr._authenticated_clone_url(other, "secret-token") == other


def test_redact_clone_url_strips_credentials():
    """``_redact_clone_url`` must strip ``user:pass@`` from a clone URL
    so we can safely surface git stderr to the user without leaking the
    OAuth token."""
    import app.hosted_routes as hr

    leaky = (
        "fatal: could not read from "
        "https://x-access-token:ghp_secret@github.com/foo/bar.git"
    )
    assert "ghp_secret" not in hr._redact_clone_url(leaky)
    assert "github.com/foo/bar.git" in hr._redact_clone_url(leaky)


def test_copy_wiki_pages_refuses_symlinks(tmp_path):
    """A repo with a symlink in wiki/ shouldn't let us read host files."""
    import os
    import app.hosted_routes as hr

    src = tmp_path / "src" / "wiki"
    dst = tmp_path / "dst" / "wiki"
    src.mkdir(parents=True)
    dst.mkdir(parents=True)
    secret = tmp_path / "passwd-equivalent.md"
    secret.write_text("super secret\n")
    try:
        os.symlink(str(secret), str(src / "looks-innocent.md"))
    except (OSError, NotImplementedError):
        # Windows test env without symlink permissions — skip silently.
        return

    imported, conflicts, skipped = hr._copy_wiki_pages(src, dst)

    assert imported == 0
    assert conflicts == []
    assert any("looks-innocent.md" in s for s in skipped)
    assert not (dst / "looks-innocent.md").exists()


def test_oauth_callback_rejects_bad_state(multi_tenant_app):
    # No session-stashed state means no expected_state — should 400.
    r = multi_tenant_app.get(
        "/auth/github/callback?code=abc&state=xyz",
        follow_redirects=False,
    )
    assert r.status_code == 400


def test_safe_redirect_allows_public_base_url(monkeypatch):
    """The OAuth callback's ``_safe_redirect`` guard must allow absolute
    URLs that point at our configured public frontend, otherwise the
    fallback ``/welcome`` resolves against the API host and 404s.
    """
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://portablellm.wiki")
    monkeypatch.setenv("SINGLE_TENANT_MODE", "0")
    monkeypatch.setenv("SESSION_SECRET", "test")
    import app.config
    import app.hosted_routes

    importlib.reload(app.config)
    importlib.reload(app.hosted_routes)

    sr = app.hosted_routes._safe_redirect

    # Same-host relative paths pass through unchanged.
    assert sr("/welcome") == "/welcome"
    assert sr("/cary") == "/cary"

    # Absolute URLs that match the public base are allowed.
    assert sr("https://portablellm.wiki/welcome") == "https://portablellm.wiki/welcome"
    assert sr("https://portablellm.wiki/cary/wiki/index.md") == (
        "https://portablellm.wiki/cary/wiki/index.md"
    )

    # ----- www / apex twin support (regression) -----
    # In production the apex 307s to www, so window.location.origin
    # resolves to https://www.portablellm.wiki for users browsing the
    # live site. The frontend passes that as return_to. If we don't
    # accept it, the safe-redirect fallback dumps the user on /welcome
    # and they see "we can't finish signing you in" — the exact post-
    # logout bug that prompted this test. So accept the www variant
    # of whichever public_base_url is configured.
    assert sr("https://www.portablellm.wiki") == "https://www.portablellm.wiki"
    assert sr("https://www.portablellm.wiki/") == "https://www.portablellm.wiki/"
    assert sr("https://www.portablellm.wiki/cary") == "https://www.portablellm.wiki/cary"
    # Lookalike subdomains must NOT be accepted — only www.
    assert sr("https://evil.portablellm.wiki") == "https://portablellm.wiki/welcome"
    assert sr("https://wwwx.portablellm.wiki") == "https://portablellm.wiki/welcome"
    # Suffix attack: trailing chars after the trusted base should not match.
    assert (
        sr("https://portablellm.wiki.evil.com") == "https://portablellm.wiki/welcome"
    )

    # Anything else gets coerced back to the default landing on the public frontend.
    assert sr("https://evil.com/steal") == "https://portablellm.wiki/welcome"
    assert sr("//evil.com/steal") == "https://portablellm.wiki/welcome"
    assert sr("javascript:alert(1)") == "https://portablellm.wiki/welcome"
    assert sr("") == "https://portablellm.wiki/welcome"


def test_safe_redirect_when_public_base_is_www_accepts_apex_too(monkeypatch):
    """The symmetric case of the previous test: if a deployment
    configures PUBLIC_BASE_URL as the www variant, the apex variant
    must also be accepted. Both directions of the apex/www flip have
    bitten real users in the wild — pin both."""
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://www.portablellm.wiki")
    monkeypatch.setenv("SINGLE_TENANT_MODE", "0")
    monkeypatch.setenv("SESSION_SECRET", "test")
    import app.config
    import app.hosted_routes

    importlib.reload(app.config)
    importlib.reload(app.hosted_routes)
    sr = app.hosted_routes._safe_redirect

    assert sr("https://www.portablellm.wiki/welcome") == (
        "https://www.portablellm.wiki/welcome"
    )
    assert sr("https://portablellm.wiki/welcome") == (
        "https://portablellm.wiki/welcome"
    )


def test_logout_get_with_www_return_to_does_not_clear_session(multi_tenant_app):
    """GET /auth/logout is a no-op even with a frontend return_to.

    Nav must POST. This used to 302-clear the session (logout CSRF).
    """
    r = multi_tenant_app.get(
        "/auth/logout?return_to=https://www.portablellm.wiki",
        follow_redirects=False,
    )
    assert r.status_code == 405
    assert "POST" in r.json().get("detail", "")


def test_logout_with_no_return_to_does_not_clear_session(multi_tenant_app):
    """GET /auth/logout without return_to still does not clear the session."""
    r = multi_tenant_app.get("/auth/logout", follow_redirects=False)
    assert r.status_code == 405
    assert "POST" in r.json().get("detail", "")


# ---------------------------------------------------------------------------
# Returning-user / duplicate-import protection
# ---------------------------------------------------------------------------


def test_auth_me_reports_page_count_zero_for_fresh_tenant(multi_tenant_app):
    """A signed-in user with no markdown pages must see page_count=0
    and fresh_signup=true so the welcome wizard renders. This is the
    fresh-signup path."""
    import app.tenants as _tenants

    # Replace alice's seeded index.md with an empty wiki so we model
    # the "fresh signup" state correctly.
    tenant = _tenants.manager().require("alice")
    for p in tenant.wiki_dir.rglob("*.md"):
        p.unlink()

    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert body["authenticated"] is True
    assert body["page_count"] == 0
    assert body["fresh_signup"] is True
    assert body["duplicate_imports_count"] == 0


def test_auth_me_reports_real_page_count_for_returning_user(multi_tenant_app):
    """A user with pages on disk must see page_count>0 and
    fresh_signup=false. This is what the welcome page reads to render
    the AlreadyOnboarded bouncer instead of the import wizard.
    """
    import app.tenants as _tenants

    tenant = _tenants.manager().require("alice")
    # Sanity: alice has 1 page from the fixture. Add another so we can
    # see the count tick.
    (tenant.wiki_dir / "extra.md").write_text(
        "---\ntitle: Extra\ntier: public\n---\n# Extra\n", encoding="utf-8"
    )

    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert body["page_count"] == 2
    assert body["fresh_signup"] is False


def test_auth_me_counts_duplicate_imports(multi_tenant_app):
    """Files matching ``*-imported*.md`` get surfaced separately so the
    welcome page can show a "Clean up duplicates" CTA with the exact
    count. Without this signal the user has to discover the damage by
    eyeballing their /browse view."""
    import app.tenants as _tenants

    tenant = _tenants.manager().require("alice")
    for name in ("avery-imported.md", "linh-park-imported.md", "concept-imported-2.md"):
        (tenant.wiki_dir / name).write_text(
            "---\ntitle: x\n---\n# x\n", encoding="utf-8"
        )

    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/auth/me")
    body = r.json()
    assert body["duplicate_imports_count"] == 3


def test_import_wiki_refuses_non_empty_tenant_without_force(multi_tenant_app):
    """The bug this guards: a returning user lands on /welcome a
    second time, fills in the GitHub URL, and the import dumps a
    duplicate ``-imported`` copy of every page on top of the originals.

    Default behavior MUST 409 instead, telling the frontend the tenant
    already has content. The frontend can re-submit with
    ``force_overwrite=true`` if the user explicitly opted in.
    """
    _set_session_user(multi_tenant_app, "alice", login="alice")
    # Alice has 1 seeded page from the fixture → non-empty tenant.
    r = multi_tenant_app.post(
        "/onboarding/import-wiki",
        json={"github_url": "https://github.com/professorpalmer/cary-wiki"},
    )
    assert r.status_code == 409, r.text
    body = r.json()
    detail = body["detail"]
    assert detail["code"] == "tenant_not_empty"
    assert detail["page_count"] >= 1
    assert detail["tenant_id"] == "alice"


def test_import_wiki_allows_force_overwrite_into_non_empty_tenant(
    multi_tenant_app, monkeypatch
):
    """When the user explicitly clicks "Import additional content
    anyway" from the AlreadyOnboarded bouncer, the frontend sets
    ``force_overwrite=true`` and the backend must accept the request.

    We stub git clone since the real test would need network. The
    guard MUST run BEFORE the git clone (otherwise we waste a network
    round-trip on a request we're about to reject) — and that's
    exactly what we assert: 409 with force_overwrite=False, then a
    different non-409 status with force_overwrite=True (here it'll be
    400 because our stubbed clone won't produce a wiki/ dir; what
    matters is that the guard didn't fire).
    """
    _set_session_user(multi_tenant_app, "alice", login="alice")

    # Without the force flag we get the 409.
    r = multi_tenant_app.post(
        "/onboarding/import-wiki",
        json={"github_url": "https://github.com/professorpalmer/cary-wiki"},
    )
    assert r.status_code == 409

    # With the force flag we get past the guard. We don't have network
    # so the call will fail downstream at git clone — the important
    # signal is that it's NOT a 409 about ``tenant_not_empty``.
    r = multi_tenant_app.post(
        "/onboarding/import-wiki",
        json={
            "github_url": "https://github.com/professorpalmer/cary-wiki",
            "force_overwrite": True,
        },
    )
    assert r.status_code != 409, r.text


def test_cleanup_imports_deletes_imported_suffixed_files(multi_tenant_app):
    """``POST /onboarding/cleanup-imports`` removes every
    ``*-imported*.md`` under the caller's tenant wiki and leaves the
    original (un-suffixed) files alone. Two-tenant fixture means we
    also verify cross-tenant isolation: alice's cleanup must NOT touch
    bob's files."""
    import app.tenants as _tenants

    alice = _tenants.manager().require("alice")
    bob = _tenants.manager().require("bob")

    # Seed alice with both originals + duplicates.
    (alice.wiki_dir / "avery.md").write_text("orig", encoding="utf-8")
    (alice.wiki_dir / "avery-imported.md").write_text("dup", encoding="utf-8")
    (alice.wiki_dir / "linh-imported-2.md").write_text("dup", encoding="utf-8")
    (alice.wiki_dir / "concepts").mkdir(exist_ok=True)
    (alice.wiki_dir / "concepts" / "boring-stack-imported.md").write_text(
        "dup", encoding="utf-8"
    )
    # And bob has a duplicate-looking file that must survive.
    (bob.wiki_dir / "evidence-imported.md").write_text("bob-dup", encoding="utf-8")

    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/onboarding/cleanup-imports")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["deleted_count"] == 3
    deleted_set = set(body["deleted"])
    assert "avery-imported.md" in deleted_set
    assert "linh-imported-2.md" in deleted_set
    assert "concepts/boring-stack-imported.md" in deleted_set

    # Alice's original survives.
    assert (alice.wiki_dir / "avery.md").exists()
    # Bob's duplicate-looking file is untouched (cross-tenant isolation).
    assert (bob.wiki_dir / "evidence-imported.md").exists()


def test_cleanup_imports_is_idempotent(multi_tenant_app):
    """Running cleanup twice in a row when there are no duplicates is
    a no-op. The endpoint must still 200 with deleted_count=0 so the
    frontend's "Cleaned up" UI works correctly even on the second
    click."""
    _set_session_user(multi_tenant_app, "alice", login="alice")

    # First call — no duplicates to clean.
    r1 = multi_tenant_app.post("/onboarding/cleanup-imports")
    assert r1.status_code == 200
    assert r1.json()["deleted_count"] == 0

    # Second call — still nothing to clean.
    r2 = multi_tenant_app.post("/onboarding/cleanup-imports")
    assert r2.status_code == 200
    assert r2.json()["deleted_count"] == 0


def test_cleanup_imports_requires_session(multi_tenant_app):
    """Without a session cookie, cleanup must 401 — never touch any
    tenant's content for an anonymous caller."""
    r = multi_tenant_app.post("/onboarding/cleanup-imports")
    assert r.status_code == 401


# ===========================================================================
# Per-tenant GitHub sync — connect-repo + sync now + cold-start hydration
# ===========================================================================
#
# These tests pin the "your wiki lives in your own GitHub repo" promise.
# We mock the GitHub HTTP layer (httpx) so tests don't need network, and
# the subprocess git layer (subprocess.run) so they don't need real git
# commits. What we actually verify is the wiring:
#   * the tenant record gets the right fields set on connect
#   * the persistence module uses the right URL (with token redacted)
#   * the sync endpoints surface state correctly to the owner panel
#   * cross-tenant elevation is impossible on these new endpoints too


def _fake_repo_data(full_name: str, branch: str = "main") -> dict:
    """Minimal GitHub repo object shape — only the fields persistence touches."""
    owner, name = full_name.split("/")
    return {
        "full_name": full_name,
        "name": name,
        "default_branch": branch,
        "private": True,
        "owner": {"login": owner},
        "html_url": f"https://github.com/{full_name}",
    }


def _stub_github_create_repo(monkeypatch, full_name: str = "alice/portable-llm-wiki"):
    """Patch github_api.create_repo to skip the network and return a fake repo."""
    from app import github_api

    async def fake_create_repo(token, *, name="portable-llm-wiki", **_kw):
        owner = "alice"
        return _fake_repo_data(f"{owner}/{name}")

    monkeypatch.setattr(github_api, "create_repo", fake_create_repo)


def _stub_github_get_repo(monkeypatch, allowed: set[str]):
    """Patch github_api.get_repo to allow only specific full_names."""
    from app import github_api

    async def fake_get_repo(token, full_name):
        if full_name in allowed:
            return _fake_repo_data(full_name)
        raise github_api.GitHubAPIError(404, "Not Found")

    monkeypatch.setattr(github_api, "get_repo", fake_get_repo)


def _stub_persistence_git(monkeypatch, record: list[list[str]]):
    """Patch persistence._run_git so tests don't shell out. Each call's
    argv is appended to ``record`` so assertions can inspect what
    sequence of git commands the connect flow actually emitted."""
    from app import persistence

    def fake_run_git(args, cwd=None, timeout=60):
        record.append(list(args))
        # Pretend `rev-parse HEAD` returns 1 (so seed_empty path runs)
        # only on the very first time it's called per tenant. After
        # the seed commit, subsequent rev-parses succeed.
        if args and args[0] == "rev-parse":
            rev_parse_calls = sum(1 for a in record if a and a[0] == "rev-parse")
            if rev_parse_calls == 1:
                return 1, "no commits yet"
            return 0, "abc123"
        if args and args[0] == "clone":
            # Pretend the clone created the target directory.
            # The destination is the LAST positional arg.
            dest = args[-1]
            from pathlib import Path

            Path(dest).mkdir(parents=True, exist_ok=True)
            (Path(dest) / ".git").mkdir(exist_ok=True)
            return 0, ""
        if args and args[0] == "status":
            return 0, ""  # no changes
        return 0, ""

    monkeypatch.setattr(persistence, "_run_git", fake_run_git)


def test_connect_repo_requires_session(multi_tenant_app):
    """Anonymous POST to /onboarding/connect-repo must 401 — never write
    a gh_repo field on a tenant we can't identify."""
    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "portable-llm-wiki"},
    )
    assert r.status_code == 401


def test_connect_repo_requires_token(multi_tenant_app, monkeypatch):
    """If the tenant has no gh_token on file (e.g. session survived
    but token was wiped), we must 401 with a clear "re-auth" message
    instead of silently using an empty token to push to GitHub."""
    _set_session_user(multi_tenant_app, "alice", login="alice")

    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = ""
    tenants.manager().upsert(alice)

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "portable-llm-wiki"},
    )
    assert r.status_code == 401
    assert "Sign in again" in r.json()["detail"]


def test_connect_repo_create_new_sets_tenant_fields(multi_tenant_app, monkeypatch):
    """The happy path: user clicks "Create new repo", we POST to GitHub,
    save the result on the tenant record, then bootstrap. The tenant
    record MUST end up with gh_repo + gh_default_branch populated so a
    cold-start reload can find the repo again. This is the core
    persistence invariant for the whole feature."""
    _set_session_user(multi_tenant_app, "alice", login="alice")

    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_fake_for_test"
    alice.gh_login = "alice"
    tenants.manager().upsert(alice)

    _stub_github_create_repo(monkeypatch)
    git_calls: list[list[str]] = []
    _stub_persistence_git(monkeypatch, git_calls)

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "portable-llm-wiki", "private": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["connected"] is True
    assert body["repo"] == "alice/portable-llm-wiki"
    assert body["branch"] == "main"

    # Re-fetch the tenant to confirm the connection is persisted.
    refreshed = tenants.manager().require("alice")
    assert refreshed.gh_repo == "alice/portable-llm-wiki"
    assert refreshed.gh_default_branch == "main"


def test_connect_repo_rejects_bad_repo_name(multi_tenant_app, monkeypatch):
    """Validation guard: names with spaces, slashes, or shell metachars
    must 400 BEFORE we ever hit the GitHub API or git CLI. This is the
    only defense against accidentally injecting weird strings into a
    POST /user/repos body or a git clone URL."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_fake"
    tenants.manager().upsert(alice)

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "evil; rm -rf /"},
    )
    assert r.status_code == 400
    assert "alphanumeric" in r.json()["detail"]


def test_connect_repo_existing_requires_owner_slash_name(
    multi_tenant_app, monkeypatch
):
    """When create_new=False, repo must be ``<owner>/<name>``. A bare
    name is ambiguous (whose repo?) and must 400 cleanly."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_fake"
    tenants.manager().upsert(alice)

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": False, "repo": "bare-name"},
    )
    assert r.status_code == 400


def test_connect_repo_existing_404s_for_inaccessible_repo(
    multi_tenant_app, monkeypatch
):
    """If GitHub returns 404 for a repo we tried to attach to, surface a
    clear "not found or not accessible" error instead of leaking the raw
    GitHub error body. The user might be typo'ing, or the repo might be
    private and outside their token's scope — either way the remediation
    is the same: pick a different repo."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_fake"
    tenants.manager().upsert(alice)

    _stub_github_get_repo(monkeypatch, allowed=set())

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": False, "repo": "alice/does-not-exist"},
    )
    assert r.status_code == 404
    assert "not found or not accessible" in r.json()["detail"]


def test_sync_status_reports_unconnected_for_new_tenant(multi_tenant_app):
    """A fresh tenant with no gh_repo should report connected=false so
    the owner-console panel can render the "Connect a repo" CTA instead
    of a fake-healthy sync display."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/owner/sync/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["connected"] is False
    assert body["repo"] == ""


def test_sync_status_reports_connected_after_connect(
    multi_tenant_app, monkeypatch
):
    """After a successful /onboarding/connect-repo call, GET /owner/sync
    /status must reflect connected=true with the matching repo. This is
    the owner-console panel's only source of truth for the connection
    state, so the chained call has to round-trip cleanly."""
    _set_session_user(multi_tenant_app, "alice", login="alice")

    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_fake"
    alice.gh_login = "alice"
    tenants.manager().upsert(alice)

    _stub_github_create_repo(monkeypatch)
    _stub_persistence_git(monkeypatch, [])

    multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "portable-llm-wiki"},
    )

    r = multi_tenant_app.get("/owner/sync/status")
    assert r.status_code == 200
    body = r.json()
    assert body["connected"] is True
    assert body["repo"] == "alice/portable-llm-wiki"
    assert body["branch"] == "main"
    assert body["remote_url_public"] == "https://github.com/alice/portable-llm-wiki"


def test_sync_now_requires_connection(multi_tenant_app):
    """Calling /owner/sync/now on a tenant that hasn't connected a repo
    must 409 with a clear "connect one first" message. Returning an
    empty success here would silently swallow the user's click."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/owner/sync/now")
    assert r.status_code == 409


def test_sync_status_accepts_personal_llm_token(multi_tenant_app):
    """Personal LLM private tokens unlock sync without a browser session.

    Diverged-host recovery otherwise gets stuck behind GitHub OAuth when
    the only credential on hand is the headless Personal LLM URL token.
    """
    from app import share_tokens, tenants

    alice = tenants.manager().require("alice")
    with tenants.set_current_tenant(alice):
        minted = share_tokens.mint_token("headless sync", "private")
    plaintext = minted["token"]

    multi_tenant_app.cookies.clear()
    r = multi_tenant_app.get(
        "/t/alice/owner/sync/status",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["connected"] is False


def test_sync_status_rejects_recruiter_share_token(multi_tenant_app):
    """Recruiter/friend share tokens must not drive owner sync."""
    from app import share_tokens, tenants

    alice = tenants.manager().require("alice")
    with tenants.set_current_tenant(alice):
        minted = share_tokens.mint_token("recruiter view", "recruiter")
    plaintext = minted["token"]

    multi_tenant_app.cookies.clear()
    r = multi_tenant_app.get(
        "/t/alice/owner/sync/status",
        headers={"Authorization": f"Bearer {plaintext}"},
    )
    assert r.status_code == 401


def test_sync_now_does_not_grant_cross_tenant_access(
    multi_tenant_app, monkeypatch
):
    """Critical isolation test: bob's session cookie must NOT be able to
    trigger a sync on alice's tenant or read alice's sync status. The
    new endpoints have to honor the same per-tenant boundary every
    other /owner/* route does."""
    _set_session_user(multi_tenant_app, "bob", login="bob")
    # Pretend alice is connected by setting fields directly.
    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_alice"
    alice.gh_repo = "alice/portable-llm-wiki"
    tenants.manager().upsert(alice)

    # bob's session reads HIS own sync state, never alice's.
    r = multi_tenant_app.get("/owner/sync/status")
    assert r.status_code == 200
    assert r.json()["repo"] == ""  # bob has nothing connected
    # And /owner/sync/now on bob's session must not push alice's repo.
    r = multi_tenant_app.post("/owner/sync/now")
    assert r.status_code == 409  # bob has no repo, so can't sync


def test_auth_me_surfaces_github_sync_status(multi_tenant_app, monkeypatch):
    """/auth/me MUST include github_sync.connected so the welcome page can
    decide whether to render the connect-repo step. This is the only
    place the frontend learns the connection state on initial load."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/auth/me")
    assert r.status_code == 200
    body = r.json()
    assert "github_sync" in body
    gs = body["github_sync"]
    assert "connected" in gs
    assert "repo" in gs
    assert "branch" in gs
    assert "last_synced_at" in gs


def test_tenant_remote_url_includes_token_and_repo():
    """Unit test for persistence._tenant_remote_url: must build a URL
    with x-access-token basic auth so subprocess git can push without
    a manual credential prompt. We assert structure, not the literal
    string (so the implementation can swap auth schemes later)."""
    from app import persistence, tenants

    t = tenants.Tenant(
        id="alice",
        wiki_root=__import__("pathlib").Path("/tmp/x"),
        gh_login="alice",
        gh_token="ghp_test_token_xyz",
        gh_repo="alice/portable-llm-wiki",
    )
    url = persistence._tenant_remote_url(t)
    assert url.startswith("https://x-access-token:")
    assert "ghp_test_token_xyz" in url
    assert url.endswith("github.com/alice/portable-llm-wiki.git")


def test_tenant_remote_url_redaction_hides_token():
    """The redactor must strip the token so we never log it. This is
    the function we put log lines through — a single missed log call
    that bypasses it would expose every user's OAuth token in any
    accidentally-shared error trace."""
    from app import persistence

    raw = "https://x-access-token:ghp_secret_token@github.com/alice/repo.git"
    redacted = persistence._redact_remote(raw)
    assert "ghp_secret_token" not in redacted
    assert "****" in redacted
    assert "github.com/alice/repo.git" in redacted


def test_tenant_status_has_no_token_in_response(multi_tenant_app, monkeypatch):
    """The /owner/sync/status response surface must NEVER include the raw
    gh_token. The frontend doesn't need it (auth is session-based) and
    leaking it to the owner-console JSON would expose it to any XSS or
    extension that can read the page. Assert by checking the serialized
    JSON for the literal token string."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    from app import tenants

    alice = tenants.manager().require("alice")
    alice.gh_token = "ghp_super_secret_TOKEN_value"
    alice.gh_repo = "alice/portable-llm-wiki"
    tenants.manager().upsert(alice)

    r = multi_tenant_app.get("/owner/sync/status")
    assert r.status_code == 200
    assert "ghp_super_secret_TOKEN_value" not in r.text


# ---------------------------------------------------------------------------
# Pull from GitHub — /owner/sync/pull
# ---------------------------------------------------------------------------
#
# The complement to /owner/sync/now. Verifies:
#   * the endpoint refuses unconnected tenants (clear 409, not a silent OK)
#   * cross-tenant isolation (bob can't pull alice's repo through his cookie)
#   * the unit-level conflict policy in persistence.pull_tenant_now is what
#     the docstring says: clean+behind FFs, clean+even no-ops, ahead-only
#     no-ops with the right action, diverged refuses w/o force, dirty
#     refuses w/o force, force does reset --hard
#   * a successful pull triggers a tenant index reload so new pages are
#     immediately visible (the whole point of the feature)


def _stub_pull_run_git(monkeypatch, *, behind: int = 0, ahead: int = 0,
                       dirty: bool = False, dirty_kind: str = "untracked",
                       fetch_fails: bool = False,
                       reset_fails: bool = False, merge_fails: bool = False):
    """Stub persistence._run_git to simulate a given branch divergence state.

    The pull function calls (in order): config, remote set-url, fetch,
    rev-list --count HEAD..origin/X, rev-list --count origin/X..HEAD,
    status --porcelain, then either merge --ff-only or reset --hard.
    We respond based on the first arg + the scenario flags. Records
    every invocation so tests can assert on what *commands* ran.

    ``dirty_kind`` controls what kind of dirt ``status --porcelain``
    reports — ``"untracked"`` (a ``??`` row, which smart pull treats as
    disposable and fast-forwards through) or ``"modified"`` (a tracked
    edit that must block the FF).
    """
    from app import persistence

    calls: list[list[str]] = []

    def fake_run_git(args, cwd=None, timeout=60):
        calls.append(list(args))
        if not args:
            return 0, ""
        cmd = args[0]
        if cmd == "fetch":
            return (1, "fetch failed") if fetch_fails else (0, "")
        if cmd == "rev-list":
            # Distinguish "behind" from "ahead" by which side of the
            # ".." is HEAD vs origin/branch.
            rev_range = args[-1]
            if rev_range.startswith("HEAD.."):
                return 0, str(behind)
            return 0, str(ahead)
        if cmd == "status":
            if not dirty:
                return 0, ""
            if dirty_kind == "modified":
                return 0, " M wiki/page.md\n"
            return 0, "?? unstaged\n"
        if cmd == "merge":
            return (1, "merge failed") if merge_fails else (0, "")
        if cmd == "reset":
            return (1, "reset failed") if reset_fails else (0, "")
        return 0, ""

    monkeypatch.setattr(persistence, "_run_git", fake_run_git)
    return calls


def _setup_connected_tenant(name: str = "alice"):
    """Set the named tenant up as if connect-repo had completed: token,
    repo, default branch, and a wiki_root with a .git dir so the
    ``_is_git_repo`` check passes."""
    from app import tenants

    t = tenants.manager().require(name)
    t.gh_token = "ghp_fake_token_for_pull_tests"
    t.gh_login = name
    t.gh_repo = f"{name}/portable-llm-wiki"
    t.gh_default_branch = "main"
    (t.wiki_root / ".git").mkdir(parents=True, exist_ok=True)
    tenants.manager().upsert(t)
    return t


def test_pull_requires_connection(multi_tenant_app):
    """A tenant that hasn't connected a repo must 409 with a clear
    message — never silently treat "no repo configured" as "nothing to
    pull, OK"."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 409
    assert "connect" in r.json()["detail"].lower()


def test_pull_does_not_grant_cross_tenant_access(multi_tenant_app, monkeypatch):
    """The pull endpoint must honor the same per-tenant boundary every
    other /owner/* route does: bob's cookie can never trigger a pull
    on alice's repo."""
    _set_session_user(multi_tenant_app, "bob", login="bob")
    _setup_connected_tenant("alice")

    # Bob has no repo of his own, so the endpoint 409s — never touches
    # alice's connection.
    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 409


def test_pull_clean_behind_fast_forwards(multi_tenant_app, monkeypatch):
    """Happy path: remote has commits we don't, working tree clean →
    fast-forward pull, action=='pulled', behind count surfaces."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(monkeypatch, behind=3, ahead=0, dirty=False)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["result"]["action"] == "pulled"
    assert body["result"]["behind"] == 3
    assert body["result"]["ahead"] == 0

    # Confirm we actually issued the FF merge — without it the local
    # working tree would still be stale even if we returned 200.
    assert any(c[0] == "merge" and "--ff-only" in c for c in calls), calls


def test_pull_up_to_date_no_op(multi_tenant_app, monkeypatch):
    """Even == nothing to do. Must not invoke merge or reset. Action is
    ``up_to_date`` (so the UI can show "already in sync" instead of a
    generic "pulled 0")."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(monkeypatch, behind=0, ahead=0, dirty=False)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    assert r.json()["result"]["action"] == "up_to_date"
    assert not any(c[0] in ("merge", "reset") for c in calls)


def test_pull_ahead_only_no_op(multi_tenant_app, monkeypatch):
    """Local has unpushed commits, remote has nothing new → no pull,
    no error. Action ``ahead_only`` tells the UI to nudge the user
    toward Sync now."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(monkeypatch, behind=0, ahead=2, dirty=False)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["result"]["action"] == "ahead_only"
    assert body["result"]["ahead"] == 2
    assert not any(c[0] in ("merge", "reset") for c in calls)


def test_pull_diverged_refuses_without_force(multi_tenant_app, monkeypatch):
    """Both sides have commits the other doesn't. We MUST refuse and
    surface a diagnostic, not silently throw away one side. The UI
    uses ``action=="diverged"`` to offer the force-pull button."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(monkeypatch, behind=2, ahead=1, dirty=False)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["result"]["action"] == "diverged"
    assert "diverged" in body["result"]["error"].lower()
    # No merge or reset executed — we bailed before mutating local state.
    assert not any(c[0] in ("merge", "reset") for c in calls)


def test_pull_untracked_only_fast_forwards(multi_tenant_app, monkeypatch):
    """Smart pull: an UNTRACKED-only working tree must NOT block a
    fast-forward. A hosted mirror has nothing authored to lose, so stray
    untracked cruft gets fast-forwarded straight through — action
    ``pulled``, not the old scary ``dirty``. This is the headline fix:
    the wart was treating all dirt as blocking.
    """
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(
        monkeypatch, behind=2, ahead=0, dirty=True, dirty_kind="untracked"
    )

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["result"]["action"] == "pulled", body["result"]
    assert body["result"]["behind"] == 2
    # The FF merge actually ran (untracked dirt didn't gate it).
    assert any(c[0] == "merge" and "--ff-only" in c for c in calls), calls


def test_pull_tracked_modified_still_blocks(multi_tenant_app, monkeypatch):
    """Smart pull still protects REAL authored edits: a tracked-modified
    file on a fast-forwardable branch must refuse with ``dirty`` and
    require force / Sync-now, since a FF checkout would clobber it."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(
        monkeypatch, behind=2, ahead=0, dirty=True, dirty_kind="modified"
    )

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["result"]["action"] == "dirty", body["result"]
    assert body["result"]["dirty"] is True
    assert body["result"]["tracked_modified"], body["result"]
    # We bailed before mutating local state.
    assert not any(c[0] in ("merge", "reset") for c in calls)


def test_pull_force_does_hard_reset(multi_tenant_app, monkeypatch):
    """force=true takes the ``git reset --hard origin/<branch>`` path.
    Confirms we actually run the destructive command — without this
    test the force button could silently be a no-op."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(
        monkeypatch, behind=2, ahead=1, dirty=True, reset_fails=False
    )

    r = multi_tenant_app.post("/owner/sync/pull", json={"force": True})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["result"]["action"] == "forced"
    assert any(
        c[0] == "reset" and "--hard" in c and any("origin/main" in x for x in c)
        for c in calls
    ), calls


def test_pull_fetch_failure_surfaces_error(multi_tenant_app, monkeypatch):
    """If git fetch fails we surface the error and DO NOT proceed to
    any reset/merge. Otherwise a transient network blip would look
    like a successful sync."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    calls = _stub_pull_run_git(monkeypatch, fetch_fails=True)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "fetch" in body["result"]["error"].lower()
    assert not any(c[0] in ("merge", "reset") for c in calls)


def test_pull_reloads_index_after_fast_forward(multi_tenant_app, monkeypatch):
    """After a real pull the tenant index must be reloaded so the new
    pages are visible immediately. We assert by spying on Tenant.reload_index."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    tenant = _setup_connected_tenant("alice")
    _stub_pull_run_git(monkeypatch, behind=1, ahead=0, dirty=False)

    reload_count = {"n": 0}
    original_reload = tenant.reload_index

    def spy_reload():
        reload_count["n"] += 1
        return original_reload()

    monkeypatch.setattr(tenant, "reload_index", spy_reload)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    assert r.json()["result"]["action"] == "pulled"
    assert reload_count["n"] >= 1


def test_pull_no_op_does_not_reload_index(multi_tenant_app, monkeypatch):
    """``up_to_date`` doesn't touch the working tree, so we shouldn't
    waste the I/O on a reload. Verifies we're being precise about
    when to invalidate the index cache."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    tenant = _setup_connected_tenant("alice")
    _stub_pull_run_git(monkeypatch, behind=0, ahead=0, dirty=False)

    reload_count = {"n": 0}

    def spy_reload():
        reload_count["n"] += 1

    monkeypatch.setattr(tenant, "reload_index", spy_reload)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    assert r.json()["result"]["action"] == "up_to_date"
    assert reload_count["n"] == 0


def test_pull_response_does_not_leak_token(multi_tenant_app, monkeypatch):
    """Same invariant as status: no path on the pull surface may
    return the raw gh_token. Defense in depth — even if a bug threw
    the token into the error string, the redactor in _redact_remote
    catches it."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    _stub_pull_run_git(monkeypatch, behind=1, ahead=0)

    r = multi_tenant_app.post("/owner/sync/pull")
    assert r.status_code == 200
    assert "ghp_fake_token_for_pull_tests" not in r.text


# ---------------------------------------------------------------------------
# GET /owner/sync/check — live remote-vs-local verdict
# ---------------------------------------------------------------------------


def test_sync_check_reports_behind_and_auto_ff(multi_tenant_app, monkeypatch):
    """The check endpoint surfaces the smart-pull classification: a mirror
    that's purely behind with clean/untracked-only dirt is ``auto_ff`` so
    the UI shows a plain Sync-now, not the destructive force button."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    _setup_connected_tenant("alice")
    _stub_pull_run_git(monkeypatch, behind=4, ahead=0, dirty=False)

    r = multi_tenant_app.get("/owner/sync/check")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    c = body["classification"]
    assert c["behind"] == 4
    assert c["auto_ff"] is True


def test_sync_check_requires_connected_repo(multi_tenant_app):
    """No repo connected → 409, never a misleading "in sync"."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/owner/sync/check")
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# Background poller — persistence.smart_pull_all_tenants
# ---------------------------------------------------------------------------


def test_smart_pull_all_tenants_drives_behind_tenant(multi_tenant_app, monkeypatch):
    """The drift killer: a connected tenant that's behind GitHub gets
    fast-forwarded by the poller sweep with zero user action — the core
    acceptance criterion for Fix #2."""
    from app import persistence

    _setup_connected_tenant("alice")
    _stub_pull_run_git(monkeypatch, behind=5, ahead=0, dirty=False)

    summary = persistence.smart_pull_all_tenants()
    assert summary["checked"] >= 1
    assert summary["pulled"] >= 1
    assert "alice" in summary["pulled_tenants"]


def test_smart_pull_all_tenants_skips_unconnected(multi_tenant_app, monkeypatch):
    """Tenants without a connected repo are never touched by the sweep."""
    from app import persistence

    # bob exists but has no gh_repo/token (default fixture state).
    summary = persistence.smart_pull_all_tenants()
    assert "bob" not in summary.get("pulled_tenants", [])


def test_smart_pull_all_tenants_invalidates_not_reloads(multi_tenant_app, monkeypatch):
    """Background pull must NOT warm indexes into RAM.

    ``reload_index`` after every poller fast-forward is what pinned every
    connected tenant's corpus in memory until Render OOM-killed the
    hosted service at 512 MiB. The poller should only invalidate.
    """
    from app import persistence

    tenant = _setup_connected_tenant("alice")
    _stub_pull_run_git(monkeypatch, behind=2, ahead=0, dirty=False)

    # Warm the index first so we can prove invalidate clears it.
    _ = tenant.index
    assert tenant._index is not None

    reload_count = {"n": 0}
    invalidate_count = {"n": 0}
    monkeypatch.setattr(
        tenant, "reload_index", lambda: reload_count.__setitem__("n", reload_count["n"] + 1)
    )
    original_invalidate = tenant.invalidate_index

    def spy_invalidate():
        invalidate_count["n"] += 1
        return original_invalidate()

    monkeypatch.setattr(tenant, "invalidate_index", spy_invalidate)

    summary = persistence.smart_pull_all_tenants()
    assert summary["pulled"] >= 1
    assert invalidate_count["n"] >= 1
    assert reload_count["n"] == 0
    assert tenant._index is None


def test_index_cache_lru_evicts_cold_tenants(multi_tenant_app, monkeypatch):
    """Only WIKI_INDEX_CACHE_MAX warm indexes stay resident; demos pin."""
    from app import tenants as _tenants

    monkeypatch.setenv("WIKI_INDEX_CACHE_MAX", "1")
    mgr = _tenants.manager()
    avery = mgr.require("avery")  # fixture marks avery is_demo=True
    bob = mgr.require("bob")

    # Cap=1 with avery (demo) already warm: loading bob reserves the
    # only slot for the in-flight tenant after pinned demos → bob is
    # protected during load, but a subsequent third-party eviction with
    # no protect drops non-demo cold entries. Warm avery first, then bob:
    # avery stays (demo). Force a tight eviction that does not protect
    # bob to prove non-demos drop.
    _ = avery.index
    _ = bob.index
    assert avery._index is not None
    # Explicit eviction with no protect: cap=1, avery pinned → bob gone.
    dropped = mgr.evict_cold_indexes()
    assert bob._index is None
    assert avery._index is not None  # demo pinned
    assert dropped >= 1


def test_invalidate_index_drops_cache(multi_tenant_app):
    from app import tenants as _tenants

    alice = _tenants.manager().require("alice")
    _ = alice.index
    assert alice._index is not None
    alice.invalidate_index()
    assert alice._index is None


# ---------------------------------------------------------------------------
# POST /hooks/github — instant local→hosted propagation webhook
# ---------------------------------------------------------------------------


def _sign(secret: str, body: bytes) -> str:
    import hashlib
    import hmac

    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_webhook_valid_signature_pulls(multi_tenant_app, monkeypatch):
    """A correctly-signed push event for a known repo fast-forwards the
    matching tenant — the instant path that kills drift without a poll."""
    from app import persistence

    tenant = _setup_connected_tenant("alice")
    tenant.gh_webhook_secret = "whsec_test_secret"
    from app import tenants as _tenants

    _tenants.manager().upsert(tenant)

    pulled = {"n": 0}

    def fake_pull(t, *, force=False):
        pulled["n"] += 1
        return {"ok": True, "action": "pulled", "behind": 2, "ahead": 0}

    monkeypatch.setattr(persistence, "pull_tenant_now", fake_pull)

    body = json.dumps(
        {"ref": "refs/heads/main", "repository": {"full_name": "alice/portable-llm-wiki"}}
    ).encode()
    r = multi_tenant_app.post(
        "/hooks/github",
        content=body,
        headers={
            "X-GitHub-Event": "push",
            "X-Hub-Signature-256": _sign("whsec_test_secret", body),
            "Content-Type": "application/json",
        },
    )
    assert r.status_code == 200, r.text
    assert pulled["n"] == 1


def test_webhook_bad_signature_rejected(multi_tenant_app, monkeypatch):
    """A push event whose signature doesn't match the tenant's stored
    secret is rejected (401) and never triggers a pull."""
    from app import persistence
    from app import tenants as _tenants

    tenant = _setup_connected_tenant("alice")
    tenant.gh_webhook_secret = "whsec_test_secret"
    _tenants.manager().upsert(tenant)

    pulled = {"n": 0}
    monkeypatch.setattr(
        persistence, "pull_tenant_now",
        lambda t, *, force=False: pulled.__setitem__("n", pulled["n"] + 1) or {"ok": True},
    )

    body = json.dumps(
        {"ref": "refs/heads/main", "repository": {"full_name": "alice/portable-llm-wiki"}}
    ).encode()
    r = multi_tenant_app.post(
        "/hooks/github",
        content=body,
        headers={
            "X-GitHub-Event": "push",
            "X-Hub-Signature-256": _sign("WRONG_secret", body),
            "Content-Type": "application/json",
        },
    )
    assert r.status_code == 401
    assert pulled["n"] == 0


def test_webhook_unknown_repo_401(multi_tenant_app):
    """Unknown repo and bad HMAC share 401 so existence is not an oracle."""
    body = json.dumps(
        {"ref": "refs/heads/main", "repository": {"full_name": "nobody/ghost-repo"}}
    ).encode()
    r = multi_tenant_app.post(
        "/hooks/github",
        content=body,
        headers={
            "X-GitHub-Event": "push",
            "X-Hub-Signature-256": "sha256=deadbeef",
            "Content-Type": "application/json",
        },
    )
    assert r.status_code == 401
    assert r.json()["detail"] == "unauthorized"


# ---------------------------------------------------------------------------
# DELETE /owner/account — self-service tenant deletion
# ---------------------------------------------------------------------------


def test_delete_account_requires_session(multi_tenant_app):
    """The leave-button must reject anonymous callers. Otherwise a
    drive-by ``curl -X DELETE`` could nuke someone else's tenant."""
    r = multi_tenant_app.request("DELETE", "/owner/account")
    assert r.status_code == 401


def test_delete_account_wipes_tenant_dir_and_session(multi_tenant_app, monkeypatch):
    """Happy path: a signed-in user hits DELETE /owner/account, the
    tenant directory disappears from disk, the registry forgets the
    tenant, and the session cookie clears so the next request is
    anonymous again."""
    import app.github_api as gh
    import app.tenants as tenants_mod

    # Best-effort GH revoke must NOT block deletion; stub it as a no-op
    # so the test doesn't need network.
    async def fake_revoke(**kwargs):
        return False

    monkeypatch.setattr(gh, "revoke_oauth_token", fake_revoke)

    _set_session_user(multi_tenant_app, "alice", login="alice")

    tenant_root = tenants_mod.manager().require("alice").wiki_root
    assert tenant_root.exists() and (tenant_root / "wiki").exists()

    r = multi_tenant_app.request("DELETE", "/owner/account")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["tenant_id"] == "alice"
    assert body["tenant_deleted_on_disk"] is True

    # Tenant directory is gone from disk.
    assert not tenant_root.exists(), "tenant directory must be wiped"
    # Tenant registry no longer knows about alice.
    assert tenants_mod.manager().get("alice") is None

    # Session is cleared on the response so the next browser request
    # doesn't think it's still alice. SessionMiddleware emits a
    # cookie-clearing Set-Cookie when ``request.session.clear()`` is
    # called inside a handler — we just assert that header exists.
    assert any(
        h.lower() == "set-cookie" and "plw_session" in v.lower()
        for h, v in r.headers.items()
    ), dict(r.headers)


def test_delete_account_calls_github_revoke(multi_tenant_app, monkeypatch):
    """When a token is stored we MUST call GitHub's revoke endpoint so
    a leaving user's token stops working at GitHub even if our local
    wipe lags. Network call is stubbed; we just assert it was invoked
    with the right token."""
    import app.github_api as gh
    import app.tenants as tenants_mod

    # Plant a token on alice so the revoke path actually runs.
    alice = tenants_mod.manager().require("alice")
    alice.gh_token = "ghp_test_token_to_revoke"

    calls: list[dict] = []

    async def fake_revoke(**kwargs):
        calls.append(kwargs)
        return True

    monkeypatch.setattr(gh, "revoke_oauth_token", fake_revoke)

    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.request("DELETE", "/owner/account")
    assert r.status_code == 200, r.text
    assert r.json()["github_token_revoked"] is True
    assert len(calls) == 1
    assert calls[0]["token"] == "ghp_test_token_to_revoke"


def test_delete_account_proceeds_when_github_revoke_fails(
    multi_tenant_app, monkeypatch
):
    """Best-effort: GitHub being down or the token already-revoked
    must NOT block local wipe. The whole point of "you can leave" is
    that we never trap the user behind a third-party failure."""
    import app.github_api as gh
    import app.tenants as tenants_mod

    alice = tenants_mod.manager().require("alice")
    alice.gh_token = "ghp_will_fail_to_revoke"

    async def boom(**kwargs):
        raise RuntimeError("github is down")

    monkeypatch.setattr(gh, "revoke_oauth_token", boom)

    tenant_root = alice.wiki_root
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.request("DELETE", "/owner/account")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["github_token_revoked"] is False
    # Local wipe still happened.
    assert body["tenant_deleted_on_disk"] is True
    assert not tenant_root.exists()


def test_delete_account_cannot_cross_tenant(multi_tenant_app, monkeypatch):
    """A signed-in alice MUST NOT be able to delete bob's tenant. This
    is the per-tenant isolation guarantee — the DELETE endpoint resolves
    the tenant from the *session*, not from any path or body parameter,
    so this is structurally safe, but we pin it explicitly.
    """
    import app.github_api as gh
    import app.tenants as tenants_mod

    async def fake_revoke(**kwargs):
        return False

    monkeypatch.setattr(gh, "revoke_oauth_token", fake_revoke)

    _set_session_user(multi_tenant_app, "alice", login="alice")

    bob_root = tenants_mod.manager().require("bob").wiki_root
    assert bob_root.exists()

    r = multi_tenant_app.request("DELETE", "/owner/account")
    assert r.status_code == 200
    assert r.json()["tenant_id"] == "alice"
    # Bob is completely untouched.
    assert bob_root.exists()
    assert tenants_mod.manager().get("bob") is not None


def test_delete_account_idempotent_when_tenant_already_gone(
    multi_tenant_app, monkeypatch
):
    """A racing second DELETE (two tabs, retried request, …) must NOT
    500 — the tenant is already gone, so the second hit reports 404
    "nothing to delete" and clears the lingering session.
    """
    import app.github_api as gh

    async def fake_revoke(**kwargs):
        return False

    monkeypatch.setattr(gh, "revoke_oauth_token", fake_revoke)

    _set_session_user(multi_tenant_app, "alice", login="alice")
    r1 = multi_tenant_app.request("DELETE", "/owner/account")
    assert r1.status_code == 200

    # Plant the same session cookie again (simulating a stale cookie
    # surviving the first delete) and verify the second call reports
    # 404 rather than crashing.
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r2 = multi_tenant_app.request("DELETE", "/owner/account")
    assert r2.status_code == 404, r2.text


# ---------------------------------------------------------------------------
# Standardize-mode import — walk-any-markdown
# ---------------------------------------------------------------------------


def test_collect_markdown_for_standardize_skips_noise(tmp_path):
    """The walker MUST skip ``.git``, ``node_modules`` etc., honor the
    file/byte caps, and emit a stable concatenated string the LLM
    drafter can consume."""
    import app.hosted_routes as hr

    root = tmp_path / "repo"
    (root / "notes").mkdir(parents=True)
    (root / ".git" / "objects").mkdir(parents=True)
    (root / "node_modules" / "pkg").mkdir(parents=True)

    (root / "notes" / "career.md").write_text(
        "# Career\n\nI worked at Stanford from 2018-2022.\n",
        encoding="utf-8",
    )
    (root / "notes" / "projects.md").write_text(
        "# Projects\n\nNumerix Labs is my current project.\n",
        encoding="utf-8",
    )
    (root / "README.md").write_text(
        "# Top-level\n\nThis is the root README.\n",
        encoding="utf-8",
    )

    # Should be skipped: .git contents, node_modules contents.
    (root / ".git" / "objects" / "skipme.md").write_text("nope\n", encoding="utf-8")
    (root / "node_modules" / "pkg" / "README.md").write_text(
        "nope\n", encoding="utf-8"
    )
    # Should be skipped: empty file.
    (root / "notes" / "empty.md").write_text("", encoding="utf-8")
    # Should be skipped: non-markdown.
    (root / "notes" / "notes.txt").write_text("plain text\n", encoding="utf-8")

    combined, files = hr._collect_markdown_for_standardize(root)

    assert "Career" in combined
    assert "Projects" in combined
    assert "Top-level" in combined
    # Noise excluded.
    assert "skipme" not in combined
    assert "nope" not in combined
    # File list reports relative paths.
    rels = set(files)
    assert "notes/career.md" in rels
    assert "notes/projects.md" in rels
    assert "README.md" in rels
    assert not any(f.startswith(".git/") for f in files)
    assert not any(f.startswith("node_modules/") for f in files)


def test_collect_markdown_for_standardize_respects_total_byte_cap(tmp_path, monkeypatch):
    """If the source dumps a gigabyte of notes on us we stop reading
    once the byte cap is hit. Otherwise the drafter call OOMs or
    burns LLM tokens we don't have."""
    import app.hosted_routes as hr

    # Slash the cap so we can prove enforcement without writing a real
    # 512 KB of notes to disk.
    monkeypatch.setattr(hr, "_STANDARDIZE_MAX_TOTAL_BYTES", 2048)
    monkeypatch.setattr(hr, "_STANDARDIZE_MAX_FILE_BYTES", 4096)

    root = tmp_path / "repo"
    root.mkdir()
    # 5 files at 1 KB each → first two fit (2048 bytes), the rest cap-cut.
    for i in range(5):
        (root / f"note{i:02d}.md").write_text("a" * 1000 + "\n", encoding="utf-8")

    combined, files = hr._collect_markdown_for_standardize(root)
    # Walker is breadth-first sorted; first 2 files should win.
    assert "note00.md" in files
    assert "note01.md" in files
    assert len(files) <= 2
    assert len(combined) <= 4096  # well under the cap + headers


def test_import_wiki_rejects_unknown_mode(multi_tenant_app):
    """Pydantic accepts any string, so the endpoint must validate the
    mode itself. Anything other than verbatim/standardize → 400 (not
    500, not silent fallback)."""
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post(
        "/onboarding/import-wiki",
        json={
            "github_url": "https://github.com/test/repo",
            "mode": "magic",
            "force_overwrite": True,  # bypass empty-tenant guard
        },
    )
    assert r.status_code == 400
    assert "verbatim" in r.text.lower() or "standardize" in r.text.lower()


# ---------------------------------------------------------------------------
# /public-config — canonical-host echo for personal-LLM-URL flow
# ---------------------------------------------------------------------------


def test_public_config_echoes_request_host_when_www_twin(monkeypatch):
    """User-reported bug pinned here.

    A user pasted ``https://portablellm.wiki/<tenant>/llm?t=<token>``
    (apex) into ChatGPT. Vercel 307s apex → www. ChatGPT's browse
    layer blocks cross-host redirects as unsafe; the fetch failed; the
    model fabricated "I can't access that URL".

    The URL came from the Personal LLM URL panel, which builds it via
    ``${publicBaseUrl}/<tenant>/llm?t=<tok>`` where ``publicBaseUrl``
    came from this endpoint. Before the fix, ``/public-config`` always
    returned the env-configured ``PUBLIC_BASE_URL`` verbatim — apex in
    production — even when the request was arriving via www. The fix:
    in hosted mode, echo the request's actual host back when it's the
    apex/www twin of the configured base, so URLs the user hands out
    don't need any redirect to reach their destination.
    """
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://portablellm.wiki")
    monkeypatch.setenv("SINGLE_TENANT_MODE", "0")
    monkeypatch.setenv("SESSION_SECRET", "test-secret-must-be-long-enough")
    import app.config
    import app.main as app_main

    importlib.reload(app.config)
    importlib.reload(app_main)

    from fastapi.testclient import TestClient

    client = TestClient(app_main.app)

    # When the request arrives via www (the realistic case — Vercel
    # 307s apex → www so users browsing live mostly land on www), the
    # response should be the www variant so the URL handed out has no
    # redirect to follow.
    r = client.get(
        "/public-config", headers={"x-forwarded-host": "www.portablellm.wiki"}
    )
    assert r.status_code == 200
    assert r.json()["public_base_url"] == "https://www.portablellm.wiki"

    # When the request arrives via apex directly, the apex is the
    # canonical destination (no redirect from apex-to-itself) so we
    # echo apex back.
    r = client.get(
        "/public-config", headers={"x-forwarded-host": "portablellm.wiki"}
    )
    assert r.status_code == 200
    assert r.json()["public_base_url"] == "https://portablellm.wiki"


def test_public_config_when_env_configured_as_www(monkeypatch):
    """Symmetric case: if PUBLIC_BASE_URL is configured as the www
    variant, apex requests should still be echoed back honestly. Both
    apex and www must work in both directions so the right URL is
    minted no matter which host the owner happens to be on."""
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://www.portablellm.wiki")
    monkeypatch.setenv("SINGLE_TENANT_MODE", "0")
    monkeypatch.setenv("SESSION_SECRET", "test-secret-must-be-long-enough")
    import app.config
    import app.main as app_main

    importlib.reload(app.config)
    importlib.reload(app_main)

    from fastapi.testclient import TestClient

    client = TestClient(app_main.app)

    r = client.get(
        "/public-config", headers={"x-forwarded-host": "portablellm.wiki"}
    )
    assert r.json()["public_base_url"] == "https://portablellm.wiki"

    r = client.get(
        "/public-config", headers={"x-forwarded-host": "www.portablellm.wiki"}
    )
    assert r.json()["public_base_url"] == "https://www.portablellm.wiki"


def test_public_config_ignores_lookalike_hosts(monkeypatch):
    """The host-echo logic must only fire for genuine apex/www twins.
    A request claiming ``evil.portablellm.wiki`` or
    ``portablellm.wiki.attacker.com`` as its host must NOT cause us to
    hand back ``https://evil.portablellm.wiki`` as a canonical base —
    that would be an open-redirect amplifier and a phishing assist."""
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://portablellm.wiki")
    monkeypatch.setenv("SINGLE_TENANT_MODE", "0")
    monkeypatch.setenv("SESSION_SECRET", "test-secret-must-be-long-enough")
    import app.config
    import app.main as app_main

    importlib.reload(app.config)
    importlib.reload(app_main)

    from fastapi.testclient import TestClient

    client = TestClient(app_main.app)

    for evil in (
        "evil.portablellm.wiki",
        "wwwx.portablellm.wiki",
        "portablellm.wiki.evil.com",
        "wiki.evil.com",
        "attacker.com",
    ):
        r = client.get("/public-config", headers={"x-forwarded-host": evil})
        assert r.json()["public_base_url"] == "https://portablellm.wiki", (
            f"lookalike host {evil!r} should NOT be echoed; got {r.json()!r}"
        )


def test_public_config_single_tenant_mode_unchanged(monkeypatch):
    """Single-tenant / OSS / self-host installs may be reachable on any
    host (tunneled localhost, custom domain, plain HTTP, whatever) and
    should NEVER have their PUBLIC_BASE_URL second-guessed by the
    request host. The apex/www logic is hosted-mode-only."""
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://localhost:3000")
    monkeypatch.setenv("SINGLE_TENANT_MODE", "1")
    monkeypatch.setenv("SESSION_SECRET", "test-secret-must-be-long-enough")
    import app.config
    import app.main as app_main

    importlib.reload(app.config)
    importlib.reload(app_main)

    from fastapi.testclient import TestClient

    client = TestClient(app_main.app)

    # Even if the request claims a weird host, single-tenant mode
    # echoes the env-configured base verbatim.
    r = client.get(
        "/public-config", headers={"x-forwarded-host": "www.portablellm.wiki"}
    )
    assert r.json()["public_base_url"] == "http://localhost:3000"


# ---------------------------------------------------------------------------
# Product-source-repo guard
# ---------------------------------------------------------------------------
#
# Refuse to bind a tenant's wiki to the portable-llm-wiki product source
# code repo. Without this guard, a user can OAuth in and accidentally
# pick a fork of the product source from the existing-repos dropdown
# (or land on it via the convention auto-bind if they named their fork
# "portable-llm-wiki"). That binding pushes wiki edits into a repo full
# of source code, surfaces tenant.json in the working tree, and lets
# force-reset replace the user's wiki with the app code. We detect the
# product source by the unambiguous signature: both `backend/` AND
# `frontend/` directories at the repo root.


def _product_source_tree(branch: str = "main") -> dict:
    """A fake `git/trees/{branch}` payload that LOOKS like the
    portable-llm-wiki product source: backend/ + frontend/ at root."""
    return {
        "sha": "abc",
        "tree": [
            {"path": "README.md", "type": "blob", "mode": "100644", "sha": "1"},
            {"path": "backend", "type": "tree", "mode": "040000", "sha": "2"},
            {"path": "frontend", "type": "tree", "mode": "040000", "sha": "3"},
            {"path": "scripts", "type": "tree", "mode": "040000", "sha": "4"},
        ],
    }


def _personal_wiki_tree() -> dict:
    """A fake `git/trees/{branch}` payload that looks like a user's
    actual wiki: wiki/ + raw/, no app code."""
    return {
        "sha": "def",
        "tree": [
            {"path": "README.md", "type": "blob", "mode": "100644", "sha": "5"},
            {"path": "wiki", "type": "tree", "mode": "040000", "sha": "6"},
            {"path": "raw", "type": "tree", "mode": "040000", "sha": "7"},
        ],
    }


def _stub_github_for_connect(
    monkeypatch, *, tree_payload: dict, repo_full_name: str = "alice/some-repo"
) -> None:
    """Patch github_api so connect-repo + the product-source check see a
    deterministic remote without actually hitting GitHub. The product
    guard fires when get_repo_root_entries returns backend/+frontend/."""
    import app.github_api as gh_api

    async def fake_get_repo(token, full_name):
        return {
            "full_name": full_name,
            "default_branch": "main",
            "private": True,
            "html_url": f"https://github.com/{full_name}",
        }

    async def fake_get_root_entries(token, full_name, branch=""):
        tree = tree_payload.get("tree", [])
        return [
            {
                "path": str(e.get("path") or ""),
                "type": str(e.get("type") or ""),
                "mode": str(e.get("mode") or ""),
                "sha": str(e.get("sha") or ""),
            }
            for e in tree
            if "/" not in str(e.get("path") or "")
        ]

    async def fake_create_repo(token, *, name, description="", private=True, auto_init=True):
        return {
            "full_name": f"alice/{name}",
            "default_branch": "main",
            "html_url": f"https://github.com/alice/{name}",
        }

    monkeypatch.setattr(gh_api, "get_repo", fake_get_repo)
    monkeypatch.setattr(gh_api, "get_repo_root_entries", fake_get_root_entries)
    monkeypatch.setattr(gh_api, "create_repo", fake_create_repo)


def _seed_token_on(multi_tenant_app, tenant_id: str = "alice") -> None:
    """Set a fake gh_token on the seeded tenant so the connect-repo
    endpoint's 401-no-token branch doesn't fire."""
    import app.tenants as tenants_mod

    mgr = tenants_mod.manager()
    t = mgr.require(tenant_id)
    t.gh_token = "fake-oauth-token-test-only"
    t.gh_login = tenant_id
    mgr.upsert(t)


def test_connect_repo_refuses_product_source_existing(
    multi_tenant_app, monkeypatch
):
    """Using an existing repo whose root has backend/ + frontend/ is
    refused with a 400 — user picked the product source by mistake.

    Critical assertions:
    * 400, not 502 (this is a user error, not a GitHub API failure).
    * Error message names BOTH directories so the user understands the
      signature ("backend/" + "frontend/").
    * Suggests creating a NEW repo as the fix.
    * tenant.gh_repo is NOT written (the rejection happens before the
      mutation, so the tenant stays in a clean disconnected state).
    """
    _seed_token_on(multi_tenant_app, "alice")
    _stub_github_for_connect(monkeypatch, tree_payload=_product_source_tree())
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": False, "repo": "alice/portable-llm-wiki-fork"},
    )
    assert r.status_code == 400, r.text
    body = r.json()
    detail = (body.get("detail") or "").lower()
    assert "product source" in detail or "backend" in detail
    assert "different" in detail or "fresh" in detail or "create" in detail

    # Tenant must still be disconnected — no gh_repo write.
    import app.tenants as tenants_mod

    t = tenants_mod.manager().require("alice")
    assert t.gh_repo == "", f"expected no binding; got gh_repo={t.gh_repo!r}"


def test_connect_repo_refuses_product_source_create_new_idempotent(
    multi_tenant_app, monkeypatch
):
    """create_new=True with name="portable-llm-wiki" is idempotent on
    GitHub's side — if the user already has a fork at that name,
    create_repo returns the existing repo. We need to catch that case
    too: the user clicked 'mint a new repo' but actually got back
    their pre-existing product fork. Without the post-create guard
    they'd silently bind to it."""
    _seed_token_on(multi_tenant_app, "alice")
    _stub_github_for_connect(monkeypatch, tree_payload=_product_source_tree())
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": True, "name": "portable-llm-wiki"},
    )
    assert r.status_code == 400, r.text
    assert "product source" in r.text.lower() or "backend" in r.text.lower()

    import app.tenants as tenants_mod

    t = tenants_mod.manager().require("alice")
    assert t.gh_repo == ""


def test_connect_repo_allows_real_wiki(multi_tenant_app, monkeypatch):
    """The guard must NOT false-positive on a normal user wiki.
    wiki/+raw/ at root is the expected shape; binding proceeds."""
    _seed_token_on(multi_tenant_app, "alice")
    _stub_github_for_connect(monkeypatch, tree_payload=_personal_wiki_tree())
    # Bootstrap path needs git available; the actual bootstrap is
    # exercised by other tests. Here we just need the connect call to
    # get PAST the product-source check.
    import app.persistence as persistence_mod

    def fake_bootstrap(tenant):
        tenant.gh_default_branch = "main"
        return {"ok": True, "action": "noop"}

    monkeypatch.setattr(persistence_mod, "bootstrap_tenant", fake_bootstrap)
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": False, "repo": "alice/my-wiki"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["repo"] == "alice/my-wiki"

    import app.tenants as tenants_mod

    t = tenants_mod.manager().require("alice")
    assert t.gh_repo == "alice/my-wiki"


def test_connect_repo_overwrites_previous_binding(
    multi_tenant_app, monkeypatch
):
    """A tenant that's already bound to one repo MUST be able to switch
    to a different one via the same endpoint. This is the load-bearing
    path for the owner-console "Switch wiki repo" button: a user who
    accidentally bound to the wrong repo (e.g. a product-source fork
    from before the guard shipped) needs a way to relocate without
    deleting their tenant and starting over.

    Pins three guarantees:
    * The new ``gh_repo`` overwrites the old one in the tenant record.
    * The default branch is updated from the new repo's metadata.
    * The product-source guard still fires on the NEW repo (you can't
      sidestep the guard by re-binding).
    """
    _seed_token_on(multi_tenant_app, "alice")
    _stub_github_for_connect(monkeypatch, tree_payload=_personal_wiki_tree())

    import app.persistence as persistence_mod
    import app.tenants as tenants_mod

    # Seed an OLD binding to simulate the user-stuck-on-wrong-repo case.
    mgr = tenants_mod.manager()
    t = mgr.require("alice")
    t.gh_repo = "alice/old-stuck-repo"
    t.gh_default_branch = "trunk"
    t.git_last_error = "git push failed: non-fast-forward"
    mgr.upsert(t)

    # Bootstrap is exercised by other tests; here we only need the
    # binding-update side-effects to be visible.
    bootstrap_calls: list[str] = []

    def fake_bootstrap(tenant):
        bootstrap_calls.append(tenant.gh_repo or "")
        tenant.gh_default_branch = "main"
        return {"ok": True, "action": "synced"}

    monkeypatch.setattr(persistence_mod, "bootstrap_tenant", fake_bootstrap)
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": False, "repo": "alice/cary-wiki"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["repo"] == "alice/cary-wiki"

    t_after = mgr.require("alice")
    assert t_after.gh_repo == "alice/cary-wiki"
    assert t_after.gh_default_branch == "main"
    # Confirm bootstrap_tenant ran AFTER the binding was updated, not
    # before — otherwise the new clone would target the old remote.
    assert bootstrap_calls == ["alice/cary-wiki"]


def test_connect_repo_overwrite_still_blocks_product_source(
    multi_tenant_app, monkeypatch
):
    """Switching repos must NOT bypass the product-source guard.
    Without this assertion a user could escape the guard by first
    binding to a wiki repo and then re-binding to a product-source
    fork (which is the exact attack the guard exists to prevent)."""
    _seed_token_on(multi_tenant_app, "alice")
    # The new repo looks like a product source fork — guard must fire.
    _stub_github_for_connect(
        monkeypatch,
        tree_payload={
            "sha": "abc",
            "tree": [
                {"path": "backend", "type": "tree", "mode": "040000", "sha": "1"},
                {"path": "frontend", "type": "tree", "mode": "040000", "sha": "2"},
            ],
        },
    )

    import app.persistence as persistence_mod
    import app.tenants as tenants_mod

    mgr = tenants_mod.manager()
    t = mgr.require("alice")
    t.gh_repo = "alice/legit-wiki"
    mgr.upsert(t)

    monkeypatch.setattr(
        persistence_mod,
        "bootstrap_tenant",
        lambda t: {"ok": True, "action": "noop"},
    )
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": False, "repo": "alice/portable-llm-wiki"},
    )
    assert r.status_code == 400, r.text
    assert "product source" in r.text.lower()

    # Old binding must be intact — refused connect leaves state alone.
    assert mgr.require("alice").gh_repo == "alice/legit-wiki"


def test_connect_repo_guard_fails_open_on_github_5xx(
    multi_tenant_app, monkeypatch
):
    """If the trees-API call fails (GitHub 5xx, rate-limit, network
    timeout), we MUST let the connection proceed. Refusing every repo
    whenever GitHub is flaky would make onboarding feel broken during
    outages. A determined attacker connecting during an outage is a
    smaller bad than legitimate users locked out by transient
    failures."""
    _seed_token_on(multi_tenant_app, "alice")

    import app.github_api as gh_api
    import app.persistence as persistence_mod

    async def fake_get_repo(token, full_name):
        return {"full_name": full_name, "default_branch": "main"}

    async def boom_get_root(token, full_name, branch=""):
        raise gh_api.GitHubAPIError(503, "GitHub is down")

    monkeypatch.setattr(gh_api, "get_repo", fake_get_repo)
    monkeypatch.setattr(gh_api, "get_repo_root_entries", boom_get_root)
    monkeypatch.setattr(
        persistence_mod,
        "bootstrap_tenant",
        lambda t: {"ok": True, "action": "noop"},
    )
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.post(
        "/onboarding/connect-repo",
        json={"create_new": False, "repo": "alice/my-wiki"},
    )
    assert r.status_code == 200, r.text


def test_entries_look_like_product_source_helper():
    """Direct unit-test of the predicate. Pin the exact rules so a
    future refactor can't accidentally widen the signature (and
    start rejecting normal repos) or narrow it (and let product
    forks through).

    Rules being pinned:
    * Empty tree → False (we never reject a repo we couldn't inspect).
    * Only one of backend/+frontend/ present → False.
    * Both present as files (not trees) → False (cheap defense
      against a user whose repo happens to have files named
      'backend' and 'frontend').
    * Both present as directories (type='tree') → True.
    """
    from app.hosted_routes import _entries_look_like_product_source

    assert _entries_look_like_product_source([]) is False
    assert (
        _entries_look_like_product_source(
            [{"path": "backend", "type": "tree"}]
        )
        is False
    )
    assert (
        _entries_look_like_product_source(
            [{"path": "frontend", "type": "tree"}]
        )
        is False
    )
    assert (
        _entries_look_like_product_source(
            [
                {"path": "backend", "type": "blob"},
                {"path": "frontend", "type": "blob"},
            ]
        )
        is False
    )
    assert (
        _entries_look_like_product_source(
            [
                {"path": "backend", "type": "tree"},
                {"path": "frontend", "type": "tree"},
            ]
        )
        is True
    )


# ---------------------------------------------------------------------------
# Force-reset preview endpoint
# ---------------------------------------------------------------------------


def test_preview_force_reset_returns_full_payload(multi_tenant_app, monkeypatch):
    """The endpoint must surface ahead/behind counts, dirty files, untracked
    files, and a sample of commits to lose/gain so the UI can build an
    informative type-to-confirm modal. Without this preview the user
    clicking force-reset is blind."""
    _seed_token_on(multi_tenant_app, "alice")
    # Bind a repo so the endpoint doesn't 409.
    import app.tenants as tenants_mod

    t = tenants_mod.manager().require("alice")
    t.gh_repo = "alice/my-wiki"
    t.gh_default_branch = "main"
    tenants_mod.manager().upsert(t)
    (t.wiki_root / ".git").mkdir(parents=True, exist_ok=True)

    import app.persistence as persistence_mod

    def fake_preview(tenant):
        return {
            "ok": True,
            "error": None,
            "branch": "main",
            "behind": 3,
            "ahead": 2,
            "dirty_files": [
                {"status": "M", "path": "wiki/entities/cary.md", "kind": "modified"},
            ],
            "untracked_files": ["wiki/.scratch.md"],
            "commits_to_lose": [
                {"sha": "abc123", "subject": "wip: fix typo"},
                {"sha": "def456", "subject": "wip: add page"},
            ],
            "commits_to_lose_total": 2,
            "commits_to_gain": [
                {"sha": "111", "subject": "remote: edit"},
                {"sha": "222", "subject": "remote: another"},
                {"sha": "333", "subject": "remote: third"},
            ],
            "commits_to_gain_total": 3,
        }

    monkeypatch.setattr(persistence_mod, "preview_force_reset", fake_preview)
    _set_session_user(multi_tenant_app, "alice", login="alice")

    r = multi_tenant_app.get("/owner/sync/preview-force-reset")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    preview = body["preview"]
    assert preview["branch"] == "main"
    assert preview["ahead"] == 2
    assert preview["behind"] == 3
    assert len(preview["dirty_files"]) == 1
    assert preview["dirty_files"][0]["path"] == "wiki/entities/cary.md"
    assert preview["untracked_files"] == ["wiki/.scratch.md"]
    assert preview["commits_to_lose_total"] == 2
    assert preview["commits_to_gain_total"] == 3
    # Sanity: status envelope still attached.
    assert "status" in body


def test_preview_force_reset_409s_when_no_repo_connected(multi_tenant_app):
    """If the tenant never connected a GitHub repo, the preview is
    nonsensical — there's nothing to reset against. The 409 mirrors
    the same shape POST /owner/sync/pull uses."""
    _seed_token_on(multi_tenant_app, "alice")
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.get("/owner/sync/preview-force-reset")
    assert r.status_code == 409
    assert "no connected" in r.text.lower() or "repo" in r.text.lower()


def test_preview_force_reset_requires_auth(multi_tenant_app):
    """Without a session cookie the endpoint must 401 — preview reveals
    local file paths and commit subjects, which are tier-private by
    definition."""
    r = multi_tenant_app.get("/owner/sync/preview-force-reset")
    assert r.status_code == 401


# Direct (no-HTTP) tests of preview_force_reset() against a real git
# repo. Pins down the parsing of porcelain status + the rev-list
# fallbacks. Uses a tmp_path-backed repo to avoid the heavy
# multi_tenant_app fixture for plain unit coverage.


def test_persistence_porcelain_status_parses_modified_and_untracked(tmp_path):
    """``git status --porcelain`` output must be split into modified
    (status != '??') vs untracked rows so the UI can show 'discarded'
    vs 'survived' separately. Untracked files are NOT touched by
    git reset --hard."""
    import subprocess

    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "--allow-empty", "-m", "init", "-q"],
        cwd=root,
        check=True,
    )
    # One tracked-then-modified file + one untracked.
    (root / "tracked.md").write_text("v1", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-m", "add tracked", "-q"],
        cwd=root,
        check=True,
    )
    (root / "tracked.md").write_text("v2", encoding="utf-8")
    (root / "untracked.md").write_text("new", encoding="utf-8")

    from app import persistence as persistence_mod

    rows = persistence_mod._porcelain_status(root)
    by_kind = {r["kind"]: r["path"] for r in rows}
    assert by_kind.get("modified") == "tracked.md"
    assert by_kind.get("untracked") == "untracked.md"


def test_persistence_preview_force_reset_against_real_repo(tmp_path):
    """End-to-end smoke against a real two-branch git repo: local
    HEAD diverges from origin/main by N commits, working tree dirty,
    one untracked file. The preview should report all of that
    accurately so the UI shows the user EXACTLY what they're about
    to nuke."""
    import subprocess

    # Build a fake "origin" bare repo + a working clone with divergence.
    bare = tmp_path / "origin.git"
    work = tmp_path / "work"
    subprocess.run(["git", "init", "--bare", str(bare), "-q"], check=True)
    subprocess.run(["git", "clone", "-q", str(bare), str(work)], check=True)
    env_args = ["-c", "user.email=t@t", "-c", "user.name=t"]
    # Initial commit on main.
    (work / "README.md").write_text("hello", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=work, check=True)
    subprocess.run(["git", *env_args, "commit", "-m", "init", "-q"], cwd=work, check=True)
    subprocess.run(["git", "branch", "-M", "main"], cwd=work, check=True)
    subprocess.run(["git", "push", "-u", "origin", "main", "-q"], cwd=work, check=True)
    # Diverge: local commit ahead of origin.
    (work / "local_only.md").write_text("local", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=work, check=True)
    subprocess.run(["git", *env_args, "commit", "-m", "local ahead", "-q"], cwd=work, check=True)
    # Dirty working tree.
    (work / "README.md").write_text("modified", encoding="utf-8")
    (work / "scratch.md").write_text("untracked", encoding="utf-8")

    # Forge a minimal Tenant pointing at the working repo.
    from app import persistence as persistence_mod
    from dataclasses import dataclass
    from pathlib import Path as _P

    @dataclass
    class _FakeTenant:
        wiki_root: _P
        gh_repo: str = "fake/fake"
        gh_token: str = "fake-token"
        gh_default_branch: str = "main"
        git_last_error: str = ""

    tenant = _FakeTenant(wiki_root=work)

    # Avoid actually hitting GitHub for the fetch (the bare repo isn't
    # a real remote URL we can authenticate to). Patch the remote URL
    # builder so set-url is a no-op, and let fetch from the local
    # bare repo go through as-is — the bare clone already has the
    # commits we pushed.
    persistence_mod._tenant_remote_url = lambda t: str(bare)  # type: ignore[assignment]

    preview = persistence_mod.preview_force_reset(tenant)
    assert preview["ok"] is True
    assert preview["branch"] == "main"
    # 1 local commit ahead of origin, 0 behind (origin hasn't moved).
    assert preview["ahead"] == 1
    assert preview["behind"] == 0
    # README modified + scratch untracked.
    dirty_paths = [r["path"] for r in preview["dirty_files"]]
    assert "README.md" in dirty_paths
    assert "scratch.md" in preview["untracked_files"]
    # The commit-to-lose sample should include our 'local ahead' commit.
    lose_subjects = " ".join(c["subject"] for c in preview["commits_to_lose"])
    assert "local ahead" in lose_subjects


# ---------------------------------------------------------------------------
# Wiki-repo convention name (defense-in-depth vs product-source collision)
# ---------------------------------------------------------------------------
#
# The convention name we look for at cold-start auto-bind was historically
# the same string as the product source repo ("portable-llm-wiki"). That
# collision caused a real OAuth token leak (commit 879f45b) when GitHub's
# idempotent POST /user/repos silently returned a user's product fork
# instead of creating a fresh wiki repo. We've since:
#
#   1. Renamed the convention to ``my-portable-llm-wiki`` (no collision
#      possible on the happy path).
#   2. Kept the OLD name as a legacy fallback so existing tenants from
#      before the rename still auto-bind (their actual personal wikis
#      are still named ``portable-llm-wiki``).
#   3. The product-source guard (`_check_not_product_source`) still
#      catches the case where a user has a fork of the product at the
#      LEGACY name — it skips that candidate rather than binding.
#
# These tests pin the order: try new first, fall back to legacy only if
# the new doesn't exist.


def test_convention_name_default_is_my_prefixed():
    """The default for create-new and the auto-bind convention must be
    ``my-portable-llm-wiki`` — distinct from the product source name.

    Pinned because a future refactor that "simplifies" by removing the
    ``my-`` prefix would reintroduce the silent-collision footgun.
    """
    from app.hosted_routes import _CONVENTIONAL_WIKI_REPO_NAME
    from app.github_api import create_repo
    from app.hosted_routes import ConnectRepoRequest
    import inspect

    assert _CONVENTIONAL_WIKI_REPO_NAME == "my-portable-llm-wiki"
    # github_api.create_repo signature default.
    sig = inspect.signature(create_repo)
    assert sig.parameters["name"].default == "my-portable-llm-wiki"
    # Pydantic model default for the connect-repo body.
    fields = ConnectRepoRequest.model_fields  # type: ignore[attr-defined]
    assert fields["name"].default == "my-portable-llm-wiki"


def test_convention_auto_bind_picks_new_name_first(multi_tenant_app, monkeypatch):
    """When the user has BOTH ``<login>/my-portable-llm-wiki`` and the
    legacy ``<login>/portable-llm-wiki``, auto-bind on cold start prefers
    the new name. Otherwise existing tenants would silently migrate
    back to the legacy name on every login."""
    import asyncio
    from app import github_api as gh_api
    from app import hosted_routes
    from app import persistence as persistence_mod
    import app.tenants as tenants_mod

    _seed_token_on(multi_tenant_app, "alice")
    tenant = tenants_mod.manager().require("alice")
    tenant.gh_repo = ""  # disconnected starting state
    tenants_mod.manager().upsert(tenant)

    calls: list[str] = []

    async def fake_get_repo(token, full_name):
        calls.append(full_name)
        return {"full_name": full_name, "default_branch": "main"}

    async def fake_get_root_entries(token, full_name, branch=""):
        # Personal-wiki shape — not product source.
        return [{"path": "wiki", "type": "tree"}, {"path": "raw", "type": "tree"}]

    bootstrap_called: list[str] = []

    def fake_bootstrap(t):
        bootstrap_called.append(t.gh_repo)
        return {"ok": True}

    monkeypatch.setattr(gh_api, "get_repo", fake_get_repo)
    monkeypatch.setattr(gh_api, "get_repo_root_entries", fake_get_root_entries)
    monkeypatch.setattr(persistence_mod, "bootstrap_tenant", fake_bootstrap)

    asyncio.get_event_loop().run_until_complete(
        hosted_routes._hydrate_tenant_from_github(tenant)
    )

    refreshed = tenants_mod.manager().require("alice")
    assert refreshed.gh_repo == "alice/my-portable-llm-wiki"
    # First lookup should be the new name. We don't care if the
    # legacy name was checked too — what matters is the new name won.
    assert calls[0] == "alice/my-portable-llm-wiki"
    assert bootstrap_called == ["alice/my-portable-llm-wiki"]


def test_convention_auto_bind_falls_back_to_legacy_name(
    multi_tenant_app, monkeypatch
):
    """When the new-convention repo doesn't exist but the legacy one
    does, auto-bind uses the legacy name. Without this, a tenant who
    onboarded before the 2026-05 rename loses their auto-bind on the
    next cold start and lands on the welcome flow even though they
    already have a working wiki repo."""
    import asyncio
    from app import github_api as gh_api
    from app import hosted_routes
    from app import persistence as persistence_mod
    import app.tenants as tenants_mod

    _seed_token_on(multi_tenant_app, "alice")
    tenant = tenants_mod.manager().require("alice")
    tenant.gh_repo = ""
    tenants_mod.manager().upsert(tenant)

    async def fake_get_repo(token, full_name):
        # Only the legacy name exists; new-convention 404s.
        if full_name == "alice/portable-llm-wiki":
            return {"full_name": full_name, "default_branch": "main"}
        raise gh_api.GitHubAPIError(404, "not found")

    async def fake_get_root_entries(token, full_name, branch=""):
        return [{"path": "wiki", "type": "tree"}, {"path": "raw", "type": "tree"}]

    monkeypatch.setattr(gh_api, "get_repo", fake_get_repo)
    monkeypatch.setattr(gh_api, "get_repo_root_entries", fake_get_root_entries)
    monkeypatch.setattr(
        persistence_mod, "bootstrap_tenant", lambda t: {"ok": True}
    )

    asyncio.get_event_loop().run_until_complete(
        hosted_routes._hydrate_tenant_from_github(tenant)
    )

    refreshed = tenants_mod.manager().require("alice")
    assert refreshed.gh_repo == "alice/portable-llm-wiki"


def test_convention_auto_bind_skips_product_fork_at_legacy_name(
    multi_tenant_app, monkeypatch
):
    """Critical safety case. The user has a fork of the product source
    at the LEGACY convention name (``<login>/portable-llm-wiki`` with
    backend/+frontend/ at root). The legacy fallback must NOT bind to
    it — the product-source guard runs per candidate. Otherwise the
    rename + guard combo wouldn't actually protect this user."""
    import asyncio
    from app import github_api as gh_api
    from app import hosted_routes
    from app import persistence as persistence_mod
    import app.tenants as tenants_mod

    _seed_token_on(multi_tenant_app, "alice")
    tenant = tenants_mod.manager().require("alice")
    tenant.gh_repo = ""
    tenants_mod.manager().upsert(tenant)

    async def fake_get_repo(token, full_name):
        # Only the legacy name exists. New convention doesn't.
        if full_name == "alice/portable-llm-wiki":
            return {"full_name": full_name, "default_branch": "main"}
        raise gh_api.GitHubAPIError(404, "not found")

    async def fake_get_root_entries(token, full_name, branch=""):
        # Product-source shape: backend/ + frontend/ at root.
        return [
            {"path": "backend", "type": "tree"},
            {"path": "frontend", "type": "tree"},
            {"path": "README.md", "type": "blob"},
        ]

    bootstrap_called = []
    monkeypatch.setattr(gh_api, "get_repo", fake_get_repo)
    monkeypatch.setattr(gh_api, "get_repo_root_entries", fake_get_root_entries)
    monkeypatch.setattr(
        persistence_mod,
        "bootstrap_tenant",
        lambda t: bootstrap_called.append(t.gh_repo) or {"ok": True},
    )

    asyncio.get_event_loop().run_until_complete(
        hosted_routes._hydrate_tenant_from_github(tenant)
    )

    refreshed = tenants_mod.manager().require("alice")
    # Critical: must NOT have bound to the product fork.
    assert refreshed.gh_repo == ""
    assert bootstrap_called == []


# ---------------------------------------------------------------------------
# Red-team hardening: visibility, owner token, Avery bind, assemble caps
# ---------------------------------------------------------------------------


def test_provision_defaults_to_unlisted(multi_tenant_app):
    from app import tenants as _tenants

    tenant = _tenants.manager().provision_local("carol", display_name="Carol")
    assert tenant.visibility == "unlisted"
    assert tenant.is_demo is False


def test_tenants_list_excludes_unlisted(multi_tenant_app):
    from app import tenants as _tenants

    carol = _tenants.manager().provision_local("carol", display_name="Carol")
    assert carol.visibility == "unlisted"

    r = multi_tenant_app.get("/tenants")
    ids = {t["id"] for t in r.json()["tenants"]}
    assert "alice" in ids
    assert "carol" not in ids

    r = multi_tenant_app.get("/tenants/carol")
    assert r.status_code == 200
    assert r.json()["visibility"] == "unlisted"

    carol.visibility = "private"
    _tenants.manager().upsert(carol)
    assert _tenants.manager().get("carol").visibility == "private"
    r = multi_tenant_app.get("/tenants/carol")
    assert r.status_code == 404


def test_owner_sets_tenant_visibility(multi_tenant_app):
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post(
        "/t/alice/owner/tenant/visibility",
        json={"visibility": "private"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["visibility"] == "private"

    r = multi_tenant_app.get("/tenants/alice")
    assert r.status_code == 404

    r = multi_tenant_app.post(
        "/t/alice/owner/tenant/visibility",
        json={"visibility": "unlisted"},
    )
    assert r.status_code == 200
    r = multi_tenant_app.get("/tenants/alice")
    assert r.status_code == 200
    assert r.json()["visibility"] == "unlisted"

    listed = {t["id"] for t in multi_tenant_app.get("/tenants").json()["tenants"]}
    assert "alice" not in listed


def test_hosted_env_owner_token_is_not_master_key(multi_tenant_app, monkeypatch):
    """Process-wide OWNER_TOKEN must not write another tenant in hosted mode."""
    import app.auth as _auth
    import app.config as _config

    monkeypatch.setattr(_config.settings, "owner_token", "hosted-env-token")
    monkeypatch.setattr(_auth.settings, "owner_token", "hosted-env-token")
    monkeypatch.setattr(_config.settings, "hosted_owner_tenant_ids", frozenset())
    monkeypatch.setattr(_auth.settings, "hosted_owner_tenant_ids", frozenset())

    r = multi_tenant_app.post(
        "/t/bob/owner/reload",
        headers={"Authorization": "Bearer hosted-env-token"},
    )
    assert r.status_code == 401, r.text

    _set_session_user(multi_tenant_app, "bob", login="bob")
    r = multi_tenant_app.post("/t/bob/owner/reload")
    assert r.status_code == 200, r.text


def test_hosted_owner_token_allowlist_is_tenant_scoped(multi_tenant_app, monkeypatch):
    """HOSTED_OWNER_TENANT_IDS elevates OWNER_TOKEN for listed tenants only."""
    import app.auth as _auth
    import app.config as _config

    monkeypatch.setattr(_config.settings, "owner_token", "hosted-env-token")
    monkeypatch.setattr(_auth.settings, "owner_token", "hosted-env-token")
    allowed = frozenset({"alice"})
    monkeypatch.setattr(_config.settings, "hosted_owner_tenant_ids", allowed)
    monkeypatch.setattr(_auth.settings, "hosted_owner_tenant_ids", allowed)

    r = multi_tenant_app.post(
        "/t/alice/owner/reload",
        headers={"Authorization": "Bearer hosted-env-token"},
    )
    assert r.status_code == 200, r.text

    r = multi_tenant_app.post(
        "/t/bob/owner/reload",
        headers={"Authorization": "Bearer hosted-env-token"},
    )
    assert r.status_code == 401, r.text


def test_demo_tenant_writes_rejected(multi_tenant_app):
    _set_session_user(multi_tenant_app, "avery", login="avery")
    r = multi_tenant_app.post("/t/avery/owner/reload")
    assert r.status_code == 403
    assert "demo" in r.json()["detail"].lower()


def test_github_callback_refuses_reserved_and_demo(multi_tenant_app, monkeypatch):
    from app import github_api
    from app.github_api import GitHubUser

    async def fake_exchange(**_kwargs):
        return "tok"

    def _user(login: str) -> GitHubUser:
        return GitHubUser(
            id=99,
            login=login,
            name=login,
            avatar_url="",
            bio="",
            email="",
            company="",
            blog="",
            location="",
            twitter_username="",
            html_url="",
        )

    monkeypatch.setattr(github_api, "exchange_oauth_code", fake_exchange)

    async def fake_avery(_token):
        return _user("avery")

    monkeypatch.setattr(github_api, "get_user", fake_avery)

    import json as _json
    import base64
    import itsdangerous

    payload = {"oauth_state": "state-avery"}
    data = base64.b64encode(_json.dumps(payload).encode("utf-8"))
    signer = itsdangerous.TimestampSigner("test-secret-do-not-use-in-prod")
    multi_tenant_app.cookies.set("plw_session", signer.sign(data).decode("utf-8"))

    r = multi_tenant_app.get(
        "/auth/github/callback?code=abc&state=state-avery",
        follow_redirects=False,
    )
    assert r.status_code == 403, r.text


def test_assemble_rejects_over_cap(multi_tenant_app):
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "urls": [{"url": f"https://example.com/{i}"} for i in range(6)],
        },
    )
    assert r.status_code == 422

    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "answers": [
                {"question": f"Q{i}", "answer": f"A{i}"} for i in range(9)
            ],
        },
    )
    assert r.status_code == 422

    r = multi_tenant_app.post(
        "/onboarding/assemble",
        json={
            "text_sources": [
                {"content": f"text {i}"} for i in range(9)
            ],
        },
    )
    assert r.status_code == 422


def test_logout_post_clears_session(multi_tenant_app):
    _set_session_user(multi_tenant_app, "alice", login="alice")
    r = multi_tenant_app.post("/auth/logout")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # Drop the planted cookie so the client only keeps what Set-Cookie wrote.
    multi_tenant_app.cookies.delete("plw_session")
    r = multi_tenant_app.get("/auth/me")
    assert r.json().get("authenticated") is False
