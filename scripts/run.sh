#!/usr/bin/env bash
# Start backend + frontend together for local dev.
# Usage: ./scripts/run.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f backend/.env ]; then
  echo "[!] backend/.env not found. Copying .env.example → .env."
  cp backend/.env.example backend/.env
  echo "    Edit backend/.env to set WIKI_ROOT and OWNER_TOKEN before continuing."
  echo "    Press enter when ready, or Ctrl-C to abort."
  read -r
fi

if [ ! -d backend/.venv ]; then
  echo "[*] Creating backend venv…"
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install --upgrade pip --quiet
  backend/.venv/bin/pip install -r backend/requirements.txt
fi

if [ ! -d frontend/node_modules ]; then
  echo "[*] Installing frontend deps…"
  (cd frontend && npm install)
fi

cleanup() {
  echo
  echo "[*] Stopping…"
  kill "${BACK_PID:-0}" "${FRONT_PID:-0}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[*] Starting backend on http://0.0.0.0:8000 (LAN-reachable)"
(cd backend && .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) &
BACK_PID=$!

sleep 1.5

echo "[*] Starting frontend on http://localhost:3000"
(cd frontend && npm run dev) &
FRONT_PID=$!

echo
echo "[ok] Open http://localhost:3000"
echo "     Backend API:    http://localhost:8000/healthz"
echo "     Manifest (JSON): http://localhost:8000/wiki/manifest.json"
echo

wait
