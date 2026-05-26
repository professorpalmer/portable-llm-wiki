"""Frictionless capture: screenshot OCR, audio transcription, paste-text → ingest.

The wiki only compounds at the rate ingest is friction-free. This module
implements three capture surfaces:

1. **Image / screenshot** → Anthropic Claude vision (or OpenAI GPT-4o
   vision) transcribes/extracts the visible content as markdown.
2. **Audio / voice memo** → OpenAI Whisper transcribes.
3. **Paste** → raw text written straight to `raw/...` (no transcription
   needed).

All three end the same way: a raw source file at
`raw/<subdir>/YYYY-MM-DD-<slug>.md` that the owner can either save as-is or
fire through the existing Puppetmaster ingest pipeline (`run_orchestrator`).

We deliberately don't auto-run the ingest pipeline on capture — capture
gives the owner the *transcribed text*, the owner reviews/edits it, then
*decides* whether to spend tokens on the full pipeline. Otherwise a stray
screenshot could trigger a 90-second LLM run with no human in the loop.
"""
from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Optional

import httpx

from .config import settings


# ---------------------------------------------------------------------------
# Slugify
# ---------------------------------------------------------------------------


def _slugify(label: str) -> str:
    s = label.lower().strip()
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-") or "untitled"


def _today_slug(label: str) -> str:
    return f"{date.today().isoformat()}-{_slugify(label)}"


# ---------------------------------------------------------------------------
# File save helpers
# ---------------------------------------------------------------------------


@dataclass
class CaptureResult:
    rel_path: str  # relative to wiki_root (e.g. raw/conversations/...)
    size: int
    text: str  # the markdown body written
    transcribed_by: Optional[str]  # "anthropic" | "openai-vision" | "openai-whisper" | None
    asset_rel_path: Optional[str] = None  # for image captures, the saved binary


def _ensure_unique_path(base_dir: Path, slug: str, ext: str) -> Path:
    """Avoid collisions when the same slug is captured twice in one day."""
    base_dir.mkdir(parents=True, exist_ok=True)
    candidate = base_dir / f"{slug}{ext}"
    if not candidate.exists():
        return candidate
    n = 2
    while True:
        candidate = base_dir / f"{slug}-{n}{ext}"
        if not candidate.exists():
            return candidate
        n += 1


def _write_source_markdown(
    *,
    subdir: str,
    slug: str,
    label: str,
    body: str,
    transcribed_by: Optional[str],
    asset_rel_path: Optional[str] = None,
) -> tuple[Path, str]:
    """Write a raw source file with a small header, return (path, rel_path)."""
    target_dir = settings.raw_dir / subdir
    target_path = _ensure_unique_path(target_dir, slug, ".md")

    today = date.today().isoformat()
    header_lines = [
        f"# {label}",
        "",
        f"_Captured {today}"
        + (f" via {transcribed_by}_" if transcribed_by else " via paste_"),
    ]
    if asset_rel_path:
        header_lines.append(f"_Source image: `{asset_rel_path}`_")
    header_lines.append("")
    header_lines.append("---")
    header_lines.append("")
    header_lines.append(body.strip())
    header_lines.append("")

    text = "\n".join(header_lines)
    target_path.write_text(text, encoding="utf-8")
    rel = str(target_path.relative_to(settings.wiki_root)).replace("\\", "/")
    return target_path, rel


# ---------------------------------------------------------------------------
# Vision transcription (Claude / GPT-4o)
# ---------------------------------------------------------------------------


VISION_PROMPT = """You are looking at a screenshot or photograph the user captured.
Your job is to faithfully transcribe everything semantically meaningful into clean markdown
so it can be saved as a wiki source.

Rules:
- If this is a text-heavy screenshot (chat thread, article, document, code, email),
  reproduce the text verbatim. Preserve speaker labels for chat threads
  ("Alice: ...", "Bob: ..."). Preserve code blocks if present. Preserve list/heading
  structure.
- If this is a UI screenshot with mostly chrome and little content, describe what's
  shown in 1-2 paragraphs and pull out any quotes/data visible.
- If this is a photo of a real-world scene or whiteboard, describe what's pictured
  factually in 1-3 paragraphs.
- Do NOT add commentary, analysis, or interpretation. You are a transcription
  engine, not an editor. The wiki ingest pipeline does the interpretation.
- Markdown output only. No preamble like "Here is the transcription:".
- If a section is illegible or cropped, write `[illegible]` rather than guessing.
"""


async def _transcribe_image_anthropic(image_bytes: bytes, mime: str) -> str:
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")
    encoded = base64.b64encode(image_bytes).decode("ascii")
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": settings.anthropic_api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": settings.anthropic_model,
        "max_tokens": 2048,
        "system": VISION_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime,
                            "data": encoded,
                        },
                    },
                    {
                        "type": "text",
                        "text": "Transcribe this image into markdown.",
                    },
                ],
            }
        ],
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        raise RuntimeError(f"Anthropic vision error {resp.status_code}: {resp.text[:400]}")
    data = resp.json()
    blocks = data.get("content") or []
    parts = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    return ("\n".join(p for p in parts if p)).strip()


