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

const phases: readonly SquadRunPhase[] = ["planning", "leader_running", "workers_running", "converged", "failed"];

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
