import {
  hasOnlyFields,
  isNonEmptyString,
  isRecord,
  validateActorAxes
} from "./task.ts";
import type { ActorAxes, ContractValidationIssue } from "./task.ts";
import type { TaskNodeId } from "./task-graph.ts";

export const executionStates = ["active", "submitted", "accepted", "changes_requested", "abandoned"] as const;
export type ExecutionState = (typeof executionStates)[number];

export interface ExecutionActor {
  readonly principal: {
    readonly personId: string;
    readonly displayName?: string;
    readonly primaryEmail?: string;
    readonly providerId?: string;
    readonly credential?: { readonly kind: string; readonly issuer: string; readonly subject: string };
  };
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  readonly responsibleHuman: string;
}

export interface ExecutionCaptureRange {
  readonly range_id: string;
  readonly coordinate: "timestamp";
  readonly start_at: string;
  readonly end_at: string | null;
  readonly bounds: "inclusive";
}

export interface ExecutionSessionBindingRecord {
  readonly binding_id: string;
  readonly session_ref: string | null;
  readonly role: "primary" | "subagent" | "reviewer_observer";
  readonly archive_status: "pending" | "complete" | "partial" | "unavailable";
  readonly attached_at: string;
  readonly session: {
    readonly runtime: string;
    readonly sessionId: string;
    readonly source: string;
    readonly detectedAt: string;
    readonly user?: string;
  } | null;
  readonly capture_range: ExecutionCaptureRange | null;
}

export interface CheckerReceipt {
  readonly checker_id: string;
  readonly checker_version: string;
  readonly target_evidence_id: string;
  readonly target_sha256: string | null;
  readonly checked_at: string;
  readonly result: "pass" | "fail";
}

export type OutputEvidenceLocator =
  | { readonly substrate: "inline"; readonly text: string }
  | { readonly substrate: "file"; readonly path: string }
  | { readonly substrate: "url"; readonly url: string }
  | { readonly substrate: "object"; readonly ref: string; readonly sha256: string; readonly size: number; readonly media_type: string }
  | { readonly substrate: "entity"; readonly entity_ref: string }
  | { readonly substrate: "checker_receipt"; readonly receipt: CheckerReceipt };

export interface OutputEvidence {
  readonly evidence_id: string;
  readonly execution_ref: string;
  readonly locator: OutputEvidenceLocator;
  readonly sha256?: string;
  readonly checker_receipt_ref?: string;
}

export interface SubmissionPacket {
  readonly completion_claim: string;
  readonly deliverables: ReadonlyArray<string>;
  readonly evidence_refs: ReadonlyArray<string>;
  readonly verification_notes: ReadonlyArray<string>;
  readonly known_gaps: ReadonlyArray<string>;
  readonly residual_risks: ReadonlyArray<string>;
}

export interface ExecutionRecord {
  readonly schema: "execution/v2";
  readonly execution_id: string;
  readonly task_ref: string;
  readonly state: ExecutionState;
  readonly primary_actor: ExecutionActor;
  readonly claimed_at: string;
  readonly submitted_at: string | null;
  readonly closed_at: string | null;
  readonly session_bindings: ReadonlyArray<ExecutionSessionBindingRecord>;
  readonly outputs: ReadonlyArray<OutputEvidence>;
  readonly submission: SubmissionPacket | null;
}

