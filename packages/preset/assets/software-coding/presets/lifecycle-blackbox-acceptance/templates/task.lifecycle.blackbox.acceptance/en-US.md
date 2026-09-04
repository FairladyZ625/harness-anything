# {{title}} — Lifecycle Black-box Acceptance

## Consumer Contract

Act as a source-blind Consumer. Discover the CLI only with `ha --help`,
`ha <command> --help`, and `ha explain`. You may execute lifecycle commands
that you discover through those surfaces. Do not read, search, list, or inspect
`packages/` or any Harness Anything source file. Do not use prior source-level
knowledge to invent commands or payload fields.

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
submit a complete typed result, record an independent approved review, provide
the required owner consent, and complete the Task. Follow command receipts and
their next-step guidance. Use `ha task show` between transitions and finish only
when the canonical Task status is `done`.

If the public CLI is undiscoverable, a receipt omits the next required step, or
field names disagree between help, schema, and receipts, stop at that first CLI
surface defect and report it verbatim. If the failure is a lifecycle, authority,
storage, or runtime defect, stop immediately without a workaround.

## Evidence

Return a chronological transcript of every command and its unedited output, the
created Task and Execution ids, the first failure classification if any, and the
final Task projection. Also return a tool-call inventory sufficient to prove
that no `packages/` path was read.
