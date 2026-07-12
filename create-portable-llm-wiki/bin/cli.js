#!/usr/bin/env node
// create-portable-llm-wiki — scaffold a fresh personal-wiki content repo.
//
// Usage:
//   npx create-portable-llm-wiki [target-dir]
//
// Default target-dir is "my-wiki" in the current directory. The script:
//   1. Creates <target-dir>/ (refuses if it's a non-empty existing folder)
//   2. Copies templates/wiki/* and templates/raw/* into it, with __TODAY__
//      placeholders replaced by today's ISO date
//   3. Writes .gitignore + a short README that points back at the main
//      project for setup instructions
//   4. Runs `git init` (best-effort; skipped if git is missing)
//   5. Prints the four-step next-steps runway for hitting "Deploy to
//      Render" on the main repo and wiring the new wiki repo to it.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PKG_ROOT, "templates");

const MAIN_REPO_URL = "https://github.com/professorpalmer/portable-llm-wiki";
const RENDER_DEPLOY_URL = `https://render.com/deploy?repo=${encodeURIComponent(
  MAIN_REPO_URL,
)}`;

const COLORS = process.stdout.isTTY
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      cyan: "\x1b[36m",
      red: "\x1b[31m",
    }
  : Object.fromEntries(
      ["reset", "bold", "dim", "green", "yellow", "cyan", "red"].map((k) => [
        k,
        "",
      ]),
    );

