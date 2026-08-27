export type SquadRunPhase = "planning" | "leader_running" | "workers_running" | "converged" | "failed";

export interface SquadRunSummaryDto {
  readonly squadRunId: string;
  readonly squadId: string;
  readonly taskId: string;
  readonly mission: string;
  readonly phase: SquadRunPhase;
  readonly leaderTurnCount: number;
  readonly workerAttemptCount: number;
  readonly runningCount: number;
  readonly latestActivityAt: string;
}

export type SquadRunsListResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly runs: readonly SquadRunSummaryDto[];
  readonly totals: { readonly runs: number };
  readonly truncated: boolean;
  readonly watermark: number;
  readonly sourceRevision: number;
};

/** 一个 leader 轮次的触发(G12 §2c 读面):initial / leader 恢复重试 / worker 结算或派工被拒。 */
export type SquadRunTriggerDto =
  | { readonly kind: "initial" }
  | { readonly kind: "leader_retry"; readonly turnId: string; readonly reason: string }
  | { readonly kind: "worker_outcome"; readonly runtimeSessionId: string }
  | { readonly kind: "worker_rejected"; readonly attemptId: string };
/** leader 轮次已解析的决策:派工计划(含派工数)或收敛。null = 决策尚未解析。 */
export type SquadRunDecisionDto =
  | { readonly kind: "converged" }
  | { readonly kind: "plan"; readonly dispatchCount: number };
export type SquadRunTurnStatus = "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "lost";
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
}
export interface SquadRunWorkerAttemptDto {
  readonly attemptId: string;
  readonly workerId: string;
  /** 派发该 attempt 的 leader 轮次(扇出树父子边);null = 存量状态,不得猜轮次。 */
  readonly leaderTurnId: string | null;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly rejection: string | null;
  readonly status: SquadRunTurnStatus | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}
/** `ha squad status` 的 statusDto 对 GUI 开放的编排流转扇出树(leaderTurnId 是
 * 父子边,turn.resultText 是该轮 receipt 原文):全部来自 SquadState、既有派工
 * 台账行及其 resultRef 指向的内容包,零新计算。 */
export type SquadRunReadResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly run: {
    readonly squadRunId: string;
    readonly squadId: string;
    readonly taskId: string;
    readonly mission: string;
    readonly phase: SquadRunPhase;
    readonly error: string | null;
    readonly currentLeaderRuntimeSessionId: string | null;
    readonly leaderTurns: readonly SquadRunLeaderTurnDto[];
    readonly workerAttempts: readonly SquadRunWorkerAttemptDto[];
  };
  readonly watermark: number;
  readonly sourceRevision: number;
};

const phases: readonly SquadRunPhase[] = ["planning", "leader_running", "workers_running", "converged", "failed"];
const turnStatuses: readonly SquadRunTurnStatus[] = ["running", "succeeded", "failed", "unknown", "cancelled", "lost"];

export function validateSquadRunsList(value: unknown): readonly string[] {
  return squadRunRecord(value) &&
    exactSquadRunFields(value, ["ok", "status", "runs", "totals", "truncated", "watermark", "sourceRevision"]) &&
    value.ok === true &&
    squadRunReadyStatus(value.status) &&
    Array.isArray(value.runs) &&
    value.runs.every(validSquadRunSummary) &&
    squadRunRecord(value.totals) &&
    exactSquadRunFields(value.totals, ["runs"]) &&
    squadRunCount(value.totals.runs) &&
    typeof value.truncated === "boolean" &&
    squadRunCount(value.watermark) &&
    squadRunCount(value.sourceRevision) &&
    squadRunSafeKeys(value)
    ? []
    : ["squad run list is invalid"];
}

export const serializeSquadRunsList = (value: unknown): string =>
  serializeSquadRunContract(value, validateSquadRunsList);

export function validateSquadRunRead(value: unknown): readonly string[] {
  return squadRunRecord(value) &&
    exactSquadRunFields(value, ["ok", "status", "run", "watermark", "sourceRevision"]) &&
    value.ok === true &&
    squadRunReadyStatus(value.status) &&
    squadRunRecord(value.run) &&
    exactSquadRunFields(value.run, [
      "squadRunId",
      "squadId",
      "taskId",
      "mission",
      "phase",
      "error",
      "currentLeaderRuntimeSessionId",
      "leaderTurns",
      "workerAttempts",
    ]) &&
    [value.run.squadRunId, value.run.squadId, value.run.taskId, value.run.mission].every(squadRunText) &&
    phases.includes(value.run.phase as SquadRunPhase) &&
    (value.run.error === null || squadRunText(value.run.error)) &&
    (value.run.currentLeaderRuntimeSessionId === null || squadRunText(value.run.currentLeaderRuntimeSessionId)) &&
    Array.isArray(value.run.leaderTurns) &&
    value.run.leaderTurns.every(validSquadRunLeaderTurn) &&
    Array.isArray(value.run.workerAttempts) &&
    value.run.workerAttempts.every(validSquadRunWorkerAttempt) &&
    squadRunCount(value.watermark) &&
    squadRunCount(value.sourceRevision) &&
    squadRunSafeKeys(value)
    ? []
    : ["squad run read is invalid"];
}

