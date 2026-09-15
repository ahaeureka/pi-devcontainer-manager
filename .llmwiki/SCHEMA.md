# Project LLM Wiki Schema

Created: 2026-09-15T02:21:06.381Z

## Domain

Project implementation knowledge for agentic coding workflows.

## Layers

- `raw/`: immutable source material copied from project documentation or curated external sources.
- `entities/`, `concepts/`, `comparisons/`, `queries/`: agent-maintained markdown synthesis.
- `SCHEMA.md`, `index.md`, and `log.md`: orientation files. Every agent must read them before wiki work.

## Rules

- Read `SCHEMA.md`, `index.md`, and recent `log.md` before ingesting, querying, or linting.
- Do not modify `raw/` files manually; re-ingest sources and preserve provenance.
- Use wikilinks for durable references.
- Update `index.md` and append `log.md` for every meaningful wiki action.
- Treat wiki content as project-understanding aid, not code-correctness proof.
