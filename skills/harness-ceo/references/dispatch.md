# Dispatch, concurrency, and recovery

## Discover the installed contract

Start with `ha capabilities` and the relevant command's help. Inspect existing
agent/squad declarations and available runtime instances before selecting one.
Validate a new declaration with the installed CLI before using or installing it.
Do not assume example IDs, flags, provider aliases, permission modes, or callback
behavior exist on another installation.

Use the existing task/preset creation path, declared read set, and task-bound
runtime or squad execution. Honor the installed claim/lease and executor binding
requirements; do not copy a fixed release/start sequence. Do not release another
holder's lease or manufacture identities to bypass authority. Use one canonical
mission; supplementary instructions should reference it rather than fork it.

If the current host cannot use a supported dispatch path, continue feasible local
work and report the specific missing capability. Do not install private wrappers
or configure credentials without authorization.

## Multiple edges, one center

The canonical center owns shared task state and matrix updates. Edges submit
through the supported central write path under the current holder/claim fence;
they do not each write a local copy and later overwrite the canonical record.
One task execution must not acquire competing writers. Use distinct authorized
execution units for parallel work or serialize work sharing the same lease.
Scheduled work belongs to the schedule occurrence claim, not a permanent shared
task that every node starts at the same time.

Each run gets an artifact destination qualified by its actual dispatch/execution
identity, allocated through the supported path. Never share a mutable `report.md`
across workers. Git worktrees isolate source changes; Git-less edges hand artifacts
back through the center without requiring Git or pretending to have a commit.

Snapshot the matrix entry/revision used for selection in the run's evidence.
Workers append observations to their own reports; the designated matrix owner
reviews and incorporates them through the central write path. Concurrent runs can
finish against different revisions without rewriting each other's observations.
The matrix is user-owned prose: this skill introduces no separate lock, registry,
claim type, or configuration parser.

## Observe, reconcile, then retry

Retain task, execution, dispatch, workspace, model/runtime, and artifact identities
from the actual run. A receipt says what was requested; inspect the supported
status/result interface and output to establish what ran. Where the host exposes
actual model/settings, record them; otherwise mark requested identity as unverified.

On timeout or connection loss, query the existing execution before redispatching.
Reconcile runtime state, artifact timestamps/content, and process state where the
host exposes it. An inaccessible process on another node is not proof of death.
Do not infer inactivity from a quiet log or trust a stale running status alone.

Use resume only when the current runtime supports it and the execution state is
eligible. Otherwise perform the documented recovery or create a new bounded run
referencing completed artifacts. Preserve the original failed attempt as evidence.
Do not turn a historical provider bug into an eternal rule for every runtime.

After repeated attempts yield no new evidence, stop repeating that approach and
take over, change the experiment, or escalate the missing capability. Continue
independent work. Before closing a supervising session, hand live runs to a known
owner or use the host's durable supervision facility; do not assume callbacks
survive session loss. Final handoff identifies remaining live work explicitly.
