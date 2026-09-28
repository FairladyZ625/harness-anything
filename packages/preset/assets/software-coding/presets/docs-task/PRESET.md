---
schema: preset-document/v1
description: Create the planning, facts, and closeout scaffold for design, documentation, or chore work that produces no code commit.
whenToUse: Use for pure design, documentation, research, or chore tasks whose deliverable is a document or decision rather than code.
---

# Documentation / Design Task

A lightweight software-coding preset for work whose deliverable is a design,
document, or chore rather than a code change.

It keeps the canonical task scaffold but omits the `ci` and
`code-doc-reconciliation` completion gates, which assume a code commit.

`--profile lightweight` is the short path for a low-risk small change such as a
one-line declaration, error text, or document revision: the plan and closeout
use the minimal templates, and closeout requires no review, consent, or Fact.
The profile is frozen when the task is created.
