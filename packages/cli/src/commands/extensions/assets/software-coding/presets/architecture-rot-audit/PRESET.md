---
schema: preset-document/v1
description: Detect structural architecture drift and record actionable findings for a software product.
whenToUse: Use before a release or architecture-focused refactor, or when ownership and boundary erosion need evidence.
entrypoints:
  check: ha preset run architecture-rot-audit check --task <task-id> --allow-scripts
---

# Product Architecture Rot Audit

Scans declared product structure for recurring architecture decay signals and writes the resulting evidence into the task package.
