export const closeoutReadinesses = ["not_required", "missing", "incomplete", "ready", "passed", "failed"] as const;

export type CloseoutReadiness = (typeof closeoutReadinesses)[number];

import { approvedReviewsForExecution, consentedApprovedReviewForExecution } from "./review.ts";
import { isNativeExecution } from "./execution.ts";
import type { ExecutionV1, ProjectedExecution, SubmissionV1 } from "./execution.ts";
import type { ReviewConsentV1, ReviewV1 } from "./review.ts";
import { currentCodeDocWitness } from "./code-doc-witness.ts";
import type { CodeDocWitnessRecord } from "./code-doc-witness.ts";
import { isHumanAttestationWitness, isPreservedVerdictWitness } from "./completion-gate-witness.ts";
import type { CompletionGateWitnessV1 } from "./completion-gate-witness.ts";
import { CODE_DOC_GATE_ID, gateAppliesToSubmission, type FrozenGateRequirement } from "./completion-contract.ts";
import type { CoverageRelation } from "./decision-coverage.ts";
import { judgeCompletionEvidence } from "./completion-evidence.ts";
import type { CloseoutGate, CloseoutOverridesV1 } from "./settings-closeout.ts";

import type { CloseoutGateStatus } from "./status-word-register-closeout.ts";
export { closeoutGateStatuses, type CloseoutGateStatus } from "./status-word-register-closeout.ts";

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
    readonly closeoutOverrides?: CloseoutOverridesV1;
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
      missing = gates.some(({ status }) => !gateSatisfied(status));
    return {
      readiness: missing ? "incomplete" : "passed",
      ...(cut ? { executionId: cut.executionId } : {}),
      ...(missing ? { blocker: "gate" as const } : {}),
      gates,
    };
  }
  // The owner's triage gate stands only while the review gate does: a lightweight profile
  // (review/consent lifted) completes straight off its submitted cut, exactly as it did before
  // the corridor existed; a reviewing profile must be forwarded to in_review first.
  if (task.status === "submitted" && effectiveGates?.review !== false)
    return { readiness: "incomplete", blocker: "review", gates: gateResults(snapshot, availability) };
  if (task.status !== "in_review" && task.status !== "submitted")
    return { readiness: "not_required", gates: gateResults(snapshot, availability) };
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
    missing = gates.some(({ status }) => !gateSatisfied(status));
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
    requirements: readonly {
      readonly gateId: string;
      readonly applies: boolean;
      readonly requirement?: FrozenGateRequirement;
    }[] =
      contract?.gates.map((gate) => ({
        gateId: gate.gateId,
        applies: cut ? gateAppliesToSubmission(gate, cut) : false,
        requirement: gate,
      })) ??
      completionGateIds(snapshot.task?.completionGateIds ?? [], cut).map((gateId) => ({
        gateId,
        applies: true,
      }));
  return requirements.map(({ gateId, applies, requirement }) => {
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
    const judged = judgeGateWitnesses(
      snapshot.gateWitnesses,
      ((snapshot.executions ?? []).find(
        (value) => value.executionId === executionId && value.iteration === iteration,
      ) as ExecutionV1 | undefined) ?? ({ executionId, iteration, submission: cut } as ExecutionV1),
      gateId,
      requirement,
    );
    return gateResult(gateId, judged.status, judged.detail);
  });
}

/** The cut's latest automated witness when it is a fail bound to the current submission — what an override may name. */
export function waivableAutomatedFail(
  witnesses: readonly CompletionGateWitnessV1[],
  execution: ExecutionV1,
  gateId: string,
): CompletionGateWitnessV1 | undefined {
  const automated = witnesses
    .filter(
      (value) =>
        value.gateId === gateId &&
        value.executionId === execution.executionId &&
        value.commitSha === execution.submission?.commitSha &&
        value.iteration === execution.iteration &&
        !isHumanAttestationWitness(value),
    )
    .at(-1);
  return automated?.result === "fail" &&
    automated.basis &&
    automated.provenance &&
    automated.observed !== undefined &&
    judgeCompletionEvidence(
      { ...automated, basis: automated.basis, provenance: automated.provenance, observed: automated.observed },
      { execution, gateId, admitFail: true },
    ).accepted
    ? automated
    : undefined;
}

export function gateSatisfied(status: CloseoutGateStatus): boolean {
  return status === "passed" || status === "waived" || status === "not_applicable";
}

type GateWitnessJudgment = {
  readonly status: Exclude<CloseoutGateStatus, "unknown" | "not_applicable">;
  readonly detail?: string;
};

/**
 * The one per-gate witness judgment for a submitted cut (dec_59FA45A407F850E2B167A192D7 four modes):
 * manual-attest judges its human witness; an automated adapter judges its own witness, then a
 * recorded fail may be waived by an override naming that receipt, and a pass may still need the
 * mandatory human signoff.
 */
