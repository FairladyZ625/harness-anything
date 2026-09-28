---
schema: preset-document/v1
description: Create the standard planning, facts, and closeout scaffold for general software work.
whenToUse: Use for ordinary implementation, maintenance, refactoring, documentation, or test work when no narrower preset fits.
---
# Standard Task

This is the default software-coding preset and the baseline for focused work that does not need a specialized workflow.

`--profile lightweight` is the short path for a low-risk small change: the plan
and closeout use the minimal templates, and closeout requires no review,
consent, or Fact. It lifts no CI: a code change still lands through the pull
request's CI. The profile is frozen when the task is created.
