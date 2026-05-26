---
type: project
title: Strand Bio Inventory Service
created: 2026-04-12
updated: 2026-05-23
status: active, v1 shipping in June 2026
sources:
  - raw/conversations/2026-04-12-architecture-doc.md
  - raw/conversations/2026-05-02-hiring-conversation.md
tags: [project, active, inventory]
tier: public
---

# Strand Bio Inventory Service

The v1 product surface at [[Strand Bio]]. Replaces a shared Google Sheet
that the wet lab was using to track plates, reagents, and sample
provenance. The sheet broke roughly weekly and was an obvious bottleneck
on every team trying to design an experiment.

## Goals

1. **Source of truth for wet-lab inventory.** Plates, wells, samples,
   reagents. Every row cites the lab notebook entry that produced it.
   Strict [[Provenance Over Recall]].
2. **Integration with the workflow orchestrator.** When a wet-lab
   workflow runs, the inventory service decrements consumed reagents and
   logs the plates produced.
3. **No manual rekeying.** Receiving docs from suppliers are ingested via
   email; lab notebook entries via the existing LIMS API.

## Architecture

- Postgres (per [[2026-04-12 Postgres Over Mongo]])
- FastAPI service (per [[Boring Stack First]])
- React + Tailwind front-end ([[Mia Patel]] owns the design)
- Deployed on Fly.io with a 3-node Postgres cluster

## Timeline

- 2026-04-12: Architecture decided
- 2026-04-19: Schema v0 + seed data loaded
- 2026-05-03: Internal alpha (wet lab using it for receiving only)
- 2026-05-16: [[Mia Patel]] full-time on the design
- 2026-06-01: v1 ship (target)
- 2026-06-15: Wet lab fully cuts over from the sheet (target)

## Open questions

- Audit log retention: 90 days or indefinite? Indefinite has compliance
  upside, performance downside. Default to indefinite, revisit at year 1.
- Mobile UX: the wet lab people are on iPads. Mia's first design sketch
  treats this as primary, not adaptive. Confirmed correct on 2026-05-20.

## See also

- [[Strand Bio]]: company context
- [[Avery Chen]]: backend owner
- [[Mia Patel]]: design owner
