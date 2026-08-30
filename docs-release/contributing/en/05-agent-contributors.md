# Agent contributors

Coding agents follow the same public contribution contract as humans. Load
[`harness-contributing`](../../../skills/harness-contributing/SKILL.md) and use
its complete sequence; do not derive an agent-specific shortcut from this page.

## Agent evidence boundary

An agent should inspect current public source before editing, keep the declared
scope visible, preserve unrelated work, and report exact commands and results.
Its handoff must distinguish what changed, what did not, which checks passed,
which checks were not run and why, open findings, and residual risk.

An agent may use only authority actually granted for the contribution. It must
not expose local context, bypass generated gates, remove a failing test to make
CI green, or claim a human review, Dashboard confirmation, release decision, or
merge approval on someone else's behalf.

## Proposal authority

An authorized agent may prepare commits, push the contribution branch, and open
or update its PR. It may not push to `main`, force-push to evade a failed check,
or decide that the PR may merge. The final handoff must say plainly that merge
remains maintainer-owned.
