# Contributing to Portable LLM Wiki

Thanks for thinking about contributing. This project's whole pitch is
"the open protocol for piping your personal context into any LLM" — and
that only works if the protocol stays small, the reference
implementation stays clean, and outside contributions are welcome.

This document covers how to work on the codebase. For the protocol
itself, see [SPEC.md](./SPEC.md).

## What kind of contributions land

**Yes, please:**

- Bug fixes in the reference implementation (backend, frontend, MCP)
- Improvements to docs (README, SPEC, examples)
- New tests covering existing untested code paths
- New `Connect from any LLM` recipes (Cursor, Claude Desktop, custom clients)
- Performance improvements that don't change the wire protocol
- Accessibility / mobile / i18n improvements to the frontend

**Maybe — open an issue first:**

- New endpoints (these are protocol changes and need a spec discussion)
- Removing or renaming endpoints (always a major version bump)
- Significant UI redesigns
- New tier types

**Probably not:**

- A hosted-SaaS layer in this repo (that would contradict the OSS-self-host pitch)
- Lock-in to a specific LLM vendor or specific hosting provider
- Features that require the wiki to leave its git repo (the markdown-in-your-git invariant is load-bearing)

## Local setup

```bash
git clone https://github.com/professorpalmer/portable-llm-wiki
cd portable-llm-wiki
./scripts/init.sh   # creates venvs, installs deps, generates an owner token
```

Then in two terminals:

```bash
# terminal 1: backend
cd backend && .venv/bin/python -m uvicorn app.main:app --reload --port 8000

# terminal 2: frontend
cd frontend && npm run dev
```

Visit http://localhost:3000.

## Running tests

```bash
# Backend (pytest)
cd backend && .venv/bin/python -m pytest tests/ -v

# Frontend unit tests (vitest)
cd frontend && npx vitest run

# Frontend E2E (Playwright; requires backend running on :8000)
cd frontend && npx playwright test
```

All three suites must pass before a PR can be merged. CI runs them on
every PR — see `.github/workflows/ci.yml`.

## Code style

- **Python**: stdlib + type hints. Black-friendly formatting. We do not
  enforce a formatter in CI yet; just keep diffs surgical.
- **TypeScript**: matches the existing style in `frontend/`. Tailwind
  classes, no separate CSS files. React Server Components by default;
  `"use client"` only when you need interactivity.
- **Commit messages**: imperative mood, short subject line, body
  explaining "why" if non-obvious. Reference issue numbers (`Fixes #42`).
- **No comments that just narrate what the code does.** Comments are
  for explaining non-obvious intent.

## Protocol changes

Any change that affects the HTTP wire format is a protocol change and
needs a spec discussion before code. The flow is:

1. Open an issue with the `protocol` label describing the proposed
   change and the motivation.
2. Discussion happens in the issue. If accepted, the spec gets a draft
   update.
3. A PR implements the spec change in SPEC.md + bumps `spec_version` in
   the reference implementation + updates the well-known endpoint.
4. The reference implementation may opt to support both versions during
   a transition window (advertise via `spec_version`).

`1.x` versions guarantee backward compatibility within the major
version. Breaking changes require `2.0`.

## Releasing

Tagging a release is currently manual:

1. Update the version in `mcp/package.json` if the MCP wrapper changed.
2. Update SPEC.md's version header if the protocol changed.
3. Tag with `git tag v1.0.0` and push tags.
4. Publish the MCP package: `cd mcp && npm publish` (requires 2FA).

## Reporting security issues

Don't open a public issue for security bugs. Email the maintainer
directly (contact in `mcp/package.json`).

## Code of conduct

Be decent. No harassment, no spam, no LLM-generated noise PRs. If
something needs to be moderated, ping a maintainer.
