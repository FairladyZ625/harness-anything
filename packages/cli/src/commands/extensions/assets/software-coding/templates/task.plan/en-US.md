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

## CI/Gate Authority Stop Condition

If this task is not a CI/gate/governance task but requires modifying CI/gate authority surfaces to pass, stop implementation, record the blocker, and request or create a governance task. Explicit CI/gate/governance tasks and break-glass main recovery are the only exceptions; break-glass must record reason, scope, and a follow-up governance task.

## Implementation Plan

- Inspect existing code, documents, and contracts.
- Record key progress with `ha task progress append <task-id> --text "..." --evidence type:PATH:summary`.
- Explicitly promote load-bearing observations needed for later decisions or cross-task reasoning with `ha fact record --task <task-id> --statement "..." --source "..." --confidence high`; Facts remain `0..N`, while delivery evidence belongs in Execution outputs.
- For route choices, reversals, long-lived boundaries, or choices that derive follow-up work, run `ha decision propose ...`; when facts support decisions or decisions derive tasks, connect them with `ha decision relate ...`.
- Verify behavior with tests and checks.

## Verification

- **Stop point = targeted tests for the surface you touched, green, plus a local commit. The full gate matrix is GitHub CI's job, not this machine's.** Name the specific test files or `--tier` selection this task's surface requires, and paste the real runner output rather than writing "all green" — output is an artifact, an assertion is not. Do not run the whole local matrix serially to feel safe: one machine running every job in sequence is strictly slower than CI running them in parallel, and it blocks every other worker on the same machine behind the shared slot budget. `npm run check:ci` remains available for deliberately reproducing a CI failure locally; it is not the stop point.
- List any review and human acceptance conditions this task additionally requires.
- Per `dec_mrg3z1we/CH4`, Facts are explicit `0..N` promotions, not a review or completion quantity gate; verify delivery through Execution outputs, review, closeout, and the applicable completion gates.
