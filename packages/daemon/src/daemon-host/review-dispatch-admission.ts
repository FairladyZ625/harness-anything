import { currentSubmittedExecutions, submissionDigest, type ExecutionV1 } from "@harness-anything/kernel";
import type { requireCurrentTaskProjection } from "./projection-readiness.ts";
import { requiredRuntimeSpawnText, runtimeSpawnError } from "../runtime-engine/runtime-spawn-errors.ts";

export interface TaskReviewTargetBinding {
  readonly kind: "task";
  readonly taskId: string;
  readonly executionId: string;
  readonly digest: string;
}

export function parseTaskReviewTarget(value: unknown): TaskReviewTargetBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.kind !== "task") return null;
  return {
    kind: "task",
    taskId: requiredRuntimeSpawnText(target.taskId, "reviewTarget.taskId"),
    executionId: requiredRuntimeSpawnText(target.executionId, "reviewTarget.executionId"),
    digest: requiredRuntimeSpawnText(target.digest, "reviewTarget.digest"),
  };
}

export function assertReviewerTarget(input: {
  readonly reviewer: boolean;
  readonly taskId: string | null;
  readonly decisionTarget: object | null;
  readonly taskTarget?: TaskReviewTargetBinding | null;
  readonly executionId: string | undefined;
  readonly remoteExecutionId: string | undefined;
  readonly remote: boolean;
}): void {
  if (input.reviewer && input.taskId === null && input.decisionTarget === null)
    throw runtimeSpawnError("invalid_runtime_spawn", "Reviewer dispatch requires a task or Decision review target.");
  if (input.executionId !== undefined && (!input.reviewer || input.decisionTarget !== null))
    throw runtimeSpawnError("invalid_runtime_spawn", "executionId only applies to a Task reviewer dispatch.");
  if (input.taskTarget) {
    if (!input.reviewer || input.decisionTarget !== null || input.taskId !== input.taskTarget.taskId)
      throw runtimeSpawnError("invalid_runtime_spawn", "Task reviewTarget must match a Task reviewer dispatch.");
    if (input.executionId !== undefined && input.executionId !== input.taskTarget.executionId)
      throw runtimeSpawnError("invalid_runtime_spawn", "Task reviewTarget executionId must match executionId.");
  }
  if (input.reviewer && input.taskId !== null && input.remote && input.remoteExecutionId === undefined)
    throw runtimeSpawnError(
      "review_target_missing",
      `Remote task context for ${input.taskId} returned no submitted execution to review.`,
    );
}

/**
 * A read-only attach dispatch binds to the frozen round's single submitted cut — the same target a
 * reviewer dispatch observes — but it is not a review: it carries no reviewer role and its session
 * may not register one. Selection only fixes which execution the attach observed.
 */
export function selectReadOnlyAttachTarget(
  taskId: string,
  taskSnapshot: ReturnType<typeof requireCurrentTaskProjection>["snapshot"],
): ExecutionV1 {
  const candidates = currentSubmittedExecutions(taskSnapshot);
  if (candidates.length === 1) return candidates[0]!;
  throw runtimeSpawnError(
    "attach_target_missing",
    candidates.length === 0
      ? `Task ${taskId} froze without a submitted execution to attach to.`
      : `Task ${taskId} has ${String(candidates.length)} submitted executions on its current iteration ` +
          `(${candidates.map((candidate) => candidate.executionId).join(", ")}); an attach dispatch cannot choose between them.`,
  );
}

/**
 * The exact commit a Task reviewer must inspect, or null when the selected cut has no code delivery.
 * `undefined` means this is not a Task reviewer dispatch or the selected submitted cut is not in the snapshot,
 * so the caller must not silently run an unpinned review.
 */
