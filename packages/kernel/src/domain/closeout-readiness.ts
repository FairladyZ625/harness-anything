export const closeoutReadinesses = [
  "not_required",
  "missing",
  "incomplete",
  "ready",
  "passed",
  "failed"
] as const;

export type CloseoutReadiness = typeof closeoutReadinesses[number];

import { approvedReviewsForCut, consentedApprovedReview } from "./review.ts";
import { isNativeExecution } from "./execution.ts";
import type { ExecutionV1, ProjectedExecution } from "./execution.ts";
import type { ReviewConsentV1, ReviewV1 } from "./review.ts";
import type { CodeDocWitnessV1 } from "./code-doc-witness.ts";
import type { CompletionGateWitnessV1 } from "./completion-gate-witness.ts";
import type { CoverageRelation } from "./decision-coverage.ts";

export type CloseoutGateStatus = "passed" | "failed" | "missing" | "unknown";
export interface CloseoutGateResult { readonly gateId: string; readonly status: CloseoutGateStatus; readonly detail?: string }
export type CloseoutBlocker = "execution" | "review" | "consent" | "gate" | "lineage" | "projection_unknown";
export interface CloseoutAssessment {
  readonly readiness: CloseoutReadiness;
  readonly executionId?: string;
  readonly blocker?: CloseoutBlocker;
  readonly gates: readonly CloseoutGateResult[];
}
export interface CloseoutProjectionAvailability {
  readonly consents: "known" | "unknown";
  readonly codeDocWitnesses: "known" | "unknown";
  readonly gateWitnesses: "known" | "unknown";
}
export interface CloseoutSnapshot {
  readonly task: { readonly status: string; readonly iteration: number; readonly completionGateIds: readonly string[]; readonly taskId?: string; readonly taskClass?: string } | null;
  readonly executions: readonly ProjectedExecution[];
  readonly reviews: readonly ReviewV1[];
  readonly consents: readonly ReviewConsentV1[];
  readonly codeDocWitnesses: readonly CodeDocWitnessV1[];
  readonly gateWitnesses: readonly CompletionGateWitnessV1[];
  readonly decisionRelations?: readonly CoverageRelation[];
}

/** The one cross-aggregate closeout judgment used by transitions and read models. */
export function closeoutReadiness(snapshot: CloseoutSnapshot, availability?: CloseoutProjectionAvailability): CloseoutAssessment {
  const task = snapshot.task;
  if (!task) return { readiness: "missing", blocker: "execution", gates: [] };
  const cuts = currentExecutionCuts(snapshot), cut = cuts.length === 1 ? cuts[0] : undefined;
  if (task.status === "done") return { readiness: "passed", ...(cut ? { executionId: cut.executionId } : {}), gates: gateResults(snapshot, availability, cut?.executionId, cut?.submission?.commitSha, cut?.iteration) };
  if (task.status !== "in_review") return { readiness: "not_required", gates: gateResults(snapshot, availability) };
  const execution = cut?.state === "submitted" ? cut : undefined;
  if (!execution?.submission) return { readiness: "missing", blocker: "execution", gates: gateResults(snapshot, availability) };
  const gates = gateResults(snapshot, availability, execution.executionId, execution.submission.commitSha, execution.iteration);
  if (availability && Object.values(availability).includes("unknown") || gates.some(({ status }) => status === "unknown")) return { readiness: "incomplete", executionId: execution.executionId, blocker: "projection_unknown", gates };
  const approved = approvedReviewsForCut(snapshot.reviews, execution.executionId, execution.submission.commitSha, execution.iteration);
  if (!approved.length) return { readiness: "incomplete", executionId: execution.executionId, blocker: "review", gates };
  if (!consentedApprovedReview(snapshot.reviews, snapshot.consents, execution.executionId, execution.submission.commitSha, execution.iteration)) return { readiness: "incomplete", executionId: execution.executionId, blocker: "consent", gates };
  const failed = gates.some(({ status }) => status === "failed"), missing = gates.some(({ status }) => status !== "passed");
  const orphan = lineageOrphan(task, snapshot.decisionRelations ?? []);
  return { readiness: failed ? "failed" : missing || orphan ? "incomplete" : "ready", executionId: execution.executionId, ...(missing ? { blocker: "gate" as const } : orphan ? { blocker: "lineage" as const } : {}), gates };
}

/** Native submitted content cuts on the Task's current iteration. Multiple results are ambiguity, never an implicit first choice. */
export function currentExecutionCuts(snapshot: CloseoutSnapshot): readonly ExecutionV1[] {
  return snapshot.executions.filter((value): value is ExecutionV1 => isNativeExecution(value) && value.iteration === snapshot.task?.iteration && value.submission !== null);
}

export function currentSubmittedExecutions(snapshot: CloseoutSnapshot): readonly ExecutionV1[] {
  return currentExecutionCuts(snapshot).filter((value) => value.state === "submitted");
}

/** dec_01KXBDV2R6DA0AA0MXTCH0E4AP CH1: a milestone or long_running task completes only with an active decision derives edge naming it. */
function lineageOrphan(task: NonNullable<CloseoutSnapshot["task"]>, relations: readonly CoverageRelation[]): boolean {
  if (task.taskId === undefined || task.taskClass !== "milestone" && task.taskClass !== "long_running") return false;
  return !relations.some(({ sourceRef, targetRef, relationType, state }) => sourceRef.startsWith("decision/") && relationType === "derives" && state === "active" && targetRef === `task/${task.taskId}`);
}

export function gateResults(snapshot: CloseoutSnapshot, availability?: CloseoutProjectionAvailability, executionId?: string, commitSha?: string, iteration?: number): readonly CloseoutGateResult[] {
  return (snapshot.task?.completionGateIds ?? []).map((gateId) => {
    const codeDoc = gateId === "code-doc-reconciliation", known = !availability || (codeDoc ? availability.codeDocWitnesses : availability.gateWitnesses) === "known";
    if (!known) return { gateId, status: "unknown", detail: "witness projection unknown" };
    if (!executionId || !commitSha || iteration === undefined) return { gateId, status: "missing", detail: "no submitted execution cut" };
    if (codeDoc) return snapshot.codeDocWitnesses.some((value) => value.executionId === executionId && value.commitSha === commitSha && value.iteration === iteration)
      ? { gateId, status: "passed" }
      : { gateId, status: "missing", detail: "current execution cut has no code/doc witness" };
    const exact = snapshot.gateWitnesses.filter((value) => value.gateId === gateId && value.executionId === executionId && value.commitSha === commitSha && value.iteration === iteration);
    return exact.some(({ result }) => result === "pass") ? { gateId, status: "passed" } : exact.length ? { gateId, status: "failed", detail: "current execution cut did not pass" } : { gateId, status: "missing", detail: "current execution cut has no gate witness" };
  });
}

export function isCloseoutReadiness(value: string): value is CloseoutReadiness {
  return (closeoutReadinesses as ReadonlyArray<string>).includes(value);
}