export function judgeGateWitnesses(
  witnesses: readonly CompletionGateWitnessV1[],
  execution: ExecutionV1,
  gateId: string,
  requirement: FrozenGateRequirement | undefined,
): GateWitnessJudgment {
  const cut = witnesses.filter(
      (value) =>
        value.gateId === gateId &&
        value.executionId === execution.executionId &&
        value.commitSha === execution.submission?.commitSha &&
        value.iteration === execution.iteration,
    ),
    judge = (witness: CompletionGateWitnessV1 | undefined): GateWitnessJudgment => {
      if (!witness) return { status: "missing", detail: "current execution cut has no gate witness" };
      const judgment =
        witness.basis && witness.provenance && witness.observed !== undefined
          ? judgeCompletionEvidence(
              { ...witness, basis: witness.basis, provenance: witness.provenance, observed: witness.observed },
              { execution, gateId },
            )
          : {
              // Accepted history keeps its original gap: a preserved verdict carries no bound evidence.
              accepted: isPreservedVerdictWitness(witness) && witness.result === "pass",
              reason: isPreservedVerdictWitness(witness)
                ? "preserved historical verdict carries no bound evidence"
                : "completion witness has no bound evidence",
            };
      if (judgment.accepted) return { status: "passed" };
      return witness.result === "fail"
        ? { status: "failed", detail: judgment.reason ?? "current execution cut did not pass" }
        : { status: "missing", detail: judgment.reason ?? "current execution cut has no gate witness" };
    };
  if (requirement?.witness.adapterId === "manual-attest") return judge(cut.at(-1));
  const automated = cut.filter((value) => !isHumanAttestationWitness(value)).at(-1),
    human = cut.filter(isHumanAttestationWitness).at(-1),
    machine = judge(automated),
    waivable = requirement?.allowOverride === true ? waivableAutomatedFail(witnesses, execution, gateId) : undefined,
    humanOverride = human?.override;
  if (humanOverride !== undefined && judge(human).status === "passed") {
    // A receipt-bound waiver covers exactly the recorded fail it names; a null waiver stands only
    // while the cut has no automated receipt at all — any later receipt voids it.
    if (waivable && humanOverride.waivedReceiptId === waivable.receiptId)
      return {
        status: "waived",
        detail:
          `receipt ${waivable.receiptId} waived by ${human!.actor.principal.personId} ` +
          `at ${human!.verifiedAt}: ${humanOverride.rationale}`,
      };
    if (requirement?.allowOverride === true && humanOverride.waivedReceiptId === null && automated === undefined)
      return {
        status: "waived",
        detail:
          `no automated witness on this cut; waived by ${human!.actor.principal.personId} ` +
          `at ${human!.verifiedAt}: ${humanOverride.rationale}`,
      };
  }
  if (machine.status !== "passed" || requirement?.mandatorySignoff !== true) return machine;
  // An override is never a signoff: only a plain human attestation satisfies dual control.
  const signoff = human !== undefined && humanOverride === undefined ? judge(human) : { status: "missing" as const };
  return signoff.status === "missing"
    ? { status: "signoff_missing", detail: "the automated witness passed; the mandatory human signoff is missing" }
    : signoff;
}

/**
 * The gates that apply to a submitted cut, by declaration: the frozen contract's requirements
 * filtered through each gate's appliesTo. Before any submission exists the declared list is the
 * best available answer; submissions predate the frozen contract only as migration input, never
 * as current cuts.
 */
export function completionGateIds(taskGateIds: readonly string[], submission?: SubmissionV1 | null): readonly string[] {
  const contract = submission?.completionContract;
  if (contract)
    return contract.gates.flatMap((gate) => (gateAppliesToSubmission(gate, submission!) ? [gate.gateId] : []));
  // Pre-freeze cuts keep the rule in force when they were judged: artifact-only delivery skipped the code gates.
  return submission?.commitSha === null
    ? taskGateIds.filter((gateId) => gateId !== "ci" && gateId !== "code-doc-reconciliation")
    : taskGateIds;
}

export function closeoutGateOk(status: CloseoutGateStatus): boolean | null {
  return status === "unknown" || status === "not_applicable" ? null : status === "passed" || status === "waived";
}

function gateResult(gateId: string, status: CloseoutGateStatus, detail?: string): CloseoutGateResult {
  return { gateId, status, ok: closeoutGateOk(status), ...(detail === undefined ? {} : { detail }) };
}

export function isCloseoutReadiness(value: string): value is CloseoutReadiness {
  return (closeoutReadinesses as ReadonlyArray<string>).includes(value);
}
