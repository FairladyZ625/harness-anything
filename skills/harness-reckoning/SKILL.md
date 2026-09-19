---
name: harness-reckoning
description: Run and interpret a read-only retrospective over Harness ledger projections, then prepare evidence-backed mechanism fixes, deletion candidates, or time-bounded rule proposals for human adjudication.
---

# Harness Reckoning

Use this skill for a periodic, offline review of repeated friction without allowing the reviewer to modify rules, Tasks, Facts, or Decisions.

## Run

The system preset starts paused because a new Harness may not have an agent runtime. Choose an agent and runtime instance, then enable it. Its mission invokes:

```sh
ha schedule reckon
```

The command reads the attached Harness projection and writes only stdout. The occurrence runtime's final output is the report artifact. A missing projection is an error, never a healthy empty report. Open candidate evidence with the relevant read commands, such as `ha task show`, `ha runtime status`, and `ha fact show`. Do not run commands that record or change entities.

Optional sources follow [references/source-contract.md](references/source-contract.md). Add their read command and evidence-merging instructions to the preset mission.

## Adjudicate

Read the evidence link or identifier on every candidate. Apply the funnel in order:

1. Fix the mechanism, configuration, or error message that created the friction.
2. If no framework fix applies, propose removal of an obsolete rule.
3. Only then consider a new rule; require a trigger and expiration date.
4. A second occurrence of the same class is a structural problem, not permission for another local patch.

The report is advisory. A human decides whether to create a Task, retire a rule, or propose a Decision. Quiet output is a valid health attestation; never manufacture findings.

## Boundaries

Occurrence claim ownership (`nodeId` plus `claimFence`) supplies multi-node mutual exclusion. Each result belongs to its occurrence; no shared report path is used. Edge nodes read their local projection, so the report identifies local evidence rather than pretending to be a fleet-wide canonical snapshot.

## Make it yours

- Edit the preset mission to change the questions, evidence depth, or report format.
- Add a read-only external source and tell the mission how its evidence joins the built-in signals.
- Select or replace the agent and runtime instance in the Schedule editor. The preset remains protected from deletion, but its cadence, timezone, mission, and target are yours to change.

## External source examples

A software team may add a `walls` report or inspect an `AGENTS.md` retirement marker. Another team might read support escalations, operations handoffs, or a customer feedback export. These are site-specific inputs and are never part of the built-in signal set. A source must declare its read scope and return stable evidence identifiers.

The method uses offline replay, external evidence, a minimal proposed difference, and human adjudication. It deliberately avoids online self-editing and append-only memory growth. See [references/method.md](references/method.md).
