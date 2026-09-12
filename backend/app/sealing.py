"""Sealed-tier keyring helpers.

Pure functions: load/validate/write the committed keyring, cheap
frontmatter scans, and the 409 conflict constructor. No index I/O
beyond the keyring path the caller supplies. Guards live at the HTTP
boundary; this module does not touch routes.
"""
from __future__ import annotations

import base64
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException

logger = logging.getLogger(__name__)

KEYRING_REL = Path("wiki/.sealed/keyring.json")
SEALABLE_TIERS = ("recruiter", "friend", "private")

_SEALED_LINE_RE = re.compile(r"^sealed:\s*v1\s*$", re.IGNORECASE | re.MULTILINE)
_TIER_LINE_RE = re.compile(r"^tier:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)

_PLAINTEXT_INTO_SEALED = (
    "Cannot write plaintext into a sealed tier. Encrypt client-side "
    "(MCP write tools or the browser sealer) and include 'sealed: v1' "
    "frontmatter."
)


@dataclass(frozen=True)
class SealingState:
    enabled: bool
    tiers: tuple[str, ...]
    keyring: dict | None


def _disabled(keyring: dict | None = None) -> SealingState:
    return SealingState(enabled=False, tiers=(), keyring=keyring)


def _require_b64(name: str, value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty base64-decodable string")
    try:
        decoded = base64.b64decode(value, validate=False)
    except Exception as exc:
        raise ValueError(f"{name} must be a non-empty base64-decodable string") from exc
    if not decoded:
        raise ValueError(f"{name} must be a non-empty base64-decodable string")
    return value


def validate_keyring(obj: object) -> dict:
    """Return a normalized keyring dict or raise ValueError with a specific message."""
    if not isinstance(obj, dict):
        raise ValueError("keyring must be a JSON object")

    if obj.get("v") != 1:
        raise ValueError("v must be 1")

    tiers_raw = obj.get("tiers")
    if not isinstance(tiers_raw, list) or not tiers_raw:
        raise ValueError(
            "tiers must be a non-empty subset of recruiter, friend, private"
        )
    tiers: list[str] = []
    allowed = set(SEALABLE_TIERS)
    for item in tiers_raw:
        if not isinstance(item, str) or item not in allowed:
            raise ValueError(
                "tiers must be a non-empty subset of recruiter, friend, private"
            )
        if item not in tiers:
            tiers.append(item)

    if obj.get("kdf") != "pbkdf2-sha256":
        raise ValueError("kdf must be 'pbkdf2-sha256'")

    iterations = obj.get("iterations")
    if type(iterations) is not int or iterations < 100000:
        raise ValueError("iterations must be an integer >= 100000")

    salt = _require_b64("salt", obj.get("salt"))
    wrapped_dek = _require_b64("wrapped_dek", obj.get("wrapped_dek"))
    check = _require_b64("check", obj.get("check"))

    created = obj.get("created")
    if not isinstance(created, str) or not created:
        raise ValueError("created must be a string")

    return {
        "v": 1,
        "tiers": tiers,
        "kdf": "pbkdf2-sha256",
        "iterations": iterations,
        "salt": salt,
        "wrapped_dek": wrapped_dek,
        "check": check,
        "created": created,
    }


def load_state(wiki_root: Path) -> SealingState:
    path = wiki_root / KEYRING_REL
    if not path.is_file():
        return _disabled()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("malformed sealing keyring at %s; treating as disabled", path)
        return _disabled()
    if not isinstance(raw, dict):
        logger.warning("malformed sealing keyring at %s; treating as disabled", path)
        return _disabled()
    tiers_raw = raw.get("tiers")
    if isinstance(tiers_raw, list) and len(tiers_raw) == 0:
        return _disabled(keyring=raw)
    try:
        keyring = validate_keyring(raw)
    except ValueError:
        logger.warning("malformed sealing keyring at %s; treating as disabled", path)
        return _disabled()
    return SealingState(
        enabled=True,
        tiers=tuple(keyring["tiers"]),
        keyring=keyring,
    )


def write_keyring(wiki_root: Path, keyring: dict) -> dict:
    validated = validate_keyring(keyring)
    path = wiki_root / KEYRING_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(validated, indent=2) + "\n", encoding="utf-8")
    return validated


def disable(wiki_root: Path) -> dict:
    path = wiki_root / KEYRING_REL
    if not path.is_file():
        raise FileNotFoundError(str(path))
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise FileNotFoundError(str(path)) from exc
    if not isinstance(raw, dict):
        raise FileNotFoundError(str(path))
    raw["tiers"] = []
    path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
    return raw


def _frontmatter_block(text: str) -> str | None:
    """Return the interior of the leading ``---`` block, or None.

    Mirrors ``_set_tier_in_frontmatter``: scan lines, do not YAML-parse.
    """
    lines = text.splitlines()
    if not lines or lines[0].rstrip("\r") != "---":
        return None
    end_idx: int | None = None
    for i in range(1, len(lines)):
        if lines[i].rstrip("\r") == "---":
            end_idx = i
            break
    if end_idx is None:
        return None
    return "\n".join(lines[1:end_idx])


def is_sealed_markdown(text: str) -> bool:
    block = _frontmatter_block(text)
    if block is None:
        return False
    return _SEALED_LINE_RE.search(block) is not None


def frontmatter_tier(text: str) -> str | None:
    block = _frontmatter_block(text)
    if block is None:
        return None
    for line in block.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("#"):
            continue
        if stripped.lower().startswith("tier:") and not stripped.startswith("#"):
            match = _TIER_LINE_RE.match(stripped)
            if not match:
                return None
            value = match.group(1).strip().strip("'\"")
            return value.lower() or None
    return None


def plaintext_write_violation(
    state: SealingState, tier: str, markdown: str
) -> str | None:
    if tier in state.tiers and not is_sealed_markdown(markdown):
        return _PLAINTEXT_INTO_SEALED
    return None


def sealing_conflict(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"code": code, "message": message},
    )
