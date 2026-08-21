import {
  hasOnlyFields,
  isNonEmptyString,
  isRecord,
  validateActorAxes
} from "./task.ts";
import type { ActorAxes, ContractValidationIssue } from "./task.ts";
import type { TaskNodeId } from "./task-graph.ts";
import { timestamp } from "./timestamp.ts";
import { hasRequiredFields, validateWriteSource } from "./write-chain.contract.ts";
import type { WriteSource } from "./write-chain.contract.ts";

export const executionStates = ["active", "submitted", "accepted", "changes_requested", "abandoned"] as const;
export type ExecutionState = (typeof executionStates)[number];
export const leasePhases = ["reserving", "held", "orphaned", "released"] as const;
export type LeasePhase = (typeof leasePhases)[number];

export const executionV1States = ["active", "submitted", "changes_requested", "accepted"] as const;
export type ExecutionV1State = (typeof executionV1States)[number];
export interface SubmissionV1 { readonly completionClaim: string; readonly deliverables: readonly string[]; readonly outputs: readonly string[]; readonly verificationNotes: readonly string[]; readonly knownGaps: readonly string[]; readonly residualRisks: readonly string[]; readonly commitSha: string }
export interface ExecutionV1 { readonly schema: "execution/v1"; readonly executionId: string; readonly taskId: string; readonly nodeId: TaskNodeId; readonly iteration: 0 | 1; readonly state: ExecutionV1State; readonly actor: ActorAxes; readonly claimedAt: string; readonly submittedAt: string | null; readonly closedAt: string | null; readonly submission: SubmissionV1 | null }
export interface ArchivedExecutionOutputV0 { readonly migratedFrom: string; readonly locator: string; readonly substrate: "repository-path" | "uri" | "canonical-event" | "opaque"; readonly checkerReceiptRef: string | null; readonly checkerResult: "pass" | "fail" | "unknown" }
export interface ArchivedExecutionV0 { readonly schema: "archived-execution/v1"; readonly generation: "v0"; readonly migratedFrom: string; readonly executionId: string; readonly taskId: string; readonly nodeId: "implementation"; readonly iteration: 0 | 1; readonly state: ExecutionState; readonly actor: ActorAxes; readonly claimedAt: string; readonly submittedAt: string | null; readonly closedAt: string | null; readonly sessionBindings: readonly Readonly<Record<string, unknown>>[]; readonly outputs: readonly ArchivedExecutionOutputV0[]; readonly submission: null; readonly archivedSubmission: Omit<SubmissionV1, "commitSha" | "outputs"> & { readonly evidenceRefs: readonly string[] } | null }
export type ProjectedExecution = ExecutionV1 | ArchivedExecutionV0;
export function isNativeExecution(value: ProjectedExecution): value is ExecutionV1 { return value.schema === "execution/v1"; }
export interface LeaseHolder { readonly taskId: string; readonly executionId: string; readonly actor: ActorAxes; readonly source: WriteSource }
export interface LeaseV1 extends LeaseHolder { readonly schema: "lease/v1"; readonly phase: LeasePhase; readonly expiresAt: string; readonly ttlMs: number; readonly version: number }
export const TASK_LEASE_BROKER_CONTRACT = Object.freeze({ capacity: 32 });
export const EXECUTION_V1_SCHEMA = Object.freeze({ id: "Execution/v1", required: Object.freeze(["schema", "executionId", "taskId", "nodeId", "iteration", "state", "actor", "claimedAt", "submittedAt", "closedAt", "submission"]), states: executionV1States });
export const LEASE_V1_SCHEMA = Object.freeze({ id: "Lease/v1", required: Object.freeze(["schema", "taskId", "executionId", "actor", "source", "phase", "expiresAt", "ttlMs", "version"]) });
const LEASE_HOLDER_FIELDS = ["taskId", "executionId", "actor", "source"] as const;
export function isNativeCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNonEmptyString);
}
export function validateSubmissionV1(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  const fields = ["completionClaim", "deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks", "commitSha"];
  if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, fields) || !isNonEmptyString(value.completionClaim)
    || !stringArray(value.deliverables) || !stringArray(value.outputs) || !stringArray(value.verificationNotes)
    || !stringArray(value.knownGaps) || !stringArray(value.residualRisks) || !isNativeCommitSha(value.commitSha)) {
    return [{ code: "invalid_submission", message: "Submission must be complete and use a native 40-character commit SHA" }];
  }
  return [];
}
export function validateExecutionV1(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, EXECUTION_V1_SCHEMA.required)) return [{ code: "invalid_execution", message: "Execution/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "execution/v1") issues.push({ code: "invalid_schema", message: "Execution must use execution/v1" });
  if (!isNonEmptyString(value.executionId) || !isNonEmptyString(value.taskId) || value.nodeId !== "implementation") issues.push({ code: "invalid_execution", message: "execution identity is invalid" });
  if (value.iteration !== 0 && value.iteration !== 1) issues.push({ code: "invalid_iteration", message: "execution iteration must be 0 or 1" });
  if (!(executionV1States as readonly unknown[]).includes(value.state)) issues.push({ code: "invalid_execution", message: "invalid execution state" });
  if (!isNonEmptyString(value.claimedAt) || (value.submittedAt !== null && !isNonEmptyString(value.submittedAt)) || (value.closedAt !== null && !isNonEmptyString(value.closedAt))) issues.push({ code: "invalid_execution", message: "execution timestamps are invalid" });
  issues.push(...validateActorAxes(value.actor, allowUnknownFields));
  if (value.submission !== null) issues.push(...validateSubmissionV1(value.submission, allowUnknownFields));
  return issues;
}
export function validateArchivedExecutionV0(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] { const fields = ["schema", "generation", "migratedFrom", "executionId", "taskId", "nodeId", "iteration", "state", "actor", "claimedAt", "submittedAt", "closedAt", "sessionBindings", "outputs", "submission", "archivedSubmission"]; if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, fields) || value.schema !== "archived-execution/v1" || value.generation !== "v0" || !isNonEmptyString(value.migratedFrom) || !isNonEmptyString(value.executionId) || !isNonEmptyString(value.taskId) || value.nodeId !== "implementation" || value.iteration !== 0 && value.iteration !== 1 || !(executionStates as readonly unknown[]).includes(value.state) || validateActorAxes(value.actor, allowUnknownFields).length || !timestamp(value.claimedAt) || value.submittedAt !== null && !timestamp(value.submittedAt) || value.closedAt !== null && !timestamp(value.closedAt) || !Array.isArray(value.sessionBindings) || !value.sessionBindings.every(isRecord) || !Array.isArray(value.outputs) || !value.outputs.every((output) => archivedOutput(output, allowUnknownFields)) || value.submission !== null || value.archivedSubmission !== null && !archivedSubmission(value.archivedSubmission, allowUnknownFields)) return [{ code: "invalid_execution", message: "archived execution fields or migration provenance are invalid" }]; return []; }
export function validateLeaseV1(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, LEASE_V1_SCHEMA.required)) return [{ code: "invalid_lease", message: "Lease/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "lease/v1") issues.push({ code: "invalid_schema", message: "Lease must use lease/v1" });
  if (!isNonEmptyString(value.taskId) || !isNonEmptyString(value.executionId) || !isNonEmptyString(value.expiresAt)
    || !Number.isInteger(value.ttlMs) || typeof value.ttlMs !== "number" || value.ttlMs < 1
    || !Number.isInteger(value.version) || typeof value.version !== "number" || value.version < 0
    || !["reserving", "held", "orphaned", "released"].includes(String(value.phase))
    || validateWriteSource(value.source, allowUnknownFields).length > 0) issues.push({ code: "invalid_lease", message: "lease holder, lifecycle, or version is invalid" });
  issues.push(...validateLeaseHolder({ taskId: value.taskId, executionId: value.executionId, actor: value.actor, source: value.source }, allowUnknownFields));
  return issues;
}
export function validateLeaseHolder(value: unknown, allowUnknownFields = false): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, LEASE_HOLDER_FIELDS) || !isNonEmptyString(value.taskId) || !isNonEmptyString(value.executionId)
    || validateActorAxes(value.actor, allowUnknownFields).length > 0 || validateWriteSource(value.source, allowUnknownFields).length > 0) return [{ code: "invalid_lease_holder", message: "lease holder requires task, execution, actor, and source" }];
  return [];
}
function archivedOutput(value: unknown, allowUnknownFields: boolean): boolean { return isRecord(value) && (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, ["migratedFrom", "locator", "substrate", "checkerReceiptRef", "checkerResult"]) && isNonEmptyString(value.migratedFrom) && isNonEmptyString(value.locator) && ["repository-path", "uri", "canonical-event", "opaque"].includes(String(value.substrate)) && (value.checkerReceiptRef === null || isNonEmptyString(value.checkerReceiptRef)) && ["pass", "fail", "unknown"].includes(String(value.checkerResult)) && (value.checkerResult === "unknown" || value.checkerReceiptRef !== null); }
function archivedSubmission(value: unknown, allowUnknownFields: boolean): boolean { return isRecord(value) && (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, ["completionClaim", "deliverables", "evidenceRefs", "verificationNotes", "knownGaps", "residualRisks"]) && isNonEmptyString(value.completionClaim) && [value.deliverables, value.evidenceRefs, value.verificationNotes, value.knownGaps, value.residualRisks].every(stringArray); }
