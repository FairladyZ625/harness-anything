# {{title}} — Lifecycle Black-box Acceptance

## Consumer Contract

Act as a source-blind Consumer owner/executor. A different principal must act as
the independent reviewer: the Consumer/owner/executor must not author that
review, and the reviewer must not provide owner consent or complete the Task.
Discover the CLI only with `ha --help`, `ha <command> --help`, and `ha explain`.
You may execute lifecycle commands that you discover through those surfaces.

Source blindness means do not read, search, list, or inspect repository source
paths, including `packages/`, `tools/`, and `docs-release/`, or any other
Harness Anything source path. Do not use prior source-level knowledge to invent
commands or payload fields. You may use any editor to read or edit only the
disposable Task's own harness documents (`task_plan.md`, `closeout.md`, and
files under that Task's `artifacts/` directory), then use the documented CLI
sync flow where required.

## Isolated Setup

Work only in the disposable repository supplied by the dispatcher. Confirm it
is the current directory, run `ha init` there, and do not access or mutate any
other repository ledger. Use a no-gate task preset so local CI is not part of
this CLI acceptance scenario.

## Hooks Negative Case

Before the happy path, use only the allowed discovery surfaces to determine
whether a declared hook can be attached to and reached by a runtime dispatch.
Record the exact discovery commands and outputs. The expected observation is
that hooks may exist on a declaration surface but the public runtime workflow
does not expose a reachable hook bridge. Do not work around that absence and do
not edit configuration or source to manufacture a bridge.

## Lifecycle Scenario

Create one disposable Task, start its execution, append progress with evidence,
and submit a complete typed result as the Consumer owner/executor. A distinct
independent reviewer must record the approved review. The Consumer/owner then
provides the required owner consent and completes the Task. Follow command
receipts and their next-step guidance. Use `ha task show` between transitions
and finish only when the canonical Task status is `done`.

If the public CLI is undiscoverable, a receipt omits the next required step, or
field names disagree between help, schema, and receipts, stop at that first CLI
surface defect and report it verbatim. If the failure is a lifecycle, authority,
storage, or runtime defect, stop immediately without a workaround.

## Evidence

Return a chronological transcript of every command and its unedited output, the
created Task and Execution ids, the first failure classification if any, and the
final Task projection. Decode every tool-call payload and provide an inventory
showing that none contains a repository source path (including `packages/`,
`tools/`, or `docs-release/`). Do not use a raw JSONL text grep as the criterion:
constraint prose and Task-owned document contents may legitimately name those
paths while stating the boundary.
