import type { JsonObject } from "./protocol/json-rpc-types.ts";

export type SquadRunPhase = "planning" | "leader_running" | "workers_running" | "converged" | "failed";

export interface SquadRunSummaryDto {
  readonly squadRunId: string;
  readonly squadId: string;
  readonly taskId: string;
  readonly mission: string;
  readonly phase: SquadRunPhase;
  readonly revision: number;
  readonly leaderTurnCount: number;
  readonly workerAttemptCount: number;
  readonly runningCount: number;
  readonly latestActivityAt: string;
  readonly currentLeaderRuntimeSessionId: string | null;
}

export interface SquadRunDetailDto {
  readonly squadRunId: string;
  readonly squadId: string;
  readonly taskId: string;
  readonly mission: string;
  readonly phase: SquadRunPhase;
  readonly revision: number;
  readonly currentLeaderRuntimeSessionId: string | null;
  readonly leaderRuntimeSessionIds: readonly string[];
  readonly leaders: readonly (JsonObject & {
    readonly turnId: string;
    readonly trigger: JsonObject;
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly decision: JsonObject | null;
  })[];
  readonly workers: readonly (JsonObject & {
    readonly attemptId: string;
    readonly workerId: string;
    readonly dispatchId: string | null;
    readonly runtimeSessionId: string | null;
  })[];
  readonly workerCallbackCount: number;
  readonly pendingLeaderCallbackCount: number;
  readonly error: string | null;
}

export type SquadRunsListResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly runs: readonly SquadRunSummaryDto[];
  readonly totals: { readonly runs: number };
  readonly truncated: boolean;
  readonly page: {
    readonly limit: number;
    readonly cursor: string | null;
    readonly nextCursor: string | null;
    readonly remainingCount: number;
  };
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

export function validateSquadRunsList(value: unknown): readonly string[] {
  return squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "ok",
      "status",
      "runs",
      "totals",
      "truncated",
      "page",
      "watermark",
      "sourceRevision",
    ]) &&
    value.ok === true &&
    squadRunReadyStatus(value.status) &&
    Array.isArray(value.runs) &&
    value.runs.every(validSquadRunSummary) &&
    squadRunRecord(value.totals) &&
    exactSquadRunFields(value.totals, ["runs"]) &&
    squadRunCount(value.totals.runs) &&
    typeof value.truncated === "boolean" &&
    validSquadRunPage(value.page) &&
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
      "revision",
      "leaderTurnCount",
      "workerAttemptCount",
      "runningCount",
      "latestActivityAt",
      "currentLeaderRuntimeSessionId",
    ]) &&
    [value.squadRunId, value.squadId, value.taskId, value.mission].every(squadRunText) &&
    phases.includes(value.phase as SquadRunPhase) &&
    [value.revision, value.leaderTurnCount, value.workerAttemptCount, value.runningCount].every(squadRunCount) &&
    squadRunIso(value.latestActivityAt) &&
    nullableSquadRunText(value.currentLeaderRuntimeSessionId)
  );
}

function validSquadRunDetail(value: unknown): value is SquadRunDetailDto {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "squadRunId",
      "squadId",
      "taskId",
      "mission",
      "phase",
      "revision",
      "currentLeaderRuntimeSessionId",
      "leaderRuntimeSessionIds",
      "leaders",
      "workers",
      "workerCallbackCount",
      "pendingLeaderCallbackCount",
      "error",
    ]) &&
    [value.squadRunId, value.squadId, value.taskId, value.mission].every(squadRunText) &&
    phases.includes(value.phase as SquadRunPhase) &&
    squadRunCount(value.revision) &&
    nullableSquadRunText(value.currentLeaderRuntimeSessionId) &&
    Array.isArray(value.leaderRuntimeSessionIds) &&
    value.leaderRuntimeSessionIds.every(squadRunText) &&
    Array.isArray(value.leaders) &&
    value.leaders.every(validSquadRunLeader) &&
    Array.isArray(value.workers) &&
    value.workers.every(validSquadRunWorker) &&
    squadRunCount(value.workerCallbackCount) &&
    squadRunCount(value.pendingLeaderCallbackCount) &&
    (value.error === null || typeof value.error === "string")
  );
}

function validSquadRunLeader(value: unknown): boolean {
  return (
    squadRunRecord(value) &&
    [value.turnId, value.dispatchId, value.runtimeSessionId].every(squadRunText) &&
    squadRunRecord(value.trigger) &&
    (value.decision === null || squadRunRecord(value.decision))
  );
}

function validSquadRunWorker(value: unknown): boolean {
  return (
    squadRunRecord(value) &&
    [value.attemptId, value.workerId].every(squadRunText) &&
    nullableSquadRunText(value.dispatchId) &&
    nullableSquadRunText(value.runtimeSessionId) &&
    (value.rejection === undefined || value.rejection === null || typeof value.rejection === "string")
  );
}

function validSquadRunPage(value: unknown): boolean {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, ["limit", "cursor", "nextCursor", "remainingCount"]) &&
    squadRunCount(value.limit) &&
    Number(value.limit) >= 1 &&
    Number(value.limit) <= 1_000 &&
    nullableSquadRunText(value.cursor) &&
    nullableSquadRunText(value.nextCursor) &&
    squadRunCount(value.remainingCount)
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
