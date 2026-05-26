#!/usr/bin/env bash
# scripts/init.sh — one-command setup for the Portable LLM Wiki.
#
# Run from the repo root: ./scripts/init.sh
#
# What this does:
#   1. Verifies Python 3.10+, Node 18+, npm/pnpm are installed.
#   2. Creates backend/.venv and installs Python deps.
#   3. Installs frontend deps (npm or pnpm).
#   4. Writes backend/.env with a freshly-generated OWNER_TOKEN.
#   5. Asks where your wiki lives (or scaffolds the bundled demo wiki).
#   6. Tells you how to start the servers.
#
# No external services required for the default path — wiki = bundled demo,
# query backend = keyword fallback. Set ANTHROPIC_API_KEY or OPENAI_API_KEY
# in backend/.env to upgrade to LLM-backed queries.

set -euo pipefail

# --- pretty output ----------------------------------------------------------
if [[ -t 1 ]]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
    RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
    BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

say()  { printf "%s\n" "${BOLD}$*${RESET}"; }
info() { printf "  ${CYAN}·${RESET} %s\n" "$*"; }
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$*" >&2; }
die()  { printf "  ${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- preflight --------------------------------------------------------------
say ""
say "Portable LLM Wiki — setup"
say "========================="
say ""

say "[1/5] Checking dependencies"

PY=""
for cand in python3.12 python3.11 python3.10 python3; do
    if command -v "$cand" >/dev/null 2>&1; then
        ver=$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
        major=${ver%.*}; minor=${ver#*.}
        if [[ "$major" -eq 3 && "$minor" -ge 10 ]]; then
            PY="$cand"; ok "Python $ver  ($cand)"; break
        fi
    fi
done
[[ -n "$PY" ]] || die "Need Python 3.10 or newer. (brew install python@3.12, or apt install python3.12)"

if command -v node >/dev/null 2>&1; then
    node_ver=$(node --version | sed 's/^v//')
    node_major=${node_ver%%.*}
    if [[ "$node_major" -ge 18 ]]; then
        ok "Node $node_ver"
    else
        die "Need Node 18 or newer (have $node_ver)"
    fi
else
    die "Need Node 18+. (brew install node, or use nvm/fnm)"
fi

PM=""
if command -v pnpm >/dev/null 2>&1; then PM="pnpm"; ok "pnpm $(pnpm --version)"
elif command -v npm >/dev/null 2>&1; then PM="npm"; ok "npm $(npm --version)"
else die "Need npm or pnpm."
fi

# --- backend deps -----------------------------------------------------------
say ""
say "[2/5] Backend (Python venv + deps)"

if [[ ! -d backend/.venv ]]; then
    info "Creating backend/.venv with $PY"
    "$PY" -m venv backend/.venv
fi
ok "venv exists at backend/.venv"

info "Installing pip dependencies (quiet)…"
backend/.venv/bin/pip install --upgrade pip --quiet
backend/.venv/bin/pip install -r backend/requirements.txt --quiet
ok "backend deps installed"

# --- frontend deps ----------------------------------------------------------
say ""
say "[3/5] Frontend (Next.js + Tailwind)"

if [[ ! -d frontend/node_modules ]]; then
    info "Installing frontend deps with $PM (takes ~30s)…"
    (cd frontend && $PM install --silent)
fi
ok "frontend deps installed at frontend/node_modules"

# --- backend/.env -----------------------------------------------------------
say ""
say "[4/5] backend/.env"

ENV_FILE=backend/.env
WIKI_ROOT_DEFAULT="$ROOT/wiki-demo"

if [[ -f "$ENV_FILE" ]]; then
    warn "$ENV_FILE already exists — leaving it alone."
    info "Delete it and re-run if you want a fresh start."
else
    # Prompt for wiki location, defaulting to the bundled demo
    say ""
    info "Where does your wiki live?"
    info "  [1] Use the bundled demo wiki (wiki-demo/) — safe default"
    info "  [2] Point at a path you already have"
    info "  [3] Scaffold a fresh wiki next to this repo"
    read -r -p "  Choice [1]: " choice
    choice=${choice:-1}

    case "$choice" in
        2)
            read -r -p "  Absolute path to wiki root: " user_path
            user_path=$(eval echo "$user_path")  # expand ~
            [[ -d "$user_path/wiki" ]] || die "No wiki/ subfolder at $user_path"
            WIKI_ROOT_VALUE="$user_path"
            ;;
        3)
            read -r -p "  Where to create the fresh wiki [$HOME/my-wiki]: " fresh
            fresh=${fresh:-$HOME/my-wiki}
            fresh=$(eval echo "$fresh")
            if [[ -d "$fresh" ]]; then
                warn "$fresh already exists — using it as-is."
            else
                info "Cloning wiki-demo/ template → $fresh"
                cp -R "$ROOT/wiki-demo" "$fresh"
                (cd "$fresh" && git init -q 2>/dev/null || true)
            fi
            WIKI_ROOT_VALUE="$fresh"
            ;;
        *)
            WIKI_ROOT_VALUE="$WIKI_ROOT_DEFAULT"
            ;;
    esac

    OWNER_TOKEN_VAL=$("$PY" -c 'import secrets; print(secrets.token_hex(32))')

    cat > "$ENV_FILE" <<EOF
# Generated by scripts/init.sh on $(date '+%Y-%m-%d %H:%M:%S')

WIKI_ROOT=$WIKI_ROOT_VALUE

# Random 64-char token. Required by every /owner/* endpoint.
OWNER_TOKEN=$OWNER_TOKEN_VAL

# Default tier for pages without an explicit tier: in frontmatter.
DEFAULT_TIER=private

# Optional. If set, /query uses Anthropic. Otherwise OpenAI, otherwise keyword fallback.
# ANTHROPIC_API_KEY=
# ANTHROPIC_MODEL=claude-3-5-sonnet-latest
# OPENAI_API_KEY=
# OPENAI_MODEL=gpt-4o-mini

CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
PUBLIC_BASE_URL=http://localhost:3000
EOF

    ok "Wrote $ENV_FILE"
    info "WIKI_ROOT = $WIKI_ROOT_VALUE"
    info "OWNER_TOKEN was generated — view it any time with:"
    info "  grep ^OWNER_TOKEN backend/.env"
fi

# --- done -------------------------------------------------------------------
say ""
say "[5/5] All set"
say ""
say "Start the dev servers (two terminals):"
say ""
printf "  ${DIM}terminal 1:${RESET} ${BOLD}./scripts/dev-backend.sh${RESET}\n"
printf "  ${DIM}terminal 2:${RESET} ${BOLD}(cd frontend && %s dev)${RESET}\n" "$PM"
say ""
say "Then open:"
printf "  ${CYAN}http://localhost:3000${RESET}      — the wiki UI\n"
printf "  ${CYAN}http://localhost:3000/owner${RESET} — paste your OWNER_TOKEN there\n"
printf "  ${CYAN}http://localhost:8000/healthz${RESET} — backend health\n"
say ""
say "Reading material:"
printf "  ${DIM}README.md${RESET} — overview, deployment, API surface\n"
printf "  ${DIM}wiki-demo/SETUP.md${RESET} — meet Avery Chen, the demo persona\n"
say ""
