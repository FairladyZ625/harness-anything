import { resolveHarnessLayout, type TaskProjection } from "@harness-anything/kernel";
import { assembleTaskCausalContext } from "./dispatch-causal-context.ts";
import { openTaskWorktreeBinding, presetSnapshotReader, taskWorkspaceView } from "./task-worktree.ts";
import { latestRuntimeContinuationSeed } from "./runtime-continuation-context.ts";
import { assignmentFromRelations } from "./entity-assignment-runtime.ts";
import { taskReviewerNote } from "./runtime-spawn-mission.ts";

/** Runtime preparation reads the same task context at the selected center or replica cut. The
 * settlement-time caller excludes the dispatch it is settling, so the continuation seed is the
 * previous stop rather than the dispatch's own just-written archive. */
export function readTaskRuntimeContext(
  rootDir: string,
  projection: TaskProjection,
  taskId: string,
  excludeDispatchId: string | null = null,
): import("./protocol/daemon-protocol-runtime-context.ts").DaemonTaskRuntimeContextResult {
  // A raw read: the caller uses the snapshot as-is, so the backend may skip the presentation
  // rollup it would otherwise compute and discard. Runtime context runs on every dispatch, and
  // that rollup walks the task's subtree on PostgreSQL (G38 read side).
  const read = projection.read(taskId, false, false),
    task = read.snapshot.task,
    snapshot: typeof read.snapshot =
      task == null
        ? read.snapshot
        : { ...read.snapshot, task: { ...task, assignment: assignmentFromRelations(projection, `task/${taskId}`) } };
  const executionIds = read.snapshot.executions.map(({ executionId }) => executionId);
  return {
    schema: "task-runtime-context-read/v3" as const,
    ok: true as const,
    taskId,
    causalContext: assembleTaskCausalContext({ projection: projection, taskId }),
    riskTier: task?.metadata?.riskTier ?? null,
    riskTierFlowVersion: task?.metadata?.riskTierFlowVersion ?? null,
    profileId: task?.metadata?.profileId ?? null,
    worktree: openTaskWorktreeBinding(task, presetSnapshotReader(projection)),
    continuationContext: latestRuntimeContinuationSeed(projection, taskId, executionIds, excludeDispatchId),
    // The same note every local worker mission carries, served to an edge that has no settings projection.
    reviewerNote: taskReviewerNote(projection, snapshot),
    snapshot: {
      ...snapshot,
      workspace: taskWorkspaceView(
        rootDir,
        task,
        read.packagePath,
        presetSnapshotReader(projection),
        resolveHarnessLayout(rootDir).authoredRoot,
      ),
    },
  };
}
