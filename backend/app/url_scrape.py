"""Best-effort URL scraping for onboarding.

The hosted onboarding flow lets users paste a profile URL (their personal
site, blog, GitHub profile, LinkedIn, About page on a company site, etc.)
instead of pasting raw bio text. We fetch the URL, extract the readable
text, and hand it to the existing import flow.

This is intentionally conservative:

* Honors a small allow-list of behaviors. We follow redirects but cap at
  ~5 to avoid loops.
* Falls back gracefully if the page is JavaScript-heavy (LinkedIn,
  Twitter without JS). We return whatever metadata is in the HTML
  <head> + <body> static markup.
* Size capped at 1MB; we abort downloads beyond that.

What we extract:

* ``title``       — ``<title>`` text
* ``description`` — ``<meta name="description">``
* ``og:title`` /
  ``og:description`` /
  ``og:image``   — for the link preview on the wiki landing
* ``content``     — heuristic body-text extraction (drop nav/footer/script
  tags, keep paragraphs and list items)

The caller composes a markdown blob from these fields and passes it to
``orchestrator.start_import_job``, same as if the user had pasted bio text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

MAX_BYTES = 1_000_000  # ~1 MB cap on what we'll download
REQUEST_TIMEOUT = 20.0
USER_AGENT = "PortableLLMWikiBot/1.0 (+https://portablellm.wiki)"


@dataclass
class ScrapedPage:
    url: str
    final_url: str = ""
    title: str = ""
    description: str = ""
    og_title: str = ""
    og_description: str = ""
    og_image: str = ""
    site_name: str = ""
    content: str = ""  # extracted body text, newline-separated paragraphs
    word_count: int = 0
    errors: list[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        """Render a markdown blob that the orchestrator can ingest as
        if the user had pasted profile text."""
        out: list[str] = []
        host = urlparse(self.final_url or self.url).hostname or "url"
        h1 = self.title or self.og_title or host
        out.append(f"# {h1}")
        out.append("")
        out.append(f"Source URL: {self.final_url or self.url}")
        if self.site_name and self.site_name != h1:
            out.append(f"Site: {self.site_name}")
        out.append("")
        if self.description and self.description != h1:
            out.append("## Summary")
            out.append("")
            out.append(self.description)
            out.append("")
        if self.og_description and self.og_description not in (self.description, h1):
            out.append("## Open Graph description")
            out.append("")
            out.append(self.og_description)
            out.append("")
        if self.content:
            out.append("## Page content")
            out.append("")
            out.append(self.content)
            out.append("")
        if self.errors:
            out.append("## Scrape warnings")
            out.append("")
            for e in self.errors:
                out.append(f"- {e}")
        return "\n".join(out).rstrip() + "\n"

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "final_url": self.final_url,
            "title": self.title,
            "description": self.description,
            "og_title": self.og_title,
            "og_description": self.og_description,
            "og_image": self.og_image,
            "site_name": self.site_name,
            "word_count": self.word_count,
            "errors": list(self.errors),
            # Preview of content; not the full body (which can be many KB).
            "content_excerpt": self.content[:600],
        }


async def scrape(url: str) -> ScrapedPage:
    """Fetch + parse a URL. Never raises — errors are accumulated on the
    returned :class:`ScrapedPage`."""
    page = ScrapedPage(url=url)

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        page.errors.append(f"unsupported scheme {parsed.scheme!r}; expected http or https")
        return page
    if not parsed.netloc:
        page.errors.append("URL missing a hostname")
        return page

    try:
        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=True,
            max_redirects=5,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
        ) as client:
            # HEAD-then-GET so we can skip oversized assets. Not all servers
            # respect HEAD, so we tolerate failures here.
            try:
                head = await client.head(url)
                length = int(head.headers.get("content-length", "0") or 0)
                if length > MAX_BYTES:
                    page.errors.append(f"response too large ({length} bytes); aborting")
                    return page
            except Exception:  # noqa: BLE001
                pass

            r = await client.get(url)
    except httpx.HTTPError as exc:
        page.errors.append(f"http error: {exc}")
        return page

    page.final_url = str(r.url)

    if r.status_code != 200:
        page.errors.append(f"http {r.status_code}: {r.reason_phrase}")
        # Don't bail — many sites 4xx for bots but include useful metadata.

    content_type = r.headers.get("content-type", "")
    if "html" not in content_type.lower() and "xml" not in content_type.lower():
        page.errors.append(f"non-html content-type: {content_type}")
        # Still try to parse — some servers mislabel.

    body = r.text[:MAX_BYTES]
    _parse_html(page, body)
    return page


def _parse_html(page: ScrapedPage, html: str) -> None:
    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception as exc:  # noqa: BLE001
        page.errors.append(f"parse error: {exc}")
        return

    if soup.title and soup.title.string:
        page.title = soup.title.string.strip()

    for meta in soup.find_all("meta"):
        name = (meta.get("name") or "").lower()
        prop = (meta.get("property") or "").lower()
        content = (meta.get("content") or "").strip()
        if not content:
            continue
        if name == "description":
            page.description = content
        elif prop == "og:title":
            page.og_title = content
        elif prop == "og:description":
            page.og_description = content
        elif prop == "og:image":
            page.og_image = content
        elif prop == "og:site_name":
            page.site_name = content

    # Strip script/style/nav/footer/aside before extracting body text.
    for tag in soup(["script", "style", "nav", "footer", "aside", "header", "noscript", "form"]):
        tag.decompose()

    body_blocks: list[str] = []

    # Prefer <main> or <article> if present (usually the meat of the page).
    article = soup.find("article") or soup.find("main")
    candidates = [article] if article else [soup.body or soup]

    for cand in candidates:
        if cand is None:
            continue
        for elem in cand.find_all(["h1", "h2", "h3", "p", "li", "blockquote"]):
            text = elem.get_text(" ", strip=True)
            if not text:
                continue
            if elem.name in ("h1", "h2", "h3"):
                level = "#" * int(elem.name[1])
                body_blocks.append(f"{level} {text}")
            elif elem.name == "li":
                body_blocks.append(f"- {text}")
            elif elem.name == "blockquote":
                body_blocks.append(f"> {text}")
            else:
                body_blocks.append(text)

    # De-duplicate immediate repeats (nav menus sometimes echo).
    deduped: list[str] = []
    last = ""
    for line in body_blocks:
        if line == last:
            continue
        deduped.append(line)
        last = line

    page.content = "\n\n".join(deduped)
    page.word_count = len(re.findall(r"\S+", page.content))

    # If we didn't find any content, surface a warning — likely a SPA.
    if page.word_count < 30 and not page.errors:
        page.errors.append(
            "very little static content extracted (page may be JS-rendered); "
            "the metadata above is still usable"
        )
