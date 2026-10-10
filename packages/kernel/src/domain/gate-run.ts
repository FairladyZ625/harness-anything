import { validateActorAxes, type ActorAxes } from "./task.ts";
import { timestamp } from "./timestamp.ts";
import { isNonEmptyString, isRecord, hasOnlyFields } from "./contract-validation.ts";
import type { ArtifactDelivery, ExecutionV1 } from "./execution.ts";
import { submissionDigest } from "./execution.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import type { FrozenGateRequirement } from "./completion-contract.ts";
import { gateAppliesToSubmission } from "./completion-contract.ts";

export const gateRunStates = ["running", "completed", "cancelled"] as const;
export const gateRunVerdicts = ["pass", "fail"] as const;
export const gateRunAvailabilityStates = ["available", "unavailable"] as const;
export interface GateRun {
  readonly runId: string;
  readonly claimFence: number;
  readonly repoId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly iteration: number;
  readonly submissionDigest: string;
  readonly gateId: string;
  readonly sourceId: string;
  readonly actor: ActorAxes;
  readonly claimedAt: string;
  readonly expiresAt: string;
  readonly state: (typeof gateRunStates)[number];
  readonly settledAt: string | null;
  readonly availability: (typeof gateRunAvailabilityStates)[number] | null;
  readonly result: (typeof gateRunVerdicts)[number] | null;
  readonly diagnostic: string;
  readonly supersedesRunId: string | null;
}
export interface CompletionWitnessResult {
  readonly result: "pass" | "fail";
  readonly subjects: readonly ArtifactDelivery[];
  readonly predicateType: string;
  readonly predicate: Readonly<Record<string, unknown>>;
  readonly diagnostic: string;
}
export function validCompletionWitnessResult(value: unknown): value is CompletionWitnessResult {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ["result", "subjects", "predicateType", "predicate", "diagnostic"]) &&
    (value.result === "pass" || value.result === "fail") &&
    Array.isArray(value.subjects) &&
    value.subjects.every(
      (subject) =>
        isRecord(subject) &&
        hasOnlyFields(subject, ["path", "revision", "blobSha256"]) &&
        isNonEmptyString(subject.path) &&
        Number.isSafeInteger(subject.revision) &&
        Number(subject.revision) > 0 &&
        typeof subject.blobSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(subject.blobSha256),
    ) &&
    isNonEmptyString(value.predicateType) &&
    isRecord(value.predicate) &&
    typeof value.diagnostic === "string"
  );
}
export function currentGateRun(
  execution: Pick<ExecutionV1, "submission" | "gateRuns">,
  gateId: string,
): GateRun | undefined {
  if (!execution.submission) return undefined;
  const digest = submissionDigest(execution.submission);
  return execution.gateRuns.findLast((run) => run.gateId === gateId && run.submissionDigest === digest);
}
export function claimGateRun(input: {
  readonly execution: ExecutionV1;
  readonly repoId: string;
  readonly requirement: FrozenGateRequirement;
  readonly runId: string;
  readonly claimFence: number;
  readonly actor: ActorAxes;
  readonly occurredAt: string;
  readonly expiresAt: string;
  readonly rerun?: { readonly runId: string; readonly reason: string };
}): GateRun {
  const { execution, requirement } = input;
  if (
    execution.state !== "submitted" ||
    !execution.submission ||
    !gateAppliesToSubmission(requirement, execution.submission)
  )
    throw gateRunError("gate_run_stale", "A gate run requires a current submitted cut.");
  if (!timestamp(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.occurredAt))
    throw gateRunError("gate_run_stale", "A claim must expire after its acceptance time.");
  const previous = currentGateRun(execution, requirement.gateId);
  if (previous && (!input.rerun || input.rerun.runId !== previous.runId || !input.rerun.reason.trim()))
    throw gateRunError("gate_run_claimed", `Gate ${requirement.gateId} already has current run ${previous.runId}.`);
  if (input.rerun && !previous) throw gateRunError("gate_run_stale", "The referenced prior run is not current.");
  if (previous && input.claimFence <= previous.claimFence)
    throw gateRunError("gate_run_stale", "A new claim must advance its fence.");
  return {
    runId: input.runId,
    claimFence: input.claimFence,
    repoId: input.repoId,
    taskId: execution.taskId,
    executionId: execution.executionId,
    iteration: execution.iteration,
    submissionDigest: submissionDigest(execution.submission),
    gateId: requirement.gateId,
    sourceId: requirement.witness.adapterId,
    actor: input.actor,
    claimedAt: input.occurredAt,
    expiresAt: input.expiresAt,
    state: "running",
    settledAt: null,
    availability: null,
    result: null,
    diagnostic: input.rerun?.reason ?? "",
    supersedesRunId: previous?.runId ?? null,
  };
}
export function settleGateRun(input: {
  readonly execution: ExecutionV1;
  readonly runId: string;
  readonly claimFence: number;
  readonly actor: ActorAxes;
  readonly occurredAt: string;
  readonly outcome:
    | { readonly availability: "available"; readonly result: "pass" | "fail"; readonly diagnostic: string }
    | { readonly availability: "unavailable"; readonly result: null; readonly diagnostic: string };
}): GateRun {
  const run = input.execution.gateRuns.find((candidate) => candidate.runId === input.runId);
  if (
    !run ||
    input.execution.state !== "submitted" ||
    currentGateRun(input.execution, run.gateId)?.runId !== run.runId ||
    run.claimFence !== input.claimFence ||
    stableStringify(run.actor) !== stableStringify(input.actor)
  )
    throw gateRunError("gate_run_stale", "Only the holder of the current submission run and fence may publish.");
  if (Date.parse(input.occurredAt) >= Date.parse(run.expiresAt))
    throw gateRunError(
      "gate_run_expired",
      "The gate claim expired; an authorized explicit rerun must advance its fence.",
    );
  if (run.state !== "running") throw gateRunError("gate_run_conflict", `Run ${run.runId} is already terminal.`);
  return { ...run, ...input.outcome, state: "completed", settledAt: input.occurredAt };
}
export function gateRunError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

