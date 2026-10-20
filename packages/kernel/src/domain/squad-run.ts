import type { ActorIdentity, EventEnvelope } from "./write-chain.contract.ts";
import { hasOnlyFields, isRecord, isNonEmptyString } from "./write-chain.contract.ts";

export type SquadRunPhase = "planning" | "leader_running" | "workers_running" | "cancelled" | "converged" | "failed";
export type SquadRunTrigger =
  | { readonly kind: "initial" }
  | { readonly kind: "leader_retry"; readonly turnId: string; readonly reason: string }
  | { readonly kind: "worker_outcome"; readonly runtimeSessionId: string }
  | { readonly kind: "worker_wait"; readonly runtimeSessionId: string; readonly reason: string }
  | { readonly kind: "worker_rejected"; readonly attemptId: string };
/**
 * Who a Squad run belongs to, mirroring the single-agent spawn/spawnScheduled subject split: a
 * manual run executes under a task execution lease, a scheduled run under a Schedule occurrence
 * claim whose claimFence is its only concurrency subject. Identity only — capability comes from
 * the admission path of the branch.
 */
export type SquadRunSubjectV1 =
  | { readonly kind: "task"; readonly taskId: string; readonly executionId: string }
  | {
      readonly kind: "schedule-occurrence";
      readonly scheduleId: string;
      readonly occurrenceId: string;
      readonly claimFence: string;
    };
export interface SquadRunIdentity {
  readonly squadRunId: string;
  readonly squadId: string;
  readonly subject: SquadRunSubjectV1;
  readonly mission: string;
  readonly leaderAgentId: string;
}
export type SquadDispatchContext =
  | SquadRunIdentity
  | {
      readonly squadRunId: string;
      readonly ownerDispatchId: string;
      readonly turnId: string;
    };
export interface SquadRunObservation extends SquadRunIdentity {
  readonly ownerDispatchId: string;
  readonly runRevision: number;
  readonly phase: SquadRunPhase;
  readonly error: string | null;
  readonly currentLeaderRuntimeSessionId: string | null;
  readonly leaderTurns: readonly {
    readonly turnId: string;
    readonly trigger: SquadRunTrigger;
    readonly dispatchId: string;
    readonly runtimeSessionId: string;
    readonly decision:
      | { readonly kind: "converged" }
      | { readonly kind: "plan"; readonly dispatchCount: number }
      | null;
  }[];
  readonly workerAttempts: readonly {
    readonly attemptId: string;
    readonly workerId: string;
    readonly leaderTurnId: string;
    readonly taskId: string | null;
    readonly executionId: string | null;
    readonly dispatchId: string | null;
    readonly runtimeSessionId: string | null;
    readonly rejection: string | null;
    readonly branch: string | null;
    readonly baseSha: string | null;
  }[];
  readonly workerCallbackCount: number;
  readonly pendingLeaderCallbackCount: number;
  readonly synthesisReportPath: string | null;
}
export interface CanonicalSquadRun extends SquadRunObservation {
  readonly owner: {
    readonly source: EventEnvelope<string, string, ActorIdentity, unknown>["source"];
    readonly personId: string;
  };
  readonly acceptedRevision: number;
  readonly acceptedAt: string;
}
const identityFields = ["squadRunId", "squadId", "subject", "mission", "leaderAgentId"];
const nullableText = (value: unknown): boolean => value === null || isNonEmptyString(value);
const count = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

export function validSquadRunSubject(value: unknown): value is SquadRunSubjectV1 {
  if (!isRecord(value)) return false;
  if (value.kind === "task")
    return (
      hasOnlyFields(value, ["kind", "taskId", "executionId"]) &&
      [value.taskId, value.executionId].every(isNonEmptyString)
    );
  return (
    value.kind === "schedule-occurrence" &&
    hasOnlyFields(value, ["kind", "scheduleId", "occurrenceId", "claimFence"]) &&
    [value.scheduleId, value.occurrenceId, value.claimFence].every(isNonEmptyString)
  );
}

