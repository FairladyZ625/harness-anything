# Context

## 用途

This folder is the **project-context source of truth**: system architecture, dev environment, external integrations, research material — the background an agent needs to understand before making changes. It is organized by topic into subdirectories, each carrying its own finer-grained guide.

## 怎么用 (How to use)

- Consume by subdirectory; do not read the whole thing:
  - `architecture/` — the system-structure source of truth (what this repo owns, which larger system it belongs to, key services/flows/architecture decisions). See `architecture/README.md`.
  - `development/` — local development/build/run environment notes.
  - `integrations/` — integration contracts and notes for external systems/services.
  - `research/` — research packs and topic material (including dated research directories).
- This README is navigation and classification only; it **does not restate** subdirectory content — the specific facts live in each subdirectory's documents (D3: pointer, not restatement).

## 放什么 / 不放什么 (What goes here / what does not)

- ✅ Put: long-lived, cross-task, reusable background facts, classified by the topics above.
- ❌ Do not put: the "why" of load-bearing architecture choices (→ `../decisions/` + `../adr/`), task-level scratch notes (→ task package), rules/standards (→ `../standards/`).

## 相关命令 (Related commands)

Context is maintained as authored documents and validated by the checker; field/file names under `architecture/` are relied on by CLI checks, so change them carefully.
