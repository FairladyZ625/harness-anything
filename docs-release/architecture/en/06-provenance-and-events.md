# Provenance, verdicts, and the event ledger

[Decision vs. verdict](../../learn/en/02-decision-and-verdict.md) draws a hard
line: a decision answers *which path do we take?* and a verdict answers *does
this one output hold?* — and conflating them lets one quietly eat the other.
This page shows the machinery that keeps them apart, plus the two record
structures they lean on: the session identity that binds a record to the run
that produced it, and the append-only event ledger the Exit Gate reads for
completeness.

## Provenance: every record points back to its origin

Attribution has two layers. The base layer is the canonical event envelope:
every accepted event carries `actor` (a `principal` person plus an optional
`executor` agent) and `source` — no record lands on disk anonymously. The
upper layer is the document surface writing session identity out explicitly: a
decision's frontmatter carries `provenance[]`, and it holds **exactly one**
entry — a `SessionProvenanceV1`
(`packages/kernel/src/domain/agent-runtime.ts`):

| Field | Meaning |
|---|---|
| `runtime` | the name of the producing runtime (`claude`, `devin`, `codex`, ...; a non-empty string) |
| `sessionId` | the session that did the writing (nullable) |
| `transcriptReachability` | how reachable that session's transcript is (`by_session_id`, `dispatch_stream_only`, ...) |
| `boundAt` | the timestamp the binding was stamped |

A decision requires exactly one session identity: a record's origin either
points back to one real run, or it does not exist — multiple origins would blur
who actually decided. A task package's ownership is carried by
`task-contract.json` and its document-owner declarations; a fact carries
`Evidence source` and `Observed at`; and the `actor`/`source` on every event
envelope backstops it all, so any entity can be traced along the canonical log
to the writer that produced it.

## Verdict: a judgment, not a decision entity

A **verdict** is a Reviewer's semantic judgment on one submitted Execution.
`review/v1` (`packages/kernel/src/domain/review.ts`) uses the closed values
`approved`, `changes_requested`, and `dismissed`, and requires a non-empty
`reason` plus `evidenceChecked[]`; it also carries `submissionDigest`, pinning
the verdict to the reviewed submission round — change the submission and the
review no longer applies. The Reviewer reads Task intent, the closeout-derived
Submission Packet, and the available artifacts before judging the round
(dec_mrg3z1we/CH3-CH4; ADR-0027 D5-D6). `review-consent/v1` then pins consent
to the same review and submission digests.

The structural fact worth underlining is what a verdict is *not*. A verdict is
**not** a decision entity. It does not get a `dec_`-style id, it does not enter
the centralized decisions directory, and it does not go on the decision queue.
Where does it live instead? In an immutable Review Entity attached to the exact
Execution it judged. A verdict is recorded next to that delivery round, not
promoted into the standing choices that shape future work (ADR-0027 D5).

| | Decision | Verdict |
|---|---|---|
| Question | which path? (WHY) | does this delivery round hold? |
| Where recorded | a decision entity in `decisions/` | immutable `review/v1` for one Execution |
| On the decision queue? | yes | no |
| Reversible | a later decision can supersede it | one-shot, fails closed |

## Session bindings and Executions

An Execution (`execution/v1`) carries `sessionBindings`, recording which
runtime sessions this delivery round was bound to; submit seals the bindings
and freezes the Submission. Bindings hold only pointers such as
`transcriptRef` — enough to locate the original provider session without
writing transcript bodies into the canonical log (ADR-0027 D1).

## Routing is not automatic

If a verdict is not a decision, when does a decision ever come out of one? Only
when the verdict surfaces something *strategic* — "this batch of results says
we chose the wrong path." And even then, the routing is **not automatic**.
Nothing in the pipeline turns `changes_requested` into a new decision on its
own. A routine negative verdict blocks acceptance; it does not open a
decision. A strategically significant verdict *prompts* a human to propose a
new decision, as a deliberate act.

This is the mechanical reason the decision queue stays meaningful. If every
routine verdict auto-created a decision, the queue would fill with per-output
bookkeeping until no one could watch it. By keeping verdicts in Execution-bound
Review records and requiring a deliberate step to escalate, the flood of
routine verdicts never reaches the one queue a human is meant to see
(ADR-0027 D5).

## Agent runtime witness events

