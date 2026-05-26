#!/usr/bin/env python3
"""Generate Portable LLM Wiki share-kit banners as PNG files.

WHY THIS EXISTS
---------------
The browser-based ``/brand`` page used html-to-image to rasterize React
components. In practice it kept producing PNGs at the wrong dimensions
(html-to-image computes the canvas size from the captured node's
bounding rect, which is unreliable when transformed ancestors or CSS
quirks intervene). LinkedIn then rejected uploads as "Save failed"
because the image was below its 1192 px minimum width.

This script renders the same three banner formats directly with
Pillow + qrcode, producing PNG files at EXACTLY the upload-spec
dimensions every time. No browser, no DOM, no surprises.

USAGE
-----
    python3 scripts/generate_banners.py \\
        --name "Jane Doe" \\
        --url  "https://portablellm.wiki/janedoe" \\
        --out  assets/branding/janedoe

The recommended ``--url`` is the tenant LANDING URL (not the ``/llm``
handshake URL). Phone cameras open the encoded URL when scanned, so
pointing at the landing page lands the human on a rendered wiki —
which itself has a prominent "Paste this URL into any LLM" widget for
the chat-handoff flow. Pointing the QR at ``/llm`` directly used to
open raw markdown text in the phone browser, which surprised users.

Produces three files in the output directory:

    linkedin-cover.png    1584 x 396  (LinkedIn profile banner)
    post-card.png         1200 x 627  (LinkedIn / X / FB link share)
    square.png            1080 x 1080 (Instagram, WhatsApp, anywhere)

The QR payload is the same fetch-forcing prompt the live frontend
embeds (see frontend/lib/llmPrompts.ts) so a vision-AI that decodes
the QR gets an imperative "GET this URL and follow the API spec"
instruction baked in, not a bare URL.

DEPENDENCIES
------------
    pip install Pillow qrcode

Both are pure-Python (Pillow has a C extension but ships wheels).
Fonts are loaded from macOS system paths — adjust ``_pick_font`` if
running on Linux/Windows.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("Pillow not installed. Run: pip install Pillow qrcode")

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_M
except ImportError:
    sys.exit("qrcode not installed. Run: pip install qrcode")


# ---------------------------------------------------------------------------
# Brand tokens — kept in sync with frontend/tailwind.config.ts so the
# script-generated banners look identical to the in-app preview ever
# rendered. If you tweak the palette here, mirror it in tailwind too.
# ---------------------------------------------------------------------------

INK = (14, 14, 16)           # #0e0e10
INK_SOFT = (26, 26, 31)      # #1a1a1f
INK_MUTED = (139, 139, 150)  # #8b8b96
PAPER = (250, 250, 247)      # #fafaf7
PAPER_SOFT = (243, 243, 238) # #f3f3ee
ACCENT = (255, 106, 0)       # #ff6a00
ACCENT_SOFT = (253, 227, 207)  # #fde3cf


# ---------------------------------------------------------------------------
# Font discovery — try macOS native first, fall back as needed. We want
# a sans-serif with weight variation so the headline pops against the
# subdued subhead + footer. Arial / Arial Bold ship on every macOS
# install and have predictable Unicode coverage, so they're a safe
# default. SF Pro would be prettier but its file structure (.ttf
# variable font) makes Pillow weight handling fiddly across versions.
# ---------------------------------------------------------------------------

_FONT_CANDIDATES_REGULAR = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",  # Linux fallback
]

_FONT_CANDIDATES_BOLD = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

_FONT_CANDIDATES_MONO = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/SFNSMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]


def _pick_font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    """Return the first font in `candidates` that exists, sized to `size`.
    Raises a clear error if nothing works — better than silently falling
    back to PIL's ugly bitmap default and producing a deformed banner."""
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise RuntimeError(
        f"No usable font found among: {candidates}. "
        "Install one or edit _FONT_CANDIDATES_* at the top of this script."
    )


# ---------------------------------------------------------------------------
# QR payload — must match buildQrPayload() in frontend/lib/llmPrompts.ts
# so the in-product QR and the print-asset QR encode the same string.
#
# Payload is the URL ONLY (no wrapper prompt). An earlier version
# embedded "GET <url> and follow the API spec…" so vision-AI decoders
# got an imperative instruction, but that broke the dominant use case:
# phone cameras stopped offering a one-tap "Open URL" action because
# the payload was no longer a clean URL. See the frontend helper's
# docstring for the full rationale.
# ---------------------------------------------------------------------------

