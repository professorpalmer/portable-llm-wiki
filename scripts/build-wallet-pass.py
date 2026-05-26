#!/usr/bin/env python3
"""Build an Apple Wallet pass (.pkpass) pointing at your Portable LLM Wiki.

The pass is a generic "card-style" pass that:
  - Holds your wiki URL as the primary back-of-card field
  - Encodes the URL as a QR-code-equivalent (Apple Wallet uses PKBarcodeFormatQR)
  - Has fields for your name, title, and a one-line bio
  - When tapped while near a paired iPhone via NFC, can deep-link to your wiki

This script writes an UNSIGNED .pkpass bundle to dist/wallet/<slug>.pkpass.
To produce a SIGNED pass (the only kind iOS will accept), you need:

  1. An Apple Developer account ($99/year)
  2. A "Pass Type ID" registered at https://developer.apple.com/account
  3. The corresponding signing certificate exported as a .p12
  4. Apple's WWDR intermediate certificate

The signing step is documented at the bottom of this file. For a one-off
personal pass you can also use a third-party signing service like
walletpasses.io (paid) — that's the lowest-friction path if you don't
already have an Apple Developer account.

Usage:
  python scripts/build-wallet-pass.py \\
      --name "Jane Doe" \\
      --title "Software Engineer" \\
      --wiki-url "https://wiki.example.com" \\
      --bio "Building owned, portable AI memory."

Or with the bundled defaults:
  python scripts/build-wallet-pass.py --wiki-url "https://wiki.example.com"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

# --- Defaults (override on the command line) --------------------------------

DEFAULT_NAME = "Avery Chen"
DEFAULT_TITLE = "Founding Engineer · Strand Bio"
DEFAULT_BIO = "Markdown in git. Queryable by any LLM."
DEFAULT_FOREGROUND = "rgb(26, 24, 20)"      # ink
DEFAULT_BACKGROUND = "rgb(250, 248, 245)"   # paper
DEFAULT_LABEL = "rgb(140, 128, 116)"        # ink-muted

# Apple's reserved-but-unused Pass Type ID. Replace with your own after
# registering one in your Apple Developer account.
DEFAULT_PASS_TYPE_ID = "pass.dev.portable-llm-wiki"
DEFAULT_TEAM_ID = "REPLACE_WITH_YOUR_APPLE_TEAM_ID"
DEFAULT_ORG = "Portable LLM Wiki"


# --- pass.json builder ------------------------------------------------------


def slugify(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9\-]+", "-", s.strip()).strip("-").lower()
    return s or "wallet-pass"


def build_pass_json(args: argparse.Namespace) -> dict:
    serial = hashlib.sha1(args.wiki_url.encode("utf-8")).hexdigest()[:16]
    return {
        "formatVersion": 1,
        "passTypeIdentifier": args.pass_type_id,
        "teamIdentifier": args.team_id,
        "organizationName": args.org,
        "serialNumber": serial,
        "description": f"{args.name} — Portable LLM Wiki",
        "logoText": args.name,
        "foregroundColor": args.foreground,
        "backgroundColor": args.background,
        "labelColor": args.label_color,
        "generic": {
            "primaryFields": [
                {
                    "key": "name",
                    "label": "wiki owner",
                    "value": args.name,
                }
            ],
            "secondaryFields": [
                {
                    "key": "title",
                    "label": "role",
                    "value": args.title,
                }
            ],
            "auxiliaryFields": [
                {
                    "key": "bio",
                    "label": "about",
                    "value": args.bio,
                }
            ],
            "backFields": [
                {
                    "key": "wiki_url",
                    "label": "Open the wiki",
                    "value": args.wiki_url,
                    "attributedValue": f'<a href="{args.wiki_url}">{args.wiki_url}</a>',
                },
                {
                    "key": "how",
                    "label": "What this is",
                    "value": (
                        "A Portable LLM Wiki is an LLM-queryable personal "
                        "context artifact. Owned by the wiki owner, served "
                        "as markdown, readable by any LLM client. Scan the "
                        "QR or open the URL above to ask it anything."
                    ),
                },
                {
                    "key": "tip",
                    "label": "Tip",
                    "value": (
                        "Paste the URL into ChatGPT, Claude, or any LLM with web "
                        "access. Say: 'Load this wiki and answer questions about "
                        "the owner.' It just works."
                    ),
                },
            ],
        },
        "barcodes": [
            {
                "format": "PKBarcodeFormatQR",
                "message": args.wiki_url,
                "messageEncoding": "iso-8859-1",
                "altText": args.wiki_url,
            }
        ],
        # NFC payload — when paired, taps the wiki URL into the user's clipboard.
        "nfc": {
            "message": args.wiki_url,
            "encryptionPublicKey": "",
        },
    }


# --- bundle writer ----------------------------------------------------------


def write_bundle(args: argparse.Namespace, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = slugify(args.name)
    bundle_dir = out_dir / f"{slug}.pass"
    if bundle_dir.exists():
        shutil.rmtree(bundle_dir)
    bundle_dir.mkdir()

    pass_json = build_pass_json(args)
    (bundle_dir / "pass.json").write_text(
        json.dumps(pass_json, indent=2), encoding="utf-8"
    )

    # Apple requires icon.png. We ship a placeholder SVG-stamped PNG note
    # since this script doesn't depend on PIL. Replace icon.png and
    # logo.png with real 29x29 / 160x50 raster assets before signing.
    placeholder = (
        "PLACEHOLDER — replace with a real 29x29 PNG for icon.png and a "
        "160x50 PNG for logo.png before signing. Apple Wallet will reject "
        "a pass without these images.\n"
    )
    (bundle_dir / "icon.png.placeholder.txt").write_text(placeholder)
    (bundle_dir / "logo.png.placeholder.txt").write_text(placeholder)

    # Manifest: SHA1 of each file in the bundle (excludes signature itself).
    manifest = {}
    for f in sorted(bundle_dir.iterdir()):
        if not f.is_file():
            continue
        manifest[f.name] = hashlib.sha1(f.read_bytes()).hexdigest()
    (bundle_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )

    # Zip the bundle into a .pkpass (Apple's required format).
    pkpass_path = out_dir / f"{slug}.pkpass"
    if pkpass_path.exists():
        pkpass_path.unlink()
    with zipfile.ZipFile(pkpass_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in bundle_dir.iterdir():
            if f.is_file():
                zf.write(f, arcname=f.name)
    return pkpass_path


# --- main -------------------------------------------------------------------


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", default=DEFAULT_NAME)
    p.add_argument("--title", default=DEFAULT_TITLE)
    p.add_argument("--bio", default=DEFAULT_BIO)
    p.add_argument("--wiki-url", required=True, help="The URL to encode in the pass barcode + back card.")
    p.add_argument("--pass-type-id", default=DEFAULT_PASS_TYPE_ID)
    p.add_argument("--team-id", default=DEFAULT_TEAM_ID)
    p.add_argument("--org", default=DEFAULT_ORG)
    p.add_argument("--foreground", default=DEFAULT_FOREGROUND)
    p.add_argument("--background", default=DEFAULT_BACKGROUND)
    p.add_argument("--label-color", default=DEFAULT_LABEL)
    p.add_argument("--out", default="dist/wallet", help="Output directory.")
    args = p.parse_args(argv)

    out_dir = Path(args.out).resolve()
    pkpass = write_bundle(args, out_dir)

    print(f"\n✓ Unsigned .pkpass written to: {pkpass}")
    print(f"  Bundle source: {out_dir / (slugify(args.name) + '.pass')}\n")
    print("To produce a SIGNED pass that iOS will accept:")
    print("  1. Replace the icon.png and logo.png placeholders with real assets.")
    print("  2. Register a Pass Type ID at https://developer.apple.com/account")
    print("     (Identifiers > Pass Type IDs). Get its identifier — overrides")
    print("     --pass-type-id and --team-id.")
    print("  3. Download the corresponding signing certificate (.cer) and the")
    print("     WWDR intermediate certificate. Export your Pass Type ID signing")
    print("     cert + private key to a .p12 in Keychain Access.")
    print("  4. Use the `signpass` tool from Apple's PassKit Sample Code, or:")
    print("       openssl smime -binary -sign -certfile WWDR.pem \\")
    print("                   -signer passcert.pem -inkey passkey.pem \\")
    print("                   -in manifest.json -out signature \\")
    print("                   -outform DER -passin pass:<your-pass-password>")
    print("     Then zip {manifest.json,pass.json,signature,*.png} into .pkpass.")
    print()
    print("Lowest-friction signing-as-a-service for a one-off personal pass:")
    print("  https://walletpasses.io   (paid, no Apple Dev account required)")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
