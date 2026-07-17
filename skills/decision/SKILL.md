---
name: decision
description: Capture a single consequential decision from the current conversation. Use when a user asks to record, propose, accept, reject, defer, amend, supersede, or retire one decision in Harness Anything. Thin trigger only: it must call the Harness Anything decision CLI and must not edit markdown directly.
---

# Decision

## Core Rule

This skill is a thin trigger over the Harness Anything CLI. All authored entity changes must go through `npx ha decision ...` or the installed `harness-anything decision ...` command.

Do not edit, create, patch, append, or rewrite decision markdown directly. Do not create frontmatter by hand. The CLI writes through the application service and WriteCoordinator, adds coordinator watermarks, and binds provenance.

## When To Use

Use this skill for one decision at a time:

- Turn an important conversation outcome into a proposed decision.
- Accept, reject, defer, supersede, amend, or retire an existing decision.
- Convert a user's explicit choice into a durable decision record.

## Workflow

1. Identify the decision question in one sentence.
2. Confirm the chosen option and at least one rejected alternative with a clear `why_not`.
3. Capture any claim that must later be supported by facts or relations.
4. Run the CLI with `--json` and inspect the receipt before reporting success.
5. If the user wants the decision finalized, run the appropriate state command through the CLI.

## Propose Pattern

For source checkouts, prefer `npx ha`:

```bash
npx ha decision propose \
  --title "Adopt decision loop" \
  --question "Should this work be recorded as a decision?" \
  --chosen "Record it" \
  --rejected "Leave it in chat only" \
  --why-not "Chat-only reasoning is not durable or queryable" \
  --claim "The decision is consequential enough to preserve" \
  --json
```

For installed package use, the equivalent command is:

```bash
harness-anything decision propose --title "..." --question "..." --chosen "..." --rejected "..." --why-not "..." --json
```

## State Commands

Use only CLI state operations:

```bash
npx ha decision transition active <decision-id> --json
npx ha decision transition rejected <decision-id> --json
npx ha decision transition deferred <decision-id> --json
npx ha decision transition superseded <decision-id> --json
npx ha decision amend <decision-id> --title "Updated title" --json
npx ha decision transition retired <decision-id> --json
```

## Guardrails

- Never bypass the CLI to mutate decision files.
- Never invent an arbiter; ask the user when it is not clear.
- Never omit the rejected alternative and `why_not` when proposing.
- Never claim a decision was recorded until the CLI command returns `ok: true`.
- If a CLI capability is missing, stop and report the missing command instead of hand-writing the record.
