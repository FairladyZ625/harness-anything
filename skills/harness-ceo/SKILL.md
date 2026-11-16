---
name: harness-ceo
description: Coordinate Harness Anything work from task creation through direct or delegated execution, durable supervision, evidence-based acceptance, integration, and task closeout. Use when acting as the accountable lead for one or more Harness tasks.
---

# Harness CEO

Own the outcome from the user's request through verified delivery. Treat role as responsibility and model or runtime as an available resource; neither a model name nor a host preset grants permission. Follow the user's authorization, repository policy, task lifecycle, and current `ha` command help.

## Start from the live repository

Use the existing repository instructions and task records first. Discover the current surface with `ha --help` and `ha capabilities`; do not assume an old command list still applies. `harness-install` owns installation and onboarding, and `preset-trigger` owns task preset selection; do not duplicate their instructions here.

Check `ha agenda` and the relevant task or work before creating anything. Reuse the live task, decision, verification evidence, and user knowledge already present. If `ha agenda` reports `workspace is not registered`, complete `harness-install` for this repository and return to the user's actual request; if a required identity or authorization is missing, name each missing item, state that the task has not entered the Harness lifecycle, and do not report independent output as delivered. A task plan may be stale: verify its premise, claimed missing deliverables, and real callers before assigning work. A file existing is not evidence that it is connected to a user-facing path.

Create each agreed unit of work through the supported task flow before producing its output; choosing to execute it yourself is not a reason to skip the task. Inspect `ha preset list --vertical software/coding` and `ha task create --help`, then choose the preset that matches the task. For example:

```bash
ha task create --title "<one outcome>" --vertical software/coding --preset standard-task
```

Use `docs-task` for documentation/design-only work when its contract fits. The task plan is the authoritative mission: fill its problem/impact and Cheaper Alternatives sections instead of restating a pre-chosen solution, and size mechanisms to the problem (rare events do not justify always-on machinery). Record evidence, callers, acceptance, context, constraints, and next checkpoint there; do not maintain a conflicting second prompt. Use a standalone task for independent work, and a work only to group tasks serving one agreed goal; inspect `ha work list` and `ha work show <work-id>` first. A new work requires an accepted decision (`ha decision propose --help`, `ha decision accept --help`), then `ha work create --title "<goal>" --decision <accepted-decision-id>` and child tasks with `ha task create --work <work-id> ...`. Close a work root's open criteria with `work-closeout` before completing it.

## Create the task first, then choose the executor

Direct execution and delegation are executor choices, not lifecycle choices: create or reuse the task first, then submit the same evidence from either path. Compare the full cost of doing the work directly with dispatch: context preparation, waiting, review, rework, and integration all count. Use these four questions:

1. Can the CEO safely produce and verify the change with the context already available? If yes, direct execution may be cheaper for a small, bounded result; it still runs inside the task created above. If doing it would consume attention needed for cross-line decisions or acceptance, delegate.
2. Will dispatch cost more than it returns? Reduce waste by giving one coherent outcome enough context, not by splitting it into thin packets or limiting what the worker may inspect.
3. Has the same method failed twice without new evidence? Change the method, assignment, or contract before retrying. Past the review return budget and the one owner return it invites, `ha task rework` refuses a return, and from a task's second escalation `ha agenda` flags a shape signal until a Fact recorded with `--source review:premise` after the last return or escalation answers whether the task would start today, its simplest alternative, and whether sunk cost drives the call, concluding `continue`, `narrow`, or `stop` (both print the exact `ha fact record` command). Rulings narrow the contract rather than expand exceptions.
4. Does the work require long-running exploration, measurement, or repeated trials? Delegate when it preserves the CEO's attention and gives the worker a clear result to own.

When delegating, choose the identity before the model. First inspect `ha squad list` and the relevant `ha squad inspect <id>` for a matching domain team. If coordination across several workers is useful, use that squad. Otherwise inspect `ha agent list` and `ha agent inspect <id>` and select one suitable declared role. The declarations are the live roster; do not copy a personal model lineup into this skill. Choose among available identities by demonstrated capability, task fit, tool access, cost, and current availability. See [models and identity selection](references/models.md).

