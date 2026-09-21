import type { SquadState } from "./squad-coordinator.ts";
import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";
import {
  compareRuntimeActivity,
  latestRuntimeActivityAt,
  runtimeSessionSemanticState,
  type TaskProjection,
} from "@harness-anything/kernel";
import {
  isAvailableSquadRunSummary,
  type SquadRunInvalidSummaryDto,
  type SquadRunListRowDto,
  type SquadRunPhase,
  type SquadRunReadResult,
  type SquadRunSummaryDto,
} from "./squad-run-contract.ts";

export function listQuery(payload: Readonly<Record<string, unknown>>): {
  readonly since: string | null;
  readonly tokens: readonly string[];
  readonly limit: number;
} {
  const fields = Object.keys(payload),
    since = payload.since,
    query = payload.query,
    limit = payload.limit;
  if (
    fields.some((field) => !["since", "query", "limit"].includes(field)) ||
    (since !== undefined && (typeof since !== "string" || !Number.isFinite(Date.parse(since)))) ||
    (query !== undefined && typeof query !== "string") ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1_000))
  )
    throw squadReadError("invalid_request", "Squad run lists accept ISO since, text query, and limit 1..1000.");
  return {
    since: typeof since === "string" ? new Date(since).toISOString() : null,
    tokens: typeof query === "string" ? query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean) : [],
    limit: typeof limit === "number" ? limit : 200,
  };
}

