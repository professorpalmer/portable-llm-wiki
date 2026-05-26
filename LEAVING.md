# Leaving portablellm.wiki

You can leave at any time. Your wiki is markdown in a GitHub repo
*you* own. The hosted service is a thin layer on top.

## The one-paragraph version

Click **Danger zone → Delete my hosted tenant** in `/owner`. Your
hosted tenant directory is wiped from our disk, your GitHub OAuth
token is revoked at GitHub, and your session cookie is cleared. Your
GitHub repository — the markdown, the frontmatter, the history — is
untouched and yours.

## What actually happens

When you click delete in the owner console:

| Thing                                  | Where it lives          | What we do                |
| -------------------------------------- | ----------------------- | ------------------------- |
| Tenant directory (`tenants/<you>/`)    | our Render disk         | `rmtree`                  |
| Stored OAuth token                     | inside that tenant dir  | wiped on disk             |
| OAuth token registration               | github.com              | `DELETE` via GH API       |
| Search index, share tokens, jobs       | inside tenant dir       | wiped                     |
| Session cookie                         | your browser            | cleared on response       |
| **Your GitHub repo**                   | github.com/&lt;you&gt;/&lt;your-wiki&gt; | **not touched**           |
| **All your markdown pages**            | inside that repo        | **not touched**           |
| **Git history of your wiki**           | inside that repo        | **not touched**           |

The asymmetry is the whole point. We host a *layer* on top of a repo
you own. When you leave, the layer goes away and you still have the
repo.

## Picking up where you left off

Three options:

1. **Just keep the repo.** It's a working
   [portable-llm-wiki](https://github.com/professorpalmer/portable-llm-wiki)
   — every page is markdown with frontmatter. Read it, edit it,
   point another tool at it.

2. **Self-host the OSS build.** Clone
   [`portable-llm-wiki`](https://github.com/professorpalmer/portable-llm-wiki),
   set `WIKI_GIT_REMOTE` to your repo's clone URL, and bring it up.
   Your previous tenant content syncs in on first launch. Everything
   that worked on the hosted service — share tokens, the `/llm`
   handshake endpoint, the LLM writeback API, the owner console —
   works the same in single-tenant mode.

3. **Come back later.** Re-sign in with GitHub on
   [portablellm.wiki](https://portablellm.wiki), point the import
   flow at your repo, and you're back. Your URLs (`portablellm.wiki/<you>`,
   `portablellm.wiki/<you>/llm`) come back exactly the same because
   they're derived from your GitHub login.

## What the hosted service stores between sign-ins

Just two things (both inside the tenant directory we wipe on delete):

- Your wiki working tree, kept in lockstep with your GitHub repo via
  the sync engine. Identical to what's on the repo's default branch.
- Your GitHub OAuth access token, used to push your edits back to
  your repo. We never put it in a cookie or a response body. It is
  the *only* secret we hold for you, and the delete flow invalidates
  it both locally and at GitHub.

There is no separate database. There is no schema you'd lose by
leaving. Every durable piece of state is either on your GitHub repo
(which you own) or trivially re-derivable from it.

## If something goes wrong

The local wipe is best-effort about the GitHub revoke step — if
GitHub is down or your token was already invalid, we still wipe the
local tenant. If you want the GitHub side scrubbed manually, visit
[github.com/settings/applications](https://github.com/settings/applications)
and revoke the **Portable LLM Wiki** OAuth App from your account.
That kills the token everywhere.

If the local wipe failed for any reason (filesystem permission, a
race with another request), the next sign-in attempt will return the
tenant in a half-deleted state. File an issue with your tenant id
and we'll finish the wipe out-of-band; we keep no other identifying
data, so there is nothing else to undo.