export function reviewerPinnedCommit(
  payload: { readonly role?: unknown; readonly executionId?: unknown; readonly reviewTarget?: unknown },
  taskSnapshot: ReturnType<typeof requireCurrentTaskProjection>["snapshot"] | null,
): string | null | undefined {
  if (payload.role !== "reviewer") return undefined;
  if (taskSnapshot === null) return null;
  const taskTarget = parseTaskReviewTarget(payload.reviewTarget),
    expectedExecutionId =
      typeof payload.executionId === "string" ? payload.executionId : (taskTarget?.executionId ?? undefined),
    candidates = currentSubmittedExecutions(taskSnapshot),
    execution =
      expectedExecutionId !== undefined
        ? candidates.find((candidate) => candidate.executionId === expectedExecutionId)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
  if (taskTarget !== null) {
    const currentDigest = execution?.submission ? submissionDigest(execution.submission) : null;
    if (taskSnapshot.task?.status !== "in_review" || !execution?.submission || currentDigest !== taskTarget.digest)
      throw runtimeSpawnError(
        "review_cut_superseded",
        `Submitted cut for task ${taskTarget.taskId} execution ${taskTarget.executionId} was amended or superseded ` +
          `(expected digest ${taskTarget.digest}, current ${currentDigest ?? "none"}).`,
      );
  }
  return execution === undefined ? undefined : (execution.submission?.commitSha ?? null);
}

/** A reviewer dispatch binds to the task's submitted cut; anything else is a dispatch error, never a fallback to an implementation execution. */
export function selectReviewTarget(
  taskId: string | null,
  requestedExecutionId: string | undefined,
  taskSnapshot: ReturnType<typeof requireCurrentTaskProjection>["snapshot"] | null,
  remote: boolean,
  expectedDigest?: string,
): ExecutionV1 | null {
  if (taskId === null || remote || taskSnapshot === null) return null;
  if (taskSnapshot.task?.status !== "in_review") {
    if (expectedDigest !== undefined)
      throw runtimeSpawnError(
        "review_cut_superseded",
        `Task ${taskId} left review after digest ${expectedDigest} was frozen; review fallback is superseded.`,
      );
    throw runtimeSpawnError(
      "review_admission_denied",
      `Task ${taskId} is not in review. Review-required submissions enter review automatically; use an explicit owner forward to request review for a review-disabled cut.`,
    );
  }
  const candidates = currentSubmittedExecutions(taskSnapshot);
  let selected: ExecutionV1;
  if (requestedExecutionId !== undefined) {
    const match = candidates.find((candidate) => candidate.executionId === requestedExecutionId);
    if (!match) {
      if (expectedDigest !== undefined)
        throw runtimeSpawnError(
          "review_cut_superseded",
          `Execution ${requestedExecutionId} (digest ${expectedDigest}) is no longer a submitted cut on task ${taskId}'s current iteration.`,
        );
      throw runtimeSpawnError(
        "review_target_missing",
        `Execution ${requestedExecutionId} is not a submitted cut on task ${taskId}'s current iteration.`,
      );
    }
    selected = match;
  } else if (candidates.length === 0) {
    if (expectedDigest !== undefined)
      throw runtimeSpawnError(
        "review_cut_superseded",
        `Task ${taskId} no longer has a submitted cut matching digest ${expectedDigest}.`,
      );
    throw runtimeSpawnError(
      "review_target_missing",
      `Task ${taskId} has no submitted execution to review; a reviewer dispatch binds to a submitted ` +
        "cut, never to the active implementation execution. Submit the implementation first.",
    );
  } else if (candidates.length > 1) {
    throw runtimeSpawnError(
      "invalid_runtime_spawn",
      `Task ${taskId} has ${String(candidates.length)} submitted executions on its current iteration ` +
        `(${candidates.map((candidate) => candidate.executionId).join(", ")}); ` +
        "dispatch each review with an explicit executionId.",
    );
  } else {
    selected = candidates[0]!;
  }
  if (expectedDigest !== undefined) {
    const currentDigest = selected.submission ? submissionDigest(selected.submission) : null;
    if (currentDigest !== expectedDigest)
      throw runtimeSpawnError(
        "review_cut_superseded",
        `Submitted cut for task ${taskId} execution ${selected.executionId} was amended or superseded ` +
          `(expected digest ${expectedDigest}, current ${currentDigest ?? "none"}).`,
      );
  }
  return selected;
}
