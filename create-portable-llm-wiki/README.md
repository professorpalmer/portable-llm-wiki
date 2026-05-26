# create-portable-llm-wiki

> Scaffold a fresh **[Portable LLM Wiki](https://github.com/professorpalmer/portable-llm-wiki)** content repo on your machine.

This is the "I want my own wiki" entry point. One command creates a
local folder with starter markdown pages, a `.gitignore`, a mini
`README.md`, and an initialized git repo. Ready for you to push to
GitHub and one-click deploy on Render.

## Usage

```bash
npx create-portable-llm-wiki my-wiki
cd my-wiki
git remote add origin https://github.com/<you>/my-wiki.git
git push -u origin main
```

Then click **Deploy to Render** on the [main project README](https://github.com/professorpalmer/portable-llm-wiki) and paste your repo URL into the `WIKI_GIT_REMOTE` env var.

## What you get

```
my-wiki/
├── .gitignore
├── README.md           ← mini README pointing at the main project
├── wiki/
│   ├── index.md        ← the catalog
│   ├── purpose.md      ← why this wiki exists (rewrite in your voice)
│   ├── log.md          ← append-only op log
│   ├── entities/
│   │   └── about-me.md
│   ├── concepts/
│   │   └── first-principle.md
│   ├── decisions/      ← (empty, .gitkeep)
│   ├── projects/       ← (empty, .gitkeep)
│   ├── sources/        ← (empty, .gitkeep)
│   └── queries/        ← (empty, .gitkeep)
└── raw/
    └── README.md       ← how raw/ works
```

All starter pages are `tier: public` so the deployed wiki has something
to show on first load. Edit, add your own pages, or run the wiki's
import wizard (`/connect → Import`) to bootstrap 8–12 pages from a
resume or LinkedIn paste.

## Why a scaffolder?

Forking the main repo and editing pages in place works, but it muddies
the boundary between the **app** (which gets updates) and your
**content** (which is yours forever). Keeping content in a separate
repo means:

- You can keep your wiki content private even though the app is OSS.
- You can swap the deployed app for a newer version without touching
  your pages.
- `WIKI_GIT_REMOTE` on the backend points at your content repo. Cold
  starts re-clone it; mutations push back to it. The app forgets you;
  your content survives.

## Local development

```bash
git clone https://github.com/professorpalmer/portable-llm-wiki
cd portable-llm-wiki
./scripts/init.sh         # choose "Point at a path you already have"
                          # → /absolute/path/to/my-wiki
./scripts/dev-backend.sh  # in one terminal
(cd frontend && npm run dev)  # in another
```

## Not yet on npm

This package isn't published to npm yet. Invoke it directly from a
clone for now:

```bash
git clone https://github.com/professorpalmer/portable-llm-wiki
node portable-llm-wiki/create-portable-llm-wiki/bin/cli.js my-wiki
```

(Publication is gated by `prepublishOnly` in `package.json`; the
package will be `npx`-able once it ships.)

## License

MIT © [professorpalmer](https://github.com/professorpalmer)