export const serializeSquadRunRead = (value: unknown): string => serializeSquadRunContract(value, validateSquadRunRead);

function validSquadRunLeaderTurn(value: unknown): value is SquadRunLeaderTurnDto {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "turnId",
      "trigger",
      "dispatchId",
      "runtimeSessionId",
      "decision",
      "resultText",
      "status",
      "startedAt",
      "endedAt",
    ]) &&
    [value.turnId, value.dispatchId, value.runtimeSessionId].every(squadRunText) &&
    (value.resultText === null || squadRunText(value.resultText)) &&
    validSquadRunTrigger(value.trigger) &&
    (value.decision === null || validSquadRunDecision(value.decision)) &&
    (value.status === null || turnStatuses.includes(value.status as SquadRunTurnStatus)) &&
    (value.startedAt === null || squadRunIso(value.startedAt)) &&
    (value.endedAt === null || squadRunIso(value.endedAt))
  );
}

function validSquadRunWorkerAttempt(value: unknown): value is SquadRunWorkerAttemptDto {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "attemptId",
      "workerId",
      "leaderTurnId",
      "dispatchId",
      "runtimeSessionId",
      "rejection",
      "status",
      "startedAt",
      "endedAt",
    ]) &&
    [value.attemptId, value.workerId].every(squadRunText) &&
    (value.leaderTurnId === null || squadRunText(value.leaderTurnId)) &&
    (value.dispatchId === null || squadRunText(value.dispatchId)) &&
    (value.runtimeSessionId === null || squadRunText(value.runtimeSessionId)) &&
    (value.rejection === null || squadRunText(value.rejection)) &&
    (value.status === null || turnStatuses.includes(value.status as SquadRunTurnStatus)) &&
    (value.startedAt === null || squadRunIso(value.startedAt)) &&
    (value.endedAt === null || squadRunIso(value.endedAt))
  );
}

function validSquadRunTrigger(value: unknown): value is SquadRunTriggerDto {
  if (!squadRunRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "initial") return exactSquadRunFields(value, ["kind"]);
  if (value.kind === "leader_retry")
    return (
      exactSquadRunFields(value, ["kind", "turnId", "reason"]) &&
      squadRunText(value.turnId) &&
      squadRunText(value.reason)
    );
  if (value.kind === "worker_outcome")
    return exactSquadRunFields(value, ["kind", "runtimeSessionId"]) && squadRunText(value.runtimeSessionId);
  return (
    value.kind === "worker_rejected" &&
    exactSquadRunFields(value, ["kind", "attemptId"]) &&
    squadRunText(value.attemptId)
  );
}

function validSquadRunDecision(value: unknown): value is SquadRunDecisionDto {
  if (!squadRunRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "converged") return exactSquadRunFields(value, ["kind"]);
  return (
    value.kind === "plan" && exactSquadRunFields(value, ["kind", "dispatchCount"]) && squadRunCount(value.dispatchCount)
  );
}

function validSquadRunSummary(value: unknown): value is SquadRunSummaryDto {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "squadRunId",
      "squadId",
      "taskId",
      "mission",
      "phase",
      "leaderTurnCount",
      "workerAttemptCount",
      "runningCount",
      "latestActivityAt",
    ]) &&
    [value.squadRunId, value.squadId, value.taskId, value.mission].every(squadRunText) &&
    phases.includes(value.phase as SquadRunPhase) &&
    [value.leaderTurnCount, value.workerAttemptCount, value.runningCount].every(squadRunCount) &&
    squadRunIso(value.latestActivityAt)
  );
}

function squadRunRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactSquadRunFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return (
    fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => fields.includes(field))
  );
}
function squadRunText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function squadRunCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function squadRunIso(value: unknown): value is string {
  return squadRunText(value) && Number.isFinite(Date.parse(value));
}
function squadRunReadyStatus(value: unknown): boolean {
  return value === "ready" || value === "pending";
}
function squadRunSafeKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(squadRunSafeKeys);
  if (!squadRunRecord(value)) return true;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:credential|password|secret|authorization|api[-_]?key|token|transcript|stdout|stderr)/iu.test(key))
      return false;
    if (!squadRunSafeKeys(nested)) return false;
  }
  return true;
}
function serializeSquadRunContract(value: unknown, validate: (candidate: unknown) => readonly string[]): string {
  const errors = validate(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}
