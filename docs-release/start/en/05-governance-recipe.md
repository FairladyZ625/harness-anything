# Governance loop recipe

This is the copy-and-run path for a complete Fact -> Decision -> Task -> review
loop. Run it from a scratch repository with the packed CLI and an isolated
`HOME`; never point a test at the default daemon.

```bash
npm pack -w @harness-anything/cli
```
Pitfall: pack from the worktree, not the canonical checkout; install the
resulting `harness-anything-cli-*.tgz` into the scratch repository.

```bash
export HOME="$PWD/.ha-home"; export HARNESS_GIT_AUTHOR_NAME="Your Name"; export HARNESS_GIT_AUTHOR_EMAIL="you@example.com"; ha init --person-id you --display-name "Your Name"
```
Pitfall: human attribution comes from the daemon; do not set
`HARNESS_ACTOR=human:you`.

```bash
ha fact record --task task_<id> --statement "Observed behavior" --source "repro" --confidence high
```
Pitfall: `--statement` and `--text` are alternatives; `--source` is required,
and `--task` is optional when the fact is not task evidence.

```bash
ha decision propose --json-input '{"title":"Use the fix","question":"Which path?","riskTier":"low","urgency":"low","decisionClass":"standard","chosen":"Use the fix","rejected":"Do nothing","claims":[{"id":"C1","text":"The fix addresses the observation"}],"relations":[]}' --body-file decision-body.md
```
Pitfall: the packet needs all five required fields plus `claims`; body prose is
separate, and `decision-body.md` must contain `## Background`, `## Decision`,
and `## Impact` before acceptance. The command prints the new decision id.

```bash
ha decision accept dec_<id> --rationale "Evidence and review support this choice" --judgment-only "The recorded evidence is sufficient"
```
Pitfall: acceptance is a double condition: provide a claim-to-evidence
relation and fulfill it, or use `--judgment-only`; an empty `appliesTo` is a
warning, not a blocking error.

```bash
ha decision claim fulfill dec_<id> --id C1 --mode evidenced
```
Pitfall: fulfillment is a separate write from the evidence relation; do both
before accepting when using the evidenced route.

```bash
ha task create --json-input '{"title":"Implement the fix","workKind":"docs","riskTier":"low","urgency":"low"}'
```
Pitfall: creation scaffolds the task package; use the printed `task_<id>` for
all following commands.

```bash
ha task start task_<id>
```
Pitfall: submit requires an active execution lease; start is the step that
acquires or reuses it.

```bash
ha task submit task_<id> --json-input '{"completionClaim":"Implemented","deliverables":["docs-release/start/en/05-governance-recipe.md"],"outputs":["commit:<sha>"],"verificationNotes":["npm run check"],"knownGaps":[],"residualRisks":[],"commitSha":"<sha>"}'
```
Pitfall: `verificationNotes` is an array, not a string; all seven fields are
required and the packet must be supplied with `--from-file` or `--json-input`.

```bash
ha task review-execution task_<id> --review-id review_<id> --json-input '{"verdict":"approved","reason":"Evidence checked","evidenceChecked":["commit:<sha>"]}'
```
Pitfall: review is independent and content-pinned; use a different reviewer
actor when self-review is rejected.

```bash
ha task review-consent task_<id> --review-id review_<id> --consent-id consent_<id> --json-input '{"reviewDigest":"<digest>","contentDigest":"<digest>"}'
```
Pitfall: consent selects the recorded review; its two digests must match the
submitted content and review.

```bash
ha task complete task_<id> --ci receipt_<id>
```
Pitfall: completion checks the closeout contract and canonical CI receipt;
`--ci` is a receipt reference, not free-form prose.

## Closeout contract

Before submit/complete, make `closeout.md` contain exactly these four headings:

```markdown
## Summary
## Verification
## Residual Risk
## Same Mechanism Elsewhere
```

The old feedback's failures are therefore explicit: missing `--rationale`
(1), undeclared relation triple (2), missing decision authorization (3), wrong
relation direction (4-6), placeholder body (7), unfulfilled claim (8), soft
`appliesTo` warning (9), missing packet input (10), missing lease (11), scalar
`verificationNotes` (12), and missing closeout headings (13). Query exact
current flags with `ha <domain> --help`; command names and fields above follow
the packed CLI's help output.

## Current and upcoming commands

The current packed CLI has no `decision preflight` or `task preflight` command;
use the read-only `ha decision validate <id>` and `ha task review <id>` checks
where applicable. Preflight, triples, and `--from-closeout` improvements from
the companion C1/C2/C3 tasks are intentionally not documented as shipped here.
