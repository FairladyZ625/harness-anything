# {{title}}

Task Contract: harness-task v1

## Mission

State in one sentence who gets which verifiable capability from this work.

## Usage Questions

| Question | Answer |
| --- | --- |
| First user | TBD |
| Forced switch point | TBD |
| Retired old path | TBD |

## Wave Decomposition

| Wave | Goal | Child task anchor | Acceptance |
| --- | --- | --- | --- |
| W0 | Charter and canonical alignment | TBD | decision and work map aligned |
| W1 | First usable capability | TBD | consumable by the first user |
| W2 | Closeout and regression | TBD | checker, gate, and usage proof complete |

## Exit Criteria

- [ ] Structural justice: the work root, its task subtree, this work map, and the charter decision anchor exist.
- [ ] Semantic acceptance: mission, usage questions, dependencies, entry conditions, and task mapping match execution.
- [ ] Adversarial verification: gate-retro two-lens review covers known defect registry review and new diff-surface scan.
- [ ] Usage proof: the first user has consumed the new path, and residuals have owners and follow-up entries.

## Context

- Work map: this `task_plan.md`; the work is this root task plus its subtree.
- Status view: `ha work show <root-task-id>`; `ha agenda --work <root-task-id>` narrows the agenda to this work.
- Charter decision: `dec_*`, decided by the CEO; this preset validates the anchor but does not create the decision.

## Required Reading

List the charter decision, this work map, adjacent works, and load-bearing code or contracts in order, identifying the final authority when sources conflict.

## Entry Conditions

List the product rulings, consumer commitments, and prerequisite capabilities that must exist before this work or a wave may start.

## Dependencies

List cross-task, cross-wave, and external-consumer dependencies and handoffs, including owner, readiness evidence, and downstream recipient.

## Execution Surface

Declare the repository, worktree, branch/base, and write boundary for each wave. Each dispatch injects its concrete absolute `cwd`.

### Hard Prohibitions

Do not change CI workflows, thresholds and budgets, required checks, credentials or host services, delete assertions, or change allowlist counts. Stop and report an exact request on these boundaries.

### Decision-Derived Authorization

Dispatch injects the execution surface from current Decisions linked by active derives edges. Only chosen entries of `in_effect` Decisions grant scope; superseded or retired Decisions grant nothing on the next dispatch. Gates and test assertions encoding contracts replaced by that Decision may be updated, provided negative cases are preserved and completed, the decision id is cited, and changed gate files are listed in closeout. Proceed and report within scope; stop outside scope or at a hard prohibition. Tasks without deriving Decisions receive no such default grant. A summary is neither the full Decision nor additional ledger write permission.

## PR/merge Operations

- Global merge-health operations ledger: `task_01KWYKCPG5FZA3AFVX9R8XX3B7` (Authority: `decision/dec_mrat6152`).
- The CEO / orchestrator owns worktree cleanup: clean the remote branch, local branch, and worktree after every merged PR, then run periodic sweeps; workers do not structurally clean global worktrees.
- If the same PR enters the queue twice and still cannot merge, treat it as a system signal: read the global ledger facts, run `npm run pr:doctor`, then record the event, attempts, and conclusion back to the global ledger as fact/progress.

## Constraints

- work = root task + its parent-child subtree; this plan is the work map, and the subtree is the execution surface.
- Follow the create-work guidance and nearby repository examples.
- Do not add compatibility shims, dual reads, backfills, or migrations for hypothetical external consumers in pre-public-release posture.

## Checkpoint

- After root task creation, fill in this work map before creating child tasks.
- At each wave boundary, reconcile the task subtree, this map, `ha work show`, and evidence.
- Before closeout, fill the four-layer done criteria and gate-retro two-lens evidence.

## Implementation Plan

- Create or confirm the charter decision and keep its `dec_*` anchor in this work map.
- Run `ha work create --title "<name>"` to create the work root.
- Read the create-work `PRESET.md`, `harness.yaml`, and nearby works; keep this map current.
- Create each child task with `ha task create --work <root-task-id>` and keep the wave table aligned with `ha work show`.
- Validate links, required sections, duplicate rows, and status agreement; run the relevant repository checks and record evidence.

## Deliverable Contract

State the work's final deliverables, destinations, recipients, first consumer, and the task-level outputs and state each wave must hand back.

## Evidence Protocol

State the required usage proof and reviewer rejection conditions; when the task repairs a defect, also state its negative control or mutation check. Never replace actual runner output and consumption evidence with a summary claim.

Close the loop before work closeout: record at least one observation with `ha fact record --task <task-id> ...` and preserve its receipt in the Execution outputs. A fact is an evidence input to a decision, so attach it to the relevant claim with `ha relation relate --source-ref decision/<decision-id>/<claim-id> --target-ref fact/F-XXXXXXXX --type evidenced-by --rationale "<why>" --expected-version 0` before accepting or reckoning that decision. If a proposal has no fact evidence yet, `ha decision propose` still succeeds, but its receipt points to these two commands.

## Verification

- The work passes the relevant repository checks and human reconciliation.
- The work root, this map, `ha work show`, and the charter decision anchor are mutually traceable.
- Per `dec_mrg3z1we/CH4`, promote load-bearing observations explicitly as `0..N` Facts; keep delivery evidence in Execution outputs and do not impose a Fact quantity gate on review or completion.
