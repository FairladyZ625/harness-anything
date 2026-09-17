import { validateActorAxes, type ActorAxes, type ContractValidationIssue } from "./task.ts";
import { mappedWitnessAdapterIds } from "./completion-contract.ts";
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
  /** The cut's delivery commit, or null when the submission delivered accepted artifacts only. */
  readonly commitSha: string | null;
  readonly iteration: number;
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
    !(record.commitSha === null || isNativeCommitSha(record.commitSha)) ||
    !Number.isSafeInteger(record.iteration) ||
    Number(record.iteration) < 0 ||
    validateActorAxes(record.actor, allowUnknownFields).length ||
    validateWriteSource(record.source, allowUnknownFields).length ||
    (record.observed !== undefined && typeof record.observed !== "boolean") ||
    (record.basis !== undefined &&
      (!isNonEmptyString(record.basis.executionId) ||
        !Number.isSafeInteger(record.basis.iteration) ||
        Number(record.basis.iteration) < 0 ||
        !/^sha256:[0-9a-f]{64}$/u.test(record.basis.submissionDigest) ||
        (record.basis.codeCommit !== undefined && !isNativeCommitSha(record.basis.codeCommit)) ||
        (record.basis.ledgerCut !== undefined &&
          (!Number.isSafeInteger(record.basis.ledgerCut) || record.basis.ledgerCut < 0)))) ||
    (record.provenance !== undefined &&
      (!["runner", "human"].includes(record.provenance.source) ||
        // Witnesses recorded before the adapter registry carry no adapterId; they stay readable as history
        // (dec_D23B9787328EF7E0FACB70F9FE) while every new witness must name a mapped adapter.
        !(
          (allowUnknownFields && record.provenance.adapterId === undefined) ||
          (mappedWitnessAdapterIds as readonly string[]).includes(record.provenance.adapterId as string)
        ) ||
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

/**
 * The new-format representation of a historical evidence gap (dec_59FA45A407F850E2B167A192D7):
 * migration keeps the accepted verdict but invents no observation — basis, provenance, and
 * observed all stay absent. Replay may honor the preserved verdict on a historical completion;
 * command admission never mints this shape (a witness write requires bound evidence), and it can
 * never satisfy a new cut's gate.
 */
export function isPreservedVerdictWitness(
  witness: Pick<CompletionGateWitnessV1, "basis" | "provenance" | "observed">,
): boolean {
  return witness.basis === undefined && witness.provenance === undefined && witness.observed === undefined;
}
