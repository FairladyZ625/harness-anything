# Dispatch and task setup

## Discover the live contract

Begin with `ha --help` and `ha capabilities`. Read the installed version's help for each command before composing flags. The CLI, preset set, declarations, and runtime instances are the live contract; an example in this skill is only a starting shape.

Before making a task, read `ha agenda`, search the relevant task tree, and read the current request and decisions. Check whether the requested outcome is already implemented, assigned, rejected, deferred, or waiting on a dependency. Verify the caller and the deliverable itself; an existing file without an active caller may be incomplete.

Use `ha preset list --vertical software/coding` and `ha task create --help` to choose the task's contract. A task preset sets planning and completion expectations; an agent or squad identity sets who performs the work. Do not conflate them. Use `standard-task` for ordinary repository changes and `docs-task` when the deliverable is documentation or design only and that preset fits. Select a risk tier from the actual impact; do not label a protected or hard-to-reverse change low risk to skip review.

Create a standalone task when it has one outcome and no meaningful shared work goal. A work is a root task and the subtree below it. Inspect `ha work list` and `ha work show <work-id>` before reusing one. A newly created work requires an accepted decision; do not invent a decision merely to get a grouping container. When there is a real new direction choice, inspect `ha decision propose --help` and `ha decision accept --help`, then use the authorized decision flow before `ha work create`. Add work items as children with `ha task create --work <work-id> ...`.

## Make the task plan executable

The generated task package is the authority for mission and acceptance. Keep one canonical task plan, not a prompt copy that can drift. Before dispatch, fill its relevant sections with:

- the source of the request and why the outcome matters;
- verified current behavior, real consumers, existing solutions, and assumptions open to challenge;
- the single outcome, user-visible or operational result, and non-goals;
- concrete output, report location, evidence, and acceptance checks;
- repository instructions, authorization, budget, dependency, and active write conflicts;
- the next checkpoint, stop conditions, and where to send a challenge or unresolved risk.

Evidence and output paths should follow the generated task contract. Keep large supporting material in the task's artifact area and link it from the plan. Do not place secret values or personal credentials in the task package.

## Choose a team, then a person

Inspect `ha squad list` before an individual agent when the work has a real domain coordination need. Inspect the candidate squad's roster and assigned runtime requirements. Otherwise use `ha agent list` and inspect the candidate declaration. Prefer an existing identity whose instructions, tools, task type, and review boundary match the work.

Use one worker for one coherent semantic result. Split only where tasks can be accepted independently, need distinct write ownership, or have different risk/check contracts. A larger packet with sufficient context is usually cheaper than repeated context transfer. Do not split by arbitrary file count. Parallel tasks must not have overlapping active write surfaces.

The current task-bound command shapes are:

```bash
ha agent run <agent-id> --task <task-id> --detach
ha squad run <squad-id> --instance <runtime-instance> --task <task-id> --detach
```

Harness owns task worktrees and squad child worktrees. Avoid a hand-made worktree or custom `--cwd` unless the task has an explicit need and its ownership is clear.

If no declared identity fits, do not substitute an unbound runtime prompt for task-bound work. The current `ha runtime run --help` explicitly directs task-bound work to `ha agent run`. Create a follow-up task to declare and validate a suitable reusable agent or squad, or revise the assignment to work the CEO can safely own. A missing identity is not permission to omit review or task tracking.

## Resolve ownership before dispatch

For each proposed parallel assignment, identify its task, execution owner, artifact location, and paths another active owner is changing. The file boundary is a deny list, not an allowlist: list only active conflicting paths and protected surfaces. Let a worker inspect adjacent code and discover unanticipated consumers. Check live task and dispatch state, and the hosting platform when relevant, before marking a path occupied. A dirty worktree by itself does not establish an active owner; a historical task status by itself does not establish a live process.

If two tasks need the same writable path, serialize that work or change the task boundary. Do not solve it with an informal lock file. If runtime ownership cannot be determined, keep the decision explicit and wait on that conflict while progressing independent work.

## Preserve an objection route

The worker may show that the requested work is unnecessary, already done, or based on a false assumption. The expected result can be a supported correction to the plan, a smaller task, or a no-change report with evidence. Do not force implementation to satisfy an obsolete file list. If the task no longer has a valid outcome, record that finding through the task's supported lifecycle instead of leaving a zombie assignment.
