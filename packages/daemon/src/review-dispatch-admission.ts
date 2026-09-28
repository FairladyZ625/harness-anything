import { currentSubmittedExecutions, type ExecutionV1 } from "@harness-anything/kernel";
import type { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";

export function assertReviewerTarget(input: {
  readonly reviewer: boolean;
  readonly taskId: string | null;
  readonly decisionTarget: object | null;
  readonly executionId: string | undefined;
  readonly remoteExecutionId: string | undefined;
  readonly remote: boolean;
}): void {
  if (input.reviewer && input.taskId === null && input.decisionTarget === null)
    throw runtimeSpawnError("invalid_runtime_spawn", "Reviewer dispatch requires a task or Decision review target.");
  if (input.executionId !== undefined && (!input.reviewer || input.decisionTarget !== null))
    throw runtimeSpawnError("invalid_runtime_spawn", "executionId only applies to a Task reviewer dispatch.");
  if (input.reviewer && input.taskId !== null && input.remote && input.remoteExecutionId === undefined)
    throw runtimeSpawnError(
      "review_target_missing",
      `Remote task context for ${input.taskId} returned no submitted execution to review.`,
    );
}

/** A reviewer dispatch binds to the task's submitted cut; anything else is a dispatch error, never a fallback to an implementation execution. */
export function selectReviewTarget(
  taskId: string | null,
  requestedExecutionId: string | undefined,
  taskSnapshot: ReturnType<typeof requireCurrentTaskProjection>["snapshot"] | null,
  remote: boolean,
): ExecutionV1 | null {
  if (taskId === null || remote || taskSnapshot === null) return null;
  if (taskSnapshot.task?.status !== "in_review")
    throw runtimeSpawnError(
      "review_admission_denied",
      `Task ${taskId} is not in review. The task owner must forward the submitted cut before a reviewer is dispatched.`,
    );
  const candidates = currentSubmittedExecutions(taskSnapshot);
  if (requestedExecutionId !== undefined) {
    const match = candidates.find((candidate) => candidate.executionId === requestedExecutionId);
    if (!match)
      throw runtimeSpawnError(
        "review_target_missing",
        `Execution ${requestedExecutionId} is not a submitted cut on task ${taskId}'s current iteration.`,
      );
    return match;
  }
  if (candidates.length === 0)
    throw runtimeSpawnError(
      "review_target_missing",
      `Task ${taskId} has no submitted execution to review; a reviewer dispatch binds to a submitted ` +
        "cut, never to the active implementation execution. Submit the implementation first.",
    );
  if (candidates.length > 1)
    throw runtimeSpawnError(
      "invalid_runtime_spawn",
      `Task ${taskId} has ${String(candidates.length)} submitted executions on its current iteration ` +
        `(${candidates.map((candidate) => candidate.executionId).join(", ")}); ` +
        "dispatch each review with an explicit executionId.",
    );
  return candidates[0]!;
}
