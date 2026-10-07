import { resolveHarnessLayout, type TaskProjection } from "@harness-anything/kernel";
import { assembleTaskCausalContext } from "./dispatch-causal-context.ts";
import { openTaskWorktreeBinding, presetSnapshotReader, taskWorkspaceView } from "./task-worktree.ts";

/** Runtime preparation reads the same task context at the selected center or replica cut. */
export function readTaskRuntimeContext(
  rootDir: string,
  projection: TaskProjection,
  taskId: string,
): import("./protocol/daemon-protocol-runtime-context.ts").DaemonTaskRuntimeContextResult {
  const read = projection.read(taskId),
    task = read.snapshot.task;
  return {
    schema: "task-runtime-context-read/v1" as const,
    ok: true as const,
    taskId,
    causalContext: assembleTaskCausalContext({ projection: projection, taskId }),
    profileId: task?.metadata?.profileId ?? null,
    worktree: openTaskWorktreeBinding(task, presetSnapshotReader(projection)),
    snapshot: {
      ...read.snapshot,
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
