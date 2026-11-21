import {
  isSettledDispatchFailure,
  reviewDispatchFailureWarning,
  submissionDigest,
  type AgentRuntimeEventV1,
  type DispatchLifecycleView,
  type ExecutionV1,
  type TaskProjectionQueries,
  type TaskReviewDispatchFailureV1,
} from "@harness-anything/kernel";
export { reviewDispatchFailureWarning };

export interface LatestCutReviewFailure {
  readonly dispatchId?: string;
  readonly code?: string;
  readonly reason: string;
  readonly failedAt?: string;
}

export interface CutReviewDispatchTarget {
  readonly taskId: string;
  readonly execution: ExecutionV1;
  readonly recordedFailure?: TaskReviewDispatchFailureV1;
}

export interface CutReviewDispatchState {
  readonly activeDispatches: ReturnType<TaskProjectionQueries["readRuntimeDispatchesByTaskExecution"]>;
  readonly latestFailure: LatestCutReviewFailure | null;
}

export type CutReviewDispatchProjection = Pick<
  TaskProjectionQueries,
  "readRuntimeDispatchesByTaskExecution" | "readRuntimeSessionEventsByType"
> &
  Partial<Pick<TaskProjectionQueries, "readDispatchLifecycle">>;

/** Stable key for a task-review dispatch; shared by the review dispatcher and the proof reads
 * that compare a stored dispatch against the execution it was opened for. */
export function reviewDispatchKey(taskId: string, execution: ExecutionV1, reviewerId?: string): string {
  const key = `task-review:${taskId}:${execution.executionId}:${execution.iteration}:${submissionDigest(
    execution.submission!,
  )}`;
  return reviewerId ? `${key}:reviewer:${reviewerId}` : key;
}

export function reviewAttemptEnded(
  projection: Pick<TaskProjectionQueries, "readRuntimeSessionEventsByType">,
  runtimeSessionId: string,
): boolean {
  return (
    projection.readRuntimeSessionEventsByType(runtimeSessionId, [
      "runtime_session_exited",
      "runtime_session_outcome_observed",
      "runtime_dispatch_outcome_unknown",
    ]).length > 0
  );
}

/** Group-level settlement judgment shared by task show, agenda, and review dispatch admission. */
export function reviewDispatchGroupSettled(
  projection: Pick<TaskProjectionQueries, "readRuntimeSessionEventsByType"> &
    Partial<Pick<TaskProjectionQueries, "readDispatchLifecycle">>,
  dispatch: { readonly dispatchId: string; readonly runtimeSessionId: string },
): boolean {
  if (typeof projection.readDispatchLifecycle === "function") {
    const read = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [dispatch.dispatchId] });
    if (read.status === "pending") return false;
    const view = read.rows[0];
    if (view) return view.policy.groupSettled;
  }
  return reviewAttemptEnded(projection, dispatch.runtimeSessionId);
}

