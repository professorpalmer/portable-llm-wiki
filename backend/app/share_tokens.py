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
import time
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


# resolve() runs on every request that carries a share token (Marionette sends
# one on each chat-turn search). Keep it off the disk: the identity store is
# cached by stat signature, and hit counters accumulate in memory and flush at
# most every _HIT_FLUSH_S (and before anything that reads or edits tokens).
_HIT_FLUSH_S = 30.0
_IDENTITY_CACHE: dict[str, tuple[tuple, list[dict]]] = {}
_PENDING_HITS: dict[str, dict[str, dict]] = {}
_LAST_FLUSH: dict[str, float] = {}


def _identity_raw(path: Path) -> list[dict]:
    try:
        st = path.stat()
    except OSError:
        return []
    sig = (st.st_mtime_ns, st.st_size, st.st_ino)
    cached = _IDENTITY_CACHE.get(str(path))
    if cached is not None and cached[0] == sig:
        return cached[1]
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        tokens = [t for t in raw.get("tokens", []) if isinstance(t, dict)]
    except (OSError, json.JSONDecodeError, TypeError, AttributeError):
        return []
    if len(_IDENTITY_CACHE) >= 64:
        _IDENTITY_CACHE.clear()
    _IDENTITY_CACHE[str(path)] = (sig, tokens)
    return tokens


def _flush_hits_locked(stats_path: Optional[Path] = None) -> None:
    """Write pending hit counters for one stats file (lock held). Never raises."""
    path = stats_path or _stats_path()
    pending = _PENDING_HITS.pop(str(path), None)
    _LAST_FLUSH[str(path)] = time.monotonic()
    if not pending:
        return
    try:
        stats = _load_stats(path)
        for tid, delta in pending.items():
            entry = stats.get(tid, {"hits": 0, "last_used_at": None})
            entry["hits"] = int(entry.get("hits") or 0) + delta["hits"]
            entry["last_used_at"] = delta["last_used_at"]
            stats[tid] = entry
        _save_stats(stats, path)
    except OSError:
        return


def flush_pending_hits() -> None:
    """Persist every buffered hit counter (shutdown hook)."""
    with _LOCK:
        for path in list(_PENDING_HITS):
            _flush_hits_locked(Path(path))


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


def _load_stats(path: Optional[Path] = None) -> dict[str, dict]:
    p = path or _stats_path()
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


def _save_stats(stats: dict[str, dict], path: Optional[Path] = None) -> None:
    p = path or _stats_path()
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
    # Listings and edits see exact counters (lock is held by every caller).
    _flush_hits_locked()
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


def purge_tokens(ids: Optional[list[str]] = None) -> int:
    """Remove ONLY revoked tokens from the identity store.

    With ids given, purge just those (silently skipping unknown or
    still-active ids); with ids None, purge all revoked. Returns the
    count removed. Active tokens are never deleted through this path.
    """
    with _LOCK:
        tokens = _load()
        if ids is None:
            remaining = [t for t in tokens if t.revoked_at is None]
            removed = len(tokens) - len(remaining)
            if removed:
                _save(remaining)
            return removed
        wanted = set(ids)
        remaining: list[ShareToken] = []
        removed = 0
        for t in tokens:
            if t.id in wanted and t.revoked_at is not None:
                removed += 1
                continue
            remaining.append(t)
        if removed:
            _save(remaining)
        return removed


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
        for raw in _identity_raw(_store_path()):
            if not hmac.compare_digest(str(raw.get("token_hash", "")), target_hash):
                continue
            if raw.get("revoked_at") is not None:
                return None
            expires_at = raw.get("expires_at")
            if expires_at:
                try:
                    exp = datetime.fromisoformat(expires_at)
                    if exp < now:
                        return None
                except ValueError:
                    pass
            stats_key = str(_stats_path())
            pending = _PENDING_HITS.setdefault(stats_key, {})
            entry = pending.setdefault(str(raw.get("id", "")), {"hits": 0, "last_used_at": None})
            entry["hits"] += 1
            entry["last_used_at"] = now.isoformat()
            if time.monotonic() - _LAST_FLUSH.get(stats_key, 0.0) >= _HIT_FLUSH_S:
                _flush_hits_locked()
            return str(raw.get("tier", ""))
    return None