export const executionV1States = ["active", "submitted", "changes_requested", "accepted"] as const;
export type ExecutionV1State = (typeof executionV1States)[number];
export interface SubmissionV1 { readonly claim: string; readonly deliverables: readonly string[]; readonly evidenceRefs: readonly string[]; readonly verification: readonly string[]; readonly knownGaps: readonly string[]; readonly residualRisks: readonly string[]; readonly commitSha: string }
export interface ExecutionV1 { readonly schema: "execution/v1"; readonly executionId: string; readonly taskId: string; readonly nodeId: TaskNodeId; readonly iteration: 0 | 1; readonly state: ExecutionV1State; readonly actor: ActorAxes; readonly claimedAt: string; readonly submittedAt: string | null; readonly closedAt: string | null; readonly submission: SubmissionV1 | null }
export interface LeaseV1 { readonly schema: "lease/v1"; readonly taskId: string; readonly executionId: string; readonly actor: ActorAxes; readonly credentialHash: string; readonly phase: "reserving" | "active" | "released"; readonly expiresAt: string; readonly version: number }
export const EXECUTION_V1_SCHEMA = Object.freeze({ id: "Execution/v1", required: Object.freeze(["schema", "executionId", "taskId", "nodeId", "iteration", "state", "actor", "claimedAt", "submittedAt", "closedAt", "submission"]), states: executionV1States });
export const LEASE_V1_SCHEMA = Object.freeze({ id: "Lease/v1", required: Object.freeze(["schema", "taskId", "executionId", "actor", "credentialHash", "phase", "expiresAt", "version"]) });
export function isNativeCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNonEmptyString);
}
export function validateSubmissionV1(value: unknown): readonly ContractValidationIssue[] {
  const fields = ["claim", "deliverables", "evidenceRefs", "verification", "knownGaps", "residualRisks", "commitSha"];
  if (!isRecord(value) || !hasOnlyFields(value, fields) || !isNonEmptyString(value.claim)
    || !stringArray(value.deliverables) || !stringArray(value.evidenceRefs) || !stringArray(value.verification)
    || !stringArray(value.knownGaps) || !stringArray(value.residualRisks) || !isNativeCommitSha(value.commitSha)) {
    return [{ code: "invalid_submission", message: "Submission must be complete and use a native 40-character commit SHA" }];
  }
  return [];
}
export function validateExecutionV1(value: unknown): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !hasOnlyFields(value, EXECUTION_V1_SCHEMA.required)) return [{ code: "invalid_execution", message: "Execution/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "execution/v1") issues.push({ code: "invalid_schema", message: "Execution must use execution/v1" });
  if (!isNonEmptyString(value.executionId) || !isNonEmptyString(value.taskId) || value.nodeId !== "implementation") issues.push({ code: "invalid_execution", message: "execution identity is invalid" });
  if (value.iteration !== 0 && value.iteration !== 1) issues.push({ code: "invalid_iteration", message: "execution iteration must be 0 or 1" });
  if (!(executionV1States as readonly unknown[]).includes(value.state)) issues.push({ code: "invalid_execution", message: "invalid execution state" });
  if (!isNonEmptyString(value.claimedAt) || (value.submittedAt !== null && !isNonEmptyString(value.submittedAt)) || (value.closedAt !== null && !isNonEmptyString(value.closedAt))) issues.push({ code: "invalid_execution", message: "execution timestamps are invalid" });
  issues.push(...validateActorAxes(value.actor));
  if (value.submission !== null) issues.push(...validateSubmissionV1(value.submission));
  return issues;
}
export function validateLeaseV1(value: unknown): readonly ContractValidationIssue[] {
  if (!isRecord(value) || !hasOnlyFields(value, LEASE_V1_SCHEMA.required)) return [{ code: "invalid_lease", message: "Lease/v1 fields are incomplete or unknown" }];
  const issues: ContractValidationIssue[] = [];
  if (value.schema !== "lease/v1") issues.push({ code: "invalid_schema", message: "Lease must use lease/v1" });
  if (!isNonEmptyString(value.taskId) || !isNonEmptyString(value.executionId) || !isNonEmptyString(value.credentialHash)
    || !isNonEmptyString(value.expiresAt) || !Number.isInteger(value.version) || typeof value.version !== "number" || value.version < 0
    || !["reserving", "active", "released"].includes(String(value.phase))) issues.push({ code: "invalid_lease", message: "lease identity, phase, or version is invalid" });
  issues.push(...validateActorAxes(value.actor));
  return issues;
}
