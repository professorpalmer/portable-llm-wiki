"""SSRF guard for the onboarding URL scraper.

The hosted onboarding flow lets any signed-in user hand the server a URL to
fetch. Without an allow-list that's a server-side request forgery primitive
(cloud metadata at 169.254.169.254, localhost admin endpoints, internal
network hosts). These tests pin the IP-classification and host-resolution
guards. They avoid external network calls: literal-IP and localhost checks
resolve locally and deterministically.
"""
from __future__ import annotations

import asyncio

import pytest

from app import url_scrape


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",          # loopback
        "10.0.0.5",           # RFC1918
        "192.168.1.10",       # RFC1918
        "172.16.0.1",         # RFC1918
        "169.254.169.254",    # cloud metadata (link-local)
        "0.0.0.0",            # unspecified
        "::1",                # IPv6 loopback
        "fd00::1",            # IPv6 unique-local
        "not-an-ip",          # un-parseable → unsafe
    ],
)
def test_blocked_ips_are_rejected(ip):
    assert url_scrape._ip_is_blocked(ip) is True


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "93.184.216.34"])
def test_public_ips_are_allowed(ip):
    assert url_scrape._ip_is_blocked(ip) is False


def test_localhost_host_is_refused():
    ok, reason = url_scrape._host_resolves_safe("localhost")
    assert ok is False
    assert reason


def test_metadata_ip_host_is_refused():
    ok, reason = url_scrape._host_resolves_safe("169.254.169.254")
    assert ok is False
    assert "blocked" in reason


def test_allow_private_escape_hatch(monkeypatch):
    """Self-hosters can opt into scraping internal hosts explicitly."""
    monkeypatch.setenv("URL_SCRAPE_ALLOW_PRIVATE", "1")
    ok, _ = url_scrape._host_resolves_safe("localhost")
    assert ok is True


def test_scrape_refuses_loopback_url():
    """End-to-end: scrape() never connects to a loopback URL and surfaces
    the refusal as an error on the page (it never raises). Driven via
    asyncio.run so we don't add a pytest-asyncio dependency."""
    page = asyncio.run(url_scrape.scrape("http://127.0.0.1:8000/owner/secrets"))
    assert page.content == ""
    assert any("refusing to fetch" in e for e in page.errors)


def test_url_on_pinned_ip_rewrites_netloc():
    assert url_scrape._url_on_pinned_ip("http://example.test/a", "203.0.113.10") == (
        "http://203.0.113.10/a"
    )
    assert url_scrape._url_on_pinned_ip("https://example.test:8443/a", "203.0.113.10") == (
        "https://203.0.113.10:8443/a"
    )


def test_scrape_pins_connect_to_validated_ip(monkeypatch):
    """scrape() connects to the already-validated IP, not a re-resolved hostname."""
    from urllib.parse import urlparse

    import httpx

    seen: dict = {}

    def fake_pin(host: str):
        return "8.8.8.8", ""

    class FakeResp:
        status_code = 200
        reason_phrase = "OK"
        headers = {"content-type": "text/html"}
        text = "<html><title>ok</title><body><p>" + ("word " * 40) + "</p></body></html>"
        url = "http://8.8.8.8/page"

    async def fake_send(self, request):
        seen["url"] = str(request.url)
        seen["host"] = request.headers.get("host")
        return FakeResp()

    monkeypatch.setattr(url_scrape, "_pin_ip_for_host", fake_pin)
    monkeypatch.setattr(httpx.AsyncClient, "send", fake_send)

    page = asyncio.run(url_scrape.scrape("http://example.test/page"))
    assert seen.get("url"), page.errors
    assert urlparse(seen["url"]).hostname == "8.8.8.8"
    assert seen["host"] == "example.test"
    assert page.title == "ok"
