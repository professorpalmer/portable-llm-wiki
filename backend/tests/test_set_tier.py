"""Regression test for the minimal-touch tier patcher.

Run with:
    cd backend && .venv/bin/python -m pytest tests/test_set_tier.py -q

The bug this protects against: an earlier implementation joined frontmatter
lines without preserving the trailing newline before the closing `---`,
producing `tier: public---` and corrupting downstream YAML parsers.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Make `app` importable
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Provide minimal env so config.py doesn't blow up at import time
os.environ.setdefault("WIKI_ROOT", str(ROOT))
os.environ.setdefault("OWNER_TOKEN", "test-token")

from app.main import _set_tier_in_frontmatter  # noqa: E402


def _yaml_parses(text: str) -> bool:
    import frontmatter

    try:
        post = frontmatter.loads(text)
    except Exception:
        return False
    return isinstance(post.metadata, dict)


def test_replace_existing_tier_preserves_body_and_format():
    src = """---
type: concept
title: Example
tags: [a, b, c]
tier: private
---

# Heading

body paragraph
"""
    out = _set_tier_in_frontmatter(src, "public")
    assert "tier: public" in out
    assert "tier: private" not in out
    assert "# Heading" in out
    assert "body paragraph" in out
    assert "tags: [a, b, c]" in out  # untouched
    assert _yaml_parses(out)


def test_insert_tier_when_missing():
    src = """---
type: concept
title: Example
tags: [a, b, c]
---

# Heading

body
"""
    out = _set_tier_in_frontmatter(src, "recruiter")
    assert "tier: recruiter" in out
    assert _yaml_parses(out)
    # frontmatter is still well-formed: the closing --- must be on its own line
    lines = out.splitlines()
    assert lines[0] == "---"
    assert "---" in lines[1:]
    # body is intact
    assert "# Heading" in out
    assert "body" in out


def test_no_frontmatter_prepends_one():
    src = "# Heading\n\nbody\n"
    out = _set_tier_in_frontmatter(src, "public")
    assert out.startswith("---\ntier: public\n---\n")
    assert "# Heading" in out
    assert _yaml_parses(out)


def test_round_trip_preserves_byte_identity_except_tier_line():
    src = """---
type: concept
title: Example
created: 2026-05-23
updated: 2026-05-23
sources:
  - raw/conversations/x.md
tags: [a, b, c]
tier: private
---

# Heading

paragraph
"""
    out_pub = _set_tier_in_frontmatter(src, "public")
    out_priv = _set_tier_in_frontmatter(out_pub, "private")
    assert out_priv == src
