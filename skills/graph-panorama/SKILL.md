---
name: graph-panorama
description: Generate a human-readable Relation Graph Panorama HTML artifact from the Harness Anything SQLite relation graph projection. Use when inspecting relation_edges and relation_coverage coverage state. This skill reads SQLite and writes only the requested generated HTML artifact.
---

# Graph Panorama

## Core Rule

This skill is a read-only inspection path over the generated SQLite projection. It must read `relation_edges` and `relation_coverage` from `.harness/cache/projections.sqlite` or an explicitly supplied projection path.

The HTML artifact is for human inspection. Automation and agents should read SQLite directly.

## Workflow

1. Confirm the projection database exists or rebuild the normal task projection through existing Harness commands.
2. Run the panorama generator:

```bash
node tools/graph-panorama.mjs --root . --out .harness/generated/graph-panorama/index.html --json
```

3. Open the returned HTML artifact for human review.
4. If a custom projection is needed, pass `--projection <path>`.

## Guardrails

- Do not edit authored markdown, decisions, facts, or task packages.
- Do not generate DOT or Mermaid output.
- Do not treat the HTML as source of truth; it is a view over SQLite.
- Do not add a daemon, watcher, scheduler, or background refresh loop.
- If the SQLite projection is missing or malformed, stop and report the failing command.