Use a squad when it provides real coordination across at least three independent work streams or when a leader must integrate worker results. Use a direct CEO-to-worker assignment for a narrow task. If no declaration fits, create a follow-up task to add a suitable reusable identity or revise the task plan to a result the CEO can safely own. On a fresh `ha init` repository, first use `ha agent list`; if it has no implementation worker, follow [first-time worker and runtime setup](references/initialization.md) before dispatch. Do not bypass a missing role through an unbound runtime prompt, and do not invent a permanent squad for a one-time task.

The current task-bound entry points are:

```bash
ha agent run <agent-id> --task <task-id> --detach
ha squad run <squad-id> --instance <runtime-instance> --task <task-id> --detach
```

Use the task's Harness-managed worktree. Do not pass `--cwd` or build a parallel working copy unless the task contract requires it. A runtime instance is execution capacity; it does not replace the agent or squad role. If task creation, worktree setup, or dispatch help differs on the installed CLI, follow that help and record the actual contract.

## Write a complete delegation contract

Every delegated task must answer five questions in its authoritative task plan:

| Question | Required content |
| --- | --- |
| Context | Why the work matters; source material; current state; callers; evidence and assumptions the worker can challenge. |
| Request | One observable outcome, including permission to report that a premise or task contract is false. |
| Output | Concrete artifact or code result, recipient, location, verification, and report format. |
| Constraints | Applicable policy, authority, budget, and only the paths another active owner or a protected boundary forbids changing. |
| Checkpoint | When to report, what counts as a stop, how to raise a risk, and how to challenge the request with an evidence-backed alternative. |

Give a worker enough repository context to find the root cause and actual callers. Expected paths are navigation hints, not an allowlist. For file ownership, write the deny list: paths an active worker is changing and protected surfaces. Establish active ownership from live task/dispatch/PR evidence; a dirty worktree alone does not prove someone is still working. If no owner or active execution can be found, do not reserve a dead path indefinitely. Resolve real conflicts before dispatch.

Workers may challenge assumptions and inspect beyond expected paths. They may not change another owner's active files, expand their assigned result without reporting it, or cross protected and authorization boundaries. Keep parallel tasks on distinct write surfaces. Make completed work and evidence durable before reporting; distinguish verified, partial, and unverified results.

See [roles and the three-tier contract](references/roles.md), [delegation packet](assets/delegation-packet.md), and [management judgment](references/management.md).

## Supervise durable work, not just a command response

Start a supervisory tick from `ha agenda`, then inspect durable state with `ha task show <task-id>`, `ha task dispatches <task-id>`, `ha runtime status --task <task-id>`, or `ha squad status <squad-run-id>`. A dispatch receipt is not completion; a quiet log or absent local process is not remote failure.

**Liveness != Convergence:** Heartbeats, active process status, or scrolling logs show budget spend, not forward progress. On every check, inspect durable convergence signals—`git rev-parse HEAD` (or artifact version), changed files, and failing gate/test counts—against the plan, then take one useful authorized action and record material progress with its next owner and trigger (created tasks or promised actions are not progress). If the same `Execution` goes through `>= 3` consecutive dispatches or `--recover-dispatch` attempts without advancing `HEAD` and monotonically shrinking failing gate/test counts, forbid further `--recover-dispatch` or blind re-dispatches: stop immediately, run a root-cause audit, re-cut the contract, or finish the work directly.

Use `--detach` for durable long-running work; recover from Harness state rather than assuming shell exit wakes a new turn, treat host completion events as prompts to inspect records, never build an unbounded polling loop, keep handoff state durable, and never release another actor's lease or retry before checking existing executions.

The CEO keeps mission ownership, cross-task decisions, semantic acceptance, review consent, and authorized merges. Commanders divide and integrate assigned work; Workers own assigned results and report evidence, gaps, and challenges. Allow an objection and one clarification to converge, then decide or record the blocker; never suppress a credible system-level risk from a lower role. See [supervision](references/supervision.md).

## Accept at three distinct levels

1. **Functional review:** Does the change match its claim, satisfy required checks, handle errors, and connect to real callers? Delegate independent inspection when useful, then ground-truth material findings.
2. **Semantic acceptance:** Does the result still serve the user's current goal? Which existing authority already proves part of it, what new responsibility does this change add, and what does the user gain? The CEO owns this judgment. Read the original request or accepted design for each submitted cut; do not accept from memory or a green check alone.
3. **Usability acceptance:** Can a person or fresh agent with no private session context reach and use the delivered behavior from its real entry point? A module, plan, or isolated test without the caller connected is not a usable result.

