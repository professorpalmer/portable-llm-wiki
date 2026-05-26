---
type: concept
title: Working Memory
created: 2026-05-24
updated: 2026-05-24
sources: []
tags: [meta, principle, knowledge-management]
tier: public
---

# Working Memory

The operating principle behind why this wiki exists at all. The
short version: *most personal-knowledge systems optimize for storage;
this one optimizes for being a working memory the LLM can read.*

## The distinction that matters

There are two different problems labeled "personal knowledge":

1. **Archive.** The shoebox of every note you ever took. Search,
   tags, backups. Optimized for "I want to find that thing from
   2019." Solved by Notion, Obsidian, Apple Notes, your filesystem.
2. **Working memory.** The handful of facts, opinions, decisions,
   and people that are actively shaping the next thing you do.
   Optimized for "what does Avery think *about this*, *right now*."

This wiki is a working memory, not an archive. The two should not
be conflated. An archive can grow forever; a working memory should
not. A working memory has churn. Facts get promoted from raw into
structured pages and demoted out of relevance with the same energy.

## Why the LLM-readable shape matters

A working memory that a person reads is structured to be skimmable.
A working memory that an LLM reads is structured to be *retrievable*: short pages, explicit cross-references, frontmatter that names the
*type* of thing each page is. This wiki is shaped for the second
reader.

The implication: pages should be short, opinionated, and link-rich.
A 4,000-word essay is good archive material and bad working memory.
A 300-word page that names three other pages by [[wikilink]] is the
opposite.

## How [[Avery Chen]] uses it operationally

- Every Friday demo (see [[Demo Friday]]), the wiki is the source of
  truth for what got done. Not Slack, not the linear board, not
  Notion. The other tools are inputs; the wiki is the digest.
- New decisions get a page within 48 hours of being made, including
  the counterarguments that didn't win. The
  [[2026-05-20 Postpone Series A]] page was started during the
  board meeting itself.
- The graph view (every wiki entity linked from this page) is
  audited monthly. Disconnected pages (no inbound or outbound
  links) are either deleted or wired in.

## See also

- [[Provenance Over Recall]]: working memory is useless if you can't
  trace what each claim is grounded in
- [[Boring Stack First]]: the wiki itself uses markdown + git for
  the same reason
