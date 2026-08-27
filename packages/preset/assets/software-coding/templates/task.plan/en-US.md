# {{title}}

Task Contract: harness-task v1

## Brief

One-line statement of the task objective and scope.

## Goal

Describe the verifiable result this task must produce, plus the deliverable's form and destination: what shape it takes, who receives it, where it lands, and who uses it first.

## Context

Record the input context and established facts. A cold-start agent must separate the three primitives first: task records what work is being done, fact records what has been observed, and decision records why a load-bearing choice holds.

## Required Reading

List concrete code, document, and contract paths in reading order, with an authority level for each item. Resolve source conflicts explicitly instead of presenting contradictory inputs as peers.

## Entry Conditions

List everything that must already be true before work starts. Stop and report when an entry condition is unmet instead of inventing missing upstream input.

## Dependencies

List upstream dependencies, handoff inputs, concurrent ownership, and downstream recipients, including how each dependency is proven ready.

## Execution Surface

Declare the repository, worktree, branch, base, and allowed write scope. The dispatcher injects the concrete absolute `cwd`; do not copy a machine-specific path into durable prose.

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

## Deliverable Contract

State the deliverable shape, destination, recipient, first consumer, and every task-specific field that completion must submit or report. Do not duplicate generic Worker discipline here.

## Evidence Protocol

State the required evidence granularity, negative controls or mutation checks, and reviewer rejection conditions. This section defines how to prove the result; `Verification` defines what must be true.

Close the loop before closeout: record at least one observation with `ha fact record --task <task-id> ...` and preserve its receipt in the Execution outputs. A fact is an evidence input to a decision, so attach it to the relevant claim with `ha decision relate <decision-id> --anchor <claim-id> --type evidenced-by --target fact/F-XXXXXXXX --rationale "<why>"` before accepting or reckoning that decision. If a proposal has no fact evidence yet, `ha decision propose` still succeeds, but its receipt points to these two commands.

## Verification

- **Stop point = targeted tests for the surface you touched, green, plus a local commit. The full gate matrix is GitHub CI's job, not this machine's.** Name the specific test files or `--tier` selection this task's surface requires, and paste the real runner output rather than writing "all green" — output is an artifact, an assertion is not. Do not run the whole local matrix serially to feel safe: one machine running every job in sequence is strictly slower than CI running them in parallel, and it blocks every other worker on the same machine behind the shared slot budget. `npm run check:ci` remains available for deliberately reproducing a CI failure locally; it is not the stop point.
- List any review and human acceptance conditions this task additionally requires.
- Per `dec_mrg3z1we/CH4`, Facts are explicit `0..N` promotions, not a review or completion quantity gate; verify delivery through Execution outputs, review, closeout, and the applicable completion gates.
