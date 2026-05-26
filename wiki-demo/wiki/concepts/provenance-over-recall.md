---
type: concept
title: Provenance Over Recall
created: 2026-05-23
updated: 2026-05-23
sources:
  - raw/conversations/2026-04-12-architecture-doc.md
tags: [architecture, principle, foundational]
tier: public
---

# Provenance Over Recall

When in tension, **always pick the system that shows where a claim came
from over the system that recalls more claims faster**. Recall without
provenance is a debugging disaster waiting to happen; provenance with
slightly slower recall is the difference between a system you can trust
in production and one you can't.

## Where it shows up

- **Data pipelines.** Every row in a derived table includes a column
  pointing back to the source row(s). When a number looks wrong, finding
  the upstream cause is a join, not a forensics project.
- **LLM-augmented features.** Every model output is tagged with the
  context window that produced it. If a user reports "the model hallucinated
  X," we can see exactly what it was given.
- **Decisions.** Every decision page in this wiki has a `sources:`
  frontmatter field pointing at the conversation or doc that produced it.

## The cost

You write more boilerplate. Schemas get wider. Performance occasionally
suffers. Joining a source-tracking table on every read isn't free.

## Why we pay it

The cost is linear; the benefit is exponential. A system without
provenance becomes harder to maintain at a compounding rate as it gets
older. A system *with* provenance gets easier to maintain. Newcomers can
self-onboard from the trace alone.

This is also why [[Avery Chen]] treats it as a hiring filter (see
[[Mia Patel]]).

## See also

- [[Boring Stack First]]: boring tools tend to come with better
  provenance affordances; novel tools tend to ship recall first
- [[2026-04-12 Postgres Over Mongo]]: a concrete application of this
  principle
