---
type: decision
title: 2026-04-30 Keep Team Onsite
created: 2026-04-30
updated: 2026-05-24
sources: []
tags: [decision, culture, hiring]
tier: public
---

# 2026-04-30 Keep Team Onsite

Decided that [[Strand Bio]] will remain a 4-day-onsite company in
Boston for the foreseeable future, and that this policy is
non-negotiable for new hires.

## Context

Two hiring conversations in April 2026 surfaced the issue: a
strong backend candidate explicitly preferred fully-remote, and
[[Theo Nakamura]] is currently fully-remote in their existing role.
Both forced an explicit answer to a question the team had been
defaulting on.

The default was already 4-days-onsite. Wet-lab folks have to be
on-site, and the engineers had drifted into matching the cadence
because the office is where the customer calls happen. But the
default had not been *committed to*.

## Decision

4 days a week in the Boston office. One flex-from-home day per week,
unspecified day. Hires who can't do this don't get an offer. Existing
employees who relocate within commute distance get one quarter's
notice and assistance.

## Rationale

Three reasons:

1. **The wet lab is the product surface.** The orchestration software
   only matters in the room where the plates are. Engineers who go
   30 days without watching a liquid handler hit an edge case start
   building software for the abstraction, not the reality. This
   risk is asymmetric. A single quarter of drift is hard to
   reverse.
2. **[[Small Teams Compounding]].** At 9 people, the compounding
   asset is unblocked Slack-to-whiteboard latency. Remote teams can
   approximate this; the approximation costs ~15-20% throughput at
   this size. Worth it later; not worth it now.
3. **Hiring signal.** Candidates who walk away over the onsite
   requirement are giving useful information: their tolerance for
   inconvenience in the service of something that matters is
   lower than what this stage requires.

## What this loses

- **[[Theo Nakamura]] as a near-term hire.** Theo is currently
  remote. Either the role-conversation happens after Theo would
  relocate (12+ months out) or it doesn't happen. See
  [[Should I bring up the VP Eng hire with Linh?]]. This constraint
  changes that timing question materially.
- **A category of strong engineers.** Acknowledged. The bet is that
  the engineers Strand Bio loses to this policy are not the engineers
  Strand Bio needs at 9 people.

## Counterarguments considered

- *"You're filtering for engineers with no kids / no spouse / no
  geographic commitments."* Partially true; mitigated by the
  flex-day and by paying for the relocation. The remaining filter
  is real and is part of the cost.
- *"Software companies do remote fine."* Software-only companies,
  yes. Companies whose product depends on physical hardware running
  in physical labs, less so.

## Status

Policy published internally 2026-05-01. One existing engineer
relocated from Brooklyn (start of August 2026 expected). One offer
withdrawn (the April candidate). No regrets so far.
