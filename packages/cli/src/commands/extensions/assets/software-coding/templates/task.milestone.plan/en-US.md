# {{title}}

Task Contract: harness-task v1

## Mission

State in one sentence who gets which verifiable capability from this milestone.

## Usage Questions

| Question | Answer |
| --- | --- |
| First user | TBD |
| Forced switch point | TBD |
| Retired old path | TBD |

## Wave Decomposition

| Wave | Goal | Child task anchor | Acceptance |
| --- | --- | --- | --- |
| W0 | Charter and canonical alignment | TBD | decision, map, roadmap, and dossier aligned |
| W1 | First usable capability | TBD | consumable by the first user |
| W2 | Closeout and regression | TBD | checker, gate, and usage proof complete |

## Exit Criteria

- [ ] Structural justice: root task, task tree, `00-overview.md`, `00-roadmap.md`, `dossier-data.md`, and charter decision anchor exist.
- [ ] Semantic acceptance: mission, usage questions, dependencies, entry conditions, and task mapping match execution.
- [ ] Adversarial verification: gate-retro two-lens review covers known defect registry review and new diff-surface scan.
- [ ] Usage proof: the first user has consumed the new path, and residuals have owners and follow-up entries.

## Context

- Map document: `harness/milestones/<line>/<slug>/00-overview.md`
- Roadmap: `<harness root>/milestones/00-roadmap.md`
- Structured table: `harness/milestones/dossier-data.md`
- Charter decision: `dec_*`, decided by the CEO; this preset validates the anchor but does not create the decision.

## PR/merge Operations

- Global merge-health operations ledger: `task_01KWYKCPG5FZA3AFVX9R8XX3B7` (Authority: `decision/dec_mrat6152`).
- Governance document: `harness/governance/standards/merge-queue-troubleshooting-standard.md`.
- The CEO / orchestrator owns worktree cleanup: clean the remote branch, local branch, and worktree after every merged PR, then run periodic sweeps; workers do not structurally clean global worktrees.
- If the same PR enters the queue twice and still cannot merge, treat it as a system signal: read the global ledger facts, run `npm run pr:doctor`, then record the event, attempts, and conclusion back to the global ledger as fact/progress.

## Constraints

- milestone = root task tree as execution surface + map document as understanding surface.
- Follow the create-milestone guidance and nearby repository examples; write only beneath the configured milestones root.
- Do not add compatibility shims, dual reads, backfills, or migrations for hypothetical external consumers in pre-public-release posture.

## Checkpoint

- After root task creation, establish the milestone map before splitting child tasks.
- At each wave boundary, reconcile the task tree, map, status views, and evidence.
- Before closeout, fill the four-layer done criteria and gate-retro two-lens evidence.

## CI/Gate Authority Stop Condition

If this milestone is not CI/gate/governance work but requires changing CI/gate authority surfaces to pass, stop, record the blocker, and request or create governance work. Exceptions are explicitly authorized governance work or break-glass main repair; break-glass must record reason, scope, and follow-up governance task.

## Implementation Plan

- Create or confirm the charter decision and keep its `dec_*` anchor in every milestone view.
- Run `ha task create --title "<name> milestone root" --vertical software/coding --preset create-milestone --long-running`.
- Read the create-milestone `PRESET.md`, `harness.yaml`, and nearby milestones; create or update the overview, index, summary, and status view under the configured milestones root.
- Fan out child tasks from the root task and keep the task mapping table aligned with the task tree.
- Validate links, required sections, duplicate rows, and status agreement; run the relevant repository checks and record evidence.

## Verification

- milestone surfaces pass the relevant repository checks and human reconciliation.
- root task, map, roadmap, dossier-data, and charter decision anchor are mutually traceable.
- Per `dec_mrg3z1we/CH4`, promote load-bearing observations explicitly as `0..N` Facts; keep delivery evidence in Execution outputs and do not impose a Fact quantity gate on review or completion.
