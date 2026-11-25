import type { CanonicalSquadRun, SquadRunPhase, SquadRunSubjectV1 } from "@harness-anything/kernel";
import type { DispatchLifecycleSummary } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";

export type { SquadRunPhase, SquadRunSubjectV1 } from "@harness-anything/kernel";

export interface SquadRunObservationIdentity {
  /** The task execution the run rides; null on schedule-occurrence runs. */
  readonly executionId: string | null;
  readonly iteration: number | null;
  readonly currentIteration: number | null;
  readonly runRevision: number;
  readonly acceptedRevision: number;
  readonly acceptedAt: string;
  readonly owner: CanonicalSquadRun["owner"];
}

export interface SquadRunSummaryDto extends SquadRunObservationIdentity {
  readonly squadRunId: string;
  readonly squadId: string;
  readonly subject: SquadRunSubjectV1;
  readonly mission: string;
  readonly phase: SquadRunPhase;
  readonly leaderTurnCount: number;
  readonly workerAttemptCount: number;
  readonly runningCount: number;
  readonly latestActivityAt: string;
}

export interface SquadRunInvalidSummaryDto {
  readonly squadRunId: string;
  readonly projectionState: "invalid";
  readonly projectionError: { readonly code: "squad_run_projection_invalid"; readonly hint: string };
}

export type SquadRunListRowDto = SquadRunSummaryDto | SquadRunInvalidSummaryDto;

export function isAvailableSquadRunSummary(row: SquadRunListRowDto): row is SquadRunSummaryDto {
  return !("projectionState" in row);
}

export type SquadRunsListResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly runs: readonly SquadRunListRowDto[];
  readonly totals: { readonly runs: number };
  readonly truncated: boolean;
  readonly watermark: number;
  readonly sourceRevision: number;
};

/** 一个 leader 轮次的触发(G12 §2c 读面):initial / leader 恢复重试 / worker 结算、等待或派工被拒。 */
export type SquadRunTriggerDto =
  | { readonly kind: "initial" }
  | { readonly kind: "leader_retry"; readonly turnId: string; readonly reason: string }
  | { readonly kind: "worker_outcome"; readonly runtimeSessionId: string }
  | { readonly kind: "worker_wait"; readonly runtimeSessionId: string; readonly reason: string }
  | { readonly kind: "worker_rejected"; readonly attemptId: string };

/** leader 轮次已解析的决策:派工计划(含派工数)或收敛。null = 决策尚未解析。 */
export type SquadRunDecisionDto =
  | { readonly kind: "converged" }
  | { readonly kind: "plan"; readonly dispatchCount: number };

export type SquadRunTurnStatus = Exclude<DispatchLifecycleSummary["displayStatus"], "blocked">;

export interface SquadRunAttemptMetricsDto {
  readonly tokenUsage: { readonly input: number | null; readonly output: number | null };
  readonly toolCallCount: number | null;
  readonly compacted: boolean | null;
}

export interface SquadRunLeaderTurnDto {
  readonly turnId: string;
  readonly trigger: SquadRunTriggerDto;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly decision: SquadRunDecisionDto | null;
  /** 该轮 receipt 原文(台账行 resultRef 指向的 runtime-result);null = 未结算或缺失。 */
  readonly resultText: string | null;
  readonly status: SquadRunTurnStatus | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly tokenUsage: SquadRunAttemptMetricsDto["tokenUsage"];
  readonly toolCallCount: number | null;
  readonly compacted: boolean | null;
}

export interface SquadRunWorkerAttemptDto {
  readonly attemptId: string;
  readonly workerId: string;
  /** 派发该 attempt 的 leader 轮次(扇出树父子边)。 */
  readonly leaderTurnId: string;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly worktree: {
    readonly branch: string;
    readonly baseSha: string;
  } | null;
  readonly rejection: string | null;
  readonly status: SquadRunTurnStatus | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly tokenUsage: SquadRunAttemptMetricsDto["tokenUsage"];
  readonly toolCallCount: number | null;
  readonly compacted: boolean | null;
}

export interface SquadRunDetailDto extends SquadRunObservationIdentity {
  readonly squadRunId: string;
  readonly squadId: string;
  readonly subject: SquadRunSubjectV1;
  readonly mission: string;
  readonly phase: SquadRunPhase;
  readonly error: string | null;
  readonly currentLeaderRuntimeSessionId: string | null;
  readonly leaderTurns: readonly SquadRunLeaderTurnDto[];
  readonly workerAttempts: readonly SquadRunWorkerAttemptDto[];
}

export function isAvailableSquadRunDetail(
  run: SquadRunDetailDto | SquadRunInvalidSummaryDto,
): run is SquadRunDetailDto {
  return !("projectionState" in run);
}

export type SquadRunReadResult = {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly run: SquadRunDetailDto | SquadRunInvalidSummaryDto;
  readonly watermark: number;
  readonly sourceRevision: number;
};
