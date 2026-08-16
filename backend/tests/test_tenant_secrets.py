"""gh_token and gh_webhook_secret are encrypted at rest in tenant.json."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from app import tenants


def test_secrets_encrypted_on_persist_and_omitted_from_to_dict(tmp_path):
    root = tmp_path / "carol"
    tenant = tenants.Tenant(
        id="carol",
        wiki_root=root,
        display_name="Carol",
        gh_token="gho_plaintext_token",
        gh_webhook_secret="whsec_plain",
        visibility="unlisted",
    )
    tenant._persist()

    meta_path = root / "tenant.json"
    raw = json.loads(meta_path.read_text(encoding="utf-8"))
    assert raw["gh_token"].startswith("enc:v1:")
    assert raw["gh_webhook_secret"].startswith("enc:v1:")
    dumped = json.dumps(raw)
    assert "gho_plaintext_token" not in dumped
    assert "whsec_plain" not in dumped

    public = tenant.to_dict()
    assert "gh_token" not in public
    assert "gh_webhook_secret" not in public

    mode = stat.S_IMODE(meta_path.stat().st_mode)
    if os.name != "nt":
        assert mode == 0o600

    loaded = tenants.manager()._tenant_from_json("carol", root, raw)
    assert loaded.gh_token == "gho_plaintext_token"
    assert loaded.gh_webhook_secret == "whsec_plain"


def test_plaintext_secrets_dual_read_then_reencrypt(tmp_path):
    root = tmp_path / "dave"
    root.mkdir()
    meta_path = root / "tenant.json"
    meta_path.write_text(
        json.dumps(
            {
                "id": "dave",
                "display_name": "Dave",
                "gh_token": "legacy-plain-token",
                "gh_webhook_secret": "legacy-whsec",
                "visibility": "unlisted",
            }
        ),
        encoding="utf-8",
    )
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    loaded = tenants.manager()._tenant_from_json("dave", root, data)
    assert loaded.gh_token == "legacy-plain-token"
    assert loaded.gh_webhook_secret == "legacy-whsec"

    loaded._persist()
    rewritten = json.loads(meta_path.read_text(encoding="utf-8"))
    assert rewritten["gh_token"].startswith("enc:v1:")
    assert rewritten["gh_webhook_secret"].startswith("enc:v1:")
    assert "legacy-plain-token" not in json.dumps(rewritten)

    again = tenants.manager()._tenant_from_json("dave", root, rewritten)
    assert again.gh_token == "legacy-plain-token"
    assert again.gh_webhook_secret == "legacy-whsec"
