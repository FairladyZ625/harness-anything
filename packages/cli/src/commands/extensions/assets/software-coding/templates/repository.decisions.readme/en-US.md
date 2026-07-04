# Decisions

## 用途

This folder is the **entity store for load-bearing decisions** in this repository. Each decision is a `decision-<id>/` subdirectory containing `decision.md` (`decision-package/v1`). It is the source of truth for "why this choice was made"; the ADR is its human-facing narrative projection (see `../adr/README.md` and ADR-0020).

## 怎么用 (How to use)

- **Do not hand-write or hand-edit the markdown here.** Decisions go through commands: `ha decision propose ...` to open, `ha decision accept ...` (or reject/defer/supersede) to adjudicate, `ha decision relate ...` to link evidence, `ha decision amend ...` to maintain state. The CLI owns the frontmatter, lifecycle state, fact evidence, and relation edges.
- A decision carries: `question` / `chosen` / `rejected(+why_not)` / `claims` / `relations`. The load-bearing "why" lives here, not in scattered prose ledgers.
- Link decisions to task/fact via relations (`decision -> task` implements, `fact -> decision` supports, etc.), not just prose references.

## 放什么 / 不放什么 (What goes here / what does not)

- ✅ Put: load-bearing choices that need lifecycle + evidence + relations.
- ❌ Do not put: one-off implementation notes (→ a task's `progress.md`), plain observed facts (record as a fact in a task's `facts.md`), long human-facing argumentation (that is `adr/`).
- ❌ Do not put: hand-written `.md`. Contents are derived by `ha decision propose`; manual edits drift from the projection.

## 相关命令 (Related commands)

`ha decision propose` · `ha decision accept` · `ha decision list` · `ha decision relate`
