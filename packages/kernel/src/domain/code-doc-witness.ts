import { consumeKnownError } from "../error-consumption.ts";
import { isNativeCommitSha } from "./execution.ts";
import { hasOnlyFields, isNonEmptyString, isRecord, validateActorAxes } from "./task.ts";
import type { ActorAxes, ContractValidationIssue } from "./task.ts";
import { hasRequiredFields, validateWriteSource, type WriteSource } from "./write-chain.contract.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
export interface CodeDocWitnessV1 {
  readonly schema: "code-doc-witness/v1";
  readonly witnessId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly commitSha: string;
  readonly iteration: 0 | 1;
  readonly paths: readonly string[];
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly reconciledAt: string;
}
export interface CodeDocRepointV1 {
  readonly schema: "code-doc-witness-repoint/v1";
  readonly recordId: string;
  readonly supersedes: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly commitSha: string;
  readonly iteration: 0 | 1;
  readonly paths: readonly string[];
  readonly disposition: "repointed" | "known-invalid";
  readonly reason: string;
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly repointedAt: string;
}
export type CodeDocWitnessRecord = CodeDocWitnessV1 | CodeDocRepointV1;
export function validateCodeDocWitnessV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "schema",
      "witnessId",
      "taskId",
      "executionId",
      "commitSha",
      "iteration",
      "paths",
      "actor",
      "source",
      "reconciledAt",
    ])
  )
    return [{ code: "invalid_witness", message: "CodeDocWitness/v1 fields are incomplete or unknown" }];
  const canonical = canonicalCodeDocPaths(value.paths);
  return value.schema === "code-doc-witness/v1" &&
    [value.witnessId, value.taskId, value.executionId, value.reconciledAt].every(isNonEmptyString) &&
    isNativeCommitSha(value.commitSha) &&
    (value.iteration === 0 || value.iteration === 1) &&
    canonical &&
    validateActorAxes(value.actor, allowUnknownFields).length === 0 &&
    validateWriteSource(value.source, allowUnknownFields).length === 0
    ? []
    : [{ code: "invalid_witness", message: "code-doc witness must bind canonical paths to an execution commit" }];
}
export function validateCodeDocRepointV1(
  value: unknown,
  allowUnknownFields = false,
): readonly ContractValidationIssue[] {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "schema",
      "recordId",
      "supersedes",
      "taskId",
      "executionId",
      "commitSha",
      "iteration",
      "paths",
      "disposition",
      "reason",
      "actor",
      "source",
      "repointedAt",
    ])
  )
    return [{ code: "invalid_witness", message: "CodeDocWitness repoint/v1 fields are incomplete or unknown" }];
  const paths = value.disposition === "repointed"
    ? canonicalCodeDocPaths(value.paths)
    : canonicalCodeDocPaths(value.paths, true) && value.paths.length === 0;
  return value.schema === "code-doc-witness-repoint/v1" &&
    [value.recordId, value.supersedes, value.taskId, value.executionId, value.reason, value.repointedAt].every(
      isNonEmptyString,
    ) &&
    isNativeCommitSha(value.commitSha) &&
    (value.iteration === 0 || value.iteration === 1) &&
    (value.disposition === "repointed" || value.disposition === "known-invalid") &&
    paths &&
    validateActorAxes(value.actor, allowUnknownFields).length === 0 &&
    validateWriteSource(value.source, allowUnknownFields).length === 0
    ? []
    : [{ code: "invalid_witness", message: "code-doc repoint must state a valid replacement or known-invalid disposition" }];
}
export function canonicalCodeDocPaths(value: unknown, allowEmpty = false): value is readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || new Set(value).size !== value.length) return false;
  try {
    return value.every((path) => typeof path === "string" && normalizeRelativeDocumentPath(path) === path);
  } catch (error) {
    consumeKnownError(error);
    return false;
  }
}
export function sameCodeDocPaths(
  left: unknown,
  right: readonly string[],
  allowEmpty = false,
): boolean {
  return canonicalCodeDocPaths(left, allowEmpty) &&
    canonicalCodeDocPaths(right, allowEmpty) &&
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
export function codeDocRecordId(value: CodeDocWitnessRecord): string {
  return value.schema === "code-doc-witness/v1" ? value.witnessId : value.recordId;
}
export function currentCodeDocRecord(
  records: readonly CodeDocWitnessRecord[],
  executionId: string,
): CodeDocWitnessRecord | undefined {
  const executionRecords = records.filter((value) => value.executionId === executionId),
    superseded = new Set(
      executionRecords.flatMap((value) => value.schema === "code-doc-witness-repoint/v1" ? [value.supersedes] : []),
    ),
    active = executionRecords.filter((value) => !superseded.has(codeDocRecordId(value)));
  return active.length === 1 ? active[0] : undefined;
}
export function currentCodeDocWitness(
  records: readonly CodeDocWitnessRecord[],
  executionId: string,
): CodeDocWitnessV1 | CodeDocRepointV1 | undefined {
  const record = currentCodeDocRecord(records, executionId);
  return record?.schema === "code-doc-witness/v1" || record?.disposition === "repointed" ? record : undefined;
}
