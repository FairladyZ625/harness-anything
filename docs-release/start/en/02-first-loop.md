# Your first closed loop

Run this recipe in a scratch Git repository after `ha init`. It follows the
canonical cycle:

```text
Fact → Decision → Task → Fact
```

The receipt fragments below came from an isolated Ubuntu fixture on 2026-09-12.
IDs will differ in your repository. Every write still goes through the center's
single-writer queue; do not run the example against somebody else's workspace.

## Before the loop

Initialize once with the human who owns the workspace:

```bash
ha init --person-id owner --display-name "Loop Owner"
```

Expected: `ok=true command=repo-bootstrap`. Do not set `HARNESS_ACTOR` to a
human value; the daemon authenticates the socket owner. Agent automation may set
`HARNESS_ACTOR=agent:<id>` for its own commands.

## 1. Record the observation

```bash
ha fact record --statement "Repeated handoffs lose the reason for the work." --source "support-review-2026-09-12" --confidence high
```

Expected: `ok=true command=fact-record factId=F-3C9EB45C status=accepted_durable`.
Keep the returned Fact ID; do not invent one from the statement.

## 2. Propose the choice

```bash
ha decision propose --json-input '{"title":"Keep handoff reasons in the ledger","question":"How should handoff context survive between sessions?","riskTier":"medium","urgency":"medium","decisionClass":"ordinary","chosen":[{"id":"CH1","text":"Record reasons as facts before creating follow-up work","rationale":"Preserves provenance"}],"rejected":[{"id":"RJ1","text":"Keep reasons only in chat","whyNot":"Chat is not a durable ledger"}],"claims":[{"id":"C1","text":"Durable facts preserve handoff reasons","loadBearing":true}]}' --body $'## 背景\nRepeated handoffs lose their rationale.\n\n## 权衡\nDurable facts preserve provenance; chat alone does not.\n\n## 结论\nRecord the reason as a Fact before creating follow-up work.'
```

Expected: `ok=true command=decision-propose decisionId=dec_... state=proposed`.
The packet carries machine fields; the body must keep the three human-readable
sections `背景`, `权衡`, and `结论`.

## 3. Attach evidence, then accept with human approval

```bash
ha relation relate --source-ref decision/dec_.../C1 --target-ref fact/F-3C9EB45C --type evidenced-by --rationale "The observed handoff loss supports the durability claim." --expected-version 0
```

Expected: `ok=true command=relation-relate relationId=rel_...`. Point to claim
`C1`, not chosen option `CH1`; acceptance requires the evidence edge or an
explicit judgment-only rationale.

```bash
ha decision transition in_effect dec_... --consent-by owner --consent-at 2026-09-12T08:00:00Z --consent-channel cli
```

Expected: `ok=true command=decision-transition state=in_effect consentId=djc_...`.
The two independent conditions are now visible: claim evidence and explicit
human approval. All three consent flags are one atomic input, and `--consent-by`
must name the authenticated principal. The old `ha decision accept` spelling is
a deprecated alias, not a second workflow.

## 4. Create the derived task

```bash
ha task create --title "Publish a durable handoff note" --preset docs-task
```

Expected: `ok=true command=task-create taskId=task_... status=accepted_durable`.
Use the returned package path, replace the scaffolded `task_plan.md` with a real
plan, then publish it with `ha doc sync --submit` before starting.

```bash
ha relation relate --source-ref decision/dec_.../CH1 --target-ref task/task_... --type derives --rationale "The chosen durable-record path creates this work." --expected-version 0
```

Expected: `ok=true command=relation-relate relationId=rel_...`. A derivation
starts at the chosen option `CH1`; this is intentionally different from the
claim anchor used by `evidenced-by`.

## 5. Start, produce the closing Fact, and submit

```bash
ha task start task_...
```

Expected: `ok=true command=task-start executionId=exe_... status=accepted_durable`.
`start` acquires the execution lease; the holder must perform the task writes.

After doing the work, record a new observation owned by this task:

```bash
ha fact record --task task_... --statement "The handoff note is present in the task package." --source "tasks/task_.../closeout.md" --confidence high
```

Expected: `ok=true command=fact-record factId=F-... status=accepted_durable`.
This new Fact closes the loop; reusing the opening Fact does not.

Fill the task's `closeout.md` before submission:

```markdown
## Summary

Published the durable handoff note.

## Verification

Checked the submitted task package and closing Fact.

## Residual Risk

None known.

## Same Mechanism Elsewhere

Use the same Fact → Decision → Task → Fact cycle for the next handoff.
```

```bash
ha task submit task_...
```

Expected: `ok=true command=task-submit transition.from=active/implementation transition.to=in_review/review`.
`submit` publishes eligible task documents, including the closeout; do not make
a separate manual Git commit in the private ledger.

## 6. Review and complete with owner consent

An independent reviewer records the verdict against the submitted execution:

```bash
HARNESS_ACTOR=agent:loop-reviewer ha task review-execution task_... --review-id review-docs-loop --json-input '{"verdict":"approved","reason":"Independent reviewer checked the submitted closeout and result fact.","evidenceChecked":["fact/F-...","tasks/task_.../closeout.md"]}'
```

Expected: `ok=true command=task-review-execution reviewId=review-docs-loop`.
The reviewer must not be the execution's agent.

```bash
ha task complete task_...
```

Expected before owner consent/disposition: `ok=false command=task-complete
code=fact_retirement_undeclared`. The receipt names every upstream Fact that
still needs an explicit disposition; do not bypass it.

```bash
ha task complete task_... --consent --fact-holds "F-3C9EB45C:The handoff-loss observation still holds after publishing this note."
```

Expected: `ok=true command=task-complete transition.to=done/review status=accepted_durable`.
`--consent` selects the approved Review and records owner consent atomically;
`--fact-holds` records why the opening evidence remains standing.

You now have a complete, queryable cycle rather than a task-shaped chat log.
Next, read [The three-primitive kernel](../../learn/en/01-three-primitive-kernel.md)
or keep the [daily command sheet](03-daily-commands.md) nearby.
