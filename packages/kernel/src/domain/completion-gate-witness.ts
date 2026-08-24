import { validateActorAxes, type ActorAxes, type ContractValidationIssue } from "./task.ts";
import { isNativeCommitSha } from "./execution.ts";
import {
  hasOnlyFields,
  hasRequiredFields,
  isNonEmptyString,
  validateWriteSource,
  type WriteSource,
} from "./write-chain.contract.ts";

export interface CompletionGateWitnessV1 {
  readonly schema: "completion-gate-witness/v1";
  readonly witnessId: string;
  readonly receiptId: string;
  readonly checkerId: string;
  readonly gateId: string;
  readonly result: "pass";
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
    hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
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
    record.result !== "pass" ||
    !isNativeCommitSha(record.commitSha) ||
    (record.iteration !== 0 && record.iteration !== 1) ||
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
