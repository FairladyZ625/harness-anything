import { validSquadRunSubject } from "@harness-anything/kernel/browser";
import type {
  SquadRunDecisionDto,
  SquadRunInvalidSummaryDto,
  SquadRunLeaderTurnDto,
  SquadRunListRowDto,
  SquadRunPhase,
  SquadRunTriggerDto,
  SquadRunTurnStatus,
  SquadRunWorkerAttemptDto,
} from "@harness-anything/application/internal/queries/squad-run-types.ts";

export {
  isAvailableSquadRunDetail,
  isAvailableSquadRunSummary,
  type SquadRunAttemptMetricsDto,
  type SquadRunDecisionDto,
  type SquadRunDetailDto,
  type SquadRunInvalidSummaryDto,
  type SquadRunLeaderTurnDto,
  type SquadRunListRowDto,
  type SquadRunPhase,
  type SquadRunReadResult,
  type SquadRunsListResult,
  type SquadRunSubjectV1,
  type SquadRunSummaryDto,
  type SquadRunTriggerDto,
  type SquadRunTurnStatus,
  type SquadRunWorkerAttemptDto,
} from "@harness-anything/application/internal/queries/squad-run-types.ts";

const phases: readonly SquadRunPhase[] = [
  "planning",
  "leader_running",
  "workers_running",
  "cancelled",
  "converged",
  "failed",
];
const turnStatuses: readonly SquadRunTurnStatus[] = [
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
  "stopped",
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

export const serializeSquadRunsList = (value: unknown): string =>
  serializeSquadRunContract(value, validateSquadRunsList);

export function validateSquadRunRead(value: unknown): readonly string[] {
  if (
    squadRunRecord(value) &&
    exactSquadRunFields(value, ["ok", "status", "run", "watermark", "sourceRevision"]) &&
    value.ok === true &&
    squadRunReadyStatus(value.status) &&
    validInvalidSquadRunProjection(value.run) &&
    squadRunCount(value.watermark) &&
    squadRunCount(value.sourceRevision) &&
    squadRunSafeKeys(value)
  )
    return [];
  return squadRunRecord(value) &&
    exactSquadRunFields(value, ["ok", "status", "run", "watermark", "sourceRevision"]) &&
    value.ok === true &&
    squadRunReadyStatus(value.status) &&
    squadRunRecord(value.run) &&
    exactSquadRunFields(value.run, [
      ...observationIdentityFields,
      "squadRunId",
      "squadId",
      "subject",
      "mission",
      "phase",
      "error",
      "currentLeaderRuntimeSessionId",
      "leaderTurns",
      "workerAttempts",
    ]) &&
    [value.run.squadRunId, value.run.squadId, value.run.mission].every(squadRunText) &&
    validSquadRunSubject(value.run.subject) &&
    validObservationIdentity(value.run) &&
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
      "tokenUsage",
      "toolCallCount",
      "compacted",
    ]) &&
    [value.turnId, value.dispatchId, value.runtimeSessionId].every(squadRunText) &&
    (value.resultText === null || squadRunText(value.resultText)) &&
    validSquadRunTrigger(value.trigger) &&
    (value.decision === null || validSquadRunDecision(value.decision)) &&
    (value.status === null || turnStatuses.includes(value.status as SquadRunTurnStatus)) &&
    (value.startedAt === null || squadRunIso(value.startedAt)) &&
    (value.endedAt === null || squadRunIso(value.endedAt)) &&
    validSquadRunAttemptMetrics(value)
  );
}

function validSquadRunWorkerAttempt(value: unknown): value is SquadRunWorkerAttemptDto {
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      "taskId",
      "executionId",
      "worktree",
      "attemptId",
      "workerId",
      "leaderTurnId",
      "dispatchId",
      "runtimeSessionId",
      "rejection",
      "status",
      "startedAt",
      "endedAt",
      "tokenUsage",
      "toolCallCount",
      "compacted",
    ]) &&
    [value.attemptId, value.workerId].every(squadRunText) &&
    squadRunText(value.leaderTurnId) &&
    (value.dispatchId === null || squadRunText(value.dispatchId)) &&
    (value.runtimeSessionId === null || squadRunText(value.runtimeSessionId)) &&
    (value.taskId === null || squadRunText(value.taskId)) &&
    (value.executionId === null || squadRunText(value.executionId)) &&
    (value.worktree === null ||
      (squadRunRecord(value.worktree) &&
        exactSquadRunFields(value.worktree, ["branch", "baseSha"]) &&
        [value.worktree.branch, value.worktree.baseSha].every(squadRunText))) &&
    (value.rejection === null || squadRunText(value.rejection)) &&
    (value.status === null || turnStatuses.includes(value.status as SquadRunTurnStatus)) &&
    (value.startedAt === null || squadRunIso(value.startedAt)) &&
    (value.endedAt === null || squadRunIso(value.endedAt)) &&
    validSquadRunAttemptMetrics(value)
  );
}

