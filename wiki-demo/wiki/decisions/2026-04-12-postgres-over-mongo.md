---
type: decision
title: 2026-04-12 Postgres Over Mongo
created: 2026-04-12
updated: 2026-05-23
sources:
  - raw/conversations/2026-04-12-architecture-doc.md
tags: [decision, infrastructure, database]
tier: public
---

# 2026-04-12 Postgres Over Mongo

Decided to use Postgres as the primary store for the
[[Strand Bio Inventory Service]], over an early proposal to use MongoDB.

## Context

The CEO and one of the ML engineers initially proposed Mongo because the
inventory schema "felt nested". Plates contain wells, wells contain
samples, samples contain reagents. A document model seemed to fit.

## Decision

Use Postgres with a properly normalized schema. Model the nesting as
foreign keys.

## Rationale

Three reasons, in order of weight:

1. **[[Provenance Over Recall]].** Every inventory row needs to cite its
   source. The lab notebook entry, the receiving doc, the wet-lab run.
   Joining on a foreign key in Postgres is trivial; reconstructing
   provenance across a document store is materially harder.
2. **[[Boring Stack First]].** Postgres has 28 years of production
   shipping behind it. Mongo has 16, and the last 6 of those have been
   noisy. Every member of the team has shipped Postgres before;
   nobody has shipped Mongo at the scale we'd need.
3. **Query flexibility.** The actual queries the business needs ("find
   every plate with a sample from supplier X used in any run between
   dates Y and Z") are hostile to a document model and trivial in SQL.

## Counterarguments considered

- *"Schema migrations are painful."* True, but `alembic` solves this
  well enough, and the schema-evolution path is well-trodden.
- *"Nested data is awkward in SQL."* True for naive denormalization, but
  proper foreign-key modeling is fine. Postgres' `jsonb` type covers the
  rare cases where we actually need document-shaped storage.

## Status

Shipped. Six weeks in, schema has evolved twice. No regrets.
