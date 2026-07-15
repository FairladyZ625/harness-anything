---
schema: preset-document/v1
description: Create and validate a milestone root task, its durable map, and its human-readable status view.
whenToUse: Use when a body of work needs a milestone boundary, coordinated waves, explicit dependencies, and closeout criteria.
---

# Create Milestone

Create the milestone with normal agent tools and the repository's governed write
roads. The preset supplies the coordination shape; it does not run a scaffold or
checker script.

## Workflow

1. Confirm an accepted charter decision, a stable milestone line and slug, a
   concise mission, and the first user or system that benefits.
2. Create the long-running root task with this preset using `ha task create`.
   Keep the returned task id as the durable root anchor.
3. Read `harness.yaml`, the repository instructions, the preset policy when one
   exists, and nearby milestone examples. Resolve `milestonesRoot` from that
   configuration; write only beneath the known repository-relative root.
4. Create or update the required milestone overview, index, machine-readable
   summary, and human-readable status view in the repository's established
   format. Register the shared milestone surface in the write-road registry
   using the existing registry format.
5. Record the root task, charter decision, mission, usage questions, waves,
   dependencies, entry conditions, switch evidence, retirement evidence, and
   closeout criteria. Keep identifiers and links consistent across every view.
6. Create child tasks with `ha task create`, add real dependency relations with
   `ha task relate`, and use the repository's governed document route for any
   registered prose.
7. Validate links, duplicate rows, required sections, status agreement, and
   rendered output. Run the relevant repository checks and record the evidence.

## Done when

- The root task, accepted decision, milestone map, and summary views resolve to
  one another without stale or duplicate entries.
- Every wave has an owner, entry condition, dependency boundary, and exit
  evidence.
- The write-road registration and verification evidence are recorded.
