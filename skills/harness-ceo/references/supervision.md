# Durable supervision and handoff

## Every supervisory tick has an outcome

Start from the current `ha agenda`. Select work from live task state, decisions, dependencies, and current owners rather than session memory. For a work subtree, inspect its root and open tasks. For a dispatched task, read its current and historical dispatches, durable runtime or squad status, and produced artifact.

Use this sequence:

1. **Establish state:** which task and execution are active, which owner holds the next action, and what evidence is current?
2. **Check the checkpoint:** compare concrete output with the task plan. Is it verified, partial, blocked, failed, or unknown?
3. **Act:** answer a question, clarify a criterion, run a focused check, review a result, dispatch a ready independent task, or change the approach based on new evidence.
4. **Record:** write meaningful progress and attach evidence through the task's supported path. State the next owner, action, and triggering condition.
5. **Handoff:** before leaving, identify all still-running, waiting, and unknown work and who will resume it.

A dispatch receipt, no-output wait, `running` label, quiet log, or absent process on the CEO's machine is not sufficient by itself to establish completion or failure. Check status in the system that owns the execution and inspect its output. If visibility is missing, state `unknown`; do not manufacture a terminal result.

## Host notifications are hints

Completion events and shell return behavior depend on the host. Use them when they are actually available, but verify the durable task and execution state when they arrive. Do not assume a shell exit automatically starts another model turn. When a host cannot wake the CEO, leave a durable checkpoint and resume on the next invocation or supported event. Do not build a private always-on poller to compensate for an absent host feature.

Use a bounded wait or event when supported. Avoid fixed sleeps as a substitute for an observable state change. Before retrying, query existing dispatches and outputs so a lost response does not create duplicate writers. Never cancel another owner's work or release a lease without the supported authority and evidence.

## Change direction without losing evidence

Keep the original task contract and prior attempts available. If evidence disproves an assumption, update the task through its supported amendment or review process; state what changed and why. A resumed worker receives completed work, exact current state, preserved changes, failed attempts, and the new objective. Do not repeat measurements whose relevant conditions have not changed.

After two attempts of the same method without new evidence, change the method or return the contract for a decision. Continue independent work while one question is waiting. If no useful authorized action remains, record the exact blocker and next trigger rather than issuing empty status turns.

## Write a usable handoff

Use [continuation](../assets/continuation.md) when a new session must take over. Include the task and execution identities, artifact and source versions, verified changes, exact test results, uncommitted work, active owners, previous attempts, remaining budget, and the next decision. Separate work that is done, submitted, under review, integrated, and released. A host notification without a durable handoff is not recovery.

## Keep long-lived goals separate from live state

If the host provides a persistent-goal facility, state the observable outcome, priority when work conflicts, completion or escalation conditions, and the current scope boundary. Keep the mutable queue, task identifiers, and execution snapshot in supported task and handoff records. A goal statement does not authorize new work or replace the task contract. If the host has no such facility, use its normal task lifecycle and a durable handoff rather than inventing a private poller.
