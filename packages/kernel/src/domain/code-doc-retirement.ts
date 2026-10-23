import { isRecord, validateWriteSource } from "./write-chain.contract.ts";
import { retiredCodeDocGateId } from "./retired-code-doc-gate.ts";
export { retiredCodeDocGateId } from "./retired-code-doc-gate.ts";
import type { ContractValidationIssue } from "./task.ts";

/**
 * Retired code/doc reconciliation (owner ruling 2026-10-21 14:35, board item B3). The mechanism only
 * proved that a commit and a set of paths existed; it compared no code against any document. The
 * command, the completion gate, the witness projection, and the GUI surface are gone.
 *
 * Accepted ledger history stays readable, and only readable: these three helpers are the single
 * place that still knows the retired names. Old envelopes parse, replay to no state, and are
 * rejected by current admission. A task whose frozen contract still lists the retired gate reports
 * it as `not_applicable` instead of a missing witness.
 */
export const retiredCodeDocEventTypes = ["code_doc_reconciled", "code_doc_repointed"] as const;
export const retiredCodeDocAnchorFile = "code-doc-anchors.json";
export type RetiredCodeDocEventType = (typeof retiredCodeDocEventTypes)[number];

/**
 * Historical accept-only values of the retired repoint record. Not a live status vocabulary: the
 * event type is rejected by current admission and only the retired payload validator reads this
 * field, so the values stay module-private instead of re-entering the entity status register.
 */
const retiredCodeDocDispositions = ["repointed", "known-invalid"] as const;
type RetiredCodeDocDisposition = (typeof retiredCodeDocDispositions)[number];

/** The exact historical witness value, kept only so accepted replay can type its payload. */
export interface RetiredCodeDocWitnessV1 {
  readonly schema: "code-doc-witness/v1";
  readonly witnessId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly commitSha: string;
  readonly iteration: number;
  readonly paths: readonly string[];
  readonly reconciledAt: string;
}
export interface RetiredCodeDocRepointV1 {
  readonly schema: "code-doc-witness-repoint/v1";
  readonly recordId: string;
  readonly supersedes: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly commitSha: string;
  readonly iteration: number;
  readonly paths: readonly string[];
  readonly disposition: RetiredCodeDocDisposition;
  readonly reason: string;
  readonly repointedAt: string;
}

export function isRetiredCodeDocEventType(type: string): type is RetiredCodeDocEventType {
  return (retiredCodeDocEventTypes as readonly string[]).includes(type);
}

export function isRetiredCodeDocRequirement(gateId: string): boolean {
  return gateId === retiredCodeDocGateId;
}

/** Historical only: the envelope shapes accepted history carries, never a current write schema. */
export function validateRetiredCodeDocPayload(
  type: RetiredCodeDocEventType,
  payload: unknown,
  allowUnknownFields: boolean,
): readonly ContractValidationIssue[] {
  const issue: ContractValidationIssue = {
    code: "invalid_event_payload",
    message: "retired code/doc reconciliation history is not a readable envelope",
  };
  if (!isRecord(payload)) return [issue];
  const record = type === "code_doc_reconciled" ? payload.witness : payload.record;
  if (!isRecord(record)) return [issue];
  const schema = type === "code_doc_reconciled" ? "code-doc-witness/v1" : "code-doc-witness-repoint/v1";
  const strings =
    type === "code_doc_reconciled"
      ? [record.witnessId, record.taskId, record.executionId, record.commitSha, record.reconciledAt]
      : [
          record.recordId,
          record.supersedes,
          record.taskId,
          record.executionId,
          record.commitSha,
          record.reason,
          record.repointedAt,
        ];
  return record.schema === schema &&
    strings.every((value) => typeof value === "string" && value.length > 0) &&
    Number.isSafeInteger(record.iteration) &&
    Array.isArray(record.paths) &&
    record.paths.every((value) => typeof value === "string") &&
    (type === "code_doc_reconciled" ||
      (retiredCodeDocDispositions as readonly string[]).includes(record.disposition as string)) &&
    isRecord(record.actor) &&
    isRecord(record.actor.principal) &&
    typeof record.actor.principal.personId === "string" &&
    (record.actor.executor === null || isRecord(record.actor.executor)) &&
    validateWriteSource(record.source, allowUnknownFields).length === 0
    ? []
    : [issue];
}

/**
 * Historical reload still checks that each retired event claimed exactly the documents it published:
 * the two lifecycle records plus the anchor file the command wrote. New writes never reach this
 * branch because the retired types are rejected by current admission.
 */
export function retiredCodeDocDocumentPaths(executionId: string, packagePath: string): readonly string[] {
  return [
    `${packagePath}/INDEX.md`,
    `${packagePath}/executions/${executionId}.md`,
    `${packagePath}/${retiredCodeDocAnchorFile}`,
  ];
}
