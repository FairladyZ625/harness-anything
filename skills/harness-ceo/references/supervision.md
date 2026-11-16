# Durable supervision and handoff

## Every supervisory tick has an outcome

Start from `ha agenda` and live task, dispatch, runtime, squad, and artifact records rather than session memory:

1. **Establish state:** identify the active task, execution, owner, and latest durable evidence.
2. **Check convergence (Liveness != Convergence):** a receipt, `running` label, heartbeat, scrolling log, or growing step count proves budget spend, not progress. Verify `git rev-parse HEAD` (or artifact revision), changed files (`git status --short`), and failing gate/test counts against the plan. State `unknown` if visibility is missing; never fabricate a terminal result.
3. **Act:** answer a blocker, clarify the contract, run a focused check, review an output, dispatch ready work, or pivot on new evidence.
4. **Record and hand off:** persist material progress with evidence, next owner, trigger, and any still-running or `unknown` work.

## Host notifications are hints

Verify durable task and execution state when host completion events arrive; do not assume shell exit wakes a model turn or build a private always-on poller. Use bounded waits or supported events instead of fixed sleeps, query existing dispatches before retrying so lost responses do not create duplicate writers, and never release another actor's lease without evidence and authority.

## Convergence circuit-breaker and source-cycle red line

Keep the original contract and prior attempts visible. When evidence disproves an assumption, amend the task through its supported path and pass verified progress, preserved changes, failed attempts, and the revised goal to any resumed worker. Do not repeat measurements whose relevant conditions have not changed; after two failed attempts of the same method without new evidence, change the method or return the contract.

- **3-round convergence circuit-breaker (`Liveness != Convergence`):** If the same `Execution` reaches `>= 3` consecutive dispatches or `ha agent run ... --recover-dispatch` attempts without advancing `git rev-parse HEAD` and monotonically reducing failing gate/test counts, **forbid further `--recover-dispatch` or blind re-dispatch**. Halt immediately, inspect the raw diff and failure output, run a root-cause audit (or re-cut the contract), or close the work directly. Continue independent work while another item waits, and record exact blockers rather than issuing empty status turns.
- **Break source cycles instead of inflating gate analyzers:** When a static gate or validator times out, hits path explosion, or OOMs—or when a worker expands `tools/gates/*` (or another gate/validator analyzer) by `> 100` lines (e.g., adding symbolic execution or heuristics) to work around a failure—judge it off-track immediately. Revert the validator bloat and break the self-referential closure or fat dependency cycle in business source code rather than masking source coupling inside gates.

## Write a usable handoff

Use [continuation](../assets/continuation.md) for session handoff. Include task/execution IDs, artifact/source versions (`HEAD`), verified changes, exact test results, uncommitted work, active owners, failed attempts, remaining budget, and next decision; separate `done`, `submitted`, `in_review`, integrated, and released work.

## Keep long-lived goals separate from live state

When the host offers persistent goals, keep observable outcomes, conflict priority, escalation triggers, and scope boundaries there, and keep mutable queues, task IDs, and execution snapshots in Harness records. A goal does not replace the task contract or authorize new work; without that host facility, use the normal task lifecycle and durable handoff.
