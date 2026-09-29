"""/wiki/search must not re-tokenize every page body on every query."""
from app import wiki as wiki_mod
from app.wiki import WikiIndex


def test_repeat_search_tokenizes_only_the_query(wiki_root, monkeypatch):
    idx = WikiIndex()
    idx.reload()
    pages = [p for p in idx.visible_pages("private") if not p.sealed]
    assert len(pages) >= 3
    idx.keyword_search("warm the terms", viewer_tier="private")
    calls = []
    real = wiki_mod._tokens
    monkeypatch.setattr(wiki_mod, "_tokens", lambda text: calls.append(1) or real(text))
    idx.keyword_search("some query words", viewer_tier="private")
    # _folded_text + terms: the query only, however many pages there are.
    assert len(calls) <= 2, len(calls)


def test_changed_body_is_re_tokenized(wiki_root):
    idx = WikiIndex()
    idx.reload()
    page = next(p for p in idx.visible_pages("private") if not p.sealed)
    page.search_terms()
    page.body = page.body + "\n\nzyxwvunique appears now"
    assert idx.keyword_search("zyxwvunique", viewer_tier="private")[0][0] is page
