"""Thin GitHub REST API client.

Used by the hosted onboarding flow:

* :func:`exchange_oauth_code` — swap an OAuth ``code`` for an access token.
* :func:`get_user` — fetch the authenticated user's profile + bio.
* :func:`create_repo` — create ``<owner>/my-portable-llm-wiki`` on the user's
  account (uses ``public_repo`` scope; falls back to private if the user
  requests it).
* :func:`commit_files` — Contents-API style batch write of multiple
  files to a repo (used to seed the repo on signup and to push wiki edits).

All functions are async + use the shared httpx client style already in
use across the codebase.

Failure mode: every function raises :class:`GitHubAPIError` on a non-2xx
response. Callers (auth, onboarding) translate those into 4xx/5xx HTTP
errors with user-friendly messages.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from typing import Optional

import httpx

GITHUB_API = "https://api.github.com"
GITHUB_OAUTH = "https://github.com/login/oauth"

# Scopes we request:
#   * ``read:user`` — show the user their name/avatar after sign-in.
#   * ``repo``      — read + write any of the user's repos, public OR
#                     private. We need private-repo read so the
#                     onboarding "Import existing wiki" picker can list
#                     and clone the user's own private wikis (most users
#                     keep their personal-context wikis private), and
#                     read+write because the existing OSS path creates +
#                     pushes to a portable-llm-wiki repo on their account.
#
# This is broader than the more conservative ``public_repo`` scope we
# used in earlier OAuth-app versions. The trade-off: we get the
# private-repo import flow that users actually want (no PAT to paste),
# at the cost of asking for the full repo scope at consent. Existing
# users signed in with the old scope will need to re-authorize once —
# the onboarding UI detects insufficient scope from the
# ``X-OAuth-Scopes`` header and prompts them to re-sign-in.
DEFAULT_SCOPES = "read:user,repo"


class GitHubAPIError(RuntimeError):
    """Non-success response from the GitHub API."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"GitHub API error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


@dataclass
class GitHubUser:
    """Subset of GitHub's user object that we actually persist."""

    id: int
    login: str
    name: str
    avatar_url: str
    bio: str
    email: str
    company: str
    blog: str
    location: str
    twitter_username: str
    html_url: str

    @classmethod
    def from_api(cls, payload: dict) -> "GitHubUser":
        return cls(
            id=int(payload.get("id", 0) or 0),
            login=str(payload.get("login", "")),
            name=str(payload.get("name") or payload.get("login", "")),
            avatar_url=str(payload.get("avatar_url", "")),
            bio=str(payload.get("bio") or ""),
            email=str(payload.get("email") or ""),
            company=str(payload.get("company") or ""),
            blog=str(payload.get("blog") or ""),
            location=str(payload.get("location") or ""),
            twitter_username=str(payload.get("twitter_username") or ""),
            html_url=str(payload.get("html_url", "")),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "login": self.login,
            "name": self.name,
            "avatar_url": self.avatar_url,
            "bio": self.bio,
            "email": self.email,
            "company": self.company,
            "blog": self.blog,
            "location": self.location,
            "twitter_username": self.twitter_username,
            "html_url": self.html_url,
        }


# ---------------------------------------------------------------------------
# OAuth
# ---------------------------------------------------------------------------


def authorize_url(client_id: str, redirect_uri: str, state: str) -> str:
    """Compose the URL we redirect the user's browser to so GitHub can ask
    them to authorize our OAuth App."""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": DEFAULT_SCOPES,
        "state": state,
        "allow_signup": "true",
    }
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{GITHUB_OAUTH}/authorize?{query}"


