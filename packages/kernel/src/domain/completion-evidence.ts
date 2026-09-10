import { submissionDigest, type ExecutionV1 } from "./execution.ts";

export const completionEvidenceResults = ["pass", "fail", "advisory", "not_run"] as const;
export type CompletionEvidenceResult = (typeof completionEvidenceResults)[number];

export interface CompletionEvidenceBasis {
  readonly executionId: string;
  readonly iteration: 0 | 1;
  readonly submissionDigest: `sha256:${string}`;
  readonly codeCommit?: string;
  readonly ledgerCut?: number;
}

export interface CompletionEvidenceProvenance {
  readonly source: "runner" | "human";
  readonly runId: string;
  readonly rawResult: string;
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
}

export interface CompletionEvidenceJudgment {
  readonly accepted: boolean;
  readonly result: CompletionEvidenceResult | "missing";
  readonly reason?: string;
}

type CompletionEvidenceForJudgment = Pick<
  CompletionEvidenceV1,
  "gateId" | "result" | "observed" | "basis" | "provenance"
>;

export function completionEvidenceBasis(execution: ExecutionV1): CompletionEvidenceBasis {
  if (!execution.submission) throw new Error("completion evidence requires a submitted execution");
  return {
    executionId: execution.executionId,
    iteration: execution.iteration,
    submissionDigest: submissionDigest(execution.submission),
    codeCommit: execution.submission.commitSha,
  };
}

export function judgeCompletionEvidence(
  evidence: CompletionEvidenceForJudgment | null | undefined,
  expected: { readonly execution: ExecutionV1; readonly gateId: string; readonly ledgerCut?: number },
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
  if (!evidence.provenance.runId || !evidence.provenance.rawResult)
    return { accepted: false, result: evidence.result, reason: "evidence provenance is incomplete" };
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
    accepted: evidence.result === "pass",
    result: evidence.result,
    ...(evidence.result === "fail" ? { reason: "checker reported fail" } : {}),
  };
}
