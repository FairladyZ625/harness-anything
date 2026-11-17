import {
  buildHandoffPacket,
  sha256Text,
  stableStringify,
  type HandoffPacketV1,
  type PriorTerminalDispositionKind,
  type TaskProjection,
} from "@harness-anything/kernel";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";
import { readDispatchRowsByIds, readTaskDispatches } from "./dispatch-read.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";
import { squadTaskRef, type SquadState } from "./squad-run-state.ts";
import {
  synthesisReportPath,
  type LeaderDecision,
  type WorkerAttempt,
  type WorkerPlan,
} from "./squad-leader-decision.ts";

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
  // Discovery needs the complete task histories; taskIds is a bounded public page.
  const taskIds = new Set([task.taskId, ...state.workerAttempts.flatMap((attempt) => attempt.taskId ?? [])]);
  return query((projection) =>
    [...taskIds].flatMap((taskId) => readTaskDispatches({ projection, rootDir, taskId }).dispatches),
  );
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

/**
 * Why a still-active run whose own subject lapsed can never advance again: no leader turn or worker
 * can be admitted, so the last running phase must not stay published once nothing is in flight. This
 * derives only from the leader-turn and dispatch facts already read for the run — a live dispatch
 * keeps the current phase true, and the first terminal fact after the subject is gone is the end.
 */
export function abandonedSquadRunError(
  state: SquadState,
  rows: readonly TaskDispatchRow[],
  runningWorkers: boolean,
): string | null {
  const currentLeaderRuntimeSessionId = state.currentLeaderRuntimeSessionId;
  if (currentLeaderRuntimeSessionId !== null) {
    const leader = rows.find((row) => row.runtimeSessionId === currentLeaderRuntimeSessionId);
    if (leader === undefined || leader.outcome === null) return null;
  } else if (runningWorkers) return null;
  const task = squadTaskRef(state),
    lastTurn = state.leaderTurns.at(-1),
    lastRow =
      lastTurn === undefined ? undefined : rows.find((row) => row.runtimeSessionId === lastTurn.runtimeSessionId),
    ended =
      lastTurn === undefined
        ? "its initial leader turn never started"
        : `leader turn ${lastTurn.turnId} ended ${lastRow?.outcome ?? lastRow?.status ?? "without a dispatch row"}`,
    ruling =
      lastRow?.classification === "awaiting_ruling" && lastRow.ruling
        ? ` while waiting for an owner ruling; answer it with ha task escalation resolve ${task?.taskId ?? "<task-id>"} ` +
          `--dispatch-id ${lastRow.dispatchId} --answer "<answer>"`
        : "";
  if (task === null)
    return (
      `Squad run ${state.squadRunId} can no longer resume: its schedule occurrence claim is no longer current, ` +
      `and ${ended}${ruling}. The Schedule admits the next occurrence as a new run.`
    );
  return (
    `Squad run ${state.squadRunId} can no longer resume: task ${task.taskId} execution ${task.executionId} is no ` +
    `longer current, and ${ended}${ruling}. Resume with ha task start ${task.taskId}, then ` +
    `ha squad run ${state.squadId} --instance ${state.runtimeInstanceId ?? "<runtime-instance-id>"} --task ${task.taskId}.`
  );
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

export function squadAttemptTerminalKind(row: TaskDispatchRow | undefined): PriorTerminalDispositionKind {
  if (!row) return "none";
  if (row.outcome === "cancelled") return "cancelled";
  if (row.providerUnreachable) return "unreachable";
  if (row.classification === "dispatch_stalled") return "stalled";
  if (row.classification === "awaiting_ruling") return "awaiting_ruling";
  if (row.outcome === "succeeded") return "succeeded";
  if (row.outcome === "failed") return "failed";
  return "none";
}

export function squadRuntimeSupportsResume(kindId: string | null, hasProviderSession: boolean): boolean {
  if (!kindId) return hasProviderSession;
  const declaration = runtimeKindForId(kindId);
  return declaration.capabilities.resume === "supported" || declaration.declaredCapabilities.includes("resume");
}

export function buildSquadWorkerHandoffPrompt(input: {
  readonly state: SquadState;
  readonly plan: WorkerPlan;
  readonly attemptId: string;
  readonly priorAttempt: WorkerAttempt | null;
  readonly priorRow: TaskDispatchRow | undefined;
  readonly nowIso: string;
  readonly readResult: (ref: string) => string;
}): { readonly packet: HandoffPacketV1; readonly digest: string; readonly promptSection: string } | null {
  if (input.plan.handoffPacket) {
    const packet = input.plan.handoffPacket,
      digest = sha256Text(stableStringify(packet));
    return {
      packet,
      digest,
      promptSection: `# HandoffPacketV1 (sha256=${digest})\n${JSON.stringify(packet, null, 2)}`,
    };
  }
  if (!input.priorAttempt) return null;
  const taskContext = input.priorRow?.resultRef ? input.readResult(input.priorRow.resultRef).slice(0, 4000) : null;
  const nowMs = Date.parse(input.nowIso),
    expiresAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + 86_400_000).toISOString(),
    taskId = input.priorAttempt.taskId ?? squadTaskRef(input.state)?.taskId ?? input.state.squadRunId,
    built = buildHandoffPacket({
      handoffId: `${input.state.squadRunId}:${input.attemptId}`,
      revision: 1,
      mode: "transfer",
      expiresAt,
      work: {
        id: taskId,
        title: `Squad assignment for ${input.plan.workerId}`,
        description: input.plan.prompt.slice(0, 500),
        specRevision: 1,
        specDigest: `sha256:${sha256Text(input.plan.prompt)}`,
      },
      attempt: {
        id: input.priorAttempt.runtimeSessionId ?? input.priorAttempt.attemptId,
        status: input.priorRow?.outcome ?? "stopped",
        sessionId: input.priorAttempt.runtimeSessionId,
        runtime: input.priorRow?.provider.instance ?? null,
        artifactId: input.priorRow?.resultRef ?? null,
        artifactDigest: input.priorRow?.resultRef?.split("/sha256/")[1] ?? null,
        error: input.priorRow?.reason ?? null,
      },
      sourceEmployeeId: input.priorAttempt.workerId,
      sideEffects: "Squad handoff cold-start; prior providerSessionId is excluded.",
      target: { employeeId: input.plan.workerId, name: input.plan.workerId },
      taskContext,
    });
  return {
    packet: built.packet,
    digest: built.digest,
    promptSection: `# HandoffPacketV1 (sha256=${built.digest})\n${built.text}`,
  };
}
