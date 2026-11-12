import type { ExecutionV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { reviewDispatchKey } from "./review-dispatch-key.ts";

export function reviewAttemptEnded(
  cell: { readonly projection: Pick<TaskProjectionQueries, "readRuntimeSessionEventsByType"> },
  runtimeSessionId: string,
): boolean {
  return (
    cell.projection.readRuntimeSessionEventsByType(runtimeSessionId, [
      "runtime_session_exited",
      "runtime_session_outcome_observed",
      "runtime_dispatch_outcome_unknown",
    ]).length > 0
  );
}

/** A task cut can have only one active primary reviewer, including keys written before migration. */
export function activeCutReviewDispatches(
  cell: {
    readonly projection: Pick<
      TaskProjectionQueries,
      "readRuntimeDispatchesByTaskExecution" | "readRuntimeSessionEventsByType"
    >;
  },
  taskId: string,
  execution: ExecutionV1,
): ReturnType<TaskProjectionQueries["readRuntimeDispatchesByTaskExecution"]> {
  const baseKey = reviewDispatchKey(taskId, execution);
  return cell.projection.readRuntimeDispatchesByTaskExecution(taskId, execution.executionId).filter(({ event }) => {
    const payload = event.payload,
      key = payload.dispatchKey,
      suffix = typeof key === "string" && key.startsWith(baseKey) ? key.slice(baseKey.length) : null,
      isCutReviewKey =
        suffix === "" ||
        /^:reviewer:[^:]+(?::attempt[1-9][0-9]*)?(?::fallback:[1-9][0-9]*)?(?::resume-fallback)?$/u.test(
          suffix ?? "",
        ) ||
        /^:attempt[1-9][0-9]*(?::fallback:[1-9][0-9]*)?(?::resume-fallback)?$/u.test(suffix ?? "");
    return payload.role === "reviewer" && isCutReviewKey && !reviewAttemptEnded(cell, payload.runtimeSessionId);
  });
}