function say(msg = "") {
  process.stdout.write(`${msg}\n`);
}
function ok(msg) {
  say(`  ${COLORS.green}✓${COLORS.reset} ${msg}`);
}
function info(msg) {
  say(`  ${COLORS.cyan}·${COLORS.reset} ${msg}`);
}
function warn(msg) {
  process.stderr.write(`  ${COLORS.yellow}!${COLORS.reset} ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`  ${COLORS.red}✗${COLORS.reset} ${msg}\n`);
  process.exit(1);
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function copyTemplateTree(srcDir, destDir, today) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  await fs.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyTemplateTree(srcPath, destPath, today);
    } else if (entry.isFile()) {
      const raw = await fs.readFile(srcPath, "utf8");
      const rendered = raw.replaceAll("__TODAY__", today);
      await fs.writeFile(destPath, rendered, "utf8");
    }
  }
}

const GITIGNORE = `# OS
.DS_Store
Thumbs.db

# Editors
.idea/
.vscode/

# Portable LLM Wiki runtime files (live alongside content but aren't content)
.lint/
.jobs.json
.job-logs/
.share-tokens.json
.share-token-stats.json
.persistence-state.json

# Local secrets (if you ever drop a .env in here by mistake)
.env
.env.local
`;

function makeMiniReadme(targetName) {
  return `# ${targetName}

Personal-context wiki content, scaffolded by [\`create-portable-llm-wiki\`](${MAIN_REPO_URL}).

This is a **content-only** repository: just markdown pages under \`wiki/\`
plus raw source material under \`raw/\`. The actual server, frontend, MCP
client, and documentation live in the main project:

→ **${MAIN_REPO_URL}**

## Quickstart

1. Push this repo to GitHub (a private repo is fine, and recommended if
   any of your pages are above \`tier: public\`).
2. On the main project's README, click **Deploy to Render**.
3. After provisioning, set \`WIKI_GIT_REMOTE\` in the Render dashboard to
   this repo's clone URL (with a Personal Access Token):
   \`\`\`
   https://USER:PAT@github.com/USER/${targetName}.git
   \`\`\`
   PAT generation: <https://github.com/settings/tokens?type=beta> with
   *Contents: read & write* scope for this one repo.
4. (Optional) Set \`ANTHROPIC_API_KEY\` or \`OPENAI_API_KEY\` in the same
   Render dashboard to upgrade \`/wiki/query\` from keyword fallback to a
   real LLM-backed answer.
5. (Optional) Deploy the frontend to Vercel, second button on the main
   README.

## Layout

\`\`\`
${targetName}/
├── wiki/             # Your content. Subfolders by type.
│   ├── index.md      # The catalog. Keep it in sync as you add pages.
│   ├── purpose.md    # Why this wiki exists. Rewrite in your voice.
│   ├── log.md        # Append-only operation log.
│   ├── entities/     # People, companies, products
│   ├── concepts/     # Operating principles, frameworks
│   ├── decisions/    # Career or technical choices, with rationale
│   ├── projects/     # What you're currently shipping
│   ├── sources/      # Digests of source material
│   └── queries/      # Saved Q&A worth keeping
└── raw/              # Immutable source material. Append-only.
\`\`\`

## Local development

Want to run the wiki on your laptop before deploying? Clone the main
project and point its backend at this folder:

\`\`\`bash
git clone ${MAIN_REPO_URL}
cd portable-llm-wiki
./scripts/init.sh   # choose "Point at a path you already have" → /absolute/path/to/${targetName}
\`\`\`

Then \`./scripts/dev-backend.sh\` and \`cd frontend && npm run dev\`.

## Tier model

Pages can declare \`tier:\` in their frontmatter, one of \`public\`,
\`recruiter\`, \`friend\`, \`private\`. Anything you don't explicitly mark
inherits the backend's \`DEFAULT_TIER\` (the \`render.yaml\` ships this as
\`public\`, which matches the scaffolded pages here). Set
\`DEFAULT_TIER=private\` in the Render dashboard if you'd rather have new
unmarked pages stay hidden until you bless them.
`;
}

function gitAvailable() {
  const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    say(`create-portable-llm-wiki: scaffold a Portable LLM Wiki content repo.

Usage:
  npx create-portable-llm-wiki [target-dir]

Default target-dir is "my-wiki".`);
    process.exit(0);
  }

  const targetArg = argv.find((a) => !a.startsWith("-")) || "my-wiki";
  const targetPath = path.resolve(process.cwd(), targetArg);
  const targetName = path.basename(targetPath);
  const today = todayISO();

  say("");
  say(`${COLORS.bold}create-portable-llm-wiki${COLORS.reset}`);
  say(`${COLORS.dim}Scaffolding ${targetPath}${COLORS.reset}`);
  say("");

  // 1. Target dir guard
  let preExisting = false;
  try {
    const entries = await fs.readdir(targetPath);
    if (entries.length > 0) {
      die(
        `${targetPath} already exists and is not empty. Pick a different name or remove the existing folder first.`,
      );
    }
    preExisting = true;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  await fs.mkdir(targetPath, { recursive: true });
  ok(`created ${path.relative(process.cwd(), targetPath) || targetPath}/`);

  // 2. Copy templates
  await copyTemplateTree(TEMPLATES_DIR, targetPath, today);
  ok(`scaffolded wiki/ with starter pages (Index, Purpose, Log, About Me, First Principle)`);
  ok(`scaffolded raw/ for immutable source material`);

  // Empty directories git doesn't track — create placeholders so the
  // shape is right when someone opens the repo on GitHub.
  const placeholderDirs = [
    "wiki/decisions",
    "wiki/projects",
    "wiki/sources",
    "wiki/queries",
  ];
  for (const rel of placeholderDirs) {
    const dir = path.join(targetPath, rel);
    await fs.mkdir(dir, { recursive: true });
    const keepPath = path.join(dir, ".gitkeep");
    await fs.writeFile(keepPath, "", "utf8");
  }
  ok(`created empty wiki/{decisions,projects,sources,queries} (.gitkeep)`);

  // 3. .gitignore + README
  await fs.writeFile(path.join(targetPath, ".gitignore"), GITIGNORE, "utf8");
  await fs.writeFile(
    path.join(targetPath, "README.md"),
    makeMiniReadme(targetName),
    "utf8",
  );
  ok(`wrote .gitignore and README.md`);

  // 4. git init (best-effort)
  if (gitAvailable()) {
    const init = spawnSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: targetPath,
      stdio: "ignore",
    });
    if (init.status === 0) {
      ok(`initialized git repo on branch main`);
    } else {
      // Older git (<2.28) doesn't know --initial-branch. Fall back.
      const initLegacy = spawnSync("git", ["init", "--quiet"], {
        cwd: targetPath,
        stdio: "ignore",
      });
      if (initLegacy.status === 0) {
        ok(`initialized git repo (legacy git; default branch name)`);
      } else {
        warn(`git init failed. Run it yourself in ${targetPath}`);
      }
    }
  } else {
    warn(`git not found on PATH. Skipped \`git init\`. Install git and run it yourself.`);
  }

  // 5. Next steps
  say("");
  say(`${COLORS.bold}${COLORS.green}Done.${COLORS.reset} Next steps:`);
  say("");
  say(`  ${COLORS.bold}1.${COLORS.reset} ${COLORS.cyan}cd ${targetArg}${COLORS.reset}`);
  say("");
  say(`  ${COLORS.bold}2.${COLORS.reset} Create a ${COLORS.bold}private${COLORS.reset} GitHub repo for your wiki content,`);
  say(`     then point this local repo at it:`);
  say("");
  say(`       ${COLORS.cyan}git add . && git commit -m "initial commit"${COLORS.reset}`);
  say(`       ${COLORS.cyan}git remote add origin https://github.com/<you>/${targetName}.git${COLORS.reset}`);
  say(`       ${COLORS.cyan}git push -u origin main${COLORS.reset}`);
  say("");
  say(`  ${COLORS.bold}3.${COLORS.reset} Click ${COLORS.bold}Deploy to Render${COLORS.reset} on the main project:`);
  say(`       ${COLORS.cyan}${MAIN_REPO_URL}${COLORS.reset}`);
  say(`     (or open the direct deploy URL:)`);
  say(`       ${COLORS.dim}${RENDER_DEPLOY_URL}${COLORS.reset}`);
  say("");
  say(`  ${COLORS.bold}4.${COLORS.reset} In the Render dashboard, set ${COLORS.bold}WIKI_GIT_REMOTE${COLORS.reset} to your repo URL`);
  say(`     with a Personal Access Token (Contents: read & write scope):`);
  say(`       ${COLORS.dim}https://USER:PAT@github.com/<you>/${targetName}.git${COLORS.reset}`);
  say(`     PAT generation: ${COLORS.cyan}https://github.com/settings/tokens?type=beta${COLORS.reset}`);
  say("");
  say(`  ${COLORS.bold}5.${COLORS.reset} (Optional) Set ${COLORS.bold}ANTHROPIC_API_KEY${COLORS.reset} or ${COLORS.bold}OPENAI_API_KEY${COLORS.reset} in the`);
  say(`     same Render env-vars panel to upgrade /wiki/query to LLM-backed answers.`);
  say("");
  say(`  ${COLORS.bold}6.${COLORS.reset} (Optional) Deploy the frontend to Vercel, second button on the main README.`);
  say("");
  say(`${COLORS.dim}Full fork checklist: ${MAIN_REPO_URL}/blob/main/scripts/deploy.md${COLORS.reset}`);
  say("");
}

main().catch((err) => {
  process.stderr.write(`\n${COLORS.red}✗${COLORS.reset} ${err.stack || err.message || err}\n`);
  process.exit(1);
});
