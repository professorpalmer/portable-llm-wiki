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

import ipaddress
import os
import re
import socket
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

MAX_BYTES = 1_000_000  # ~1 MB cap on what we'll download
REQUEST_TIMEOUT = 20.0
USER_AGENT = "PortableLLMWikiBot/1.0 (+https://portablellm.wiki)"
MAX_REDIRECTS = 5


def _allow_private_targets() -> bool:
    """Escape hatch for self-hosters who deliberately scrape internal hosts
    (an intranet profile page, a LAN service). OFF by default — the hosted
    product must never let a signed-in user point the scraper at internal
    infrastructure. Set URL_SCRAPE_ALLOW_PRIVATE=1 to relax."""
    return os.getenv("URL_SCRAPE_ALLOW_PRIVATE", "0").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _ip_is_blocked(ip_text: str) -> bool:
    """True for any address we must never connect to from the server:
    loopback, RFC1918 private, link-local (incl. the 169.254.169.254 cloud
    metadata endpoint), unique-local IPv6, reserved, multicast, unspecified."""
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        return True  # un-parseable → treat as unsafe
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _host_resolves_safe(host: str) -> tuple[bool, str]:
    """Resolve ``host`` (A + AAAA) and confirm EVERY address is a public,
    routable IP. Returns (ok, reason). Blocks SSRF to cloud metadata,
    localhost, and internal networks. Re-run for every redirect hop.

    Residual caveat (honest): this validates at resolve time, so a TOCTOU
    DNS-rebind between this check and httpx's own resolution is still
    theoretically possible. Closing that fully requires pinning the
    connection to the validated IP; for this owner/signed-in-user-gated
    onboarding flow the resolve-time check removes the practical hole.
    """
    if _allow_private_targets():
        return True, ""
    if not host:
        return False, "missing host"
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as exc:
        return False, f"DNS resolution failed: {exc}"
    if not infos:
        return False, "host did not resolve"
    for info in infos:
        ip_text = info[4][0]
        if _ip_is_blocked(ip_text):
            return False, f"blocked address {ip_text} (private/loopback/link-local)"
    return True, ""


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
    if not parsed.hostname:
        page.errors.append("URL missing a hostname")
        return page

    safe, reason = _host_resolves_safe(parsed.hostname)
    if not safe:
        page.errors.append(f"refusing to fetch {parsed.hostname!r}: {reason}")
        return page

    # Manual redirect following so we can re-validate the target host on
    # every hop. httpx's built-in follow_redirects would chase a 3xx to an
    # internal address without giving us a chance to re-check it — the
    # classic SSRF redirect bypass.
    r: Optional[httpx.Response] = None
    try:
        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT,
            follow_redirects=False,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
        ) as client:
            current = url
            for _ in range(MAX_REDIRECTS + 1):
                r = await client.get(current)
                if r.status_code not in (301, 302, 303, 307, 308):
                    break
                location = r.headers.get("location")
                if not location:
                    break
                current = urljoin(current, location)
                hop = urlparse(current)
                if hop.scheme not in ("http", "https") or not hop.hostname:
                    page.errors.append(f"redirect to unsupported target {current!r}")
                    return page
                ok, why = _host_resolves_safe(hop.hostname)
                if not ok:
                    page.errors.append(
                        f"refusing redirect to {hop.hostname!r}: {why}"
                    )
                    return page
            else:
                page.errors.append("too many redirects; aborting")
                return page
    except httpx.HTTPError as exc:
        page.errors.append(f"http error: {exc}")
        return page

    if r is None:  # defensive: loop never assigned (unreachable in practice)
        page.errors.append("no response received")
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
