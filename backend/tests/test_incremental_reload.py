"""The stale check re-parses only changed files and notices deletions."""
import os

from app.config import settings
from app.wiki import WikiIndex


def _page(name, title, body="Body."):
    path = settings.wiki_dir / "concepts" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\ntype: concept\ntitle: {title}\ntier: public\n---\n\n{body}\n", encoding="utf-8")
    return path


def _bump(path):
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000))


def _stale(idx):
    idx._last_stale_check = 0.0
    idx.reload_if_stale()


def test_one_edit_reparses_one_file(wiki_root, monkeypatch):
    a = _page("inc-alpha", "Inc Alpha", "Links to [[Inc Beta]].")
    b = _page("inc-beta", "Inc Beta")
    try:
        idx = WikiIndex()
        idx.reload()
        parsed = []
        real = idx._load_page
        monkeypatch.setattr(idx, "_load_page", lambda p: parsed.append(p.name) or real(p))
        _stale(idx)
        assert parsed == []
        b.write_text(b.read_text(encoding="utf-8").replace("Body.", "Body, edited."), encoding="utf-8")
        _bump(b)
        _stale(idx)
        assert parsed == ["inc-beta.md"]
        assert "edited" in idx.get("inc-beta").body
        assert idx.get("inc-beta").links_in == ["inc-alpha"]
        assert idx.get("inc-alpha").links_out == ["inc-beta"]
    finally:
        a.unlink(missing_ok=True)
        b.unlink(missing_ok=True)


def test_deleted_page_disappears_on_the_stale_check(wiki_root):
    a = _page("inc-gone", "Inc Gone")
    idx = WikiIndex()
    idx.reload()
    assert idx.get("inc-gone") is not None
    a.unlink()
    _stale(idx)
    assert idx.get("inc-gone") is None


def test_explicit_reload_reparses_everything(wiki_root, monkeypatch):
    a = _page("inc-full", "Inc Full")
    try:
        idx = WikiIndex()
        idx.reload()
        parsed = []
        real = idx._load_page
        monkeypatch.setattr(idx, "_load_page", lambda p: parsed.append(p.name) or real(p))
        idx.reload()
        assert "inc-full.md" in parsed and len(parsed) == len(idx.all_pages())
    finally:
        a.unlink(missing_ok=True)
