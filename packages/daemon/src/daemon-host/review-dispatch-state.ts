import {
  dispatchLifecycleSummary,
  type AgentRuntimeEventV1,
  type ExecutionV1,
  type TaskProjectionQueries,
  type TaskReviewDispatchFailureV1,
} from "@harness-anything/kernel";
import { reviewDispatchKey } from "./review-dispatch-key.ts";

export interface LatestCutReviewFailure {
  readonly dispatchId?: string;
  readonly code?: string;
  readonly reason: string;
  readonly failedAt?: string;
}

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

function cutReviewDispatches(
  cell: {
    readonly projection: Pick<TaskProjectionQueries, "readRuntimeDispatchesByTaskExecution">;
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
    return payload.role === "reviewer" && isCutReviewKey;
  });
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
  return cutReviewDispatches(cell, taskId, execution).filter(
    ({ event }) => !reviewAttemptEnded(cell, event.payload.runtimeSessionId),
  );
}

function compactReviewFailureReason(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim().replace(/\.+$/u, "");
  if (normalized.length <= 280) return normalized;
  return `${normalized.slice(0, 277)}...`;
}

/**
 * Latest failed/exhausted review dispatch for a submitted cut when no active reviewer remains.
 * Consumes `readDispatchLifecycle` so an attempt still waiting in provider fallback backoff is
 * never misreported as exhausted.
 */
export function latestFailedCutReviewDispatch(
  cell: {
    readonly projection: Pick<
      TaskProjectionQueries,
      "readRuntimeDispatchesByTaskExecution" | "readRuntimeSessionEventsByType" | "readDispatchLifecycle"
    >;
  },
  taskId: string,
  execution: ExecutionV1,
  recordedFailure?: TaskReviewDispatchFailureV1,
): LatestCutReviewFailure | null {
  const matchingRecorded =
      recordedFailure?.executionId === execution.executionId
        ? {
            code: recordedFailure.code,
            reason: compactReviewFailureReason(recordedFailure.message),
            failedAt: recordedFailure.failedAt,
          }
        : null,
    dispatches = cutReviewDispatches(cell, taskId, execution);
  if (dispatches.some(({ event }) => !reviewAttemptEnded(cell, event.payload.runtimeSessionId))) return null;
  const latest = [...dispatches]
    .sort(
      (left, right) =>
        left.event.workspaceRevision - right.event.workspaceRevision ||
        String(left.event.occurredAt).localeCompare(String(right.event.occurredAt)),
    )
    .at(-1)?.event;
  let dispatchFailure: LatestCutReviewFailure | null = null;
  if (latest && typeof cell.projection.readDispatchLifecycle === "function") {
    const lifecycle = dispatchLifecycleSummary(
      cell.projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [latest.payload.dispatchId] }),
    );
    if (lifecycle.policy && !lifecycle.policy.groupSettled) return null;
    if (lifecycle.outcome && lifecycle.outcome !== "succeeded") {
      const outcomeEvent = cell.projection
          .readRuntimeSessionEventsByType(latest.payload.runtimeSessionId, ["runtime_session_outcome_observed"])
          .findLast(
            (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }> =>
              event.type === "runtime_session_outcome_observed",
          ),
        rawReason =
          outcomeEvent?.payload.attempt?.reason ??
          outcomeEvent?.payload.reasonCode ??
          `review dispatch ended with outcome ${lifecycle.outcome}`,
        code = outcomeEvent?.payload.reasonCode ?? outcomeEvent?.payload.attempt?.classification ?? lifecycle.outcome;
      dispatchFailure = {
        dispatchId: latest.payload.dispatchId,
        code,
        reason: compactReviewFailureReason(rawReason),
        failedAt: outcomeEvent?.payload.endedAt ?? outcomeEvent?.occurredAt ?? latest.occurredAt,
      };
    }
  }
  if (!dispatchFailure) return matchingRecorded;
  if (!matchingRecorded) return dispatchFailure;
  const dispatchMs = Date.parse(dispatchFailure.failedAt ?? ""),
    recordedMs = Date.parse(matchingRecorded.failedAt ?? "");
  return Number.isFinite(recordedMs) && (!Number.isFinite(dispatchMs) || recordedMs > dispatchMs)
    ? matchingRecorded
    : dispatchFailure;
}
