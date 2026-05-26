# Deploy your own Portable LLM Wiki

This is the post-click runway for self-hosters. If you got here from the
**Deploy to Render** + **Deploy to Vercel** buttons on the README, you're
in the right place — keep going.

There are three ways to run your own copy:

1. **[Cloud (one-click)](#1-cloud-one-click-render--vercel)** — Render
   for the backend, Vercel for the frontend. ~60 seconds end-to-end.
2. **[Local (npx scaffolder)](#2-local-development-npx-scaffolder)** —
   scaffold a content repo, then run the dev servers against it.
3. **[Self-host (Docker)](#3-self-host-docker)** — bring your own host.

Pick one. Or, more commonly: do (1) to get a hosted URL, do (2) on the
side to edit pages locally, and let git-backed persistence reconcile.

---

## 1. Cloud (one-click): Render + Vercel

### Step 1 — Scaffold a content repo

```bash
npx create-portable-llm-wiki my-wiki
cd my-wiki
git add .
git commit -m "initial wiki content"
```

Create a **private** GitHub repo for your wiki content (e.g.
`https://github.com/<you>/my-wiki`), then:

```bash
git remote add origin https://github.com/<you>/my-wiki.git
git push -u origin main
```

Why a separate content repo? Your wiki *content* lives in this repo —
not in a fork of the main project. That way you can pull future updates
to the wiki *app* without touching your pages, and your pages stay
private even though the app is open source.

### Step 2 — Click "Deploy to Render" on the main README

[`https://github.com/professorpalmer/portable-llm-wiki`](https://github.com/professorpalmer/portable-llm-wiki) → the **Deploy to Render** button at the top.

Render reads `render.yaml`, provisions
`portable-llm-wiki-backend`, and prompts you for these env vars before
deploying:

| Variable | What to set | Required? |
|---|---|---|
| `WIKI_GIT_REMOTE` | `https://USER:PAT@github.com/<you>/my-wiki.git` | recommended |
| `ANTHROPIC_API_KEY` | your key, if you have one | optional |
| `OPENAI_API_KEY` | your key, if you have one | optional |
| `CORS_ORIGINS` | leave blank for now — fill after Vercel | later |
| `PUBLIC_BASE_URL` | leave blank for now — fill after Vercel | later |

**Generating the PAT for `WIKI_GIT_REMOTE`:**

1. Go to <https://github.com/settings/tokens?type=beta>.
2. Click **Generate new token**.
3. *Resource owner*: you. *Repository access*: **Only select
   repositories** → pick `my-wiki`. *Permissions*: **Contents → Read
   and write**.
4. Copy the token. Format the value as
   `https://<your-github-username>:<token>@github.com/<your-github-username>/my-wiki.git`
   and paste it into Render.

Click **Apply**. Wait ~90 seconds for the build. Render gives you a
URL like `https://portable-llm-wiki-backend-XXXX.onrender.com`. Hit
`/healthz` on it — you should see `{"status":"ok",…}`.

### Step 3 — Note your `OWNER_TOKEN`

In the Render dashboard → your service → **Environment** → reveal
`OWNER_TOKEN`. Copy it. You'll paste it on the `/owner` page after the
frontend is up to authenticate as the wiki owner.

### Step 4 — Click "Deploy to Vercel" on the main README

The button pre-fills:

- Repository to clone: this project
- Project name + repo name: `portable-llm-wiki-frontend` (you can rename)
- Env var prompts: `NEXT_PUBLIC_BACKEND_URL`

Set `NEXT_PUBLIC_BACKEND_URL` to the Render URL from Step 2 (without a
trailing slash). Vercel auto-detects the `frontend/` root from
`vercel.json` and deploys.

When Vercel finishes, you'll have a URL like
`https://my-wiki.vercel.app`. Open it. You should see your wiki's
homepage rendering content from the Render backend.

### Step 5 — Tighten CORS

Go back to the Render dashboard → Environment, set:

| Variable | Value |
|---|---|
| `CORS_ORIGINS` | `https://my-wiki.vercel.app` (and any custom domain) |
| `PUBLIC_BASE_URL` | `https://my-wiki.vercel.app` |

Save. Render redeploys. Cross-origin requests from your real Vercel URL
now succeed; everything else is blocked.

### Step 6 — Connect from your LLMs

Open your wiki at `https://my-wiki.vercel.app/connect`. The page gives
you copy-pasteable MCP config blocks for Cursor and Claude Desktop, and
the `.well-known` URL for browser-based LLMs (ChatGPT custom GPT
schemas, OpenWebUI, etc.).

For Cursor:

```json
{
  "mcpServers": {
    "portable-llm-wiki": {
      "command": "npx",
      "args": ["-y", "portable-llm-wiki-mcp"],
      "env": {
        "WIKI_API_BASE": "https://portable-llm-wiki-backend-XXXX.onrender.com",
        "WIKI_OWNER_TOKEN": "<your OWNER_TOKEN>"
      }
    }
  }
}
```

You're done. Total wall-clock: ~60 seconds of clicking + a few minutes
of Render/Vercel build time.

---

## 2. Local development (npx scaffolder)

If you'd rather run the wiki on your laptop first:

```bash
# Scaffold a content folder
npx create-portable-llm-wiki my-wiki

# Clone the app
git clone https://github.com/professorpalmer/portable-llm-wiki
cd portable-llm-wiki

# Point the backend at your content folder
./scripts/init.sh
#   → choose "Point at a path you already have"
#   → /absolute/path/to/my-wiki

# Two terminals
./scripts/dev-backend.sh
(cd frontend && npm run dev)
```

Open <http://localhost:3000>. Paste the auto-generated `OWNER_TOKEN`
from `backend/.env` on `/owner` to authenticate.

When you're ready to publish, push your `my-wiki` folder to a private
GitHub repo and follow the **Cloud** path above starting from Step 2.

---

## 3. Self-host (Docker)

The repo ships a working `docker-compose.yml` at the root that builds
both backend and frontend, wires them together, and mounts the bundled
demo wiki as the content folder. One command brings the stack up:

```bash
git clone https://github.com/professorpalmer/portable-llm-wiki
cd portable-llm-wiki
export OWNER_TOKEN="$(openssl rand -hex 32)"
docker compose up --build
# → http://localhost:3000
```

To point at your own wiki, edit the `volumes:` entry on the `backend`
service in `docker-compose.yml`:

```yaml
volumes:
  - /absolute/path/to/my-wiki:/app/wiki    # replaces ./wiki-demo
```

Backend-only / custom orchestration (skip the frontend, run it
elsewhere or behind your own reverse proxy):

```bash
# Build the backend image
docker build -f backend/Dockerfile -t portable-llm-wiki-backend .

# Run with your own wiki folder mounted
docker run --rm -p 8000:8000 \
  -v /absolute/path/to/my-wiki:/app/wiki \
  -e OWNER_TOKEN="$(openssl rand -hex 32)" \
  -e DEFAULT_TIER=private \
  -e CORS_ORIGINS="http://localhost:3000" \
  portable-llm-wiki-backend
```

The frontend is a stock Next.js app:

```bash
cd frontend
NEXT_PUBLIC_BACKEND_URL=https://your-backend.example.com \
  npm install && npm run build && npm start
```

For git-backed persistence on Docker, set `WIKI_GIT_REMOTE` in the
environment and the backend will clone on boot + push on writes, same
as on Render.

---

## Fork checklist (after Deploy to Render)

A condensed version of the steps above, in case you're scanning:

- [ ] **Scaffold your content repo** — `npx create-portable-llm-wiki my-wiki`
- [ ] **Push it to a private GitHub repo** — `git remote add origin … && git push`
- [ ] **Click Deploy to Render** on the main project README
- [ ] **Generate a GitHub PAT** at <https://github.com/settings/tokens?type=beta>
  (Contents: read & write, scoped to your wiki repo only)
- [ ] **Set `WIKI_GIT_REMOTE`** in the Render dashboard to
  `https://USER:PAT@github.com/USER/my-wiki.git`
- [ ] **Copy `OWNER_TOKEN`** from Render's Environment tab (it was auto-generated)
- [ ] **(Optional)** Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for LLM-backed Q&A
- [ ] **Click Deploy to Vercel** on the main project README
- [ ] **Set `NEXT_PUBLIC_BACKEND_URL`** to your Render URL
- [ ] **Tighten `CORS_ORIGINS`** + **`PUBLIC_BASE_URL`** in Render to your Vercel URL
- [ ] **Open `<vercel-url>/owner`** and paste your `OWNER_TOKEN` to authenticate
- [ ] **Open `<vercel-url>/connect`** and copy the MCP config into Cursor / Claude

---

## Troubleshooting

**Render build fails with "no such file or directory: wiki-demo".**
This happens if you forked the repo and removed `wiki-demo/`. The
Dockerfile copies `wiki-demo/` to `/app/wiki` as the fallback content.
Either keep `wiki-demo/` in your fork or update `backend/Dockerfile`
to skip that COPY step.

**Frontend shows "fetch failed" on every page.**
`CORS_ORIGINS` on the backend doesn't include your Vercel URL. Set it
in the Render dashboard and let the service redeploy.

**Owner token doesn't work on `/owner`.**
You're reading the wrong env var. Make sure you copied `OWNER_TOKEN`
from the Render dashboard (not `WIKI_GIT_REMOTE` or anything else),
and paste it without surrounding quotes.

**Wiki content disappears after a cold start.**
You don't have `WIKI_GIT_REMOTE` set, so writes are ephemeral. Follow
Step 2 above to wire git-backed persistence.

**MCP server can't reach the backend.**
The `WIKI_API_BASE` in your MCP config points at localhost. For a
hosted deploy, change it to your Render URL.
