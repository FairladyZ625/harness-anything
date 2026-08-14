---
schema: preset-document/v1
description: Shape implementation work around a registered module and add module-specific planning and handoff documents.
whenToUse: Use when ownership, scope, and progress must be tracked against one registered repository module.
---

# Module

Adds a module plan, brief, and session prompt while preserving the standard software-coding task contract. Create against an existing module with `ha task create --preset module --module <key>`; to register a new module context, also provide the complete `--register-module`, `--module-title`, `--module-prefix`, and `--module-scope` field group. The task package records the binding in `module.md`.