async def exchange_oauth_code(
    *,
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
) -> str:
    """POST /login/oauth/access_token — returns the access token string."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f"{GITHUB_OAUTH}/access_token",
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
            },
            headers={"Accept": "application/json"},
        )
    if r.status_code != 200:
        raise GitHubAPIError(r.status_code, r.text[:200])
    payload = r.json()
    if "access_token" not in payload:
        # GitHub returns 200 with an error field if the code is bad.
        raise GitHubAPIError(400, payload.get("error_description") or str(payload))
    return str(payload["access_token"])


# ---------------------------------------------------------------------------
# OAuth token revocation (account-deletion path)
# ---------------------------------------------------------------------------


async def revoke_oauth_token(
    *,
    client_id: str,
    client_secret: str,
    token: str,
) -> bool:
    """DELETE /applications/{client_id}/token — invalidate a single user token.

    Returns True on success (GitHub 204). Returns False on any failure;
    callers treat this as best-effort: if GitHub is down or the token
    was already revoked, we still want the account-delete flow to
    proceed and wipe local state. (The alternative — refusing to delete
    the tenant dir because a third-party API is flaky — would trap the
    user in our service, which is the opposite of "you own your data".)

    GitHub auth here is HTTP Basic with client_id : client_secret, NOT
    the user token itself. The user token goes in the JSON body. See
    https://docs.github.com/en/rest/apps/oauth-applications.
    """
    if not (client_id and client_secret and token):
        return False
    url = f"{GITHUB_API}/applications/{client_id}/token"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.request(
                "DELETE",
                url,
                auth=(client_id, client_secret),
                json={"access_token": token},
                headers={"Accept": "application/vnd.github+json"},
            )
    except httpx.HTTPError:
        return False
    # 204 = revoked. 404 = already invalid (also fine, end state matches).
    return r.status_code in (204, 404)


# ---------------------------------------------------------------------------
# User profile
# ---------------------------------------------------------------------------


async def get_user(token: str) -> GitHubUser:
    """GET /user — the authenticated user."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{GITHUB_API}/user",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    if r.status_code != 200:
        raise GitHubAPIError(r.status_code, r.text[:200])
    return GitHubUser.from_api(r.json())


@dataclass
class GitHubRepo:
    """Subset of GitHub's repo object we surface to the import picker."""

    id: int
    name: str
    full_name: str  # "<owner>/<name>"
    description: str
    private: bool
    default_branch: str
    html_url: str
    clone_url: str  # "https://github.com/<owner>/<name>.git"
    pushed_at: str
    fork: bool
    archived: bool

    @classmethod
    def from_api(cls, payload: dict) -> "GitHubRepo":
        return cls(
            id=int(payload.get("id", 0) or 0),
            name=str(payload.get("name", "")),
            full_name=str(payload.get("full_name", "")),
            description=str(payload.get("description") or ""),
            private=bool(payload.get("private", False)),
            default_branch=str(payload.get("default_branch") or "main"),
            html_url=str(payload.get("html_url", "")),
            clone_url=str(payload.get("clone_url", "")),
            pushed_at=str(payload.get("pushed_at") or ""),
            fork=bool(payload.get("fork", False)),
            archived=bool(payload.get("archived", False)),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "full_name": self.full_name,
            "description": self.description,
            "private": self.private,
            "default_branch": self.default_branch,
            "html_url": self.html_url,
            "clone_url": self.clone_url,
            "pushed_at": self.pushed_at,
            "fork": self.fork,
            "archived": self.archived,
        }


@dataclass
class RepoListing:
    """Result of :func:`list_user_repos` — includes scope-check metadata so
    callers can surface "needs re-auth" UI when the stored OAuth token
    was minted under a narrower scope than we now want."""

    repos: list[GitHubRepo]
    scopes: list[str]  # X-OAuth-Scopes — comma-split, stripped
    has_repo_scope: bool  # True iff the token can list private repos

    def to_dict(self) -> dict:
        return {
            "repos": [r.to_dict() for r in self.repos],
            "scopes": self.scopes,
            "has_repo_scope": self.has_repo_scope,
        }


