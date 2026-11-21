# Collaboration Governance

## Collaboration Flow

1. Create a task with the matching `office/collab` preset (`deliverable-task`, `handoff-task`, or `minutes-task`).
2. Start the task to acquire an execution lease before authoring deliverables.
3. Submit frozen artifacts so declared completion gates verify structure and upstream freshness deterministically.

## Review and Handoff

- Reviewers verify submitted artifacts directly against declared acceptance criteria and never self-review their own deliverables.
- Cross-owner handoffs must explicitly record `ownerTransfer`, `deliverables`, `openItems`, and `acceptanceCriteria`.
