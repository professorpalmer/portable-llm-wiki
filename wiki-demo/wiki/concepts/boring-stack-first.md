---
type: concept
title: Boring Stack First
created: 2026-05-23
updated: 2026-05-23
sources:
  - raw/conversations/2026-04-12-architecture-doc.md
tags: [architecture, principle, foundational]
tier: public
---

# Boring Stack First

The operating principle that the first version of any system at
[[Strand Bio]] uses the most boring technology that could plausibly work.
"Boring" means: ≥7 years old, ≥1M production deployments, ≥3 of the
team's last 5 jobs already used it.

## Why

At 9 people, every new piece of infrastructure costs the team
disproportionately. Trendy tooling has hidden costs that don't show up
until month four: missing observability, half-baked libraries, churning
APIs, no Stack Overflow answers when you hit the edge case at 11pm. A
boring tool has all of those problems already solved by other people.

The bet: novelty in *the product* compounds. Novelty in *the stack*
mostly costs.

## How it's applied at Strand Bio

- Postgres, not Mongo (see [[2026-04-12 Postgres Over Mongo]])
- Python + FastAPI, not a serverless microservice mesh
- Fly.io + Cloudflare, not a custom Kubernetes cluster
- pytest, not a homegrown property-based testing framework
- Standard SQL migrations, not an ORM-managed schema diffing tool

## When to break it

Domain logic. The actual orchestration engine for lab workflows uses a
custom state machine because the existing options (Airflow, Temporal)
mis-model the problem. Boring stack for plumbing; opinionated for the
moat.

## See also

- [[Provenance Over Recall]]: boring tools are debuggable; debuggable
  beats fancy
- [[Small Teams Compounding]]: boring stack is a force multiplier when
  the team is small