async def _transcribe_image_openai(image_bytes: bytes, mime: str) -> str:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY not configured")
    encoded = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:{mime};base64,{encoded}"
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.openai_model,
        "messages": [
            {"role": "system", "content": VISION_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Transcribe this image into markdown."},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
        "temperature": 0.1,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        raise RuntimeError(f"OpenAI vision error {resp.status_code}: {resp.text[:400]}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError):
        return f"(unexpected OpenAI response: {json.dumps(data)[:300]})"


async def transcribe_image(image_bytes: bytes, mime: str) -> tuple[str, str]:
    """Returns (markdown, backend_label). Prefers Anthropic, falls back to OpenAI."""
    if settings.anthropic_api_key:
        text = await _transcribe_image_anthropic(image_bytes, mime)
        return text, "anthropic"
    if settings.openai_api_key:
        text = await _transcribe_image_openai(image_bytes, mime)
        return text, "openai-vision"
    raise RuntimeError(
        "No vision LLM configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in backend/.env."
    )


# ---------------------------------------------------------------------------
# Audio transcription (OpenAI Whisper)
# ---------------------------------------------------------------------------


async def transcribe_audio(audio_bytes: bytes, filename: str, mime: str) -> tuple[str, str]:
    """Returns (text, backend_label). OpenAI Whisper only — Anthropic doesn't
    expose audio transcription yet at the public API level."""
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY required for audio transcription. Set it in backend/.env."
        )
    url = "https://api.openai.com/v1/audio/transcriptions"
    headers = {"Authorization": f"Bearer {settings.openai_api_key}"}
    files = {"file": (filename or "audio.webm", audio_bytes, mime or "audio/webm")}
    data = {"model": "whisper-1"}
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(url, headers=headers, data=data, files=files)
    if resp.status_code >= 400:
        raise RuntimeError(
            f"OpenAI Whisper error {resp.status_code}: {resp.text[:400]}"
        )
    payload = resp.json()
    text = payload.get("text", "").strip()
    if not text:
        text = "(empty transcription)"
    return text, "openai-whisper"


# ---------------------------------------------------------------------------
# Public capture API (called from main.py endpoints)
# ---------------------------------------------------------------------------


async def capture_image(
    *,
    image_bytes: bytes,
    mime: str,
    filename: str,
    label: str,
    subdir: str = "articles",
) -> CaptureResult:
    """Save the binary asset to raw/assets/ + write the transcribed markdown
    to raw/<subdir>/. Returns a CaptureResult with both paths."""
    slug = _today_slug(label or Path(filename).stem or "screenshot")
    ext_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    ext = ext_map.get(mime.lower(), Path(filename).suffix.lower() or ".png")
    asset_path = _ensure_unique_path(settings.raw_dir / "assets", slug, ext)
    asset_path.write_bytes(image_bytes)
    asset_rel = str(asset_path.relative_to(settings.wiki_root)).replace("\\", "/")

    text, backend = await transcribe_image(image_bytes, mime)

    _, rel_path = _write_source_markdown(
        subdir=subdir,
        slug=slug,
        label=label or "Captured screenshot",
        body=text,
        transcribed_by=backend,
        asset_rel_path=asset_rel,
    )
    return CaptureResult(
        rel_path=rel_path,
        size=len(text),
        text=text,
        transcribed_by=backend,
        asset_rel_path=asset_rel,
    )


async def capture_audio(
    *,
    audio_bytes: bytes,
    mime: str,
    filename: str,
    label: str,
    subdir: str = "meetings",
) -> CaptureResult:
    text, backend = await transcribe_audio(audio_bytes, filename, mime)
    slug = _today_slug(label or Path(filename).stem or "voice-memo")
    _, rel_path = _write_source_markdown(
        subdir=subdir,
        slug=slug,
        label=label or "Voice memo",
        body=text,
        transcribed_by=backend,
    )
    return CaptureResult(
        rel_path=rel_path,
        size=len(text),
        text=text,
        transcribed_by=backend,
    )


def capture_paste(
    *,
    content: str,
    label: str,
    subdir: str = "conversations",
) -> CaptureResult:
    """No transcription needed — just file the raw text. Synchronous."""
    slug = _today_slug(label or "paste")
    _, rel_path = _write_source_markdown(
        subdir=subdir,
        slug=slug,
        label=label or "Pasted source",
        body=content,
        transcribed_by=None,
    )
    return CaptureResult(
        rel_path=rel_path,
        size=len(content),
        text=content,
        transcribed_by=None,
    )
