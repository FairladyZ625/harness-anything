---
schema: preset-document/v1
description: Create and validate a milestone root task, its durable map, and its human-readable status view.
whenToUse: Use when a body of work needs a milestone boundary, coordinated waves, explicit dependencies, and closeout criteria.
---
# Create Milestone

Create the milestone with normal agent tools and the repository's governed write roads. The preset supplies the coordination shape; it does not run a scaffold or checker script.

## Workflow

1. Propose the charter decision (`ha decision propose`) with a stable milestone line and slug, a concise mission, and the first user or system that benefits. Leave it `proposed`; do not accept it yet.
2. Create the root task with this preset using `ha task create --task-class milestone` and keep the returned task id as the durable anchor. Root task creation does not require an accepted charter.
3. Anchor the charter's load-bearing claims to evidence, then transition it to `in_effect`. Record observations as Facts on the root task and relate each claim with `evidenced-by`; a Task target is also accepted by the evidence floor. Reserve `--judgment-only` for claims that genuinely rest on judgement rather than observation — accepting an `evidenced` claim through it leaves the evidence chain empty.
4. Read `harness.yaml`, repository instructions, this preset policy, and nearby milestone examples; write only beneath the configured milestones root.
5. Create the milestone overview, index, machine-readable summary, and human-readable status view in the established repository format.
6. Record the mission, waves, dependencies, entry conditions, switch evidence, retirement evidence, and closeout criteria.
7. Create child tasks and real dependency relations through governed write roads.
8. Validate links, duplicate rows, required sections, status agreement, and rendered output.

## Done when

- The root task, accepted decision, milestone map, and summary views resolve to one another.
- Every wave has an owner, entry condition, dependency boundary, and exit evidence.
- Write-road registration and verification evidence are recorded.
