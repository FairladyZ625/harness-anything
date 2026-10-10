import type { ArtifactDelivery } from "./execution.ts";
import { validateActorAxes, type ActorAxes, type ContractValidationIssue } from "./task.ts";
import { isNativeCommitSha } from "./execution.ts";
import {
  validCompletionEvidenceOverride,
  type CompletionEvidenceBasis,
  type CompletionEvidenceOverride,
  type CompletionEvidenceProvenance,
} from "./completion-evidence.ts";
import { hasRequiredFields, isNonEmptyString, validateWriteSource, type WriteSource } from "./write-chain.contract.ts";

interface CompletionGateReceipt {
  readonly witnessId: string;
  readonly receiptId: string;
  readonly checkerId: string;
  readonly gateId: string;
  readonly result: "pass" | "fail" | "advisory" | "not_run";
  readonly observed?: boolean;
  readonly basis?: CompletionEvidenceBasis;
  readonly provenance?: CompletionEvidenceProvenance;
  readonly override?: CompletionEvidenceOverride;
  readonly taskId: string;
  readonly executionId: string;
  /** The cut's delivery commit, or null when the submission delivered accepted artifacts only. */
  readonly commitSha: string | null;
  readonly iteration: number;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly verifiedAt: string;
}
export type CompletionGateWitnessV1 = CompletionGateReceipt &
  (
    | {
        readonly schema: "completion-gate-witness/v1";
        readonly subjects: readonly ArtifactDelivery[];
        readonly predicateType: string;
        readonly predicate: Readonly<Record<string, unknown>>;
        readonly diagnostic: string;
        readonly historicalAcceptance?: never;
      }
    | {
        readonly schema: "completion-gate-acceptance/v1";
        readonly historicalAcceptance: {
          readonly sourceGeneration: 1 | 2;
          readonly sourceRevision: number;
          readonly submissionDigest: `sha256:${string}`;
        };
        readonly subjects?: never;
        readonly predicateType?: never;
        readonly predicate?: never;
        readonly diagnostic?: never;
      }
  );
export function validateCompletionGateWitnessV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  const record = value as Partial<CompletionGateWitnessV1> | null,
    historical = allowUnknownFields && record?.schema === "completion-gate-acceptance/v1",
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
      ...(historical ? ["historicalAcceptance"] : ["subjects", "predicateType", "predicate", "diagnostic"]),
    ],
    optionalFields = ["observed", "basis", "provenance", "override"],
    hasFields = allowUnknownFields
      ? hasRequiredFields
      : (candidate: Record<string, unknown>, required: readonly string[]) =>
          hasRequiredFields(candidate, required) &&
          Object.keys(candidate).every((field) => required.includes(field) || optionalFields.includes(field));
  return !record ||
    typeof record !== "object" ||
    !hasFields(record as Record<string, unknown>, fields) ||
    (!historical && record.schema !== "completion-gate-witness/v1") ||
    (historical && ["subjects", "predicateType", "predicate", "diagnostic"].some((field) => field in record)) ||
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
    (record.historicalAcceptance !== undefined &&
      (!historical ||
        ![1, 2].includes(record.historicalAcceptance.sourceGeneration) ||
        !Number.isSafeInteger(record.historicalAcceptance.sourceRevision) ||
        record.historicalAcceptance.sourceRevision < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(record.historicalAcceptance.submissionDigest))) ||
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
        !(record.historicalAcceptance !== undefined || isNonEmptyString(record.provenance.adapterId)) ||
        !isNonEmptyString(record.provenance.runId) ||
        !isNonEmptyString(record.provenance.rawResult))) ||
    (record.override !== undefined && !validCompletionEvidenceOverride(record.override))
    ? [
        {
          code: "invalid_gate_witness",
          message: "completion gate witness must bind one canonical checker receipt to an execution cut",
        },
      ]
    : [];
}

/**
 * A human attestation on a gate whose frozen witness is an automated adapter (dual-control signoff or
 * break-glass override) is kept apart from that adapter's witness: recording one never replaces the
 * other, so an automated fail stays on the cut after it is waived. A manual-attest gate has one lane.
 */
export function isHumanAttestationWitness(witness: Pick<CompletionGateWitnessV1, "provenance">): boolean {
  return witness.provenance?.source === "human";
}

/** Explicit offline acceptance history cannot establish a measured result for a new cut. */
export function isPreservedVerdictWitness(witness: Pick<CompletionGateWitnessV1, "historicalAcceptance">): boolean {
  return witness.historicalAcceptance !== undefined;
}