export function validGateRun(value: unknown): value is GateRun {
  return (
    isRecord(value) &&
    hasOnlyFields(value, [
      "runId",
      "claimFence",
      "repoId",
      "taskId",
      "executionId",
      "iteration",
      "submissionDigest",
      "gateId",
      "sourceId",
      "actor",
      "claimedAt",
      "expiresAt",
      "state",
      "settledAt",
      "availability",
      "result",
      "diagnostic",
      "supersedesRunId",
    ]) &&
    [value.runId, value.repoId, value.taskId, value.executionId, value.gateId, value.sourceId].every(
      isNonEmptyString,
    ) &&
    Number.isSafeInteger(value.claimFence) &&
    Number(value.claimFence) > 0 &&
    Number.isSafeInteger(value.iteration) &&
    Number(value.iteration) >= 0 &&
    typeof value.submissionDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.submissionDigest) &&
    validateActorAxes(value.actor).length === 0 &&
    timestamp(value.claimedAt) &&
    timestamp(value.expiresAt) &&
    Date.parse(String(value.expiresAt)) > Date.parse(String(value.claimedAt)) &&
    typeof value.diagnostic === "string" &&
    (value.supersedesRunId === null || isNonEmptyString(value.supersedesRunId)) &&
    (value.state === "running"
      ? value.settledAt === null && value.availability === null && value.result === null
      : value.state === "completed"
        ? timestamp(value.settledAt) &&
          (value.availability === "available"
            ? value.result === "pass" || value.result === "fail"
            : value.availability === "unavailable" && value.result === null)
        : value.state === "cancelled" &&
          timestamp(value.settledAt) &&
          value.availability === null &&
          value.result === null)
  );
}
export function replaceGateRun(execution: ExecutionV1, run: GateRun): ExecutionV1 {
  const exists = execution.gateRuns.some((candidate) => candidate.runId === run.runId);
  return {
    ...execution,
    gateRuns: exists
      ? execution.gateRuns.map((candidate) => (candidate.runId === run.runId ? run : candidate))
      : [...execution.gateRuns, run],
  };
}
