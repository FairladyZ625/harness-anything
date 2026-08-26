export type SquadRunPhase = "planning" | "leader_running" | "workers_running" | "converged" | "failed";
type SquadRunMemberStatus = "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "lost";

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

export interface SquadRunLeaderDto {
  readonly turnId: string;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly agentName: string | null;
  readonly instanceId: string | null;
  readonly status: SquadRunMemberStatus;
  readonly startedAt: string | null;
}

export interface SquadRunWorkerDto {
  readonly attemptId: string;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly agentName: string | null;
  readonly instanceId: string | null;
  readonly status: SquadRunMemberStatus;
  readonly startedAt: string | null;
  readonly rejection: string | null;
}

export interface SquadRunDetailDto {
  readonly leaders: readonly SquadRunLeaderDto[];
  readonly workers: readonly SquadRunWorkerDto[];
  readonly error: string | null;
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

export type SquadRunReadResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly run: SquadRunDetailDto;
  readonly watermark: number;
  readonly sourceRevision: number;
};

const phases: readonly SquadRunPhase[] = ["planning", "leader_running", "workers_running", "converged", "failed"];
const memberStatuses: readonly SquadRunMemberStatus[] = [
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
  "lost",
];

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

export function validateSquadRunRead(value: unknown): readonly string[] {
  return squadRunRecord(value) &&
    exactSquadRunFields(value, ["ok", "status", "run", "watermark", "sourceRevision"]) &&
    value.ok === true &&
    squadRunReadyStatus(value.status) &&
    validSquadRunDetail(value.run) &&
    squadRunCount(value.watermark) &&
    squadRunCount(value.sourceRevision) &&
    squadRunSafeKeys(value)
    ? []
    : ["squad run read is invalid"];
}

export const serializeSquadRunsList = (value: unknown): string =>
    serializeSquadRunContract(value, validateSquadRunsList),
  serializeSquadRunRead = (value: unknown): string => serializeSquadRunContract(value, validateSquadRunRead);

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

function validSquadRunDetail(value: unknown): value is SquadRunDetailDto {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, ["leaders", "workers", "error"]) &&
    Array.isArray(value.leaders) &&
    value.leaders.every(validSquadRunLeader) &&
    Array.isArray(value.workers) &&
    value.workers.every(validSquadRunWorker) &&
    (value.error === null || typeof value.error === "string")
  );
}

function validSquadRunLeader(value: unknown): boolean {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "turnId",
      "dispatchId",
      "runtimeSessionId",
      "agentName",
      "instanceId",
      "status",
      "startedAt",
    ]) &&
    [value.turnId, value.dispatchId, value.runtimeSessionId].every(squadRunText) &&
    nullableSquadRunText(value.agentName) &&
    nullableSquadRunText(value.instanceId) &&
    memberStatuses.includes(value.status as SquadRunMemberStatus) &&
    nullableSquadRunIso(value.startedAt)
  );
}

function validSquadRunWorker(value: unknown): boolean {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "attemptId",
      "dispatchId",
      "runtimeSessionId",
      "agentName",
      "instanceId",
      "status",
      "startedAt",
      "rejection",
    ]) &&
    squadRunText(value.attemptId) &&
    nullableSquadRunText(value.dispatchId) &&
    nullableSquadRunText(value.runtimeSessionId) &&
    nullableSquadRunText(value.agentName) &&
    nullableSquadRunText(value.instanceId) &&
    memberStatuses.includes(value.status as SquadRunMemberStatus) &&
    nullableSquadRunIso(value.startedAt) &&
    nullableSquadRunText(value.rejection)
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
function nullableSquadRunText(value: unknown): value is string | null {
  return value === null || squadRunText(value);
}
function squadRunCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function squadRunIso(value: unknown): value is string {
  return squadRunText(value) && Number.isFinite(Date.parse(value));
}
function nullableSquadRunIso(value: unknown): value is string | null {
  return value === null || squadRunIso(value);
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
