# {{title}}

Task Contract: harness-task v1

## Brief

One-line statement of the task objective and scope.

## Goal

Describe the verifiable result this task must produce, plus the deliverable's form and destination: what shape it takes, who receives it, where it lands, and who uses it first.

## Context

Record the input context and established facts, the preconditions that must hold before work starts, and the upstream, downstream, and concurrent owners. Stop when a precondition is disproven; never implement against the stale premise.

## Required Reading

List concrete code, document, and contract paths in reading order, with an authority level for each item. Resolve source conflicts explicitly instead of presenting contradictory inputs as peers. A decision cited by the plan is read from the ledger at start time; a superseded decision yields to its successor.

## Execution Surface

Declare the repository, worktree, branch, base, and allowed write scope. The dispatcher injects the concrete absolute `cwd`; do not copy a machine-specific path into durable prose. The write scope is a boundary, not an allowlist: name prohibited areas explicitly and stop when one is hit.

## Constraints

List the assumptions that must not be made, the boundaries that must not be crossed, and this task's stop points: which current state must stay unchanged, which actions are off-limits without authorization (external and destructive actions are forbidden by default), and what must stop the work for a report.

## Deliverable Contract

State the deliverable shape, destination, recipient, first consumer, and every task-specific field that completion must submit or report. Do not duplicate generic Worker discipline here.

## Evidence Protocol

State this task's evidence granularity and the conditions under which a reviewer must reject it; when the task repairs a defect, also state its negative control or mutation check. This section defines how to prove the result; `Verification` defines what must be true.

## Verification

Write every acceptance item as "command + expected result"; raise an unachievable criterion before work starts instead of waiting for review. Name the specific test files this task's surface requires and paste real runner output; the repository's current rules own the full gate matrix and CI. List any review and human acceptance conditions this task additionally requires.