export function matchesRunQuery(run: SquadRunListRowDto, tokens: readonly string[]): boolean {
  const searchable = (
    isAvailableSquadRunSummary(run)
      ? [run.squadRunId, run.squadId, run.taskId, run.mission, run.phase]
      : [run.squadRunId, run.projectionState, run.projectionError.code, run.projectionError.hint]
  )
    .join("\n")
    .toLocaleLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

export function activePhase(phase: SquadRunPhase): boolean {
  return phase === "planning" || phase === "leader_running" || phase === "workers_running";
}

/** 小队 run 版的活动窗判定。为什么比瞬值而非字符串,写在 kernel 的 compareRuntimeActivity —— 那里
 * 是这条语义的唯一实现,活动窗与排序都从它取。 */
export function runInActivityWindow(run: SquadRunSummaryDto, since: string): boolean {
  return compareRuntimeActivity(run.latestActivityAt, since) >= 0;
}

export function compareRunSummaries(left: SquadRunListRowDto, right: SquadRunListRowDto): number {
  if (!isAvailableSquadRunSummary(left))
    return isAvailableSquadRunSummary(right) ? 1 : left.squadRunId.localeCompare(right.squadRunId);
  if (!isAvailableSquadRunSummary(right)) return -1;
  const active = Number(activePhase(right.phase)) - Number(activePhase(left.phase));
  return (
    active ||
    compareRuntimeActivity(right.latestActivityAt, left.latestActivityAt) ||
    left.squadRunId.localeCompare(right.squadRunId)
  );
}

export function invalidSquadRunProjection(squadRunId: string): SquadRunInvalidSummaryDto {
  return {
    squadRunId,
    projectionState: "invalid",
    projectionError: {
      code: "squad_run_projection_invalid",
      hint: `Squad run projection ${squadRunId} is invalid.`,
    },
  };
}

export function squadReadError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function detailDto(
  state: SquadState,
  rows: readonly TaskDispatchRow[],
  phase: SquadRunPhase,
  cut: { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number },
  receiptText: (row: TaskDispatchRow | undefined) => string | null,
): SquadRunReadResult {
  const byDispatchId = new Map(rows.map((row) => [row.dispatchId, row]));
  return {
    ok: true,
    status: cut.status,
    run: {
      squadRunId: state.squadRunId,
      squadId: state.squadId,
      taskId: state.taskId,
      mission: state.mission,
      phase,
      error: state.error,
      currentLeaderRuntimeSessionId: state.currentLeaderRuntimeSessionId,
      leaderTurns: state.leaderTurns.map((turn) => {
        const row = byDispatchId.get(turn.dispatchId);
        return {
          turnId: turn.turnId,
          trigger: turn.trigger,
          dispatchId: turn.dispatchId,
          runtimeSessionId: turn.runtimeSessionId,
          decision:
            turn.decision === null
              ? null
              : turn.decision.kind === "converged"
                ? { kind: "converged" }
                : {
                    kind: "plan",
                    dispatchCount: turn.decision.kind === "waiting" ? 0 : turn.decision.dispatches.length,
                  },
          resultText: receiptText(row),
          status: row?.status ?? null,
          startedAt: row?.startedAt ?? null,
          endedAt: row?.endedAt ?? null,
          ...attemptMetrics(row),
        };
      }),
      workerAttempts: state.workerAttempts.map((attempt) => {
        const row = attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined;
        return {
          attemptId: attempt.attemptId,
          workerId: attempt.workerId,
          leaderTurnId: attempt.leaderTurnId,
          dispatchId: attempt.dispatchId,
          runtimeSessionId: attempt.runtimeSessionId,
          worktree: attempt.worktree ?? null,
          rejection: attempt.rejection,
          status: row?.status ?? null,
          startedAt: row?.startedAt ?? null,
          endedAt: row?.endedAt ?? null,
          ...attemptMetrics(row),
        };
      }),
    },
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
  };
}

export function attemptMetrics(row: TaskDispatchRow | undefined) {
  return {
    tokenUsage: {
      input: row?.metrics?.inputTokens ?? 0,
      output: row?.metrics?.outputTokens ?? 0,
    },
    toolCallCount: row?.metrics?.toolCallCount ?? 0,
    compacted: row?.metrics?.compacted ?? false,
  };
}

export function statusDto(state: SquadState, rows: readonly TaskDispatchRow[]) {
  const byDispatchId = new Map(rows.map((row) => [row.dispatchId, row]));
  return {
    squadRunId: state.squadRunId,
    squadId: state.squadId,
    taskId: state.taskId,
    mission: state.mission,
    revision: state.revision,
    currentLeaderRuntimeSessionId: state.currentLeaderRuntimeSessionId,
    leaderRuntimeSessionIds: state.leaderTurns.map((turn) => turn.runtimeSessionId),
    leaders: state.leaderTurns.map((turn) => {
      const row = byDispatchId.get(turn.dispatchId);
      return { ...row, ...turn, ...attemptMetrics(row) };
    }),
    workers: state.workerAttempts.map((attempt) => ({
      ...(attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined),
      ...attempt,
      ...attemptMetrics(attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined),
    })),
    workerCallbackCount: state.observedWorkerRuntimeSessionIds.length,
    pendingLeaderCallbackCount: state.pendingLeaderTriggers.length + state.workerWaits.length,
    error: state.error,
  };
}

export function summaryDto(
  state: SquadState,
  rows: readonly TaskDispatchRow[],
  phase: SquadRunPhase,
  projection: TaskProjection,
): SquadRunSummaryDto {
  const byDispatchId = new Map(rows.map((row) => [row.dispatchId, row])),
    sessions = [
      ...state.leaderTurns.map((turn) => turn.runtimeSessionId),
      ...state.workerAttempts.flatMap((attempt) => (attempt.runtimeSessionId ? [attempt.runtimeSessionId] : [])),
    ]
      .map((runtimeSessionId) => projection.readRuntimeSession(runtimeSessionId))
      .filter((session) => session !== null);
  return {
    squadRunId: state.squadRunId,
    squadId: state.squadId,
    taskId: state.taskId,
    mission: state.mission,
    phase,
    leaderTurnCount: state.leaderTurns.length,
    workerAttemptCount: state.workerAttempts.length,
    runningCount: sessions.filter((session) => runtimeSessionSemanticState(session) === "running").length,
    // 活动时间只从已落盘事实按瞬值取 max:run 自有派工台账行(startedAt 恒有、归档另有 endedAt)∪ 成员会话最后观测时间;epoch 仅是空集的 max 恒等元,不是读取兜底。
    latestActivityAt: latestRuntimeActivityAt([
      ...state.leaderTurns.flatMap((turn) => dispatchRowStamps(byDispatchId.get(turn.dispatchId))),
      ...state.workerAttempts.flatMap((attempt) => dispatchRowStamps(byDispatchId.get(attempt.dispatchId ?? ""))),
      ...sessions.map((session) => session.lastObservedAt),
    ]),
  };
}

/** 派工台账行的已落盘时间事实:startedAt 恒有,endedAt 仅归档结算行有;无台账行的派工不贡献时间。 */
function dispatchRowStamps(row: TaskDispatchRow | undefined): readonly string[] {
  return row === undefined ? [] : [row.startedAt, ...(row.endedAt === null ? [] : [row.endedAt])];
}
