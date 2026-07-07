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
- Roadmap: `harness/milestones/00-roadmap.md`
- Structured table: `harness/milestones/dossier-data.md`
- Charter decision: `dec_*`, decided by the CEO; this preset validates the anchor but does not create the decision.

## Constraints

- milestone = root task tree as execution surface + map document as understanding surface.
- Do not hand-build milestone files; run create-milestone scaffold/check.
- Do not add compatibility shims, dual reads, backfills, or migrations for hypothetical external consumers in pre-public-release posture.

## Checkpoint

- After root task creation, run scaffold before splitting child tasks.
- At each wave boundary, run the structure checker and record the output as progress evidence.
- Before closeout, fill the four-layer done criteria and gate-retro two-lens evidence.

## CI/Gate Authority Stop Condition

If this milestone is not CI/gate/governance work but requires changing CI/gate authority surfaces to pass, stop, record the blocker, and request or create governance work. Exceptions are explicitly authorized governance work or break-glass main repair; break-glass must record reason, scope, and follow-up governance task.

## Implementation Plan

- Create or confirm the charter decision, then pass the `dec_*` anchor to scaffold.
- Run `ha task create --title "<name> milestone root" --vertical software/coding --preset create-milestone --long-running`.
- Run `ha script run preset:create-milestone:scaffold --task <root-task-id> --input line=<line> --input slug=<slug> --input charterDecision=dec_* --input milestoneName="<name>" --input mission="<mission>"`.
- Fan out child tasks from the root task and keep the task mapping table aligned with the task tree.
- Re-run `ha script run preset:create-milestone:check --task <root-task-id> --input line=<line> --input slug=<slug>`.

## Verification

- create-milestone checker reports green.
- root task, map, roadmap, dossier-data, and charter decision anchor are mutually traceable.
- E75 gate: at least one real fact exists before review / complete.
