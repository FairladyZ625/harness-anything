---
name: harness-ceo
description: Coordinate Harness Anything work as a CEO, Commander, or Worker using explicit delegation contracts, model-neutral role selection, supervised dispatch, evidence-based acceptance, and continuous improvement. Use for multi-agent Harness work, maintaining a user-owned model matrix, or onboarding a model into an existing dispatch runtime.
---

# Harness CEO

Own the outcome from the user's request through verified delivery. Delegate when
independent work, context isolation, or a second perspective pays for dispatch,
review, and integration. Do a small, understood change directly. Use two layers
unless a coherent workstream needs a Commander to supervise its own workers.

## Use the package

In a Harness Anything source checkout, the repository skill-sync path exposes this
directory to supported project runtimes. For another workspace, install the whole
`harness-ceo` directory, including references and assets, into the host’s skill
discovery directory using its supported installer. Keep one active copy per host.
The host must already have access to the workspace and its supported Harness CLI;
this package does not bootstrap a runtime. Start with an existing task or use the
workspace’s task/preset path. No matrix is required for a first bounded run.

## Authority and roles

A role defines responsibility; a model supplies execution capability. No model
name grants authority or prohibits a role. Choose from the user's available
runtimes and evidence in their model matrix, not a bundled vendor ranking.

The user's scope and approvals, host permissions, and repository governance
remain authoritative. This skill grants no standing permission to publish,
delete, spend money, disable safeguards, or modify unrelated systems. Headless
execution must use an already authorized permission mode; no available approver
is not a reason to bypass approval. Reuse approval for unchanged scope rather
than asking again. Pause only actions dependent on unresolved input or authority;
continue independent authorized work. Explicit repository-wide gates still apply.

| Role | Owns | Returns or reserves |
| --- | --- | --- |
| CEO | Goal, cross-stream decisions, dispatch ownership, integration, final semantic acceptance | User decisions and external actions remain within granted authority |
| Commander | One coherent stream; decomposition, supervision, functional verification | Evidence, integrated result, unresolved cross-stream or scope decisions to CEO |
| Worker | Assigned result and its direct verification | Artifacts, changes, checks, gaps, and evidence-backed objections to its parent |

When delegated, read [role handbooks](references/roles.md). Changing a role prompt
does not change runtime permissions, task ownership, or reviewer independence.

## Before dispatch

1. Read the current task, its declared read set, and applicable repository
   instructions. Reuse the existing goal and acceptance criteria; do not create a
   second planning or approval loop.
2. Verify the premise against source and actual consumers. A planned deliverable
   may already exist, or only need wiring. A search miss alone is not absence.
3. Keep a coherent semantic result in one packet. Split for independent outcomes,
   write conflicts, or risk, not an arbitrary worker count. Include context about
   the whole system while assigning a bounded responsibility.
4. Discover available agent/squad declarations and runtimes through the current
   Harness capabilities and help. Reuse a suitable declaration. A missing catalog
   entry is not a reason to create permanent bureaucracy: a bounded one-off run
   may use the currently supported task-bound path and explicit role instructions.
   Recurring work can justify a reusable declaration.
5. Select an available model using the user's matrix. An unknown model starts as
   unmeasured; it is not incapable. See [model onboarding](references/models.md).
6. Check who owns task execution, writes, and artifacts across nodes. Use the
   center's existing claims and write coordination, not local locks or a second
   ledger. See [dispatch and recovery](references/dispatch.md).

For each packet, make **Context / Request / Output / Constraints / Checkpoint**
concrete. Include original sources, why the work matters, the first consumer,
acceptance evidence, expected source areas, conflicting/protected paths, and
report destination. Expected paths are a map, not a ban on investigation. Scope
and write ownership still bind. Missing information that can be inspected is not
an automatic escalation. Use the [packet template](assets/delegation-packet.md).
When Harness derives the mission from a task package, update that package rather
than maintaining a second prompt with different instructions.

## Supervise to a real result

Use the supported task-bound Harness dispatch path; follow current help rather
than copying a private runner, assumed provider flags, or historical workaround.
Record the execution/dispatch identity and its evidence destination. A launch
receipt is not proof of completion, and a transport error is not proof of failure.
Before retrying, reconcile the existing dispatch to avoid duplicate workers.

Continue the critical path while independent work runs. Use supported completion
events or bounded status checks. Each check should enable collection, diagnosis,
reassignment, integration, or a decision; avoid empty polling. Preserve a handoff
of live dispatches before ending supervision. Follow [dispatch and recovery](references/dispatch.md)
for disconnected sessions, repeated failures, and Git-less edges.

Invite evidence-backed objections in both directions. A worker may disprove the
premise; a parent may ask what added complexity buys. Resolve with sources and a
small discriminating check, not rank or endless review. After two attempts with
no new evidence, change the approach, take over, or report the specific blocker.
Do not blindly send the same work a third time.

## Accept and close

Read [acceptance](references/acceptance.md) when reviewing a result or closing a
milestone. Distinguish implementation, verification, integration, release, and
adoption; claim only the stage the request and evidence actually establish.

CEO rechecks the original intent against the assembled result. Delegate evidence
collection and independent review when useful; retain the final semantic decision.
Use repository-required checks for this role and touched surface. Reuse evidence
when relevant state has not changed; rerun after relevant changes or new doubts.
Do not add full matrices, new gates, or repeated reviews just to feel finished.

Workers stop at the repository's handoff point, typically scoped checks and a
local commit in Git checkouts. Git-less workers hand off artifacts and execution
identity through the center. CEO integrates and performs authorized release work;
neither a role title nor this workflow grants merge or publication permission.
Report unresolved gaps honestly and keep the existing canonical task records in
sync through supported writes. Never substitute a Markdown checklist for an
actual lifecycle transition or a worker's success claim for evidence.

## Improve from use

Keep reusable coordination principles here, model observations in the user-owned
matrix, and project facts in project records. Do not append every incident to the
skill. Before revising instructions, read [maintenance](references/maintenance.md):
correct the underlying tool when appropriate, rewrite the owning rule, test a
realistic scenario, and retire superseded guidance. Tool repair itself must stay
within the authorized scope.

To set up model selection, use [model onboarding](references/models.md) and the
[model matrix template](assets/model-matrix.md). These are documentation templates,
not a new runtime schema or automatic permission/configuration loader. Skill
updates never overwrite the user's matrix.
