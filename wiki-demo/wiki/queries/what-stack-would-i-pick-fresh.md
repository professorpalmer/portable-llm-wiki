---
type: query
title: If I were rebuilding the inventory service from scratch today, what would change?
created: 2026-05-23
updated: 2026-05-24
sources: []
tags: [query, retrospective, architecture]
tier: public
---

# If I were rebuilding the inventory service from scratch today, what would change?

A retrospective query [[Avery Chen]] asked the wiki on 2026-05-23,
six weeks after the [[Strand Bio Inventory Service]] hit private
beta. The framing: pretend the codebase doesn't exist and the team is
making the same choices fresh. What changes?

## What would stay the same

Most of it. The dispositive principle is [[Boring Stack First]], and
the boring choices have all aged well so far:

- **Postgres.** No regrets. See [[2026-04-12 Postgres Over Mongo]].
  If anything, six weeks of production confirms the rationale. The
  join-on-foreign-key pattern is doing exactly what
  [[Provenance Over Recall]] needs.
- **FastAPI.** Has not pushed back on a single use case. The
  generated OpenAPI docs are a sales asset Avery did not expect:
  customer-lab engineers can read the API surface in five minutes.
- **Fly.io + Cloudflare.** Boring; correct; fast.
- **Markdown-everything for internal documentation,** including this
  wiki. See [[Working Memory]].

## What would change

Three things:

1. **The provenance schema would be a separate table from row one.**
   Currently provenance is a `source_id` foreign key on every
   substantive table. It works but it doesn't *scale to multi-source
   provenance*. When one inventory row is justified by both a wet-lab
   run and a vendor receipt, the schema forces a choice. A
   `provenance_records` table with a polymorphic foreign key would
   have been the right call from day one. Cost to fix today: ~3
   days; cost to have done it right: ~0.5 days. The 2.5-day delta
   is the [[Boring Stack First]] tax that Avery was willing to pay,
   correctly, but worth naming.
2. **No `alembic`-managed migrations of the analytics tables.**
   The product-data tables are right to be `alembic`-managed. The
   analytics tables (which are downstream-derived) shouldn't be.
   They should be regenerated from product data by a deterministic
   script. The current setup encourages drift between the two.
   This is a worth-fixing item but not urgent.
3. **The orchestration state machine would be in its own service from
   week one.** Currently it lives inside the inventory monolith
   because [[Boring Stack First]] argued against premature service
   splits. Six weeks in, the [[Boring Stack First]] argument is
   weaker. The state machine has its own data model, its own
   deploy cadence, and its own scaling profile. The split is now a
   "next month, before customer load doubles" item.

## What would NOT change, even though it looks like it should

- **The 9-person team.** A bigger team would let us parallelize the
  three items above. The bigger team would also add three months of
  hiring and onboarding cost, which is worse than the technical-debt
  cost being avoided. [[Small Teams Compounding]] wins this trade.
- **The customer-pilot cadence.** Three labs in beta is the right
  number. Adding a fourth would dilute the depth of feedback Strand
  Bio is getting from each lab.

## Action items generated

- Schedule a half-day to design the `provenance_records` migration
  (week of 2026-06-01).
- Bring the state-machine-split conversation to a Friday demo (see
  [[Demo Friday]]) to socialize before scoping.

## See also

- [[Boring Stack First]]
- [[Provenance Over Recall]]
- [[2026-04-12 Postgres Over Mongo]]
