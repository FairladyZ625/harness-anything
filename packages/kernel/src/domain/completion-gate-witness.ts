import { validateActorAxes, type ActorAxes, type ContractValidationIssue } from "./task.ts";
import { mappedWitnessAdapterIds } from "./completion-contract.ts";
import { isNativeCommitSha } from "./execution.ts";
import {
  validCompletionEvidenceOverride,
  type CompletionEvidenceBasis,
  type CompletionEvidenceOverride,
  type CompletionEvidenceProvenance,
} from "./completion-evidence.ts";
import {
  hasRequiredFields,
  isNonEmptyString,
  isRecord,
  validateWriteSource,
  type WriteSource,
} from "./write-chain.contract.ts";

/**
 * The evidence bound to a recorded gate verdict (dec_ED8A4E774FA7A96820D32D171D):
 * `observed` carries a real adapter observation with its basis, provenance, and optional override;
 * `historical-verdict` is a read-only migration fact for a verdict accepted before the completion
 * chain existed — `binding-not-recorded` preserves a verdict with no evidence fields at all,
 * `adapter-not-recorded` preserves basis and the human/runner provenance of an accepted verdict whose
 * adapter identity was never persisted. Command admission never mints a historical-verdict shape.
 */
export type CompletionWitnessEvidence =
  | {
      readonly kind: "observed";
      readonly observed: boolean;
      readonly basis: CompletionEvidenceBasis;
      readonly provenance: CompletionEvidenceProvenance;
      readonly override?: CompletionEvidenceOverride;
    }
  | { readonly kind: "historical-verdict"; readonly gap: "binding-not-recorded" }
  | {
      readonly kind: "historical-verdict";
      readonly gap: "adapter-not-recorded";
      readonly basis: CompletionEvidenceBasis;
      readonly provenance: {
        readonly source: "runner" | "human";
        readonly runId: string;
        readonly rawResult: string;
      };
    };

export interface CompletionGateWitnessV1 {
  readonly schema: "completion-gate-witness/v1";
  readonly witnessId: string;
  readonly receiptId: string;
  readonly checkerId: string;
  readonly gateId: string;
  readonly result: "pass" | "fail" | "advisory" | "not_run";
  readonly evidence: CompletionWitnessEvidence;
  readonly taskId: string;
  readonly executionId: string;
  /** The cut's delivery commit, or null when the submission delivered accepted artifacts only. */
  readonly commitSha: string | null;
  readonly iteration: number;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly verifiedAt: string;
}

function validBasis(basis: CompletionEvidenceBasis | undefined): boolean {
  return (
    isRecord(basis) &&
    isNonEmptyString(basis.executionId) &&
    Number.isSafeInteger(basis.iteration) &&
    basis.iteration >= 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(basis.submissionDigest) &&
    (basis.codeCommit === undefined || isNativeCommitSha(basis.codeCommit)) &&
    (basis.ledgerCut === undefined || (Number.isSafeInteger(basis.ledgerCut) && basis.ledgerCut >= 0))
  );
}

function validProvenance(provenance: CompletionEvidenceProvenance | undefined): boolean {
  return (
    isRecord(provenance) &&
    ["runner", "human"].includes(provenance.source) &&
    (mappedWitnessAdapterIds as readonly string[]).includes(provenance.adapterId as string) &&
    isNonEmptyString(provenance.runId) &&
    isNonEmptyString(provenance.rawResult)
  );
}

function validEvidence(evidence: CompletionWitnessEvidence | undefined, allowUnknownFields: boolean): boolean {
  const fields = allowUnknownFields
    ? hasRequiredFields
    : (candidate: Record<string, unknown>, required: readonly string[]) =>
        hasRequiredFields(candidate, required) &&
        Object.keys(candidate).every((field) => required.includes(field) || field === "override");
  if (!isRecord(evidence)) return false;
  if (evidence.kind === "observed")
    return (
      fields(evidence as Record<string, unknown>, ["kind", "observed", "basis", "provenance"]) &&
      typeof evidence.observed === "boolean" &&
      validBasis(evidence.basis) &&
      validProvenance(evidence.provenance) &&
      (evidence.override === undefined || validCompletionEvidenceOverride(evidence.override))
    );
  if (evidence.kind === "historical-verdict" && evidence.gap === "binding-not-recorded")
    return fields(evidence as Record<string, unknown>, ["kind", "gap"]);
  if (evidence.kind === "historical-verdict" && evidence.gap === "adapter-not-recorded")
    return (
      fields(evidence as Record<string, unknown>, ["kind", "gap", "basis", "provenance"]) &&
      validBasis(evidence.basis) &&
      isRecord(evidence.provenance) &&
      ["runner", "human"].includes(evidence.provenance.source) &&
      isNonEmptyString(evidence.provenance.runId) &&
      isNonEmptyString(evidence.provenance.rawResult)
    );
  return false;
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
      "evidence",
      "taskId",
      "executionId",
      "commitSha",
      "iteration",
      "actor",
      "source",
      "verifiedAt",
    ],
    hasFields = allowUnknownFields
      ? hasRequiredFields
      : (candidate: Record<string, unknown>, required: readonly string[]) =>
          hasRequiredFields(candidate, required) && Object.keys(candidate).every((field) => required.includes(field));
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
    !validEvidence(record.evidence, allowUnknownFields) ||
    !(record.commitSha === null || isNativeCommitSha(record.commitSha)) ||
    !Number.isSafeInteger(record.iteration) ||
    Number(record.iteration) < 0 ||
    validateActorAxes(record.actor, allowUnknownFields).length ||
    validateWriteSource(record.source, allowUnknownFields).length
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
export function isHumanAttestationWitness(witness: Pick<CompletionGateWitnessV1, "evidence">): boolean {
  return (
    witness.evidence?.kind === "observed" &&
    witness.evidence.provenance.source === "human" &&
    witness.evidence.provenance.adapterId === "manual-attest"
  );
}

/** Snapshot replacement key: a newer witness replaces the older one only within its own lane. */
export function sameGateWitnessLane(left: CompletionGateWitnessV1, right: CompletionGateWitnessV1): boolean {
  return (
    left.executionId === right.executionId &&
    left.gateId === right.gateId &&
    isHumanAttestationWitness(left) === isHumanAttestationWitness(right)
  );
}

/**
 * A migration-preserved historical verdict (dec_ED8A4E774FA7A96820D32D171D): the accepted result
 * stands as history, but no bound observation exists. Replay may honor it on an already-accepted
 * historical completion; it never satisfies a current cut's gate, signoff, override, or adapter
 * dispatch.
 */
export function isHistoricalVerdictWitness(witness: Pick<CompletionGateWitnessV1, "evidence">): boolean {
  return witness.evidence?.kind === "historical-verdict";
}
