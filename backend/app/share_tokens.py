"""Persistent share tokens.

The SHARE_TOKENS env var was the v0 mechanism (static, read at boot). This
module adds runtime-mintable, runtime-revocable tokens stored at
`<WIKI_ROOT>/.share-tokens.json`.

Each token grants a fixed viewer tier. We track issuance metadata (label,
created_at) in the durable identity file, and hit counters
(hits, last_used_at) in a separate gitignored sidecar
`.share-token-stats.json` so every successful resolve does not dirty the
tracked worktree (which would block smart-pull when the tenant is behind
GitHub).

Tokens are 32-byte url-safe random strings (256 bits of entropy). They are
shown to the owner once at mint time and never revealed again — the owner
copies the share URL and forwards it.

Identity storage (``.share-tokens.json``, git-synced on mint/revoke)::

    {
      "tokens": [
        {
          "id": "<12-char-prefix>",
          "token_hash": "<sha256-hex>",
          "label": "Recruiter at Acme",
          "tier": "recruiter",
          "created_at": "2026-05-23T22:00:00+00:00",
          "expires_at": null,
          "revoked_at": null
        }
      ]
    }

Stats sidecar (``.share-token-stats.json``, gitignored)::

    {
      "<token-id>": {"hits": 7, "last_used_at": "2026-05-23T22:14:33+00:00"}
    }

We hash the token at rest. The plaintext is returned exactly once at mint
time. Hash verification is constant-time.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import VALID_TIERS, settings


_LOCK = threading.Lock()


def _store_path() -> Path:
    return settings.wiki_root / ".share-tokens.json"


def _stats_path() -> Path:
    return settings.wiki_root / ".share-token-stats.json"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _token_id(token: str) -> str:
    """First 12 chars of the hash — short, stable, safe to show in a URL or UI."""
    return _hash(token)[:12]


@dataclass
class ShareToken:
    id: str
    token_hash: str
    label: str
    tier: str
    created_at: str
    expires_at: Optional[str] = None
    hits: int = 0
    last_used_at: Optional[str] = None
    revoked_at: Optional[str] = None

    def to_public_dict(self) -> dict:
        """Owner-facing view. token_hash is intentionally excluded."""
        return {
            "id": self.id,
            "label": self.label,
            "tier": self.tier,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "hits": self.hits,
            "last_used_at": self.last_used_at,
            "revoked": self.revoked_at is not None,
            "revoked_at": self.revoked_at,
        }

    def to_identity_dict(self) -> dict:
        """Fields written to the tracked identity store (no hit counters)."""
        return {
            "id": self.id,
            "token_hash": self.token_hash,
            "label": self.label,
            "tier": self.tier,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "revoked_at": self.revoked_at,
        }


def _load_stats() -> dict[str, dict]:
    p = _stats_path()
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}
        out: dict[str, dict] = {}
        for key, val in raw.items():
            if isinstance(val, dict):
                out[str(key)] = val
        return out
    except (OSError, json.JSONDecodeError, TypeError):
        return {}


def _save_stats(stats: dict[str, dict]) -> None:
    p = _stats_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(stats, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def _token_from_raw(raw: dict, stats: dict[str, dict]) -> ShareToken:
    """Build a ShareToken, merging sidecar stats over any legacy hit fields."""
    tid = str(raw.get("id", ""))
    sidecar = stats.get(tid, {})
    hits = sidecar.get("hits", raw.get("hits", 0))
    last_used = sidecar.get("last_used_at", raw.get("last_used_at"))
    return ShareToken(
        id=tid,
        token_hash=str(raw.get("token_hash", "")),
        label=str(raw.get("label", "")),
        tier=str(raw.get("tier", "")),
        created_at=str(raw.get("created_at", "")),
        expires_at=raw.get("expires_at"),
        hits=int(hits or 0),
        last_used_at=last_used,
        revoked_at=raw.get("revoked_at"),
    )


def _migrate_legacy_hits_to_sidecar(
    raw_tokens: list[dict], stats: dict[str, dict]
) -> dict[str, dict]:
    """One-shot: copy hits/last_used_at from an old identity file into the
    sidecar when the sidecar has no entry yet. Does not rewrite the
    tracked identity file.
    """
    changed = False
    for raw in raw_tokens:
        tid = str(raw.get("id", ""))
        if not tid or tid in stats:
            continue
        legacy_hits = raw.get("hits")
        legacy_last = raw.get("last_used_at")
        if legacy_hits or legacy_last:
            stats[tid] = {
                "hits": int(legacy_hits or 0),
                "last_used_at": legacy_last,
            }
            changed = True
    if changed:
        _save_stats(stats)
    return stats


def _load() -> list[ShareToken]:
    p = _store_path()
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        raw_tokens = raw.get("tokens", [])
        if not isinstance(raw_tokens, list):
            return []
        stats = _load_stats()
        stats = _migrate_legacy_hits_to_sidecar(raw_tokens, stats)
        return [_token_from_raw(t, stats) for t in raw_tokens if isinstance(t, dict)]
    except (OSError, json.JSONDecodeError, TypeError):
        return []


def _save(tokens: list[ShareToken]) -> None:
    """Write identity fields only — never hits / last_used_at."""
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(
            {"tokens": [t.to_identity_dict() for t in tokens]},
            indent=2,
        ),
        encoding="utf-8",
    )
    os.replace(tmp, p)


def list_tokens() -> list[dict]:
    with _LOCK:
        return [t.to_public_dict() for t in _load()]


def mint_token(label: str, tier: str, expires_at: Optional[str] = None) -> dict:
    """Generate a new share token. Returns the plaintext token exactly once."""
    if tier not in VALID_TIERS:
        raise ValueError(f"invalid tier {tier!r}, expected one of {VALID_TIERS}")
    label = label.strip()
    if len(label) < 1 or len(label) > 200:
        raise ValueError("label must be 1-200 chars")
    plaintext = secrets.token_urlsafe(32)
    tok = ShareToken(
        id=_token_id(plaintext),
        token_hash=_hash(plaintext),
        label=label,
        tier=tier,
        created_at=datetime.now(timezone.utc).isoformat(),
        expires_at=expires_at,
    )
    with _LOCK:
        tokens = _load()
        tokens.append(tok)
        _save(tokens)
        stats = _load_stats()
        stats[tok.id] = {"hits": 0, "last_used_at": None}
        _save_stats(stats)
    return {
        **tok.to_public_dict(),
        # Returned ONCE at mint time. Never re-derivable.
        "token": plaintext,
    }


def revoke_token(token_id: str) -> bool:
    with _LOCK:
        tokens = _load()
        for t in tokens:
            if t.id == token_id and t.revoked_at is None:
                t.revoked_at = datetime.now(timezone.utc).isoformat()
                _save(tokens)
                return True
    return False


def resolve(token: str) -> Optional[str]:
    """Return the viewer tier if the token is valid and not revoked/expired.

    Records a hit in the stats sidecar only — never rewrites the tracked
    identity file, so resolve traffic cannot create pull-blocking dirt.
    """
    if not token:
        return None
    target_hash = _hash(token)
    now = datetime.now(timezone.utc)
    with _LOCK:
        tokens = _load()
        for t in tokens:
            if not hmac.compare_digest(t.token_hash, target_hash):
                continue
            if t.revoked_at is not None:
                return None
            if t.expires_at:
                try:
                    exp = datetime.fromisoformat(t.expires_at)
                    if exp < now:
                        return None
                except ValueError:
                    pass
            stats = _load_stats()
            entry = stats.get(t.id, {"hits": 0, "last_used_at": None})
            entry["hits"] = int(entry.get("hits") or 0) + 1
            entry["last_used_at"] = now.isoformat()
            stats[t.id] = entry
            _save_stats(stats)
            return t.tier
    return None
