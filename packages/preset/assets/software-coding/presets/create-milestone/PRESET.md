---
schema: preset-document/v1
description: Create and validate a milestone root task, its durable map, and its human-readable status view.
whenToUse: Use when a body of work needs a milestone boundary, coordinated waves, explicit dependencies, and closeout criteria.
---
# Create Milestone

Create the milestone with normal agent tools and the repository's governed write roads. The preset supplies the coordination shape; it does not run a scaffold or checker script.

## Workflow

1. Confirm an accepted charter decision, a stable milestone line and slug, a concise mission, and the first user or system that benefits.
2. Create the root task with this preset using `ha task create --task-class milestone` and keep the returned task id as the durable anchor.
3. Read `harness.yaml`, repository instructions, this preset policy, and nearby milestone examples; write only beneath the configured milestones root.
4. Create the milestone overview, index, machine-readable summary, and human-readable status view in the established repository format.
5. Record the mission, waves, dependencies, entry conditions, switch evidence, retirement evidence, and closeout criteria.
6. Create child tasks and real dependency relations through governed write roads.
7. Validate links, duplicate rows, required sections, status agreement, and rendered output.

## Done when

- The root task, accepted decision, milestone map, and summary views resolve to one another.
- Every wave has an owner, entry condition, dependency boundary, and exit evidence.
- Write-road registration and verification evidence are recorded.
