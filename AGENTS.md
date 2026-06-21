# Contributing conventions — portable-llm-wiki

Guidance for humans and AI coding agents working in this repository.

## Hard rules

- **No emojis, ever.** Do not use emojis or decorative pictographs
  anywhere — not in code, UI strings, button labels, log messages,
  commit messages, comments, or documentation. This includes glyphs
  like check marks, warning signs, clipboards, and similar
  (`✓`, `⚠`, `📋`, etc.). Use plain words instead: render "copied",
  not "copied ✓". Typographic punctuation (em dash `—`, en dash `–`,
  directional arrows in prose) is acceptable; emoji and pictographs
  are not.

## Project layout

- `backend/` — FastAPI app (Python). Tests under `backend/tests/`,
  run with `backend/.venv/bin/python -m pytest`.
- `frontend/` — Next.js app (TypeScript/React). Tests run with
  `npx vitest run`; type-check with `npx tsc --noEmit`.
- `render.yaml` — Render Blueprint for the backend. The hosted service
  is Blueprint-managed with autoDeploy; keep this file in sync with the
  live dashboard so the two never drift.

## Testing

- Run the full relevant suite before claiming work is done:
  backend `pytest`, frontend `vitest run` + `tsc --noEmit`.
- Prefer behavior/invariant assertions over change-detector snapshots.

## Commits

- Conventional commits: `fix:`, `feat:`, `refactor:`, `docs:`,
  `chore:`. Concise subject, body explaining the why.
- Never auto-commit; commit only when explicitly asked. Keep unrelated
  work in separate commits.
