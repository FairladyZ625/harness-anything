---
name: harness-reckoning
description: Run and interpret a read-only nightly retrospective over Harness ledger projections, then prepare evidence-backed framework fixes, deletion candidates, or time-bounded rule proposals for human adjudication.
---

# Harness Reckoning

Use this skill when a maintainer wants a daily, offline review of repeated friction without allowing the reviewer to modify code, rules, Tasks, Facts, or Decisions.

## Run

The schedule uses `mode: detect`; any agent runtime can run it. Its mission invokes:

```sh
node tools/nightly-reckoning/run-reckoning.mjs --root "$REPOSITORY_ROOT" --db "$LEDGER_ROOT/.harness/cache/task.sqlite"
```

The command reads the local SQLite projection and repository files and writes only stdout. The occurrence runtime's final output is the report artifact. A missing projection is an error, never a healthy empty report. To open the evidence behind a candidate you may run any read command (`ha task show`, `ha runtime status`, `ha fact show`, `git log`). Do not write: no `ha` command that records or changes an entity, no edits or new files in the repository, no commits, and no redirecting output into the repository.

Optional sources implement the contract in [references/source-contract.md](references/source-contract.md) and are passed with repeated `--source` arguments.

## Adjudicate

Read the evidence link or identifier on every candidate. Apply the funnel in order:

1. Fix the CLI, SDK, kernel, configuration, or error message that created the friction.
2. If no framework fix applies, propose removal of an obsolete rule.
3. Only then consider a new rule; require a trigger and expiration date.
4. A second occurrence is an architecture defect, not permission for a second local patch.

The report is advisory. A human decides whether to create a Task, retire a rule, or propose a Decision. Quiet output is a valid health attestation; never manufacture findings.

## Boundaries

Occurrence claim ownership (`nodeId` plus `claimFence`) supplies multi-node mutual exclusion. Each result belongs to its occurrence; no shared report path is used. Edge nodes read their local projection, so the report identifies local evidence rather than pretending to be a fleet-wide canonical snapshot.

The method follows the third-generation pattern: offline replay, external evidence, a minimal proposed difference, and human adjudication. It deliberately avoids online self-editing and append-only memory growth. See [references/method.md](references/method.md).
