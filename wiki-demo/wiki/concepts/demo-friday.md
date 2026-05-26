---
type: concept
title: Demo Friday
created: 2026-05-24
updated: 2026-05-24
sources: []
tags: [cadence, operating-principle, team]
tier: public
---

# Demo Friday

The single load-bearing operating ritual at [[Strand Bio]]. Every
Friday, 11am Boston time, every team member demos one thing they
finished that week. To the rest of the team and (when relevant)
to one customer lab on a Zoom side-channel.

## Rules

1. **Demo or skip. No "updates."** A status update is not a demo.
   "I finished the migration" is not a demo. Opening the migration
   in psql and showing the rows is.
2. **Customer-facing or it's a stretch.** The implicit filter is
   "would [[Linh Park]] be willing to show this to the customer lab
   on the side-channel?" Backend cleanup work counts when it
   unblocks a feature; pure refactors usually don't.
3. **Recorded.** The recording goes in the [[Working Memory]] wiki
   under `raw/conversations/YYYY-MM-DD-demo-friday.md`. The wiki
   page summary is written by Avery or [[Linh Park]] on Friday
   evening.

## Why this works

Three reasons:

1. **Forcing function for shippable work.** The "would I demo this
   on Friday?" filter caught two would-be sprints before they
   started. The most useful sentence in the team's vocabulary is
   "that's not demoable yet, what *is* demoable by Friday?"
2. **Customer-loop compression.** The side-channel turns a normal
   12-week customer-feedback cycle into a 7-day one. Three customer
   labs are currently on the rotation; each shows up roughly monthly.
3. **Hire signal.** Candidates who finish their trial month do at
   least one Demo Friday. Two of the three founding hires sold
   themselves harder in the demo than in any interview.

## Failure modes

- **Demo-theater.** The bad version of this ritual is engineers
  optimizing for a 30-second demo at the expense of the actual
  underlying work. Mitigation: the post-demo Q&A from [[Linh Park]]
  is unsparing about whether what was demoed was the load-bearing
  thing or a sideshow.
- **Calendar tax.** 9 people × 30 min × 52 weeks is real time. The
  defense is that the loss of *not* having this ritual is much
  worse. The slow drift toward "everyone's busy, nobody knows what
  anyone is actually shipping."

## See also

- [[Small Teams Compounding]]: the ritual works because the team
  fits in one room
- [[Working Memory]]: the demo notes are what feed the wiki
