---
schema: preset-document/v1
description: Create the standard planning, facts, and closeout scaffold for general software work.
whenToUse: Use for ordinary implementation, maintenance, refactoring, documentation, or test work when no narrower preset fits.
---

# Standard Task

This is the default software-coding preset and the baseline for focused work that does not need a specialized workflow.

Declare `--risk-tier low` for a low-risk small change. When this preset declares
the short profile, the task automatically uses its minimal plan and closeout;
closeout requires no review or consent. It lifts no CI: a code change still
lands through the pull request's CI. Submit-time repository risk scripts may
raise the review route.
