export const closeoutReadinesses = ["not_required", "missing", "incomplete", "ready", "passed", "failed"] as const;

export type CloseoutReadiness = (typeof closeoutReadinesses)[number];

import { approvedReviewsForExecution, consentedApprovedReviewForExecution } from "./review.ts";
import { isNativeExecution } from "./execution.ts";
import type { ExecutionV1, ProjectedExecution, SubmissionV1 } from "./execution.ts";
import type { ReviewConsentV1, ReviewV1 } from "./review.ts";
import { currentCodeDocWitness } from "./code-doc-witness.ts";
import type { CodeDocWitnessRecord } from "./code-doc-witness.ts";
import { isPreservedVerdictWitness } from "./completion-gate-witness.ts";
import type { CompletionGateWitnessV1 } from "./completion-gate-witness.ts";
import { CODE_DOC_GATE_ID, gateAppliesToSubmission } from "./completion-contract.ts";
import type { CoverageRelation } from "./decision-coverage.ts";
import { judgeCompletionEvidence } from "./completion-evidence.ts";
import type { CloseoutGate } from "./settings-closeout.ts";

export type CloseoutGateStatus = "passed" | "failed" | "missing" | "unknown" | "not_applicable";
export interface CloseoutGateResult {
  readonly gateId: string;
  readonly status: CloseoutGateStatus;
  readonly ok: boolean | null;
  readonly detail?: string;
}
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
  readonly task: {
    readonly status: string;
    readonly iteration: number;
    readonly completionGateIds: readonly string[];
    readonly taskId?: string;
    readonly taskClass?: string;
  } | null;
  readonly executions: readonly ProjectedExecution[];
  readonly reviews: readonly ReviewV1[];
  readonly consents: readonly ReviewConsentV1[];
  readonly codeDocWitnesses: readonly CodeDocWitnessRecord[];
  readonly gateWitnesses: readonly CompletionGateWitnessV1[];
  readonly decisionRelations?: readonly CoverageRelation[];
}

/** The one cross-aggregate closeout judgment used by transitions and read models. */
export function closeoutReadiness(
  snapshot: CloseoutSnapshot,
  availability?: CloseoutProjectionAvailability,
  effectiveGates?: Readonly<Record<CloseoutGate, boolean>>,
): CloseoutAssessment {
  const task = snapshot.task;
  if (!task) return { readiness: "missing", blocker: "execution", gates: [] };
  const cuts = currentExecutionCuts(snapshot),
    cut = cuts.length === 1 ? cuts[0] : undefined;
  if (task.status === "done") {
    if (!cut)
      return {
        readiness: "incomplete",
        blocker: "execution",
        gates: gateResults(snapshot, availability),
      };
    const gates = gateResults(snapshot, availability, cut?.executionId, cut?.submission, cut?.iteration),
      missing = gates.some(({ status }) => status !== "passed" && status !== "not_applicable");
    return {
      readiness: missing ? "incomplete" : "passed",
      ...(cut ? { executionId: cut.executionId } : {}),
      ...(missing ? { blocker: "gate" as const } : {}),
      gates,
    };
  }
  if (task.status !== "in_review") return { readiness: "not_required", gates: gateResults(snapshot, availability) };
  const execution = cut?.state === "submitted" ? cut : undefined;
  if (!execution?.submission)
    return { readiness: "missing", blocker: "execution", gates: gateResults(snapshot, availability) };
  const gates = gateResults(snapshot, availability, execution.executionId, execution.submission, execution.iteration);
  if (
    (availability && Object.values(availability).includes("unknown")) ||
    gates.some(({ status }) => status === "unknown")
  )
    return { readiness: "incomplete", executionId: execution.executionId, blocker: "projection_unknown", gates };
  const approved = approvedReviewsForExecution(snapshot.reviews, execution),
    consented = consentedApprovedReviewForExecution(snapshot.reviews, snapshot.consents, execution);
  // An amended cut needs a fresh approval, unless the owner explicitly consented to a review for this cut.
  if (effectiveGates?.review !== false && !approved.length && !consented)
    return { readiness: "incomplete", executionId: execution.executionId, blocker: "review", gates };
  if (effectiveGates?.consent !== false && !consented)
    return { readiness: "incomplete", executionId: execution.executionId, blocker: "consent", gates };
  const failed = gates.some(({ status }) => status === "failed"),
    missing = gates.some(({ status }) => status !== "passed" && status !== "not_applicable");
  const orphan = lineageOrphan(task, snapshot.decisionRelations ?? []);
  return {
    readiness: failed ? "failed" : missing || orphan ? "incomplete" : "ready",
    executionId: execution.executionId,
    ...(missing ? { blocker: "gate" as const } : orphan ? { blocker: "lineage" as const } : {}),
    gates,
  };
}

/** Native submitted content cuts on the Task's current iteration. Multiple results are ambiguity, never an implicit first choice. */
export function currentExecutionCuts(snapshot: CloseoutSnapshot): readonly ExecutionV1[] {
  return snapshot.executions.filter(
    (value): value is ExecutionV1 =>
      isNativeExecution(value) && value.iteration === snapshot.task?.iteration && value.submission !== null,
  );
}

