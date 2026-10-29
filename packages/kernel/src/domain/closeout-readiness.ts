import { currentGateRun } from "./gate-run.ts";
export const closeoutReadinesses = ["not_required", "missing", "incomplete", "ready", "passed", "failed"] as const;

export type CloseoutReadiness = (typeof closeoutReadinesses)[number];

import {
  consentedApprovedReviewForExecution,
  reviewsForExecution,
  settledApprovedReviewsForExecution,
} from "./review.ts";
import { isNativeExecution, submissionDigest } from "./execution.ts";
import type { ExecutionV1, ProjectedExecution, SubmissionV1 } from "./execution.ts";
import type { ReviewConsentV1, ReviewDispositionV1, ReviewV1 } from "./review.ts";
import {
  settleReviewFindings,
  type ReviewFindingSettlement,
  type ReviewFindingTriageV1,
  type SettleableReviewFinding,
} from "./review-settlement.ts";
import { disposedReviewIdsForSubmission } from "./review-consent-validity.ts";
import { isHumanAttestationWitness, isPreservedVerdictWitness } from "./completion-gate-witness.ts";
import type { CompletionGateWitnessV1 } from "./completion-gate-witness.ts";
import { gateAppliesToSubmission, type FrozenGateRequirement } from "./completion-contract.ts";
import type { CoverageRelation } from "./decision-coverage.ts";
import { judgeCompletionEvidence } from "./completion-evidence.ts";
import type { CloseoutGate, CloseoutOverridesV1 } from "./settings-closeout.ts";
import type { ForwardedCutRecord } from "./task-lifecycle-contract-internal-types.ts";
import { isRetiredCodeDocRequirement } from "./code-doc-retirement.ts";

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
  readonly escalatedFindings?: readonly { readonly reviewId: string; readonly findingId: string }[];
  readonly blockingFindings?: readonly { readonly reviewId: string; readonly findingId: string }[];
  readonly gates: readonly CloseoutGateResult[];
}

export interface CloseoutFindingRef {
  readonly reviewId: string;
  readonly findingId: string;
}
export interface CloseoutProjectionAvailability {
  readonly consents: "known" | "unknown";
  readonly gateWitnesses: "known" | "unknown";
}
export interface CompletionDeliveryStatus {
  readonly required: boolean;
  readonly merged: boolean | null;
  readonly targetBranch: string;
  readonly targetRef?: string;
  readonly mergeSha?: string;
  readonly deliveryCommitSha?: string;
  readonly deliveryIssue?: "merge-not-on-target" | "delivery-not-contained" | "delivery-evidence-unavailable";
}

/** One delivery baseline resolver shared by completion reads and closeout gate details. */
export function deliveryTargetRef(delivery: Pick<CompletionDeliveryStatus, "targetBranch" | "targetRef">): string {
  return delivery.targetRef ?? `refs/remotes/origin/${delivery.targetBranch}`;
}

export function deliveryTargetLabel(delivery: Pick<CompletionDeliveryStatus, "targetBranch" | "targetRef">): string {
  return delivery.targetRef ?? `origin/${delivery.targetBranch}`;
}
export interface CloseoutSnapshot {
  readonly task: {
    readonly status: string;
    readonly iteration: number;
    readonly completionGateIds: readonly string[];
    readonly closeoutOverrides?: CloseoutOverridesV1;
    readonly presetSnapshotDigest?: string | null;
    readonly presetSnapshotGap?: import("./task.ts").TaskV2["presetSnapshotGap"];
    readonly taskId?: string;
    readonly taskClass?: string;
  } | null;
  readonly executions: readonly ProjectedExecution[];
  /** The forward adjudications the journal replay recorded; absent in a hand-built snapshot,
   * which then reads as never forwarded. */
  readonly forwardedCuts?: readonly ForwardedCutRecord[];
  readonly reviews: readonly ReviewV1[];
  readonly consents: readonly ReviewConsentV1[];
  readonly reviewDispositions?: readonly ReviewDispositionV1[];
  /** Per-finding triage answers the center recorded for this cut's categorized findings. */
  readonly reviewFindingTriages?: readonly ReviewFindingTriageV1[];
  readonly gateWitnesses: readonly CompletionGateWitnessV1[];
  readonly decisionRelations?: readonly CoverageRelation[];
  readonly siblingResolution?: { readonly sourceTaskId: string; readonly rationale: string; readonly factRef: string };
}

