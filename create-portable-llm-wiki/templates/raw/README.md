# raw/

This directory holds **immutable source material**. The conversations,
articles, transcripts, screenshots, and pasted notes that the wiki pages
are derived from.

The Karpathy schema treats `raw/` as append-only: you (or the LLM) never
edit a source after it's filed. Wiki pages cite sources by relative
path:

```yaml
---
sources:
  - raw/conversations/2026-05-23-example.md
---
```

Conventional subfolders:

- `raw/conversations/`: chat / Slack / DM transcripts
- `raw/articles/`: saved articles, blog posts
- `raw/notes/`: your own loose notes before they become wiki pages
- `raw/talks/`: meeting / podcast / talk notes
- `raw/assets/`: binary attachments (images, PDFs) referenced by other
  raw files

Nothing here is required. The backend will still serve wiki pages even
if `raw/` is empty. But provenance gets much weaker.
