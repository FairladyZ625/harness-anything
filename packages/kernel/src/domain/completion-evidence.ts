import { submissionDigest, type ExecutionV1 } from "./execution.ts";
import { mappedWitnessAdapterIds, type MappedWitnessAdapterId } from "./completion-contract.ts";

export const completionEvidenceResults = ["pass", "fail", "advisory", "not_run"] as const;
export type CompletionEvidenceResult = (typeof completionEvidenceResults)[number];

export interface CompletionEvidenceBasis {
  readonly executionId: string;
  readonly iteration: number;
  readonly submissionDigest: `sha256:${string}`;
  readonly codeCommit?: string;
  readonly ledgerCut?: number;
}

export interface CompletionEvidenceProvenance {
  readonly source: "runner" | "human";
  /**
   * Which witness adapter produced this observation; the canonical write binds it to the declared one.
   * Absent only on evidence recorded before the completion contract froze an adapter registry.
   */
  readonly adapterId?: MappedWitnessAdapterId;
  readonly runId: string;
  readonly rawResult: string;
}

/**
 * A break-glass waiver: a human pass over one recorded automated `fail` on the same cut. The
 * waived fail witness stays recorded; the override only names it.
 */
export interface CompletionEvidenceOverride {
  readonly rationale: string;
  readonly waivedReceiptId: string;
}

export const OVERRIDE_RATIONALE_MIN_LENGTH = 10;

export function validOverrideRationale(value: unknown): value is string {
  return typeof value === "string" && [...value.trim()].length >= OVERRIDE_RATIONALE_MIN_LENGTH;
}

export function validCompletionEvidenceOverride(value: unknown): value is CompletionEvidenceOverride {
  const record = value as Partial<CompletionEvidenceOverride> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    Object.keys(record).every((field) => field === "rationale" || field === "waivedReceiptId") &&
    validOverrideRationale(record.rationale) &&
    typeof record.waivedReceiptId === "string" &&
    record.waivedReceiptId.length > 0
  );
}

export interface CompletionEvidenceV1 {
  readonly schema: "completion-evidence/v1";
  readonly evidenceId?: string;
  readonly checkerId: string;
  readonly gateId: string;
  readonly result: CompletionEvidenceResult;
  readonly observed: boolean;
  readonly basis: CompletionEvidenceBasis;
  readonly provenance: CompletionEvidenceProvenance;
  readonly override?: CompletionEvidenceOverride;
}

export interface CompletionEvidenceJudgment {
  readonly accepted: boolean;
  readonly result: CompletionEvidenceResult | "missing";
  readonly reason?: string;
}

type CompletionEvidenceForJudgment = Pick<
  CompletionEvidenceV1,
  "gateId" | "result" | "observed" | "basis" | "provenance" | "override"
>;

export function completionEvidenceBasis(execution: ExecutionV1): CompletionEvidenceBasis {
  if (!execution.submission) throw new Error("completion evidence requires a submitted execution");
  return {
    executionId: execution.executionId,
    iteration: execution.iteration,
    submissionDigest: submissionDigest(execution.submission),
    ...(execution.submission.commitSha === null
      ? { ledgerCut: Math.max(...execution.submission.artifacts.map((anchor) => anchor.revision)) }
      : { codeCommit: execution.submission.commitSha }),
  };
}

export function judgeCompletionEvidence(
  evidence: CompletionEvidenceForJudgment | null | undefined,
  expected: {
    readonly execution: ExecutionV1;
    readonly gateId: string;
    readonly ledgerCut?: number;
    /** Canonical witness publication admits a binding-valid `fail` record; satisfaction still requires pass. */
    readonly admitFail?: boolean;
  },
): CompletionEvidenceJudgment {
  if (!evidence) return { accepted: false, result: "missing", reason: "no completion evidence was recorded" };
  if (evidence.gateId !== expected.gateId)
    return { accepted: false, result: evidence.result, reason: "evidence gate does not match the required gate" };
  if (!evidence.basis) return { accepted: false, result: evidence.result, reason: "evidence basis is missing" };
  if (!evidence.provenance)
    return { accepted: false, result: evidence.result, reason: "evidence provenance is missing" };
  if (evidence.basis.executionId !== expected.execution.executionId)
    return { accepted: false, result: evidence.result, reason: "evidence executionId is not the current execution" };
  if (evidence.basis.iteration !== expected.execution.iteration)
    return { accepted: false, result: evidence.result, reason: "evidence iteration is not the current iteration" };
  if (!expected.execution.submission)
    return { accepted: false, result: evidence.result, reason: "current execution has no submitted content" };
  if (evidence.basis.submissionDigest !== submissionDigest(expected.execution.submission))
    return {
      accepted: false,
      result: evidence.result,
      reason: "evidence submissionDigest is not the current submission",
    };
  if (evidence.basis.codeCommit !== undefined && evidence.basis.codeCommit !== expected.execution.submission.commitSha)
    return { accepted: false, result: evidence.result, reason: "evidence codeCommit is not the submitted commit" };
  if (expected.ledgerCut !== undefined && evidence.basis.ledgerCut !== expected.ledgerCut)
    return { accepted: false, result: evidence.result, reason: "evidence ledgerCut is not the canonical cut" };
  if (!(evidence.provenance.source === "runner" || evidence.provenance.source === "human"))
    return { accepted: false, result: evidence.result, reason: "evidence provenance source is unsupported" };
  if (
    !evidence.provenance.runId ||
    !evidence.provenance.rawResult ||
    // A cut frozen before the completion contract was judged before the adapter registry existed, so its
    // evidence names no adapter (dec_D23B9787328EF7E0FACB70F9FE); every contract cut must name a mapped one.
    !(
      (expected.execution.submission?.completionContract === undefined &&
        evidence.provenance.adapterId === undefined) ||
      (mappedWitnessAdapterIds as readonly string[]).includes(evidence.provenance.adapterId as string)
    )
  )
    return { accepted: false, result: evidence.result, reason: "evidence provenance is incomplete" };
  if (
    evidence.override !== undefined &&
    (evidence.provenance.source !== "human" ||
      evidence.provenance.adapterId !== "manual-attest" ||
      evidence.result !== "pass" ||
      !validCompletionEvidenceOverride(evidence.override))
  )
    return {
      accepted: false,
      result: evidence.result,
      reason: "an override must be a human pass naming the waived receipt with a rationale",
    };
  if (evidence.result === "pass" && !evidence.observed)
    return { accepted: false, result: evidence.result, reason: "a pass must be observed by a runner or human" };
  if (evidence.result === "advisory")
    return {
      accepted: false,
      result: evidence.result,
      reason: "advisory evidence is observed but cannot satisfy a gate",
    };
  if (evidence.result === "not_run")
    return { accepted: false, result: evidence.result, reason: "the checker did not run" };
  return {
    accepted: evidence.result === "pass" || (expected.admitFail === true && evidence.result === "fail"),
    result: evidence.result,
    ...(evidence.result === "fail" ? { reason: "checker reported fail" } : {}),
  };
}