def build_qr_payload(llm_url: str) -> str:
    """Mirror of buildQrPayload() in frontend/lib/llmPrompts.ts.

    Returns the URL verbatim so phone scanners detect it as a URL
    and offer a one-tap "Open in browser" action. The /llm endpoint
    the URL resolves to IS the self-describing LLM handshake, so any
    LLM that fetches the URL gets the full API spec in the response
    body — no wrapper prompt is needed at the QR layer."""
    return llm_url


def render_qr(payload: str, size_px: int) -> Image.Image:
    """Build a black-on-paper QR at exactly `size_px` square. Uses
    error correction M (15% recovery) — the sweet spot for print
    where slight damage / glare is normal but density needs to stay
    low enough to scan at small sizes."""
    qr = qrcode.QRCode(
        version=None,           # auto-pick smallest version that fits
        error_correction=ERROR_CORRECT_M,
        box_size=10,            # we resize after; this is just a base
        border=1,               # tight margin — looks nicer in framed contexts
    )
    qr.add_data(payload)
    qr.make(fit=True)
    img = qr.make_image(fill_color=INK, back_color=PAPER).convert("RGB")
    return img.resize((size_px, size_px), Image.NEAREST)


# ---------------------------------------------------------------------------
# Banner config — one dataclass per format. Keeping everything in
# data instead of branching inside render functions makes it easy to
# add a fourth format (Twitter header, business card, etc.).
# ---------------------------------------------------------------------------

@dataclass
class BannerSpec:
    name: str           # filename (without .png)
    width: int
    height: int
    layout: str         # "side-by-side" or "vertical-stack"
    # Pixels of bottom-left real estate that will be overlaid by the
    # platform's profile photo. LinkedIn's profile picture sits at the
    # bottom-left of the cover banner with its center roughly on the
    # banner's bottom edge — meaning the upper half of the photo
    # circle obscures the lower-left of the banner. We reserve a
    # column of `profile_photo_safe_w` px on the left so the entire
    # text block clears the photo even at the larger "jumbo" rendering
    # some accounts use. Defaults to 0 for formats that aren't
    # profile-banner shaped (post card, square thumbnail).
    profile_photo_safe_w: int = 0


SPECS = [
    # LinkedIn covers get a 360 px left safe zone. Empirically measured
    # against a real profile screenshot: LinkedIn renders the profile
    # photo with its right edge at roughly x=441 on a 1584-wide banner
    # (much larger than the 152 px desktop spec suggests, because the
    # profile preview canvas scales the photo up). 360 px of left
    # padding puts our first character at x≈470 — clearing the photo
    # right edge with ~30 px of breathing room. If your profile photo
    # sits differently (e.g. a custom brand setup), pass --photo-safe-w
    # on the CLI to override.
    BannerSpec("linkedin-cover", 1584, 396, "side-by-side", profile_photo_safe_w=360),
    BannerSpec("post-card",      1200, 627, "side-by-side"),
    BannerSpec("square",         1080, 1080, "vertical-stack"),
]


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------

