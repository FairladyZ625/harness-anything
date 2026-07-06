# {{title}}

Task Contract: harness-task v1

## Brief

One-line statement of the task objective and scope.

## Goal

Describe the verifiable result this task must produce, plus the deliverable's form and destination: what shape it takes, who receives it, where it lands, and who uses it first.

## Context

Record input context and a "where to look" list (concrete paths to the code, documents, and contracts to read). A cold-start agent must separate the three primitives first: task records what work is being done, fact records what has been observed, and decision records why a load-bearing choice holds.

## Constraints

List the assumptions that must not be made and the boundaries that must not be crossed: which current state must stay unchanged, and which actions are off-limits without authorization (external and destructive actions are forbidden by default).

## Checkpoint

State when to stop and report or request a ruling: stop-on-hit conditions (out-of-scope changes, gate bypass, conflict with an existing ruling, blast radius beyond estimate) and planned report-back points (e.g. after breakdown, before opening a PR).

## Implementation Plan

- Inspect existing code, documents, and contracts.
- Record key progress with `ha task progress append <task-id> --text "..." --evidence type:PATH:summary`.
- For observations that support review, PRs, architecture judgment, or later choices, run `ha fact record --task <task-id> --statement "..." --source "..." --confidence high`.
- For route choices, reversals, long-lived boundaries, or choices that derive follow-up work, run `ha decision propose ...`; when facts support decisions or decisions derive tasks, connect them with `ha decision relate ...`.
- Verify behavior with tests and checks.

## Verification

- List required local checks, CI, and review evidence.
- E75 gate: before `ha task review` / `ha task complete`, the task must have at least one real fact; without facts, there is no output to judge.
