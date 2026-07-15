---
schema: preset-document/v1
description: Select a GitHub issue and turn it into an evidence-backed repair plan inside a task package.
whenToUse: Use when implementation starts from an existing GitHub issue and its current state must be captured before repair.
inputs:
  state: GitHub issue state filter.
  limit: Maximum issues considered while selecting work.
  labels: Required comma-separated labels.
  excludeLabels: Comma-separated labels excluded from selection.
  issue: Explicit issue number or next eligible issue.
  fixtureFile: Local issue fixture used for deterministic runs.
  issueJson: Inline issue payload used for deterministic runs.
  fetchMode: Whether network-backed issue fetching is enabled.
entrypoints:
  plan: ha preset run github-issue-repair plan --task <task-id> --allow-scripts
---

# GitHub Issue Repair

Captures the selected issue and prepares a repair plan without embedding issue-specific behavior in the CLI core.