async def list_user_repos(
    token: str,
    *,
    per_page: int = 100,
    max_pages: int = 4,
) -> RepoListing:
    """GET /user/repos — the authenticated user's repos.

    Returns up to ``per_page * max_pages`` repos (default 400) sorted by
    push recency, plus the OAuth scopes attached to the token so the
    caller can detect "this user signed in before we asked for private-
    repo access — prompt them to re-authorize."

    We page explicitly with ``Link``-header style pagination so that we
    don't accidentally serve only the first 30 (GitHub's default page
    size when ``per_page`` is omitted).
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    repos: list[GitHubRepo] = []
    scopes: list[str] = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for page in range(1, max_pages + 1):
            r = await client.get(
                f"{GITHUB_API}/user/repos",
                headers=headers,
                params={
                    "per_page": per_page,
                    "page": page,
                    "sort": "pushed",
                    "direction": "desc",
                    # "all" = owner + collaborator + organization_member, but
                    # we filter to "owner" so the picker doesn't show 500
                    # org repos the user happens to collaborate on. If
                    # someone really wants to import a collaborator repo
                    # they can paste the URL.
                    "affiliation": "owner",
                },
            )
            if r.status_code != 200:
                raise GitHubAPIError(r.status_code, r.text[:200])
            if not scopes:
                # X-OAuth-Scopes is only on the first response; cache it.
                raw = r.headers.get("X-OAuth-Scopes", "")
                scopes = [s.strip() for s in raw.split(",") if s.strip()]
            batch = [GitHubRepo.from_api(item) for item in r.json()]
            repos.extend(batch)
            if len(batch) < per_page:
                break

    has_repo_scope = "repo" in scopes
    return RepoListing(repos=repos, scopes=scopes, has_repo_scope=has_repo_scope)


async def get_user_readme(token: str, login: str) -> str:
    """Best-effort fetch of <login>/<login>/README.md (GitHub profile README).

    Empty string if the user doesn't have one. Never raises — onboarding
    bio scrape uses this as an enrichment signal, not a hard requirement.
    """
    url = f"{GITHUB_API}/repos/{login}/{login}/readme"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.get(url, headers=headers)
        if r.status_code == 200:
            return r.text
    except Exception:  # noqa: BLE001
        pass
    return ""


# ---------------------------------------------------------------------------
# Repo creation + content writes
# ---------------------------------------------------------------------------


async def get_repo(token: str, full_name: str) -> dict:
    """GET /repos/{owner}/{repo}.

    Returns the GitHub repo object. Raises :class:`GitHubAPIError` with
    status_code=404 if the token can't see the repo (private + no access,
    or repo simply doesn't exist — GitHub doesn't distinguish to avoid
    leaking existence of private repos).
    """
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{GITHUB_API}/repos/{full_name}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    if r.status_code != 200:
        raise GitHubAPIError(r.status_code, r.text[:200])
    return r.json()


async def get_repo_root_entries(
    token: str, full_name: str, branch: str = ""
) -> list[dict]:
    """Return the root-level entries (files + directories) of a repo's
    default branch (or the given branch).

    Uses the Trees API (``GET /repos/{owner}/{repo}/git/trees/{branch}``)
    which is one round-trip and returns a complete listing with type
    information ("blob" vs "tree") in a single response. Costs us no
    additional auth scope vs ``get_repo``.

    Returns a list of dicts shaped like::

        [
          {"path": "README.md",  "type": "blob", "mode": "100644", "sha": "..."},
          {"path": "backend",    "type": "tree", "mode": "040000", "sha": "..."},
          {"path": "frontend",   "type": "tree", "mode": "040000", "sha": "..."},
        ]

    Raises :class:`GitHubAPIError` on non-200 responses. The caller
    should treat any error as "couldn't inspect" and fall back to
    accepting the repo (the alternative — refusing to connect any
    repo we can't list — would block legitimate users whose GitHub is
    transiently 5xx). Used by the product-source-repo guard so the
    user can't accidentally bind their wiki to the portable-llm-wiki
    application source code.
    """
    # Empty branch = let GitHub pick HEAD. We resolve HEAD by calling
    # get_repo first when the caller didn't supply one, because the
    # Trees API needs a concrete ref (branch name, tag, or SHA), not
    # the literal string "HEAD".
    ref = (branch or "").strip()
    if not ref:
        meta = await get_repo(token, full_name)
        ref = meta.get("default_branch") or "main"
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{GITHUB_API}/repos/{full_name}/git/trees/{ref}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    if r.status_code != 200:
        raise GitHubAPIError(r.status_code, r.text[:200])
    body = r.json()
    tree = body.get("tree")
    if not isinstance(tree, list):
        return []
    out: list[dict] = []
    for entry in tree:
        if not isinstance(entry, dict):
            continue
        # Trees API root listing only returns top-level entries —
        # subdirectories show up as type="tree". Defensive filter just
        # in case a future API version changes (recursive=1 would
        # return paths with "/" in them, which we ignore here).
        path = str(entry.get("path") or "")
        if "/" in path:
            continue
        out.append(
            {
                "path": path,
                "type": str(entry.get("type") or ""),
                "mode": str(entry.get("mode") or ""),
                "sha": str(entry.get("sha") or ""),
            }
        )
    return out


async def create_repo(
    token: str,
    *,
    name: str = "my-portable-llm-wiki",
    description: str = "My portable LLM wiki. Vendor-neutral personal context, in markdown.",
    private: bool = False,
    auto_init: bool = True,
) -> dict:
    """POST /user/repos.

    Returns the GitHub repo object (full_name, default_branch, html_url, …).
    If a repo with the same name already exists, we GET that one instead and
    return it — onboarding is idempotent.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{GITHUB_API}/user/repos",
            json={
                "name": name,
                "description": description,
                "private": private,
                "auto_init": auto_init,
                "has_issues": False,
                "has_wiki": False,
                "has_projects": False,
            },
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )

        # Already exists — fetch it. We re-use the existing repo on signup;
        # the user can rename later if they want.
        if r.status_code == 422 and "already exists" in r.text:
            user = await get_user(token)
            r = await client.get(
                f"{GITHUB_API}/repos/{user.login}/{name}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )

    if r.status_code not in (200, 201):
        raise GitHubAPIError(r.status_code, r.text[:200])
    return r.json()


async def put_file(
    token: str,
    *,
    owner: str,
    repo: str,
    path: str,
    content: str,
    message: str,
    branch: str = "main",
    sha: Optional[str] = None,
) -> dict:
    """PUT /repos/{owner}/{repo}/contents/{path}.

    Creates or updates a single file. Pass ``sha`` (current blob sha) to
    update; omit it to create. The Contents API is rate-limited but is the
    simplest way to seed a fresh repo without setting up local git.
    """
    body: dict = {
        "message": message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
        "branch": branch,
    }
    if sha:
        body["sha"] = sha

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.put(
            f"{GITHUB_API}/repos/{owner}/{repo}/contents/{path}",
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    if r.status_code not in (200, 201):
        raise GitHubAPIError(r.status_code, r.text[:200])
    return r.json()


async def commit_files(
    token: str,
    *,
    owner: str,
    repo: str,
    files: list[tuple[str, str]],
    message: str,
    branch: str = "main",
    concurrency: int = 4,
) -> list[dict]:
    """Write many files via Contents API.

    ``files`` is a list of ``(repo_path, content)`` tuples. We dispatch up
    to ``concurrency`` PUTs in parallel; the Contents API serializes commits
    server-side anyway but parallel requests keep wall-clock low for the
    initial seed (~20 files in <10s).

    For large numbers of files (>50) we should switch to the Git Data API
    (create blob/tree/commit) — that's a v1.1 optimization.
    """
    sem = asyncio.Semaphore(concurrency)
    results: list[dict] = []
    errors: list[Exception] = []

    async def _one(path_content: tuple[str, str]) -> None:
        path, content = path_content
        async with sem:
            try:
                res = await put_file(
                    token,
                    owner=owner,
                    repo=repo,
                    path=path,
                    content=content,
                    message=f"{message} ({path})",
                    branch=branch,
                )
                results.append(res)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

    await asyncio.gather(*(_one(fc) for fc in files))

    if errors:
        # Surface the first error; partial writes are not ideal but the
        # onboarding flow treats this as best-effort (wiki still lives on
        # our disk).
        raise errors[0]
    return results
