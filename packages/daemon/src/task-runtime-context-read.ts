import { resolveHarnessLayout, type TaskProjection } from "@harness-anything/kernel";
import { assembleTaskCausalContext } from "./dispatch-causal-context.ts";
import { openTaskWorktreeBinding, presetSnapshotReader, taskWorkspaceView } from "./task-worktree.ts";
import { latestRuntimeContinuationSeed } from "./runtime-continuation-context.ts";
import { assignmentFromRelations } from "./entity-assignment-runtime.ts";

/** Runtime preparation reads the same task context at the selected center or replica cut. */
export function readTaskRuntimeContext(
  rootDir: string,
  projection: TaskProjection,
  taskId: string,
): import("./protocol/daemon-protocol-runtime-context.ts").DaemonTaskRuntimeContextResult {
  const read = projection.read(taskId),
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
    continuationContext: latestRuntimeContinuationSeed(projection, taskId, executionIds),
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
