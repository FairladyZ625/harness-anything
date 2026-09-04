---
schema: preset-document/v1
description: Materialize a source-blind, dual-principal black-box acceptance script for the complete Task lifecycle and the hooks negative case.
whenToUse: Use when validating that a Consumer owner/executor and a distinct independent reviewer can complete the Task lifecycle through the public ha CLI alone.
---

# Lifecycle Black-box Acceptance

Adds `lifecycle-blackbox-acceptance.md`, a reproducible dual-principal script for
the hooks negative case and the start, progress, review, and completion path. It
keeps repository source paths blind while permitting normal editing of the
disposable Task's own harness documents and artifacts.