/** The one cross-aggregate closeout judgment used by transitions and read models. */
export function closeoutReadiness(
  snapshot: CloseoutSnapshot,
  availability?: CloseoutProjectionAvailability,
  effectiveGates?: Readonly<Record<CloseoutGate, boolean>>,
  delivery?: CompletionDeliveryStatus,
): CloseoutAssessment {
  const task = snapshot.task;
  if (!task) return { readiness: "missing", blocker: "execution", gates: [] };
  if (task.status === "done" && snapshot.siblingResolution) return { readiness: "passed", gates: [] };
  const cuts = currentExecutionCuts(snapshot),
    cut = cuts.length === 1 ? cuts[0] : undefined;
  if (task.status === "done") {
    if (!cut)
      return {
        readiness: "incomplete",
        blocker: "execution",
        gates: gateResults(snapshot, availability, undefined, undefined, undefined, delivery),
      };
    const gates = gateResults(snapshot, availability, cut?.executionId, cut?.submission, cut?.iteration, delivery),
      missing = gates.some(({ status }) => !gateSatisfied(status));
    return {
      readiness: missing ? "incomplete" : "passed",
      ...(cut ? { executionId: cut.executionId } : {}),
      ...(missing ? { blocker: "gate" as const } : {}),
      gates,
    };
  }
  // Review-required cuts must be in_review; review-disabled profiles complete from submitted.
  // Historical submitted review cuts have no entry into review in the current version: the
  // registered stock disposal in docs-release/data-format-migrations.md names their exits.
  if (task.status === "submitted" && effectiveGates?.review !== false)
    return {
      readiness: "incomplete",
      blocker: "review",
      gates: gateResults(snapshot, availability, undefined, undefined, undefined, delivery),
    };
  if (task.status !== "in_review" && task.status !== "submitted")
    return {
      readiness: "not_required",
      gates: gateResults(snapshot, availability, undefined, undefined, undefined, delivery),
    };
  const execution = cut?.state === "submitted" ? cut : undefined;
  if (!execution?.submission)
    return {
      readiness: "missing",
      blocker: "execution",
      gates: gateResults(snapshot, availability, undefined, undefined, undefined, delivery),
    };
  const gates = gateResults(
    snapshot,
    availability,
    execution.executionId,
    execution.submission,
    execution.iteration,
    delivery,
  );
  if (
    (availability && Object.values(availability).includes("unknown")) ||
    gates.some(({ status }) => status === "unknown")
  )
    return { readiness: "incomplete", executionId: execution.executionId, blocker: "projection_unknown", gates };
  const approved = settledApprovedReviewsForExecution(snapshot.reviews, execution, snapshot.reviewDispositions ?? []),
    consented = consentedApprovedReviewForExecution(
      snapshot.reviews,
      snapshot.consents,
      execution,
      snapshot.reviewDispositions ?? [],
    );
  // The owner's forward adjudication is the review requirement a lifted profile skipped: the cut
  // it named owes its verdict even though the frozen profile lifted review. Keyed on the journal's
  // forward record, not the in_review position — a preset upgrade resets task-bound overrides and
  // snapshots reach in_review by other paths, so only the order itself buys the verdict.
  const forwarded = (snapshot.forwardedCuts ?? []).some(
    (record) => record.executionId === execution.executionId && record.iteration === execution.iteration,
  );
  // Per-finding settlement (dec_6A77D43B8523823ABA1F5E4D3C CH5): once a current cut carries a
  // finding, each finding is the pass unit and a missing or ambiguous triage is unresolved review —
  // never an approved one. A cut whose reviews raise no finding at all passes on its own verdict
  // (CH1 "无 finding 时直接通过"), which is also how historical records still complete.
  //
  // A cut that raised a finding without a category must not slip back to the single-`approved`
  // predicate: that predicate is exactly what C3 deletes, and it would let a reviewer return
  // `changes_requested` findings and be overruled by one `approved` record. Such a cut is
  // unresolved review — the reviewer answered neither the triage question nor "no findings".
  // Pinning a cut means hashing its whole submission, and this judgment runs once per rendered
  // board row. A repository whose reviews carry no finding at all cannot enter either branch below,
  // so one cheap scan over the snapshot spares that hash; only a repository that actually records
  // findings pays for the per-cut pinning.
  const findingsRecorded = snapshot.reviews.some((review) => (review.findings ?? []).length > 0),
    settlement = findingsRecorded
      ? currentCutSettlement(
          snapshot.reviews,
          execution,
          snapshot.reviewFindingTriages ?? [],
          snapshot.reviewDispositions ?? [],
        )
      : null,
    reviewOwed = effectiveGates?.review !== false || forwarded,
    consentReviewBlockers = reviewConsentBlockers(
      snapshot.reviews,
      execution,
      snapshot.reviewFindingTriages ?? [],
      snapshot.reviewDispositions ?? [],
      settlement,
    ),
    escalatedFindingRefs = settlement?.escalated.map(({ reviewId, findingId }) => ({ reviewId, findingId })) ?? [],
    targetDigest = submissionDigest(execution.submission),
    blockingFindingRefs =
      settlement?.blockers.filter(({ reviewId, findingId }) =>
        (snapshot.reviewDispositions ?? []).some(
          (value) =>
            value.submissionDigest === targetDigest &&
            value.findingRuling?.targetDigest === targetDigest &&
            value.findingRuling.reviewId === reviewId &&
            value.findingRuling.findingId === findingId &&
            value.findingRuling.disposition === "blocker",
        ),
      ) ?? [],
    reviewSatisfied =
      consentReviewBlockers.length === 0 &&
      (settlement === null
        ? approved.length > 0 || consented !== undefined
        : settlement.outcome === "passed" || consented !== undefined);
  if (reviewOwed && !reviewSatisfied)
    return {
      readiness: "incomplete",
      executionId: execution.executionId,
      blocker: "review",
      ...(escalatedFindingRefs.length ? { escalatedFindings: escalatedFindingRefs } : {}),
      ...(blockingFindingRefs.length ? { blockingFindings: blockingFindingRefs } : {}),
      gates,
    };
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

/**
 * The findings of one cut that enter per-finding settlement, in review order. A finding without a
 * recorded category is not settled: the pre-triage review path keeps owning it (a category is only
 * written by a reviewer that answered the triage question). The center's triage producer asks about
 * exactly these findings, so the question it pays for and the judgment that reads the answer cannot
 * drift apart.
 */
export function cutReviewFindings(
  reviews: readonly ReviewV1[],
  execution: ExecutionV1,
): readonly SettleableReviewFinding[] {
  return reviewsForExecution(reviews, execution).flatMap((review) =>
    (review.findings ?? []).flatMap((finding) =>
      finding.category === undefined
        ? []
        : [
            {
              reviewId: review.reviewId,
              findingId: finding.findingId,
              category: finding.category,
              label: finding.label ?? ("Important" as const),
              text: finding.text,
              reviewerBlocking: finding.blocking,
              ...(finding.evidenceDigest === undefined || finding.anchor === undefined
                ? {}
                : { evidence: { anchor: finding.anchor, evidenceDigest: finding.evidenceDigest } }),
              ...(finding.priorFindingRefs === undefined ? {} : { priorFindingRefs: finding.priorFindingRefs }),
            },
          ],
    ),
  );
}

/**
 * The per-finding settlement of one cut, or null for a cut that raised no categorized finding. Only
 * findings bound to this execution/iteration enter, so a prior cut's settlement cannot pass a new one.
 */
export function currentCutSettlement(
  reviews: readonly ReviewV1[],
  execution: ExecutionV1,
  triages: readonly ReviewFindingTriageV1[],
  dispositions: readonly ReviewDispositionV1[] = [],
): ReviewFindingSettlement | null {
  const findings = cutReviewFindings(reviews, execution);
  if (findings.length === 0 || !execution.submission) return null;
  // The cut a settlement answers is its submission digest: an amend mints a new one, and a record
  // minted for the old cut must not answer the new one (B-3: `(reviewId, findingId)` is reusable).
  return settleReviewFindings({
    findings,
    triages,
    targetDigest: submissionDigest(execution.submission),
    rulings: dispositions.flatMap((value) => (value.findingRuling ? [value.findingRuling] : [])),
  });
}

/** Findings an explicit owner consent cannot waive on a Task cut. Shared settlement remains unchanged. */
export function reviewConsentBlockers(
  reviews: readonly ReviewV1[],
  execution: ExecutionV1,
  triages: readonly ReviewFindingTriageV1[],
  dispositions: readonly ReviewDispositionV1[] = [],
  knownSettlement?: ReviewFindingSettlement | null,
): readonly CloseoutFindingRef[] {
  if (!execution.submission) return [];
  const targetDigest = submissionDigest(execution.submission),
    rawFindings = reviewsForExecution(reviews, execution).flatMap((review) =>
      (review.findings ?? []).map((finding) => ({ review, finding })),
    ),
    settlement = knownSettlement ?? currentCutSettlement(reviews, execution, triages, dispositions),
    unfiled = unfiledReviewFindings(reviews, execution, dispositions),
    refs = new Map<string, CloseoutFindingRef>();
  for (const finding of unfiled) {
    refs.set(`${finding.reviewId}/${finding.findingId}`, finding);
  }
  for (const settled of settlement?.findings ?? []) {
    if (settled.outcome === "escalated") {
      refs.set(`${settled.reviewId}/${settled.findingId}`, {
        reviewId: settled.reviewId,
        findingId: settled.findingId,
      });
      continue;
    }
    if (settled.outcome !== "blocked") continue;
    const triage = triages.find(
      (value) =>
        value.reviewId === settled.reviewId &&
        value.findingId === settled.findingId &&
        value.targetDigest === targetDigest,
    );
    const raw = rawFindings.find(
      ({ review, finding }) => review.reviewId === settled.reviewId && finding.findingId === settled.findingId,
    )?.finding;
    const consentExempt =
      settled.category === "ci-required" &&
      raw?.blocking === false &&
      triage?.selected !== "blocker" &&
      triage?.critic?.selected !== "blocker" &&
      !dispositions.some(
        (value) =>
          value.submissionDigest === targetDigest &&
          value.findingRuling?.targetDigest === targetDigest &&
          value.findingRuling.reviewId === settled.reviewId &&
          value.findingRuling.findingId === settled.findingId &&
          value.findingRuling.disposition === "blocker",
      );
    if (!consentExempt)
      refs.set(`${settled.reviewId}/${settled.findingId}`, {
        reviewId: settled.reviewId,
        findingId: settled.findingId,
      });
  }
  return [...refs.values()];
}

export function unfiledReviewFindings(
  reviews: readonly ReviewV1[],
  execution: ExecutionV1,
  dispositions: readonly ReviewDispositionV1[],
): readonly CloseoutFindingRef[] {
  if (!execution.submission) return [];
  const disposed = disposedReviewIdsForSubmission(dispositions, submissionDigest(execution.submission));
  return reviewsForExecution(reviews, execution).flatMap((review) =>
    disposed.has(review.reviewId)
      ? []
      : (review.findings ?? [])
          .filter((finding) => finding.category === undefined)
          .map(({ findingId }) => ({ reviewId: review.reviewId, findingId })),
  );
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

/** dec_01KXBDV2R6DA0AA0MXTCH0E4AP CH1: a work or long_running task completes only with an active decision derives edge naming it. */
export function lineageOrphan(
  task: NonNullable<CloseoutSnapshot["task"]>,
  relations: readonly CoverageRelation[],
): boolean {
  if (task.taskId === undefined || (task.taskClass !== "work" && task.taskClass !== "long_running")) return false;
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
  delivery?: CompletionDeliveryStatus,
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
    if (snapshot.task?.presetSnapshotGap || contract?.historicalAcceptance?.snapshotGap)
      return gateResult(
        gateId,
        "missing",
        `Historical snapshot gap: ${contract?.presetSnapshotDigest ?? snapshot.task?.presetSnapshotDigest}; original bytes unavailable.`,
      );
    if (!applies)
      return gateResult(gateId, "not_applicable", "the gate's declared scope has no delivery part in this cut");
    // A retired requirement has no live witness source; the one retirement judgment decides that,
    // and this file alone decides what the retirement reads as.
    if (isRetiredGateRequirement(gateId, requirement)) return retiredGateResult(gateId, requirement, delivery);
    if (!executionId || !cut || iteration === undefined)
      return gateResult(gateId, "missing", "no submitted execution cut");
    if (availability && availability.gateWitnesses !== "known")
      return gateResult(gateId, "unknown", "witness projection unknown");
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

export function isRetiredCiRequirement(gateId: string, requirement: FrozenGateRequirement | undefined): boolean {
  return (
    gateId === "ci" || requirement?.witness.kind === "github-actions" || requirement?.witness.kind === "gitlab-pipeline"
  );
}

/**
 * The one judgment for a frozen requirement whose witness source no longer exists. Retired hosted CI
 * is answered by merge evidence, retired code/doc reconciliation by its own retirement; every
 * completion-path consumer uses this predicate so receipts, witness counts, and replay agree on what
 * a retired gate owes. It deliberately does not decide the gate's resulting status: CI reads through
 * delivery policy, code/doc reads `not_applicable`.
 */
export function isRetiredGateRequirement(gateId: string, requirement: FrozenGateRequirement | undefined): boolean {
  return isRetiredCiRequirement(gateId, requirement) || isRetiredCodeDocRequirement(gateId);
}

/** What a retired requirement reads as. CI has merge evidence; code/doc reconciliation never had content. */
function retiredGateResult(
  gateId: string,
  requirement: FrozenGateRequirement | undefined,
  delivery: CompletionDeliveryStatus | undefined,
): CloseoutGateResult {
  if (!isRetiredCiRequirement(gateId, requirement))
    return gateResult(gateId, "not_applicable", "code/doc reconciliation is retired");
  return delivery === undefined
    ? gateResult(gateId, "unknown", "repository delivery configuration is unavailable")
    : delivery.required
      ? delivery.merged === null
        ? gateResult(gateId, "unknown", `unable to verify delivery merge on ${deliveryTargetLabel(delivery)}`)
        : delivery.merged
          ? gateResult(gateId, "passed", `delivery merge is on ${deliveryTargetLabel(delivery)}`)
          : gateResult(
              gateId,
              "missing",
              delivery.deliveryIssue === "delivery-not-contained"
                ? `annotated merge commit does not contain delivery ${delivery.deliveryCommitSha}`
                : `delivery merge is not on ${deliveryTargetLabel(delivery)}`,
            )
      : gateResult(gateId, "not_applicable", "the repository does not require code delivery to be merged");
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
        value.provenance?.runId === currentGateRun(execution, gateId)?.runId &&
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
      if (witness.historicalAcceptance)
        return witness.historicalAcceptance.submissionDigest === submissionDigest(execution.submission!) &&
          witness.result === "pass"
          ? { status: "passed", detail: "Historical acceptance; no new measurement is asserted." }
          : {
              status: witness.result === "fail" ? "failed" : "missing",
              detail: "Historical acceptance does not bind this submission.",
            };
      const judgment =
        witness.basis && witness.provenance && witness.observed !== undefined
          ? judgeCompletionEvidence(
              { ...witness, basis: witness.basis, provenance: witness.provenance, observed: witness.observed },
              { execution, gateId },
            )
          : { accepted: false, reason: "completion witness has no bound evidence" };
      if (judgment.accepted) return { status: "passed" };
      return witness.result === "fail"
        ? { status: "failed", detail: witness.diagnostic || judgment.reason || "current execution cut did not pass" }
        : { status: "missing", detail: judgment.reason ?? "current execution cut has no gate witness" };
    };
  if (requirement?.witness.kind === "manual") return judge(cut.at(-1));
  const activeRun = currentGateRun(execution, gateId);
  if (requirement?.witness.kind === "historical")
    return judge(cut.filter((value) => isPreservedVerdictWitness(value)).at(-1));
  const automated = cut
      .filter((value) => !isHumanAttestationWitness(value) && value.provenance?.runId === activeRun?.runId)
      .at(-1),
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
    if (
      requirement?.allowOverride === true &&
      humanOverride.waivedReceiptId === null &&
      !cut.some(
        (value) =>
          !isHumanAttestationWitness(value) &&
          value.basis?.submissionDigest === submissionDigest(execution.submission!),
      )
    )
      return {
        status: "waived",
        detail:
          `no automated witness on this cut; waived by ${human!.actor.principal.personId} ` +
          `at ${human!.verifiedAt}: ${humanOverride.rationale}`,
      };
  }
  if (activeRun && activeRun.state !== "completed")
    return { status: "missing", detail: `Gate run ${activeRun.runId} is ${activeRun.state}.` };
  if (activeRun?.availability === "unavailable") return { status: "missing", detail: activeRun.diagnostic };
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
  return taskGateIds;
}

export function closeoutGateOk(status: CloseoutGateStatus): boolean | null {
  return status === "unknown" || status === "not_applicable" ? null : status === "passed" || status === "waived";
}

function gateResult(gateId: string, status: CloseoutGateStatus, detail?: string): CloseoutGateResult {
  return { gateId, status, ok: closeoutGateOk(status), ...(detail === undefined ? {} : { detail }) };
}