export function currentSubmittedExecutions(snapshot: CloseoutSnapshot): readonly ExecutionV1[] {
  return currentExecutionCuts(snapshot).filter((value) => value.state === "submitted");
}

/** dec_01KXBDV2R6DA0AA0MXTCH0E4AP CH1: a milestone or long_running task completes only with an active decision derives edge naming it. */
export function lineageOrphan(
  task: NonNullable<CloseoutSnapshot["task"]>,
  relations: readonly CoverageRelation[],
): boolean {
  if (task.taskId === undefined || (task.taskClass !== "milestone" && task.taskClass !== "long_running")) return false;
  return !relations.some(
    ({ sourceRef, targetRef, relationType, state }) =>
      sourceRef.startsWith("decision/") &&
      relationType === "derives" &&
      state === "active" &&
      targetRef === `task/${task.taskId}`,
  );
}

export function gateResults(
  snapshot: CloseoutSnapshot,
  availability?: CloseoutProjectionAvailability,
  executionId?: string,
  submission?: SubmissionV1 | null,
  iteration?: number,
): readonly CloseoutGateResult[] {
  const submitted = executionId
      ? (snapshot.executions ?? []).find((value) => value.executionId === executionId && value.iteration === iteration)
      : undefined,
    cut = submission ?? submitted?.submission,
    contract = cut?.completionContract,
    // The frozen contract is the gate list: a `none` mapping removed the requirement at submit
    // time, and a requirement whose appliesTo does not match this cut reports not_applicable —
    // distinct from both a missing witness and a passing one.
    requirements =
      contract?.gates.map((gate) => ({
        gateId: gate.gateId,
        applies: cut ? gateAppliesToSubmission(gate, cut) : false,
      })) ??
      completionGateIds(snapshot.task?.completionGateIds ?? [], cut).map((gateId) => ({
        gateId,
        applies: true,
      }));
  return requirements.map(({ gateId, applies }) => {
    if (!applies)
      return gateResult(gateId, "not_applicable", "the gate's declared scope has no delivery part in this cut");
    const codeDoc = gateId === CODE_DOC_GATE_ID,
      commitSha = cut?.commitSha,
      known = !availability || (codeDoc ? availability.codeDocWitnesses : availability.gateWitnesses) === "known";
    if (!executionId || !cut || iteration === undefined)
      return gateResult(gateId, "missing", "no submitted execution cut");
    if (!known) return gateResult(gateId, "unknown", "witness projection unknown");
    if (codeDoc) {
      const witness = currentCodeDocWitness(snapshot.codeDocWitnesses, executionId);
      // A valid repoint may bind an archival commit rather than the submitted cut.
      if (
        witness?.iteration === iteration &&
        (witness.schema === "code-doc-witness-repoint/v1" || witness.commitSha === commitSha)
      )
        return gateResult(gateId, "passed");
      return gateResult(gateId, "missing", "current execution cut has no code/doc witness");
    }
    const exact = snapshot.gateWitnesses.filter(
      (value) =>
        value.gateId === gateId &&
        value.executionId === executionId &&
        value.commitSha === commitSha &&
        value.iteration === iteration,
    );
    const witness = exact.at(-1),
      judgment =
        witness?.basis && witness.provenance && witness.observed !== undefined
          ? judgeCompletionEvidence(
              { ...witness, basis: witness.basis, provenance: witness.provenance, observed: witness.observed },
              {
                execution: snapshot.executions.find(
                  (value) => value.executionId === executionId && value.iteration === iteration,
                ) as ExecutionV1,
                gateId,
              },
            )
          : witness
            ? {
                accepted: false,
                result: witness.result,
                reason: isPreservedVerdictWitness(witness)
                  ? "preserved historical verdict carries no bound evidence"
                  : "completion witness has no bound evidence",
              }
            : null;
    return judgment?.accepted
      ? gateResult(gateId, "passed")
      : exact.length && witness?.result === "fail"
        ? gateResult(gateId, "failed", judgment?.reason ?? "current execution cut did not pass")
        : gateResult(gateId, "missing", judgment?.reason ?? "current execution cut has no gate witness");
  });
}

/**
 * The gates that apply to a submitted cut, by declaration: the frozen contract's requirements
 * filtered through each gate's appliesTo. Before any submission exists the declared list is the
 * best available answer; submissions predate the frozen contract only as migration input, never
 * as current cuts.
 */
export function completionGateIds(taskGateIds: readonly string[], submission?: SubmissionV1 | null): readonly string[] {
  const contract = submission?.completionContract;
  return contract
    ? contract.gates.flatMap((gate) => (submission && gateAppliesToSubmission(gate, submission) ? [gate.gateId] : []))
    : taskGateIds;
}

export function closeoutGateOk(status: CloseoutGateStatus): boolean | null {
  return status === "unknown" || status === "not_applicable" ? null : status === "passed";
}

function gateResult(gateId: string, status: CloseoutGateStatus, detail?: string): CloseoutGateResult {
  return { gateId, status, ok: closeoutGateOk(status), ...(detail === undefined ? {} : { detail }) };
}

export function isCloseoutReadiness(value: string): value is CloseoutReadiness {
  return (closeoutReadinesses as ReadonlyArray<string>).includes(value);
}
