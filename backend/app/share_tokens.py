"""Persistent share tokens.

The SHARE_TOKENS env var was the v0 mechanism (static, read at boot). This
module adds runtime-mintable, runtime-revocable tokens stored at
`<WIKI_ROOT>/.share-tokens.json`.

Each token grants a fixed viewer tier. We track issuance metadata (label,
created_at, hits, last_used_at) so the owner can audit who pulled what.

Tokens are 32-byte url-safe random strings (256 bits of entropy). They are
shown to the owner once at mint time and never revealed again — the owner
copies the share URL and forwards it.

Storage format:
{
  "tokens": [
    {
      "id": "<12-char-prefix>",
      "token_hash": "<sha256-hex>",
      "label": "Recruiter at Acme",
      "tier": "recruiter",
      "created_at": "2026-05-23T22:00:00+00:00",
      "expires_at": null,
      "hits": 7,
      "last_used_at": "2026-05-23T22:14:33+00:00"
    }
  ]
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
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import VALID_TIERS, settings


_LOCK = threading.Lock()


def _store_path() -> Path:
    return settings.wiki_root / ".share-tokens.json"


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


def _load() -> list[ShareToken]:
    p = _store_path()
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return [ShareToken(**t) for t in raw.get("tokens", [])]
    except (OSError, json.JSONDecodeError, TypeError):
        return []


def _save(tokens: list[ShareToken]) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps({"tokens": [asdict(t) for t in tokens]}, indent=2),
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

    Records a hit (atomic write) when the token resolves successfully.
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
            t.hits += 1
            t.last_used_at = now.isoformat()
            _save(tokens)
            return t.tier
    return None
