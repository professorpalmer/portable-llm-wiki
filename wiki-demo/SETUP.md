# Demo wiki — meet Avery Chen

This is a sample Portable LLM Wiki seeded with the context of a fictional
person. **Avery Chen**, a founding engineer at a small synthetic-biology
startup. It exists so a fresh clone of this repo has *something* to point
at on first run, instead of an empty index.

The pages are all `tier: public` so the demo works without auth.

Replace this directory with your own wiki when you're ready to make it
yours. `scripts/init.sh` will help, or just point `WIKI_ROOT` in
`backend/.env` at your real wiki folder.

## What's in here

- **entities/**: Avery, the company, and key collaborators
- **concepts/**: operating principles Avery works by
- **decisions/**: recent career/technical decisions with rationale
- **projects/**: what Avery is shipping right now
- **sources/**: digests of the raw materials these pages came from
- **raw/**: the immutable source layer (conversations, articles)

If you ask the wiki *"what is Avery currently working on?"* or
*"how does Avery think about technical debt?"*, you should get a
sourced answer that cites these pages.