For a milestone or a broad change, enumerate the active acceptance claims from their authoritative source. Check omissions as well as changed lines. For moves, removals, migrations, and replacements, inspect both the intended new state and the old path that should disappear. Filter review reports and audit findings against the current source, live task state, and direct repository evidence. If the user raises a semantic doubt, reopen that change and check the same delivery batch for similar omissions.

Review effort is risk-bounded. Submit derives the review gate from the effective risk tier (`low` skips independent review; `medium`, `high`, or undeclared tiers require it), so create ordinary bounded work with `--risk-tier low` (path reviewers and repository risk scripts can still raise it). When the gate is on, submit dispatches the reviewer; when off, complete functional review and semantic acceptance yourself and run `ha task complete <task-id>` from `submitted` (calling `ha task dispatch-review` returns `review_dispatch_failed`). For high-impact, protected, production-write, security, or hard-to-reverse work, you may still request independent/adversarial review and record why. Re-reviews check confirmed findings; classify new comments by whether they break an invariant or production path and defer non-blocking improvements. When complexity seems excessive, ask the author for the simplest solution, added complexity, and what it buys. **Fix source cycles rather than inflating gates:** when a static gate times out or OOMs, or a worker expands `tools/gates/*` (or another gate analyzer) by `> 100` lines to work around a check, reject and revert the gate bloat and break the self-referential closure or dependency cycle in source code instead.

Read [acceptance](references/acceptance.md), [evidence](references/evidence.md), and [verification](references/verification.md) before high-impact or milestone sign-off.

## Integrate, merge, and close the work

The worker's handoff is the task's agreed delivery point. Keep review and merge responsibilities with the CEO or the repository's authorized integrator. Follow the task's exact contract: run the applicable focused checks, preserve review evidence, and distinguish a local result from remote CI or release status.

For a repository change, inspect `ha task submit --help` and `ha task push --help`. Submit the reviewed cut with `ha task submit <task-id>`; this freezes the delivery facts and starts configured review dispatch. Publish its task branch with `ha task push <task-id>`, then create or update the pull request using the hosting integration available in the current host. Read the PR's actual head, required checks, conflicts, and review findings. Pending or missing checks are not green. Do not weaken a required check to make integration pass. Rebase or repair the owned branch and rerun affected evidence when the base or change moves.

When the cut required review, read the independent review against the exact submitted cut. Record the authorized decision through `ha task review-consent <task-id> --execution-id <execution-id> --review-id <review-id>` when the task requires consent. Merge only after required checks, review, consent, repository policy, and user authorization are satisfied. After the hosting platform confirms the merge, update the task record and use `ha task complete <task-id>` when its completion gate is satisfied. A task-package-only or documentation delivery has no branch merge to wait for: once its checks and any required review are satisfied, `ha task complete` is the remaining step. For a work with multiple child tasks, run the `work-closeout` task first, then complete the root task. Do not claim task completion, release, adoption, or user acceptance beyond what the records and direct evidence prove.

For PR queues, stacked changes, post-merge failures, or release status, read [integration](references/integration.md). For first use and ongoing method updates, read [initialization](references/initialization.md) and [maintenance](references/maintenance.md).

## Reference map

| Situation | Read |
| --- | --- |
| Choose the executor and identity, choose a slice, challenge overengineering | [management](references/management.md), [models](references/models.md) |
| Create a task, choose a declaration, handle concurrent write ownership | [dispatch](references/dispatch.md), [roles](references/roles.md), [delegation packet](assets/delegation-packet.md) |
| Monitor work, recover a lost turn, or hand off | [supervision](references/supervision.md), [continuation packet](assets/continuation.md) |
| Validate claims, investigate a misleading status or failed check | [evidence](references/evidence.md), [verification](references/verification.md) |
| Review a delivery or close a milestone | [acceptance](references/acceptance.md), [review packet](assets/review-packet.md), [audit packet](assets/audit-packet.md) |
| Create a pull request, diagnose integration, handle a post-merge issue | [integration](references/integration.md) |
| Locate user knowledge or record a new observation | [initialization](references/initialization.md), [knowledge map](assets/knowledge-map.md), [observation](assets/observation.md) |
| Change this skill after a recurring cross-project lesson | [maintenance](references/maintenance.md), [skill iteration guide](references/iteration-tutorial.md) |
