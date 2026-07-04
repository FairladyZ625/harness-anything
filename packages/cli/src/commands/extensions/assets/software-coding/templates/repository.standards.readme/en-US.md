# Standards

## 用途

This folder holds **repository-level standards**: governance conventions, coding/process rules — long-lived, cross-task, reusable rules. `AGENTS.md` is only a thin pointer; the source of truth for the actual rules is here.

## 怎么用 (How to use)

- Each standard is a standalone `.md` (e.g. `repo-governance.md`). Before starting, an agent follows the task-reading matrix in `AGENTS.md` and loads only the standards relevant to the current task — never load them all.
- Standards are the "how we do things" ruleset; they are not decision records (load-bearing choices → `../decisions/`) nor architecture facts (system structure → `../context/architecture/`).
- Adding/changing a standard must preserve a single source of truth: define a rule in one place only; do not keep a copy in both `AGENTS.md` and here (ADR-0021 D3 anti-drift principle).

## 放什么 / 不放什么 (What goes here / what does not)

- ✅ Put: governance conventions, directory/naming conventions, commit and branch conventions, high-reuse process rules.
- ❌ Do not put: one-off task instructions, load-bearing architecture choices (→ decisions/adr), runtime facts that change over time (→ context).

## 相关命令 (Related commands)

Standards are maintained as authored documents and validated by the checker; `repo-governance.md` is materialized by the `repository.governance` seededDoc at init.
