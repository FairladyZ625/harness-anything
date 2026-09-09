import { validateActorAxes, type ActorAxes, type ContractValidationIssue } from "./task.ts";
import { isNativeCommitSha } from "./execution.ts";
import type { CompletionEvidenceBasis, CompletionEvidenceProvenance } from "./completion-evidence.ts";
import { hasRequiredFields, isNonEmptyString, validateWriteSource, type WriteSource } from "./write-chain.contract.ts";

export interface CompletionGateWitnessV1 {
  readonly schema: "completion-gate-witness/v1";
  readonly witnessId: string;
  readonly receiptId: string;
  readonly checkerId: string;
  readonly gateId: string;
  readonly result: "pass" | "fail" | "advisory" | "not_run";
  readonly observed?: boolean;
  readonly basis?: CompletionEvidenceBasis;
  readonly provenance?: CompletionEvidenceProvenance;
  readonly taskId: string;
  readonly executionId: string;
  readonly commitSha: string;
  readonly iteration: 0 | 1;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly verifiedAt: string;
}
export function validateCompletionGateWitnessV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const record = value as Partial<CompletionGateWitnessV1> | null,
    fields = [
      "schema",
      "witnessId",
      "receiptId",
      "checkerId",
      "gateId",
      "result",
      "taskId",
      "executionId",
      "commitSha",
      "iteration",
      "actor",
      "source",
      "verifiedAt",
    ],
    optionalFields = ["observed", "basis", "provenance"],
    hasFields = allowUnknownFields
      ? hasRequiredFields
      : (candidate: Record<string, unknown>, required: readonly string[]) =>
          hasRequiredFields(candidate, required) &&
          Object.keys(candidate).every((field) => required.includes(field) || optionalFields.includes(field));
  return !record ||
    typeof record !== "object" ||
    !hasFields(record as Record<string, unknown>, fields) ||
    record.schema !== "completion-gate-witness/v1" ||
    ![
      record.witnessId,
      record.receiptId,
      record.checkerId,
      record.gateId,
      record.taskId,
      record.executionId,
      record.verifiedAt,
    ].every(isNonEmptyString) ||
    !["pass", "fail", "advisory", "not_run"].includes(record.result as string) ||
    !isNativeCommitSha(record.commitSha) ||
    (record.iteration !== 0 && record.iteration !== 1) ||
    validateActorAxes(record.actor, allowUnknownFields).length ||
    validateWriteSource(record.source, allowUnknownFields).length ||
    (record.observed !== undefined && typeof record.observed !== "boolean") ||
    (record.basis !== undefined &&
      (!isNonEmptyString(record.basis.executionId) ||
        (record.basis.iteration !== 0 && record.basis.iteration !== 1) ||
        !/^sha256:[0-9a-f]{64}$/u.test(record.basis.submissionDigest) ||
        (record.basis.codeCommit !== undefined && !isNativeCommitSha(record.basis.codeCommit)) ||
        (record.basis.ledgerCut !== undefined &&
          (!Number.isSafeInteger(record.basis.ledgerCut) || record.basis.ledgerCut < 0)))) ||
    (record.provenance !== undefined &&
      (!["runner", "human"].includes(record.provenance.source) ||
        !isNonEmptyString(record.provenance.runId) ||
        !isNonEmptyString(record.provenance.rawResult)))
    ? [
        {
          code: "invalid_gate_witness",
          message: "completion gate witness must bind one canonical checker receipt to an execution cut",
        },
      ]
    : [];
}
