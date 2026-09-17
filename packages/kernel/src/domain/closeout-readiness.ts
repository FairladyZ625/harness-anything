export const closeoutReadinesses = ["not_required", "missing", "incomplete", "ready", "passed", "failed"] as const;

export type CloseoutReadiness = (typeof closeoutReadinesses)[number];

import { approvedReviewsForExecution, consentedApprovedReviewForExecution } from "./review.ts";
import { isNativeExecution, submissionDigest } from "./execution.ts";
import type { ExecutionV1, ProjectedExecution, SubmissionV1 } from "./execution.ts";
import type { ReviewConsentV1, ReviewV1 } from "./review.ts";
import { currentCodeDocWitness } from "./code-doc-witness.ts";
import type { CodeDocWitnessRecord } from "./code-doc-witness.ts";
import { isHumanAttestationWitness, isHistoricalVerdictWitness } from "./completion-gate-witness.ts";
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
    const gates = gateResults(snapshot, availability, cut?.executionId, cut?.submission, cut?.iteration, true),
      missing = gates.some(({ status }) => !gateSatisfied(status));
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
  admitHistoricalVerdict = false,
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
      admitHistoricalVerdict,
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
  const evidence = automated?.evidence;
  return automated?.result === "fail" &&
    evidence?.kind === "observed" &&
    judgeCompletionEvidence(
      {
        ...automated,
        observed: evidence.observed,
        basis: evidence.basis,
        provenance: evidence.provenance,
        override: evidence.override,
      },
      { execution, gateId, admitFail: true },
    ).accepted
    ? automated
    : undefined;
}

export function gateSatisfied(status: CloseoutGateStatus): boolean {
  return status === "passed" || status === "waived" || status === "not_applicable" || status === "historical_accepted";
}

type GateWitnessJudgment = {
  readonly status: Exclude<CloseoutGateStatus, "unknown" | "not_applicable">;
  readonly detail?: string;
};

/**
 * The one per-gate witness judgment for a submitted cut (dec_59FA45A407F850E2B167A192D7 four modes):
 * manual-attest judges its human witness; an automated adapter judges its own witness, then a
 * recorded fail may be waived by an override naming that receipt, and a pass may still need the
 * mandatory human signoff. `admitHistoricalVerdict` lets replay honor verdicts already accepted
 * before the completion chain existed (dec_ED8A4E774FA7A96820D32D171D); a historical verdict is
 * never a current pass.
 */
export function judgeGateWitnesses(
  witnesses: readonly CompletionGateWitnessV1[],
  execution: ExecutionV1,
  gateId: string,
  requirement: FrozenGateRequirement | undefined,
  admitHistoricalVerdict = false,
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
      const evidence = witness.evidence;
      if (isHistoricalVerdictWitness(witness))
        return { status: "missing", detail: "preserved historical verdict is not evidence for a current cut" };
      const judgment =
        evidence?.kind === "observed"
          ? judgeCompletionEvidence(
              {
                ...witness,
                observed: evidence.observed,
                basis: evidence.basis,
                provenance: evidence.provenance,
                override: evidence.override,
              },
              { execution, gateId },
            )
          : { accepted: false, reason: "completion witness has no bound evidence" };
      if (judgment.accepted) return { status: "passed" };
      return witness.result === "fail"
        ? { status: "failed", detail: judgment.reason ?? "current execution cut did not pass" }
        : { status: "missing", detail: judgment.reason ?? "current execution cut has no gate witness" };
    };
  const latest = cut.at(-1);
  if (requirement?.witness.kind === "historical-policy-unavailable") {
    // The frozen requirement is migration-preserved history: it can never be dispatched,
    // signed off, overridden, or fulfilled by a new witness — only a preserved verdict
    // may be honored, and only while replaying already-accepted history.
    if (!latest || !isHistoricalVerdictWitness(latest))
      return {
        status: "missing",
        detail: "the gate's frozen requirement is migration-preserved history and cannot satisfy a current cut",
      };
  }
  if (latest && isHistoricalVerdictWitness(latest)) {
    if (!admitHistoricalVerdict || latest.result !== "pass")
      return { status: "missing", detail: "preserved historical verdict is not evidence for a current cut" };
    const evidence = latest.evidence;
    if (evidence.kind === "historical-verdict" && evidence.gap === "adapter-not-recorded") {
      const bound =
        evidence.basis.executionId === execution.executionId &&
        evidence.basis.iteration === execution.iteration &&
        evidence.basis.submissionDigest === submissionDigest(execution.submission!) &&
        (evidence.basis.codeCommit === undefined || evidence.basis.codeCommit === execution.submission?.commitSha);
      if (!bound)
        return { status: "missing", detail: "the preserved historical verdict's basis does not match this cut" };
    }
    return { status: "historical_accepted" };
  }
  if (requirement?.witness.kind === "adapter" && requirement.witness.adapterId === "manual-attest")
    return judge(cut.at(-1));
  const automated = cut.filter((value) => !isHumanAttestationWitness(value)).at(-1),
    human = cut.filter(isHumanAttestationWitness).at(-1),
    machine = judge(automated),
    waivable = requirement?.allowOverride === true ? waivableAutomatedFail(witnesses, execution, gateId) : undefined,
    humanOverride = human?.evidence.kind === "observed" ? human.evidence.override : undefined;
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
  return contract
    ? contract.gates.flatMap((gate) => (submission && gateAppliesToSubmission(gate, submission) ? [gate.gateId] : []))
    : taskGateIds;
}

export function closeoutGateOk(status: CloseoutGateStatus): boolean | null {
  return status === "unknown" || status === "not_applicable" || status === "historical_accepted"
    ? null
    : status === "passed" || status === "waived";
}

function gateResult(gateId: string, status: CloseoutGateStatus, detail?: string): CloseoutGateResult {
  return { gateId, status, ok: closeoutGateOk(status), ...(detail === undefined ? {} : { detail }) };
}

export function isCloseoutReadiness(value: string): value is CloseoutReadiness {
  return (closeoutReadinesses as ReadonlyArray<string>).includes(value);
}
