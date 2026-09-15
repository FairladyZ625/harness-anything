# {{title}}

Task Contract: harness-task v1

## Brief

Run the source-blind Task lifecycle acceptance scenario described in `lifecycle-blackbox-acceptance.md`.

## Goal

Produce a chronological public-CLI transcript that reaches canonical Task status `done`, or stops at the first public-surface defect without a workaround.

## Context

This is a CLI black-box measurement. Task documents and artifacts are visible; repository source paths are not.

## Required Reading

Read only this Task's `task_plan.md`, `closeout.md`, and `lifecycle-blackbox-acceptance.md`, plus public `ha` help, receipts, and explanations.

## Entry Conditions

Use the disposable repository supplied by the dispatcher and a distinct principal for the independent review.

## Dependencies

The dispatcher supplies an isolated repository and the installed candidate CLI; the acceptance report is consumed by the release owner.

## Execution Surface

Operate only through the public CLI and this disposable Task's own documents and artifacts.

## Constraints

Do not inspect repository source paths, invent undisclosed payload fields, or work around a lifecycle or public-surface defect.

## Checkpoint

Stop at the first defect named by the acceptance script, or after `ha task show` reports canonical status `done`.

## CI/Gate Authority Stop Condition

This no-gate acceptance task does not modify CI or gate authority surfaces.

## Implementation Plan

Follow `lifecycle-blackbox-acceptance.md` in order: discover public commands, run the hooks negative case, execute the dual-principal lifecycle, and record every command and output.

## Deliverable Contract

Write the transcript, identifiers, first-failure classification, final projection, and decoded tool-call path inventory under this Task's `artifacts/` directory.

## Evidence Protocol

Preserve command output verbatim. Record at least one observed fact through the public CLI before completion. Reject the run if the reviewer is not independent or any decoded filesystem operand targets a repository source path.

## Verification

Verify only through public CLI receipts, `ha task show`, and `ha explain`. No source tests, `node tools/...` commands, repository gate, or local delivery commit is required by this acceptance task.
