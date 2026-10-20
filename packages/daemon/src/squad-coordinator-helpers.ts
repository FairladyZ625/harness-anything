import type { TaskProjection } from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";
import { readDispatchRowsByIds, readTaskDispatches } from "./dispatch-read.ts";
import { squadReadError } from "./squad-run-list.ts";
import { squadTaskRef, type SquadState } from "./squad-run-state.ts";
import { synthesisReportPath, type LeaderDecision, type WorkerAttempt } from "./squad-leader-decision.ts";

export function revise(
  state: SquadState,
  change: Partial<Omit<SquadState, "schema" | "squadRunId" | "revision">>,
): SquadState {
  return { ...state, ...change, revision: state.revision + 1 };
}

export function requiredSquadText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} is required.`);
  return value;
}

export function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function requiredReceiptText(receipt: JsonObject, field: string): string {
  if (receipt.ok !== true) throw new Error(receiptHint(receipt));
  return requiredSquadText(receipt[field], field);
}

function receiptHint(receipt: JsonObject): string {
  const error = receipt.error && typeof receipt.error === "object" ? (receipt.error as Record<string, unknown>) : null;
  return typeof error?.hint === "string" ? error.hint : "Runtime dispatch was rejected.";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
    ? String((error as { readonly code: string }).code)
    : fallback;
}

export function dispatchRows(
  state: SquadState,
  query: <T>(read: (projection: TaskProjection) => T) => T,
  rootDir: string,
): readonly TaskDispatchRow[] {
  const task = squadTaskRef(state);
  if (!task) {
    const dispatchIds = [
      ...state.leaderTurns.map((turn) => turn.dispatchId),
      ...state.workerAttempts.flatMap((attempt) => (attempt.dispatchId ? [attempt.dispatchId] : [])),
    ];
    return query((projection) => readDispatchRowsByIds({ projection, rootDir, dispatchIds }));
  }
  const childIds = state.workerAttempts.flatMap((attempt) => (attempt.taskId ? [attempt.taskId] : [])),
    result = query((projection) =>
      readTaskDispatches({
        projection,
        rootDir,
        ...(childIds.length ? { taskIds: [task.taskId, ...childIds] } : { taskId: task.taskId }),
      }),
    );
  if ("unavailableTaskIds" in result && result.unavailableTaskIds.length)
    throw squadReadError("task_not_found", `Task ${result.unavailableTaskIds[0]} has no projected package path.`);
  return result.dispatches;
}

export function workerRows(
  state: SquadState,
  rows: (state: SquadState) => readonly TaskDispatchRow[],
): readonly { readonly attempt: WorkerAttempt; readonly row: TaskDispatchRow | undefined }[] {
  const byDispatchId = new Map(rows(state).map((row) => [row.dispatchId, row]));
  return state.workerAttempts.map((attempt) => ({
    attempt,
    row: attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined,
  }));
}

export function hasRunningWorkers(
  state: SquadState,
  rows: (
    state: SquadState,
  ) => readonly { readonly attempt: WorkerAttempt; readonly row: TaskDispatchRow | undefined }[],
): boolean {
  return rows(state).some(({ attempt, row }) => attempt.rejection === null && (!row || row.outcome === null));
}

export function terminalRow(
  state: SquadState,
  runtimeSessionId: string,
  rows: (state: SquadState) => readonly TaskDispatchRow[],
): TaskDispatchRow | undefined {
  return rows(state).find((row) => row.runtimeSessionId === runtimeSessionId && row.outcome !== null);
}

export function resultText(resultRef: string | null | undefined, readResult: (ref: string) => string): string {
  if (!resultRef) throw new Error("TaskDispatchRow has no runtime result reference.");
  return readResult(resultRef);
}

export function convergenceError(
  state: SquadState,
  decision: Extract<LeaderDecision, { readonly kind: "converged" }>,
): string | null {
  const missing: string[] = [];
  const reportPath = squadTaskRef(state) ? synthesisReportPath(state) : "occurrence-owned";
  if (reportPath === null) missing.push("a roster-declared synthesis report path");
  if (decision.report !== null && decision.report.trim().length > 0)
    return missing.length ? `Leader declared convergence without ${missing.join(" and ")}.` : null;
  missing.push("a non-empty synthesis report");
  return missing.length ? `Leader declared convergence without ${missing.join(" and ")}.` : null;
}
