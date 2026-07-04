# {{title}}

Task Contract: harness-task v1

## Brief

One-line statement of the task objective and scope.

## Goal

Describe the verifiable result this task must produce.

## Context

Record input context, relevant constraints, and boundaries that must not change. A cold-start agent must separate the three primitives first: task records what work is being done, fact records what has been observed, and decision records why a load-bearing choice holds.

## Implementation Plan

- Inspect existing code, documents, and contracts.
- Record key progress with `ha task progress append <task-id> --text "..." --evidence type:PATH:summary`.
- For observations that support review, PRs, architecture judgment, or later choices, run `ha record fact --task <task-id> --statement "..." --source "..." --confidence high`.
- For route choices, reversals, long-lived boundaries, or choices that derive follow-up work, run `ha decision propose ...`; when facts support decisions or decisions derive tasks, connect them with `ha decision relate ...`.
- Verify behavior with tests and checks.

## Verification

- List required local checks, CI, and review evidence.
- E75 gate: before `task-review` / `task-complete`, the task must have at least one real fact; without facts, there is no output to judge.
