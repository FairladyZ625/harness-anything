---
name: decisions
description: Drive a conversational decision queue for Harness Anything. Use when a user wants to review multiple pending decisions, walk through decision candidates, or finalize several decisions. Thin trigger only: it must call the Harness Anything decision CLI and must not edit markdown directly.
---

# Decisions

## Core Rule

This skill coordinates a decision review loop. It does not own persistence. All changes must be executed through `npx ha decision ...` or the installed `harness-anything decision ...` command.

Do not edit, create, patch, append, or rewrite decision, task, fact, relation, or session markdown directly. The CLI path is responsible for WriteCoordinator, provenance binding, and watermark checks.

## When To Use

Use this skill when there is more than one decision candidate or when the user wants to process a queue conversationally:

- Review proposed decision candidates one by one.
- Turn a conversation backlog into proposed decisions.
- Accept, reject, defer, supersede, amend, or retire existing decisions.

## Queue Loop

1. Ask the user for the next candidate or existing decision id.
2. For a new candidate, collect `title`, `question`, `chosen`, `rejected`, `why_not`, and optional `claim`.
3. For an existing decision, ask for the intended outcome: accept, reject, defer, supersede, amend, or retire.
4. Run exactly one CLI command for the current item and inspect the JSON receipt.
5. Summarize the result, then ask whether to continue to the next item.

## CLI Patterns

Propose:

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

Finalize:

```bash
npx ha decision transition active <decision-id> --json
npx ha decision transition rejected <decision-id> --json
npx ha decision transition deferred <decision-id> --json
npx ha decision transition superseded <decision-id> --json
npx ha decision amend <decision-id> --title "Updated title" --json
npx ha decision transition retired <decision-id> --json
```

For installed package use, replace `npx ha` with `harness-anything`.

## Guardrails

- Process one item at a time; do not batch-write multiple decisions blindly.
- Never bypass the CLI to mutate authored markdown.
- Never silently choose an arbiter or a rejected alternative.
- Never report queue progress as durable until the CLI returns `ok: true`.
- If no candidate or id is available, ask the user for the next item instead of scanning and editing files.
