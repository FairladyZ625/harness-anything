## Office Collaboration (office/collab)

- Use `deliverable-task` for structured reports, proposals, specifications, briefings, and checklists.
- Use `handoff-task` when transferring ownership across people or roles.
- Use `minutes-task` when turning meeting discussions into owned action items.

## Deliverables and Freshness

- Under `verified` / `upstream-verified` profiles, submit `artifacts/deliverable-manifest.json` (and `artifacts/upstream-freshness.json` when tracking upstream baselines) alongside the deliverable document.
- If an upstream baseline changes, refresh the deliverable and update its baseline digest before amending the submission.

## Handoff Discipline

- Every formal handoff submits `artifacts/handoff.json` covering all four elements: `ownerTransfer`, `deliverables`, `openItems`, and `acceptanceCriteria`.

## Meeting Minutes

- Capture meeting metadata, key decisions, owned action items with due dates, and unresolved questions in `minutes.md`.