function cutReviewDispatchesForTarget(
  projection: Pick<TaskProjectionQueries, "readRuntimeDispatchesByTaskExecution">,
  taskId: string,
  execution: ExecutionV1,
): ReturnType<TaskProjectionQueries["readRuntimeDispatchesByTaskExecution"]> {
  const baseKey = reviewDispatchKey(taskId, execution);
  return projection.readRuntimeDispatchesByTaskExecution(taskId, execution.executionId).filter(({ event }) => {
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

function compactReviewFailureReason(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim().replace(/\.+$/u, "");
  if (normalized.length <= 280) return normalized;
  return `${normalized.slice(0, 277)}...`;
}

interface RankedReviewFailure {
  readonly failure: LatestCutReviewFailure;
  readonly terminalRevision: number;
}

function compareRankedReviewFailures(left: RankedReviewFailure, right: RankedReviewFailure): number {
  const leftMs = Date.parse(left.failure.failedAt ?? ""),
    rightMs = Date.parse(right.failure.failedAt ?? "");
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
  if (Number.isFinite(leftMs) !== Number.isFinite(rightMs)) return Number.isFinite(leftMs) ? 1 : -1;
  if (left.terminalRevision !== right.terminalRevision) return left.terminalRevision - right.terminalRevision;
  return String(left.failure.failedAt ?? "").localeCompare(String(right.failure.failedAt ?? ""));
}

export function cutReviewTargetKey(taskId: string, executionId: string): string {
  return `${taskId}:${executionId}`;
}

/**
 * Pure cross-aggregate read assembling both active review dispatches and latest settled failure
 * for one or more submitted cuts using a single batched `readDispatchLifecycle` lookup.
 */
export function readCutReviewDispatchStates(
  projection: CutReviewDispatchProjection,
  targets: readonly CutReviewDispatchTarget[],
): ReadonlyMap<string, CutReviewDispatchState> {
  const results = new Map<string, CutReviewDispatchState>();
  if (targets.length === 0) return results;

  const dispatchesByTarget = targets.map((target) => ({
      target,
      key: cutReviewTargetKey(target.taskId, target.execution.executionId),
      dispatches: cutReviewDispatchesForTarget(projection, target.taskId, target.execution),
    })),
    allDispatchIds = [
      ...new Set(
        dispatchesByTarget.flatMap(({ dispatches }) => dispatches.map(({ event }) => event.payload.dispatchId)),
      ),
    ],
    lifecycleRead =
      allDispatchIds.length > 0 && typeof projection.readDispatchLifecycle === "function"
        ? projection.readDispatchLifecycle({ by: "dispatch-batch", dispatchIds: allDispatchIds })
        : null,
    viewsByDispatchId = new Map<string, DispatchLifecycleView>(
      lifecycleRead?.status === "ready" ? lifecycleRead.rows.map((row) => [row.attempt.dispatchId, row]) : [],
    );

  for (const { target, key, dispatches } of dispatchesByTarget) {
    const activeDispatches: ReturnType<TaskProjectionQueries["readRuntimeDispatchesByTaskExecution"]>[number][] = [];
    if (lifecycleRead === null) {
      for (const row of dispatches) {
        if (!reviewAttemptEnded(projection, row.event.payload.runtimeSessionId)) activeDispatches.push(row);
      }
    } else if (lifecycleRead.status === "pending") {
      activeDispatches.push(...dispatches);
    } else {
      for (const row of dispatches) {
        const view = viewsByDispatchId.get(row.event.payload.dispatchId);
        if (!view) {
          if (!reviewAttemptEnded(projection, row.event.payload.runtimeSessionId)) activeDispatches.push(row);
          continue;
        }
        if (!view.policy.groupSettled && view.controlLeafDispatchId === row.event.payload.dispatchId)
          activeDispatches.push(row);
      }
    }

    if (activeDispatches.length > 0) {
      results.set(key, { activeDispatches, latestFailure: null });
      continue;
    }

    let bestFailure: RankedReviewFailure | null = null;
    if (lifecycleRead?.status === "ready") {
      for (const row of dispatches) {
        const dispatchId = row.event.payload.dispatchId,
          view = viewsByDispatchId.get(dispatchId);
        if (!view || !view.policy.groupSettled || view.controlLeafDispatchId !== dispatchId) continue;
        const outcome = view.attempt.outcome;
        if (outcome === "succeeded" || outcome === "cancelled" || outcome === "stopped") continue;
        const outcomeEvent = projection
          .readRuntimeSessionEventsByType(row.event.payload.runtimeSessionId, ["runtime_session_outcome_observed"])
          .findLast(
            (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }> =>
              event.type === "runtime_session_outcome_observed",
          );
        if (!isSettledDispatchFailure(view, outcomeEvent?.payload.attempt)) continue;
        const rawReason =
            outcomeEvent?.payload.attempt?.reason ??
            outcomeEvent?.payload.reasonCode ??
            `review dispatch ended with outcome ${outcome ?? "failed"}`,
          code =
            outcomeEvent?.payload.reasonCode ?? outcomeEvent?.payload.attempt?.classification ?? outcome ?? "failed",
          candidate: RankedReviewFailure = {
            failure: {
              dispatchId,
              code,
              reason: compactReviewFailureReason(rawReason),
              failedAt: outcomeEvent?.payload.endedAt ?? outcomeEvent?.occurredAt ?? row.event.occurredAt,
            },
            terminalRevision: outcomeEvent?.workspaceRevision ?? view.revision ?? row.event.workspaceRevision,
          };
        if (bestFailure === null || compareRankedReviewFailures(bestFailure, candidate) < 0) bestFailure = candidate;
      }
    }

    const matchingRecorded: RankedReviewFailure | null =
      target.recordedFailure?.executionId === target.execution.executionId
        ? {
            failure: {
              code: target.recordedFailure.code,
              reason: compactReviewFailureReason(target.recordedFailure.message),
              failedAt: target.recordedFailure.failedAt,
            },
            terminalRevision: -1,
          }
        : null;

    const selected =
      bestFailure === null
        ? matchingRecorded
        : matchingRecorded === null
          ? bestFailure
          : compareRankedReviewFailures(bestFailure, matchingRecorded) < 0
            ? matchingRecorded
            : bestFailure;

    results.set(key, { activeDispatches, latestFailure: selected?.failure ?? null });
  }

  return results;
}

export function readCutReviewDispatchState(
  projection: CutReviewDispatchProjection,
  target: CutReviewDispatchTarget,
): CutReviewDispatchState {
  return (
    readCutReviewDispatchStates(projection, [target]).get(
      cutReviewTargetKey(target.taskId, target.execution.executionId),
    ) ?? { activeDispatches: [], latestFailure: null }
  );
}

/** A task cut can have only one active primary reviewer, including groups in waiting_backoff. */
export function activeCutReviewDispatches(
  projection: CutReviewDispatchProjection,
  taskId: string,
  execution: ExecutionV1,
): ReturnType<TaskProjectionQueries["readRuntimeDispatchesByTaskExecution"]> {
  return readCutReviewDispatchState(projection, { taskId, execution }).activeDispatches;
}

/** Latest failed/exhausted review dispatch for a submitted cut when no active reviewer remains. */
export function latestFailedCutReviewDispatch(
  projection: CutReviewDispatchProjection,
  taskId: string,
  execution: ExecutionV1,
  recordedFailure?: TaskReviewDispatchFailureV1,
): LatestCutReviewFailure | null {
  return readCutReviewDispatchState(projection, {
    taskId,
    execution,
    ...(recordedFailure ? { recordedFailure } : {}),
  }).latestFailure;
}

/** Preserve the boundary's code and explanation; recovery advice supplements the actual failure. */
export function reviewDispatchDiagnostic(input: { readonly code: string | null; readonly message: string }) {
  const code = input.code ?? "node_auto_dispatch_failed",
    authentication = ["human_confirmation_required", "authentication_required", "oidc_device_expired"].includes(code),
    recovery = authentication
      ? " The personal access token or session is missing, expired or revoked. Sign in to the center again with ha bootstrap --operation login and sync this node before retrying."
      : code === "execution_credential_rejected"
        ? " The execution credential is expired or revoked. Sign in again with ha bootstrap --operation login and ask the owner to sync the node or renew the execution before retrying."
        : "";
  return { code, message: `${input.message}${recovery}` };
}

export function withReviewDispatchFailures<T extends Record<string, unknown>>(
  receipt: T,
  failures: readonly TaskReviewDispatchFailureV1[],
):
  | T
  | (T & {
      readonly reviewDispatchFailures: readonly TaskReviewDispatchFailureV1[];
      readonly warnings: readonly unknown[];
    }) {
  if (failures.length === 0) return receipt;
  const warnings = failures.map(reviewDispatchFailureWarning);
  return {
    ...receipt,
    reviewDispatchFailures: failures,
    warnings: [...(Array.isArray(receipt.warnings) ? receipt.warnings : []), ...warnings],
    summary: [receipt.summary, ...warnings].filter(Boolean).join("\n"),
  };
}