Agent runtime events are durable **witnesses of lifecycle changes**, not a raw
activity stream. `AgentRuntimeEventV1`
(`packages/kernel/src/domain/agent-runtime.ts`) shares the same canonical
envelope, SQLite event ledger, and rebuildable projection as task and document
events. It records installation observations, session lifecycle transitions,
provider session binding, and explicit task/execution binding. A binding stores
only a `transcriptRef`, so the original provider session can be located without
putting the transcript body into the canonical log.

Heartbeat ticks, stdout/stderr, transcript bodies, tool calls, and token/cost
streams are operational data and do not become canonical events. In particular,
heartbeat traffic grows the log only when it crosses a liveness threshold and
produces a `runtime_session_liveness_changed` event. Runtime liveness and task
lease/lifecycle remain separate facts; a session event cannot renew a lease or
complete a task.

The daemon does retain a provider's structured event stream locally at
`.harness/runtime/dispatches/<dispatch-id>.jsonl`. This is operational evidence,
not database or canonical-event content: the header relates the dispatch to its
task, runtime session, and local stream reference, while the remaining JSONL
records are parsed only when someone asks to inspect them. Before a record is
written, recursively named secret-bearing fields and recognizable bearer/token
values are replaced with `[REDACTED]`; credentials, executable paths, and
provider environment values never become stream content. `ha task dispatches
<task-id>` combines an in-flight local record with terminal task artifacts, and
the terminal dispatch artifact retains the stream reference plus provider
session identifier. Thus `ha runtime run --resume-dispatch <dispatch-id>
--prompt "…"` resumes without exposing or requiring a provider session id.
Resume inherits the recorded agent, working directory, permission mode, and
model. Task workers can use `ha agent run <agent-id> --resume-dispatch
<dispatch-id>`; a different agent and a second resume of the same source
dispatch are rejected. Quota exits appear as `provider_quota`, with a reset
time when the provider supplies one and a resume command in `nextAction`.
When a leader supplies `--agent <leader-id> --to <worker-id>`, the same
dispatch artifact records `squadId`, worker `agentId`, and
`delegatedByAgentId`; the target must be that leader's roster member and its
open `runtimes` set must contain the closed instance kind.

When a dispatch is task-bound, the daemon also publishes its terminal work
artifacts through canonical doc sync. One batch creates
`artifacts/missions/<dispatch-id>.md`,
`artifacts/dispatches/<dispatch-id>.json`, and
`artifacts/reports/<dispatch-id>.md`. The task package's realized `task_plan.md`
is the required mission source: task start, runtime dispatch, and Squad
dispatch all reject empty required sections or retained preset scaffold text
with `plan_placeholder`. `ha agent run <agent-id> --task <id> --mission <name>`
appends the canonical `artifacts/missions/<name>.md` document to that
plan-derived mission; `--prompt` remains an explicit override. Agent
declarations select a node-local instance and permission mode; `--instance` and
`--cwd` are dispatch overrides. `ha squad run --task <id>` derives the same
mission without requiring a prompt. Reports come from the provider's
structured runtime result, never by parsing human-readable terminal output. An
unbound runtime run has no task package and therefore publishes none of these
documents.

## How the pieces connect

Three separate structures, one spine of accountability:

```text
provenance / actor    ──▶  every record names the run and actor that produced it
runtime witness       ──▶  task and execution can locate the native session
verdict on execution  ──▶  every judged output is recorded next to the work

A strategic verdict → a human proposes a new decision (see learn/02)
```

Provenance answers *who produced this record*. The runtime witness answers
*which native session was observed*. A verdict answers *did this one output
hold*. None of the three is a decision, and none of them silently becomes one —
the escalation from a verdict to a decision is always a deliberate human act,
which is exactly what keeps the decision spine, and the queue that watches it,
worth reading. The "why" behind that separation is the argument in
[decision vs. verdict](../../learn/en/02-decision-and-verdict.md); the "done"
it feeds into is [the adoption law](../../learn/en/05-adoption-law.md).

## Authored governance configuration

The authored `governance/walls/walls.json` manifest uses the existing doc-sync
whole-file JSON policy. Preview it with `ha doc status --path
governance/walls/walls.json`, then submit that path with `ha doc sync --submit
--path governance/walls/walls.json`. Updates retain the canonical cut and
content checks used by other authored documents. This classification does not
enable arbitrary JSON documents or replace the typed writers for task contracts
and dispatch records.
