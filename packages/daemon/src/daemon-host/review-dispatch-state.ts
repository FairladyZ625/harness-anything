import {
  activeCutReviewDispatches as readActiveCutReviewDispatches,
  latestFailedCutReviewDispatch as readLatestFailedCutReviewDispatch,
  reviewAttemptEnded as projectionReviewAttemptEnded,
  reviewDispatchGroupSettled as projectionReviewDispatchGroupSettled,
  type CutReviewDispatchProjection,
  type LatestCutReviewFailure,
} from "@harness-anything/application/queries";
import type { ExecutionV1, TaskProjectionQueries, TaskReviewDispatchFailureV1 } from "@harness-anything/kernel";

export type { LatestCutReviewFailure };

export function reviewAttemptEnded(
  cell: { readonly projection: Pick<TaskProjectionQueries, "readRuntimeSessionEventsByType"> },
  runtimeSessionId: string,
): boolean {
  return projectionReviewAttemptEnded(cell.projection, runtimeSessionId);
}

/** Group-level settlement judgment shared by task show, agenda, and review dispatch admission. */
export function reviewDispatchGroupSettled(
  cell: {
    readonly projection: Pick<TaskProjectionQueries, "readRuntimeSessionEventsByType"> &
      Partial<Pick<TaskProjectionQueries, "readDispatchLifecycle">>;
  },
  dispatch: { readonly dispatchId: string; readonly runtimeSessionId: string },
): boolean {
  return projectionReviewDispatchGroupSettled(cell.projection, dispatch);
}

/** A task cut can have only one active primary reviewer, including groups in waiting_backoff. */
export function activeCutReviewDispatches(
  cell: { readonly projection: CutReviewDispatchProjection },
  taskId: string,
  execution: ExecutionV1,
): ReturnType<TaskProjectionQueries["readRuntimeDispatchesByTaskExecution"]> {
  return readActiveCutReviewDispatches(cell.projection, taskId, execution);
}

/** Latest failed/exhausted review dispatch for a submitted cut when no active reviewer remains. */
export function latestFailedCutReviewDispatch(
  cell: { readonly projection: CutReviewDispatchProjection },
  taskId: string,
  execution: ExecutionV1,
  recordedFailure?: TaskReviewDispatchFailureV1,
): LatestCutReviewFailure | null {
  return readLatestFailedCutReviewDispatch(cell.projection, taskId, execution, recordedFailure);
}
