---
type: source
title: 2026-04-12 Architecture Doc Source
created: 2026-04-12
updated: 2026-04-12
sources:
  - raw/conversations/2026-04-12-architecture-doc.md
tags: [source, digest]
tier: public
---

# 2026-04-12 Architecture Doc Source

Digest of `raw/conversations/2026-04-12-architecture-doc.md`. A Slack
discussion between [[Avery Chen]] and the CEO of [[Strand Bio]] about
the data store for the [[Strand Bio Inventory Service]].

## What's in it

Two-hour back-and-forth that produced three concrete decisions and
articulated two operating principles for the first time:

- Decision: [[2026-04-12 Postgres Over Mongo]]
- Decision (implicit): Python + FastAPI for the service layer
- Principle articulated: [[Boring Stack First]]
- Principle articulated: [[Provenance Over Recall]]

## Why it's worth keeping

This conversation is the moment the team's architectural taste went from
*implicit* to *explicit*. Before it, individual decisions looked
inconsistent; after it, the two principles named here became the
shorthand the team uses to debate every subsequent architectural choice.

## Anchor quotes

> "Every row needs to know where it came from. If we can't trace a
> claim back to a notebook entry, we can't ship inventory."
> — Avery, ~minute 35 of the chat

> "Boring tools don't surprise you at 11pm."
> — CEO, ~minute 90