export function validSquadDispatchContext(value: unknown): value is SquadDispatchContext {
  return (
    isRecord(value) &&
    ("ownerDispatchId" in value
      ? hasOnlyFields(value, ["squadRunId", "ownerDispatchId", "turnId"]) &&
        [value.squadRunId, value.ownerDispatchId, value.turnId].every(isNonEmptyString)
      : hasOnlyFields(value, identityFields) &&
        ["squadRunId", "squadId", "mission", "leaderAgentId"].every((field) => isNonEmptyString(value[field])) &&
        validSquadRunSubject(value.subject)) &&
    /^squad_[a-f0-9]{24}$/u.test(String(value.squadRunId))
  );
}
export function validSquadRunObservation(value: unknown): value is SquadRunObservation {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      ...identityFields,
      "ownerDispatchId",
      "runRevision",
      "phase",
      "error",
      "currentLeaderRuntimeSessionId",
      "leaderTurns",
      "workerAttempts",
      "workerCallbackCount",
      "pendingLeaderCallbackCount",
      "synthesisReportPath",
    ])
  )
    return false;
  return (
    ["squadRunId", "squadId", "mission", "leaderAgentId"].every((field) => isNonEmptyString(value[field])) &&
    validSquadRunSubject(value.subject) &&
    /^squad_[a-f0-9]{24}$/u.test(String(value.squadRunId)) &&
    isNonEmptyString(value.ownerDispatchId) &&
    count(value.runRevision) &&
    ["planning", "leader_running", "workers_running", "cancelled", "converged", "failed"].includes(
      String(value.phase),
    ) &&
    nullableText(value.error) &&
    nullableText(value.currentLeaderRuntimeSessionId) &&
    count(value.workerCallbackCount) &&
    count(value.pendingLeaderCallbackCount) &&
    (value.synthesisReportPath === null ||
      (typeof value.synthesisReportPath === "string" &&
        /^artifacts\/reports\/[A-Za-z0-9._-]+\.md$/u.test(value.synthesisReportPath) &&
        value.synthesisReportPath.includes(String(value.squadRunId)))) &&
    Array.isArray(value.leaderTurns) &&
    value.leaderTurns.every(
      (turn) =>
        isRecord(turn) &&
        hasOnlyFields(turn, ["turnId", "trigger", "dispatchId", "runtimeSessionId", "decision"]) &&
        [turn.turnId, turn.dispatchId, turn.runtimeSessionId].every(isNonEmptyString) &&
        validTrigger(turn.trigger) &&
        (turn.decision === null ||
          (isRecord(turn.decision) &&
            (turn.decision.kind === "converged"
              ? hasOnlyFields(turn.decision, ["kind"])
              : turn.decision.kind === "plan" &&
                hasOnlyFields(turn.decision, ["kind", "dispatchCount"]) &&
                count(turn.decision.dispatchCount)))),
    ) &&
    Array.isArray(value.workerAttempts) &&
    value.workerAttempts.every(
      (attempt) =>
        isRecord(attempt) &&
        hasOnlyFields(attempt, [
          "attemptId",
          "workerId",
          "leaderTurnId",
          "taskId",
          "executionId",
          "dispatchId",
          "runtimeSessionId",
          "rejection",
          "branch",
          "baseSha",
        ]) &&
        [attempt.attemptId, attempt.workerId, attempt.leaderTurnId].every(isNonEmptyString) &&
        [
          attempt.taskId,
          attempt.executionId,
          attempt.dispatchId,
          attempt.runtimeSessionId,
          attempt.rejection,
          attempt.branch,
          attempt.baseSha,
        ].every(nullableText),
    )
  );
}
function validTrigger(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "initial":
      return hasOnlyFields(value, ["kind"]);
    case "leader_retry":
      return hasOnlyFields(value, ["kind", "turnId", "reason"]) && [value.turnId, value.reason].every(isNonEmptyString);
    case "worker_outcome":
      return hasOnlyFields(value, ["kind", "runtimeSessionId"]) && isNonEmptyString(value.runtimeSessionId);
    case "worker_wait":
      return (
        hasOnlyFields(value, ["kind", "runtimeSessionId", "reason"]) &&
        [value.runtimeSessionId, value.reason].every(isNonEmptyString)
      );
    case "worker_rejected":
      return hasOnlyFields(value, ["kind", "attemptId"]) && isNonEmptyString(value.attemptId);
    default:
      return false;
  }
}
