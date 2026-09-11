# Governance loop recipe

This is the copy-and-run Fact -> Decision -> Task loop. Use a scratch Git
repository, a packed CLI, and an isolated `HOME`; never point a test at the
default daemon. The receipts below are from a packed-CLI run on 2026-09-11.
Replace its generated IDs with the IDs printed in your run.

```bash
npm pack --workspace @harness-anything/cli --pack-destination "$PWD/.recipe-pack"
```

Pitfall: pack from the worktree, not the canonical checkout; install the
generated tarball into an empty prefix.

```text
harness-anything-cli-0.0.1.tgz
```

```bash
export HOME="$PWD/.ha-home" HARNESS_GIT_AUTHOR_NAME="Your Name" HARNESS_GIT_AUTHOR_EMAIL="you@example.com"
ha init --person-id you --display-name "Your Name"
ha daemon status
```

Pitfall: human attribution comes from the daemon; do not set
`HARNESS_ACTOR=human:you`. Status must name the isolated `userRoot`, never
your ordinary `~/.harness`.

```text
initialized harness at harness/harness.yaml
outcome: applied
daemon status: pid=<pid> repos=1 entry=dist commit=<commit>
target: endpoint=/tmp/harness-anything/<socket> daemonId=default userRoot=<scratch>/.ha-home/.harness repoId=<repo-id> canonicalRoot=<scratch>
```

```bash
ha task create --json-input '{"title":"Implement the recipe","workKind":"docs","riskTier":"low","urgency":"low"}'
ha task start task_e984b4eb7d6a54eb1c44cbe9e7
```

Pitfall: creation writes a scaffold, not an executable plan. A new task
intentionally refuses to start until its plan is authored and submitted with
`ha doc sync --submit`; this is not a lease failure.

```text
created task task_e984b4eb7d6a54eb1c44cbe9e7 at tasks/task_e984b4eb7d6a54eb1c44cbe9e7-implement-the-recipe
preset: standard-task/baseline
error code=plan_placeholder hint=Required-section diagnostics:
- Brief: still contains scaffold text “One-line statement of the task objective and scope.”
[...the remaining required sections are also reported...]
Edit harness/tasks/task_e984b4eb7d6a54eb1c44cbe9e7-implement-the-recipe/task_plan.md, then run ha doc sync --submit --path tasks/task_e984b4eb7d6a54eb1c44cbe9e7-implement-the-recipe/task_plan.md and retry.
```

```bash
ha fact record --task task_e984b4eb7d6a54eb1c44cbe9e7 --statement "The packed CLI runs in an isolated HOME." --source "recipe run" --confidence high
```

Pitfall: `--statement` and `--text` are alternatives; `--source` is required.

```text
schema=fact-row/v1 ref=fact/F-16E9FECB taskId=task_e984b4eb7d6a54eb1c44cbe9e7 statement=The packed CLI runs in an isolated HOME. confidence=high
acceptance: accepted_durable; git: pending; projection: verified
```

```bash
ha decision propose --json-input '{"title":"Use the packed CLI","question":"Which command path should the recipe use?","riskTier":"low","urgency":"low","decisionClass":"ordinary","chosen":[{"id":"CH1","text":"Use the packed CLI"}],"rejected":[{"id":"RJ1","text":"Use the workspace CLI","whyNot":"It is guarded outside the canonical checkout."}],"claims":[{"id":"C1","text":"The packed CLI can run in the isolated repository.","loadBearing":true}]}' --body $'## Background\n\nThe recipe must not use the default daemon.\n\n## Decision\n\nUse the packed CLI.\n\n## Impact\n\nThe commands run in an isolated HOME.'
```

Pitfall: `chosen` is an array of `{id,text}` objects and every claim needs a
boolean `loadBearing`; the body needs all three headings before acceptance.

```text
chosen:
CH1  Use the packed CLI
claims:
C1  The packed CLI can run in the isolated repository.  true
schema=decision-row/v1 decisionId=dec_B4D8A89380D163D7168CD3977C state=proposed
```

```bash
ha relation relate --source-ref decision/dec_B4D8A89380D163D7168CD3977C/C1 --target-ref fact/F-16E9FECB --type evidenced-by --rationale "The run produced this observation." --expected-version 0
ha decision claim fulfill dec_B4D8A89380D163D7168CD3977C --id C1 --mode evidenced
ha decision accept dec_B4D8A89380D163D7168CD3977C --rationale "The recorded fact supports the claim."
```

Pitfall: evidence needs both the relation and a separate claim fulfillment;
only then can `accept` pass (the alternative is `--judgment-only`).

```text
schema=relation-action-history/v1 relationId=rel_aab341acca8329ed eventType=relation_created aggregateRevision=6
C1  The packed CLI can run in the isolated repository.  true  evidenced
schema=decision-row/v1 decisionId=dec_B4D8A89380D163D7168CD3977C state=in_effect
```

```bash
ha task submit task_e984b4eb7d6a54eb1c44cbe9e7 --json-input '{"completionClaim":"Implemented","deliverables":["docs-release/start/en/05-governance-recipe.md"],"outputs":["commit:<sha>"],"verificationNotes":["npm run check"],"knownGaps":[],"residualRisks":[],"commitSha":"<sha>"}'
ha task complete task_e984b4eb7d6a54eb1c44cbe9e7 --ci receipt_recipe
```

Pitfall: `verificationNotes` is an array, and submit needs the active lease
that only a non-placeholder plan can obtain. `complete --ci` takes a canonical
receipt reference, not free-form prose.

```text
error code=lease_required hint=Validation failed for entity=task task_e984b4eb7d6a54eb1c44cbe9e7 field=lease; actual=no matching active lease for the authenticated actor
error code=invalid_command hint=Task complete could not select one current closeout execution.
```

Before submitting a started task, author and sync `closeout.md` with exactly:

```markdown
## Summary
## Verification
## Residual Risk
## Same Mechanism Elsewhere
```

Then use `ha task review-execution` with a different reviewer actor, followed
by `ha task review-consent` using the review and content digests. They are not
reachable in this run because it preserves the observed `plan_placeholder`.

```bash
ha daemon stop
```

Pitfall: stop only the isolated daemon after the recipe run.

```text
daemon-stop: applied
```

## Current and upcoming commands

The packed CLI used here has no `decision preflight`, `task preflight`, or
`--from-closeout`. C1/C2/C3 companion work may add them; update this page when
they ship.
