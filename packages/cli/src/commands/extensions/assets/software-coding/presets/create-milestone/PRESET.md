---
schema: preset-document/v1
description: Create and validate a milestone root task, its durable map, and its human-readable status view.
whenToUse: Use when a body of work needs a milestone boundary, coordinated waves, explicit dependencies, and closeout criteria.
inputs:
  line: Stable milestone line identifier.
  slug: Filesystem-safe milestone slug.
  milestoneName: Human-readable milestone name.
  mission: One-sentence milestone mission.
  status: Initial milestone lifecycle status.
  firstUser: First user expected to benefit from the milestone.
  switchWhen: Evidence that permits switching to the new behavior.
  retireWhen: Evidence that permits retiring the previous behavior.
  dependencies: Comma-separated milestone dependencies.
  charterDecision: Accepted decision that authorizes the milestone.
  waves: Ordered implementation waves.
  source: Milestone summary document used by the HTML renderer.
entrypoints:
  scaffold: ha preset run create-milestone scaffold --task <task-id> --allow-scripts
  render-html: ha preset run create-milestone render-html --task <task-id> --allow-scripts
  check: ha preset run create-milestone check --task <task-id> --allow-scripts
---

# Create Milestone

Scaffolds the milestone contract and long-running coordination documents, maintains the milestone map, and validates the resulting package.