function validSquadRunAttemptMetrics(value: Readonly<Record<string, unknown>>): boolean {
  return (
    squadRunRecord(value.tokenUsage) &&
    exactSquadRunFields(value.tokenUsage, ["input", "output"]) &&
    (value.tokenUsage.input === null || squadRunCount(value.tokenUsage.input)) &&
    (value.tokenUsage.output === null || squadRunCount(value.tokenUsage.output)) &&
    (value.toolCallCount === null || squadRunCount(value.toolCallCount)) &&
    (value.compacted === null || typeof value.compacted === "boolean")
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
  if (value.kind === "worker_wait")
    return (
      exactSquadRunFields(value, ["kind", "runtimeSessionId", "reason"]) &&
      squadRunText(value.runtimeSessionId) &&
      squadRunText(value.reason)
    );
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

function validSquadRunSummary(value: unknown): value is SquadRunListRowDto {
  if (validInvalidSquadRunProjection(value)) return true;
  return (
    squadRunRecord(value) &&
    exactSquadRunFields(value, [
      ...observationIdentityFields,
      "squadRunId",
      "squadId",
      "subject",
      "mission",
      "phase",
      "leaderTurnCount",
      "workerAttemptCount",
      "runningCount",
      "latestActivityAt",
    ]) &&
    [value.squadRunId, value.squadId, value.mission].every(squadRunText) &&
    validSquadRunSubject(value.subject) &&
    validObservationIdentity(value) &&
    phases.includes(value.phase as SquadRunPhase) &&
    [value.leaderTurnCount, value.workerAttemptCount, value.runningCount].every(squadRunCount) &&
    squadRunIso(value.latestActivityAt)
  );
}

function validInvalidSquadRunProjection(value: unknown): value is SquadRunInvalidSummaryDto {
  return (
    squadRunRecord(value) &&
    value.projectionState === "invalid" &&
    exactSquadRunFields(value, ["squadRunId", "projectionState", "projectionError"]) &&
    squadRunText(value.squadRunId) &&
    squadRunRecord(value.projectionError) &&
    exactSquadRunFields(value.projectionError, ["code", "hint"]) &&
    value.projectionError.code === "squad_run_projection_invalid" &&
    squadRunText(value.projectionError.hint)
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
// A token-named key carries a credential only when its value is a string — the same value-type
// line as the dispatch-stream scrubber (dispatch-stream.ts), because this contract is the one
// reject-side surface where LLM usage telemetry legitimately crosses (tokenUsage counters). The
// old tokenUsage key exemption was weaker: it waved any value, strings included, through under
// that one name; counting keys with non-string values now pass on their type instead.
const squadRunForbiddenKey = /(?:credential|password|secret|authorization|api[-_]?key|transcript|stdout|stderr)/iu,
  squadRunTokenKey = /token/iu;
function squadRunSafeKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(squadRunSafeKeys);
  if (!squadRunRecord(value)) return true;
  for (const [key, nested] of Object.entries(value)) {
    if (squadRunForbiddenKey.test(key) || (squadRunTokenKey.test(key) && typeof nested === "string")) return false;
    if (!squadRunSafeKeys(nested)) return false;
  }
  return true;
}
function serializeSquadRunContract(value: unknown, validate: (candidate: unknown) => readonly string[]): string {
  const errors = validate(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
}

const observationIdentityFields = [
  "executionId",
  "iteration",
  "currentIteration",
  "runRevision",
  "acceptedRevision",
  "acceptedAt",
  "owner",
];
function validObservationIdentity(value: Record<string, unknown>): boolean {
  const owner = value.owner;
  return (
    (value.executionId === null || squadRunText(value.executionId)) &&
    [value.iteration, value.currentIteration].every((v) => v === null || squadRunCount(v)) &&
    squadRunCount(value.runRevision) &&
    squadRunCount(value.acceptedRevision) &&
    squadRunIso(value.acceptedAt) &&
    squadRunRecord(owner) &&
    exactSquadRunFields(owner, ["source", "personId"]) &&
    squadRunText(owner.personId) &&
    (owner.source === "local" ||
      (squadRunRecord(owner.source) &&
        exactSquadRunFields(owner.source, ["kind", "nodeId"]) &&
        owner.source.kind === "node" &&
        squadRunText(owner.source.nodeId)))
  );
}