def _measure(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont) -> tuple[int, int]:
    """Width, height of `text` rendered with `font`. Pillow's
    textbbox is more accurate than textsize (deprecated in 10.x)."""
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _draw_eyebrow(
    draw: ImageDraw.ImageDraw,
    pos: tuple[int, int],
    label: str,
    font: ImageFont.FreeTypeFont,
    color: tuple[int, int, int] = ACCENT,
) -> int:
    """Draw the "● PORTABLE LLM WIKI" eyebrow tag. Returns the y
    position immediately below the tag so the caller can stack the
    headline next."""
    x, y = pos
    dot_size = max(6, font.size // 3)
    # Dot — drawn as a filled circle so the tag has the same
    # "● TAG" rhythm as the live landing page.
    draw.ellipse(
        [x, y + (font.size // 3), x + dot_size, y + (font.size // 3) + dot_size],
        fill=color,
    )
    gap = dot_size + (dot_size // 2)
    draw.text((x + gap, y), label, fill=color, font=font)
    _, h = _measure(draw, label, font)
    return y + h


def _draw_qr_frame(
    base: Image.Image,
    top_left: tuple[int, int],
    panel_size: int,
    qr_img: Image.Image,
    label: str,
    caption: str,
    footer_url: str,
    fonts: dict,
) -> None:
    """Draw the peach-framed QR card with eyebrow + caption + QR +
    footer URL. Matches the live HeroStream QR card on the landing
    page so the in-product and print artifacts read as the same brand."""
    x, y = top_left
    draw = ImageDraw.Draw(base)
    padding = max(16, panel_size // 12)
    radius = max(12, panel_size // 16)

    # Outer peach frame.
    draw.rounded_rectangle(
        [x, y, x + panel_size, y + panel_size],
        radius=radius,
        fill=ACCENT_SOFT,
    )

    cursor_y = y + padding

    # Eyebrow tag inside the frame.
    eyebrow_font = fonts["eyebrow_qr"]
    draw.text((x + padding, cursor_y), label, fill=ACCENT, font=eyebrow_font)
    _, eyebrow_h = _measure(draw, label, eyebrow_font)
    cursor_y += eyebrow_h + (padding // 2)

    # Caption "@ <display_name>".
    cap_font = fonts["caption"]
    draw.text((x + padding, cursor_y), caption, fill=INK_MUTED, font=cap_font)
    _, cap_h = _measure(draw, caption, cap_font)
    cursor_y += cap_h + padding

    # QR inner white tile. The QR itself sits inside a paper-colored
    # box with its own inner padding — same visual rhythm as the
    # /share page QR card.
    qr_inner_pad = max(8, padding // 3)
    qr_box_size = panel_size - 2 * padding
    qr_tile_y_end = cursor_y + qr_box_size
    # Make sure the QR tile fits inside the frame.
    if qr_tile_y_end + padding > y + panel_size:
        # Recompute QR box size to fit the remaining vertical space.
        available = (y + panel_size) - cursor_y - padding
        qr_box_size = min(qr_box_size, available)
    qr_tile_x = x + padding
    qr_tile_y = cursor_y
    draw.rounded_rectangle(
        [
            qr_tile_x,
            qr_tile_y,
            qr_tile_x + qr_box_size,
            qr_tile_y + qr_box_size,
        ],
        radius=max(8, radius // 2),
        fill=PAPER,
    )
    # Paste resized QR centered in the tile.
    qr_target = qr_box_size - 2 * qr_inner_pad
    qr_resized = qr_img.resize((qr_target, qr_target), Image.NEAREST)
    base.paste(qr_resized, (qr_tile_x + qr_inner_pad, qr_tile_y + qr_inner_pad))

    # Footer URL under the QR (mono, muted).
    footer_y = qr_tile_y + qr_box_size + (padding // 2)
    mono_font = fonts["mono"]
    fw, _ = _measure(draw, footer_url, mono_font)
    if fw > panel_size - 2 * padding:
        # URL too long to fit — fall back to ellipsizing the middle so
        # the domain + handle stay visible.
        footer_url = _ellipsize_mono(draw, footer_url, mono_font, panel_size - 2 * padding)
        fw, _ = _measure(draw, footer_url, mono_font)
    draw.text(
        (x + (panel_size - fw) // 2, footer_y),
        footer_url,
        fill=INK_MUTED,
        font=mono_font,
    )


def _ellipsize_mono(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_w: int,
) -> str:
    """Trim a long URL middle-out so the domain prefix AND the path
    tail stay visible — better signal for a print-asset reader than
    a plain "domain.com/very/long/pa…" tail ellipsis.

    Two-pointer single pass: we compute target keep length, then
    splice "<head>…<tail>" once. Avoids the multi-iteration drift
    where a previous implementation stacked ellipses into garbled
    middles ("…wik_essorpalmer/llm")."""
    if _measure(draw, text, font)[0] <= max_w:
        return text
    n = len(text)
    # Binary-search the largest keep-length whose ellipsized form
    # still fits. We split the keep-budget 60/40 head/tail because
    # the domain prefix is more recognizable than the path suffix.
    lo, hi = 4, n - 1
    best = text[:2] + "…" + text[-2:]
    while lo <= hi:
        mid = (lo + hi) // 2
        head_n = (mid * 6) // 10
        tail_n = mid - head_n
        candidate = text[:head_n] + "…" + text[-tail_n:] if tail_n > 0 else text[:head_n] + "…"
        if _measure(draw, candidate, font)[0] <= max_w:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return best


# ---------------------------------------------------------------------------
# Banner layouts
# ---------------------------------------------------------------------------

def _render_side_by_side(spec: BannerSpec, ctx: "RenderContext") -> Image.Image:
    """LinkedIn cover + post card: orange edge accent, left content
    block (eyebrow + headline + subhead + URL), right QR card."""
    img = Image.new("RGB", (spec.width, spec.height), PAPER)
    draw = ImageDraw.Draw(img)

    # Left accent bar — same visual cue as the landing page.
    accent_w = 6 if spec.height < 500 else 12
    draw.rectangle([0, 0, accent_w, spec.height], fill=ACCENT)

    # For the post-card we also add two small corner accents so the
    # banner reads well at small thumbnail sizes (e.g. inside a
    # LinkedIn feed link preview).
    if spec.name == "post-card":
        draw.rectangle([0, 0, 80, 8], fill=ACCENT)
        draw.rectangle([spec.width - 80, spec.height - 8, spec.width, spec.height], fill=ACCENT)

    # Layout: 60/40 split with generous gap. Padding scales with
    # banner height so the LinkedIn cover (squat) and post card
    # (taller) both breathe.
    pad_x = 80
    pad_y = 60 if spec.height < 500 else 80
    # Picking the QR panel size: same min(height) heuristic as the
    # React component so the visual mass on the right matches.
    qr_panel_size = min(spec.height - pad_y, 320 if spec.height < 500 else 420)
    qr_x = spec.width - pad_x - qr_panel_size
    qr_y = (spec.height - qr_panel_size) // 2

    # Text block coordinates. The whole left block — eyebrow, headline,
    # subhead, footer URL — shifts right by `profile_photo_safe_w` so it
    # clears the platform's profile-photo overlay. We move the eyebrow
    # too (instead of leaving it pinned to the corner) so the indent
    # reads as deliberate composition rather than a half-broken layout
    # where one tag floats alone in the photo's column.
    text_left = pad_x + accent_w + 24 + spec.profile_photo_safe_w
    text_right = qr_x - 40  # leave breathing room before the QR
    text_top = pad_y

    # Eyebrow.
    eyebrow_y_end = _draw_eyebrow(
        draw,
        (text_left, text_top),
        "PORTABLE LLM WIKI",
        ctx.fonts["eyebrow"],
    )

    # Headline — auto-wraps if it doesn't fit the available width.
    # Line gap scales with font size so big headlines breathe and
    # small ones stay tight. The +12 floor prevents descender/ascender
    # collisions on small fonts. The subhead sits 28px below the last
    # headline line so the two text blocks read as separate beats
    # rather than continuous prose.
    head_y = eyebrow_y_end + 18
    headline_lines = _wrap_to_width(
        draw, ctx.headline, ctx.fonts["headline"], text_right - text_left
    )
    line_gap = max(12, ctx.fonts["headline"].size // 7)
    for line in headline_lines:
        draw.text((text_left, head_y), line, fill=INK, font=ctx.fonts["headline"])
        _, lh = _measure(draw, line, ctx.fonts["headline"])
        head_y += lh + line_gap

    # Subhead.
    sub_y = head_y + 16
    draw.text((text_left, sub_y), ctx.subhead, fill=INK, font=ctx.fonts["subhead"])
    _, sub_h = _measure(draw, ctx.subhead, ctx.fonts["subhead"])

    # URL footer (mono).
    url_y = sub_y + sub_h + 18
    draw.text((text_left, url_y), ctx.footer_url, fill=INK_MUTED, font=ctx.fonts["mono"])

    # QR card on the right.
    _draw_qr_frame(
        base=img,
        top_left=(qr_x, qr_y),
        panel_size=qr_panel_size,
        qr_img=ctx.qr_img,
        label="SCAN TO MEET ME",
        caption=f"@ {ctx.name}",
        footer_url=ctx.footer_url,
        fonts=ctx.fonts,
    )

    return img


def _render_vertical_stack(spec: BannerSpec, ctx: "RenderContext") -> Image.Image:
    """Square thumbnail: top accent bar, eyebrow + headline at top,
    QR + caption + URL stacked at bottom. Vertical layouts read better
    in IG / WhatsApp tile grids where height is the dominant axis."""
    img = Image.new("RGB", (spec.width, spec.height), PAPER)
    draw = ImageDraw.Draw(img)

    # Top accent bar — clear top edge for the square format.
    draw.rectangle([0, 0, spec.width, 12], fill=ACCENT)

    pad_x = 80
    pad_y = 96

    # Eyebrow.
    eyebrow_y_end = _draw_eyebrow(
        draw,
        (pad_x, pad_y),
        "PORTABLE LLM WIKI",
        ctx.fonts["eyebrow"],
    )

    # Headline.
    head_y = eyebrow_y_end + 32
    headline_lines = _wrap_to_width(
        draw, ctx.headline, ctx.fonts["headline"], spec.width - 2 * pad_x
    )
    for line in headline_lines:
        draw.text((pad_x, head_y), line, fill=INK, font=ctx.fonts["headline"])
        _, lh = _measure(draw, line, ctx.fonts["headline"])
        head_y += lh + 6

    # Subhead.
    sub_y = head_y + 20
    draw.text((pad_x, sub_y), ctx.subhead, fill=INK, font=ctx.fonts["subhead"])

    # Bottom block: QR on right, descriptive text on left.
    bottom_pad = pad_y
    qr_panel_size = 520
    qr_x = spec.width - pad_x - qr_panel_size
    qr_y = spec.height - bottom_pad - qr_panel_size

    _draw_qr_frame(
        base=img,
        top_left=(qr_x, qr_y),
        panel_size=qr_panel_size,
        qr_img=ctx.qr_img,
        label="SCAN TO MEET ME",
        caption=f"@ {ctx.name}",
        footer_url=ctx.footer_url,
        fonts=ctx.fonts,
    )

    # Left-side blurb above the URL.
    blurb_x = pad_x
    blurb_w = qr_x - pad_x - 32
    blurb_y = qr_y + 40
    blurb_lines = _wrap_to_width(
        draw,
        "A portable database of you. Scan it with any phone — your LLM "
        "finally has context to answer for you.",
        ctx.fonts["body"],
        blurb_w,
    )
    for line in blurb_lines:
        draw.text((blurb_x, blurb_y), line, fill=INK_MUTED, font=ctx.fonts["body"])
        _, bh = _measure(draw, line, ctx.fonts["body"])
        blurb_y += bh + 4

    # Domain in bold mono near the bottom.
    blurb_y += 16
    draw.text(
        (blurb_x, blurb_y),
        ctx.footer_url,
        fill=INK,
        font=ctx.fonts["mono_bold"],
    )

    return img


def _wrap_to_width(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_w: int,
) -> list[str]:
    """Greedy word-wrap. Returns lines that each fit within max_w
    pixels. We never split words — long words just overflow rather
    than getting hyphenated, which usually looks worse than overflow."""
    words = text.split()
    lines: list[str] = []
    cur: list[str] = []
    for w in words:
        candidate = (" ".join(cur + [w])).strip()
        if _measure(draw, candidate, font)[0] <= max_w or not cur:
            cur.append(w)
        else:
            lines.append(" ".join(cur))
            cur = [w]
    if cur:
        lines.append(" ".join(cur))
    return lines


# ---------------------------------------------------------------------------
# Render context — bundles per-banner state we'd otherwise pass through
# 12 function arguments.
# ---------------------------------------------------------------------------

@dataclass
class RenderContext:
    name: str
    headline: str
    subhead: str
    footer_url: str
    qr_img: Image.Image
    fonts: dict


def _build_fonts(spec: BannerSpec) -> dict:
    """Pick font sizes proportional to banner dimensions. Tested
    visually against the React /brand preview so the print artifacts
    look identical to what the live frontend would have rendered."""
    if spec.name == "linkedin-cover":
        # Headline drops from 72 → 56 because the 290 px profile-photo
        # safe zone (see SPECS) shrinks the usable text column to
        # ~750 px. At 72 px the headline wrapped awkwardly and the
        # second line collided with the subhead; 56 px lets "Your LLM
        # doesn't" / "know you." wrap to two balanced lines with
        # comfortable line gap before the subhead beneath.
        return {
            "eyebrow":     _pick_font(_FONT_CANDIDATES_BOLD, 16),
            "eyebrow_qr":  _pick_font(_FONT_CANDIDATES_BOLD, 14),
            "headline":    _pick_font(_FONT_CANDIDATES_BOLD, 56),
            "subhead":     _pick_font(_FONT_CANDIDATES_REGULAR, 24),
            "body":        _pick_font(_FONT_CANDIDATES_REGULAR, 18),
            "caption":     _pick_font(_FONT_CANDIDATES_REGULAR, 16),
            "mono":        _pick_font(_FONT_CANDIDATES_MONO, 14),
            "mono_bold":   _pick_font(_FONT_CANDIDATES_BOLD, 18),
        }
    if spec.name == "post-card":
        # Headline drops from 80 → 64 to keep the 26-char default
        # ("Your LLM doesn't know you.") at two lines max with the QR
        # panel taking ~40% of the canvas width. Tighter sizes than 64
        # start to look thin against the chunky LinkedIn cover.
        return {
            "eyebrow":     _pick_font(_FONT_CANDIDATES_BOLD, 18),
            "eyebrow_qr":  _pick_font(_FONT_CANDIDATES_BOLD, 16),
            "headline":    _pick_font(_FONT_CANDIDATES_BOLD, 64),
            "subhead":     _pick_font(_FONT_CANDIDATES_REGULAR, 28),
            "body":        _pick_font(_FONT_CANDIDATES_REGULAR, 20),
            "caption":     _pick_font(_FONT_CANDIDATES_REGULAR, 18),
            "mono":        _pick_font(_FONT_CANDIDATES_MONO, 16),
            "mono_bold":   _pick_font(_FONT_CANDIDATES_BOLD, 20),
        }
    # square (1080x1080)
    return {
        "eyebrow":     _pick_font(_FONT_CANDIDATES_BOLD, 22),
        "eyebrow_qr":  _pick_font(_FONT_CANDIDATES_BOLD, 22),
        "headline":    _pick_font(_FONT_CANDIDATES_BOLD, 92),
        "subhead":     _pick_font(_FONT_CANDIDATES_REGULAR, 36),
        "body":        _pick_font(_FONT_CANDIDATES_REGULAR, 22),
        "caption":     _pick_font(_FONT_CANDIDATES_REGULAR, 22),
        "mono":        _pick_font(_FONT_CANDIDATES_MONO, 18),
        "mono_bold":   _pick_font(_FONT_CANDIDATES_BOLD, 22),
    }


def render_banner(spec: BannerSpec, ctx: RenderContext) -> Image.Image:
    if spec.layout == "side-by-side":
        return _render_side_by_side(spec, ctx)
    if spec.layout == "vertical-stack":
        return _render_vertical_stack(spec, ctx)
    raise ValueError(f"Unknown layout: {spec.layout}")


# ---------------------------------------------------------------------------
# Debug helpers
# ---------------------------------------------------------------------------

def _overlay_photo_silhouette(banner: Image.Image, spec: BannerSpec) -> Image.Image:
    """Draw a translucent gray circle where LinkedIn's profile photo
    will sit. Used by --debug-photo-overlay so the human can sanity-
    check the safe zone visually before committing to the live upload.

    The circle's geometry mirrors LinkedIn's profile-preview canvas:
    center sits on the banner's bottom edge, ~120 px in from the left,
    with radius ~170 px (the larger preview rendering, not the smaller
    standard 76 px live-view rendering — we want to verify against the
    worst case)."""
    overlay = Image.new("RGBA", banner.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    cx, cy, r = 120 + 60, banner.height, 170
    od.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        fill=(60, 60, 80, 110),
        outline=(60, 60, 80, 220),
        width=3,
    )
    out = banner.convert("RGBA")
    out.alpha_composite(overlay)
    return out.convert("RGB")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate Portable LLM Wiki share banners as PNGs.",
    )
    parser.add_argument(
        "--name",
        required=True,
        help="Display name shown in the QR caption (e.g. 'Jane Doe').",
    )
    parser.add_argument(
        "--url",
        required=True,
        help=(
            "The LLM-handshake URL the QR resolves to. Usually "
            "https://portablellm.wiki/<tenant>/llm[?t=<share-token>]. "
            "Include ?t=<token> for tier-gated recruiter/friend QRs."
        ),
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="Output directory. Created if missing.",
    )
    parser.add_argument(
        "--headline",
        default="Your LLM doesn't know you.",
        help="Headline text. Default matches the landing page.",
    )
    parser.add_argument(
        "--subhead",
        default="It will in 60 seconds.",
        help="Subhead text. Default matches the landing page.",
    )
    parser.add_argument(
        "--photo-safe-w",
        type=int,
        default=None,
        help=(
            "Override the LinkedIn-cover left safe-zone in pixels. "
            "Defaults to 360, which clears the standard profile photo "
            "plus the larger rendering LinkedIn shows in the profile "
            "preview canvas. Pass 0 to disable (text starts at the "
            "left edge). Pass a larger value if your profile photo is "
            "unusually big."
        ),
    )
    parser.add_argument(
        "--debug-photo-overlay",
        action="store_true",
        help=(
            "Overlay a translucent gray disc on the LinkedIn cover at "
            "the spot where the profile photo would sit. Use this to "
            "visually confirm the safe zone matches your actual photo "
            "before uploading. The overlay is purely diagnostic and "
            "is never written to non-debug banners."
        ),
    )
    args = parser.parse_args(argv)

    # CLI override flows into the LinkedIn-cover spec only — post card
    # and square don't sit under a profile photo so the offset is
    # meaningless for them. Mutating the module-level SPECS list keeps
    # the rest of the rendering pipeline parameter-free.
    if args.photo_safe_w is not None:
        for s in SPECS:
            if s.name == "linkedin-cover":
                s.profile_photo_safe_w = max(0, args.photo_safe_w)

    args.out.mkdir(parents=True, exist_ok=True)

    # The footer URL is the user-visible link on each banner — we
    # strip the protocol + share-token query so visible text stays
    # clean ("portablellm.wiki/cary"). The QR still carries the full
    # URL including any token.
    visible_url = args.url
    if "://" in visible_url:
        visible_url = visible_url.split("://", 1)[1]
    if "?" in visible_url:
        visible_url = visible_url.split("?", 1)[0]

    # Pre-build a single large QR image — we resize per banner.
    # Building once is faster but also ensures all three banners
    # encode IDENTICAL payloads (no rounding-error drift).
    qr_payload = build_qr_payload(args.url)
    print(
        f"QR payload ({len(qr_payload.encode('utf-8'))} bytes UTF-8): {qr_payload}",
        file=sys.stderr,
    )
    qr_master = render_qr(qr_payload, size_px=1024)

    for spec in SPECS:
        fonts = _build_fonts(spec)
        ctx = RenderContext(
            name=args.name,
            headline=args.headline,
            subhead=args.subhead,
            footer_url=visible_url,
            qr_img=qr_master,
            fonts=fonts,
        )
        banner = render_banner(spec, ctx)
        # Sanity-check the output dimensions before saving — this is
        # the exact contract that LinkedIn enforces; if we ever drift
        # below the upload-spec minimum, fail loudly instead of
        # quietly emitting a too-small banner.
        if (banner.width, banner.height) != (spec.width, spec.height):
            raise RuntimeError(
                f"{spec.name}: rendered {banner.size}, expected "
                f"{(spec.width, spec.height)}. Refusing to save."
            )
        # Optional debug overlay: draws a translucent gray disc where
        # LinkedIn's profile photo will land so the human can sanity-
        # check the safe zone before uploading. Only applied to the
        # LinkedIn cover (the only banner with a photo overlay), and
        # written to a separate -debug.png so the real banner stays
        # clean.
        if args.debug_photo_overlay and spec.profile_photo_safe_w > 0:
            debug_banner = _overlay_photo_silhouette(banner, spec)
            debug_path = args.out / f"{spec.name}-debug.png"
            debug_banner.save(debug_path, format="PNG", optimize=True)
            print(f"  wrote {debug_path}  (debug overlay)")
        out_path = args.out / f"{spec.name}.png"
        banner.save(out_path, format="PNG", optimize=True)
        print(f"  wrote {out_path}  ({spec.width}x{spec.height})")

    print(f"\nDone. {len(SPECS)} banners written to {args.out}/", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
