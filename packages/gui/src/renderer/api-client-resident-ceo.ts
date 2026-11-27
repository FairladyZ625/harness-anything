import { isRendererRecord, localErrorHint } from "./result-validation.ts";

export type ResidentCeoProfileStatus = "stopped" | "running";
export type ResidentCeoWakeStatus = "running" | "succeeded" | "failed";
export type ResidentCeoWakeCause = "heartbeat" | "peer-request" | "human-chat";
export type ResidentCeoExecutionPolicy = "advisory-only" | "approval-gated";
export type ResidentCeoProposalStatus = "pending_approval" | "promoted" | "rejected" | "failed";
export type ResidentCeoPromotedTaskStatus = "done" | "cancelled";
export type ResidentCeoApprovalMode = "manual" | "allowlist-auto" | "decider-auto" | "owner-direct";
export type ResidentCeoApprovalGateMode = "off" | "secondary-guard" | "auto-promote";

export interface ResidentCeoApprovalGateConfigRead {
  readonly mode: ResidentCeoApprovalGateMode;
  readonly providerId?: string | null;
  readonly minConfidence?: number;
}

export interface ResidentCeoGateVerdictRead {
  readonly mode: ResidentCeoApprovalGateMode;
  readonly selected: "approve_low_risk" | "require_human_approval" | "insufficient_information" | null;
  readonly confidence: number | null;
  readonly minConfidence: number;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly evaluatedAt: string;
  readonly fallbackReason: string | null;
}

export interface ResidentCeoWakeReceiptRead {
  readonly wakeId: string;
  readonly cause: ResidentCeoWakeCause;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly status: ResidentCeoWakeStatus;
  readonly runtimeSessionId: string | null;
  readonly peerRequestId?: string;
  readonly detail: string | null;
}

export interface ResidentCeoDelegationProposalRead {
  readonly proposalId: string;
  readonly peerRequestId: string;
  readonly fromPersonId: string;
  readonly summary: string;
  readonly actionKind?:
    | "promote_and_dispatch"
    | "start_and_dispatch_existing"
    | "archive_or_cancel_unleased"
    | "doc_sync_plan";
  readonly sourceChannel?: "peer-request" | "human-chat";
  readonly targetTaskId?: string | null;
  readonly cleanupMode?: "archive" | "cancel" | null;
  readonly proposedTitle: string;
  readonly proposedWorkId: string | null;
  readonly proposedAgentId: string | null;
  readonly proposedTargetNodeId?: string | null;
  readonly proposedPrompt: string | null;
  readonly rationale: string;
  readonly wakeId: string;
  readonly status: ResidentCeoProposalStatus;
  readonly approvalMode: ResidentCeoApprovalMode | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedByPersonId: string | null;
  readonly promotedTaskId: string | null;
  readonly dispatchedTargetNodeId?: string | null;
  readonly dispatchRuntimeSessionId: string | null;
  readonly dispatchError: string | null;
  readonly rejectionReason: string | null;
  readonly gateVerdict?: ResidentCeoGateVerdictRead | null;
  readonly terminalOutcome: {
    readonly taskStatus: ResidentCeoPromotedTaskStatus;
    readonly summary: string;
    readonly reportedAt: string;
  } | null;
}

export interface ResidentCeoHistoryExecutionSummaryRead {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly toolCallCount?: number;
  readonly model?: string;
  readonly runtimeInstanceId?: string;
  readonly permissionMode?: string | null;
}

export interface ResidentCeoHistoryEntryRead {
  readonly wakeId: string;
  readonly cause: ResidentCeoWakeCause;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly status: ResidentCeoWakeStatus;
  readonly runtimeSessionId: string | null;
  readonly peerRequestId?: string | null;
  readonly fromPersonId?: string | null;
  readonly peerSummary?: string | null;
  readonly requestText: string | null;
  readonly responseText: string | null;
  readonly detail: string | null;
  readonly proposalId?: string | null;
  readonly execution?: ResidentCeoHistoryExecutionSummaryRead | null;
}

export interface ResidentCeoProfileRead {
  readonly schema: "resident-ceo-profile/v1";
  readonly principalPersonId: string;
  readonly repoId?: string;
  readonly runtimeInstanceId: string;
  readonly model: string;
  readonly heartbeatIntervalSec: number;
  readonly executionPolicy?: ResidentCeoExecutionPolicy;
  readonly defaultWorkId?: string | null;
  readonly defaultAgentId?: string | null;
  readonly autoApproveSenders?: readonly string[];
  readonly approvalGate?: ResidentCeoApprovalGateConfigRead;
  readonly persistentSessionId: string | null;
  readonly status: ResidentCeoProfileStatus;
  readonly lastWake: ResidentCeoWakeReceiptRead | null;
  readonly proposals?: readonly ResidentCeoDelegationProposalRead[];
  readonly history?: readonly ResidentCeoHistoryEntryRead[];
  readonly updatedAt: string;
}

export interface ResidentCeoActionReceiptRead {
  readonly tier: "tier0" | "tier1" | "tier2";
  readonly actionKind: string;
  readonly outcome: string;
  readonly approvalMode: string | null;
  readonly targetRef: string | null;
  readonly resultRef: string | null;
  readonly proposalId: string | null;
  readonly requestId?: string | null;
  readonly taskId?: string | null;
  readonly runtimeSessionId?: string | null;
  readonly errorCode: string | null;
  readonly detail: string;
}

export interface ResidentCeoReceipt {
  readonly ok: true;
  readonly profile: ResidentCeoProfileRead | null;
  readonly summary?: string;
  readonly response?: string | null;
  readonly actionReceipts?: readonly ResidentCeoActionReceiptRead[];
}

export interface ResidentCeoProposalsReceipt {
  readonly ok: true;
  readonly profile: ResidentCeoProfileRead | null;
  readonly summary?: string;
  readonly proposals: readonly ResidentCeoDelegationProposalRead[];
}

export interface ResidentCeoHistoryReceipt {
  readonly ok: true;
  readonly profile: ResidentCeoProfileRead | null;
  readonly summary?: string;
  readonly history: readonly ResidentCeoHistoryEntryRead[];
}

export interface ResidentCeoProposalDecisionReceipt {
  readonly ok: true;
  readonly profile: ResidentCeoProfileRead | null;
  readonly summary?: string;
  readonly proposal: ResidentCeoDelegationProposalRead;
  readonly promotedTaskId?: string | null;
  readonly dispatchedTargetNodeId?: string | null;
  readonly dispatchRuntimeSessionId?: string | null;
  readonly dispatchError?: string | null;
}

export interface ResidentCeoConfigureInput {
  readonly repoId: string;
  readonly runtimeInstanceId: string;
  readonly model: string;
  readonly heartbeatIntervalSec: number;
  readonly executionPolicy?: ResidentCeoExecutionPolicy;
  readonly defaultWorkId?: string | null;
  readonly defaultAgentId?: string | null;
  readonly autoApproveSenders?: readonly string[];
  readonly gateMode?: ResidentCeoApprovalGateMode;
  readonly gateProviderId?: string | null;
  readonly gateMinConfidence?: number;
}

export interface ResidentCeoApproveProposalInput {
  readonly repoId: string;
  readonly proposalId: string;
  readonly workId?: string;
  readonly title?: string;
  readonly agentId?: string;
  readonly targetNodeId?: string;
  readonly runtimeInstanceId?: string;
  readonly model?: string;
  readonly prompt?: string;
}

export interface ResidentCeoRejectProposalInput {
  readonly repoId: string;
  readonly proposalId: string;
  readonly reason: string;
}

export interface ResidentCeoHistoryQuery {
  readonly repoId: string;
  readonly limit?: number;
  readonly cause?: ResidentCeoWakeCause;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isResidentCeoHistoryEntry(value: unknown): value is ResidentCeoHistoryEntryRead {
  return (
    isRendererRecord(value) &&
    typeof value.wakeId === "string" &&
    (value.cause === "heartbeat" || value.cause === "peer-request" || value.cause === "human-chat") &&
    typeof value.requestedAt === "string" &&
    isNullableString(value.completedAt) &&
    (value.status === "running" || value.status === "succeeded" || value.status === "failed") &&
    isNullableString(value.runtimeSessionId) &&
    (value.requestText === undefined || isNullableString(value.requestText)) &&
    (value.responseText === undefined || isNullableString(value.responseText)) &&
    (value.detail === undefined || isNullableString(value.detail))
  );
}

export function isResidentCeoProposal(value: unknown): value is ResidentCeoDelegationProposalRead {
  return (
    isRendererRecord(value) &&
    typeof value.proposalId === "string" &&
    typeof value.peerRequestId === "string" &&
    typeof value.fromPersonId === "string" &&
    typeof value.summary === "string" &&
    typeof value.proposedTitle === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "string"
  );
}

/**
 * N/N-1 compatible Resident CEO profile guard: accepts both Phase 1 profiles without optional
 * Phase 2/3 fields and newer daemon profiles with `repoId`, `executionPolicy`, `autoApproveSenders`,
 * `defaultAgentId`, `defaultWorkId`, `approvalGate`, `proposals`, `history`, or future additive fields.
 */
export function isResidentCeoProfile(value: unknown): value is ResidentCeoProfileRead {
  if (
    !isRendererRecord(value) ||
    value.schema !== "resident-ceo-profile/v1" ||
    typeof value.principalPersonId !== "string" ||
    typeof value.runtimeInstanceId !== "string" ||
    typeof value.model !== "string" ||
    !Number.isSafeInteger(value.heartbeatIntervalSec) ||
    !isNullableString(value.persistentSessionId) ||
    (value.status !== "running" && value.status !== "stopped") ||
    (value.lastWake !== null && !isRendererRecord(value.lastWake)) ||
    typeof value.updatedAt !== "string"
  )
    return false;
  if (value.repoId !== undefined && typeof value.repoId !== "string") return false;
  if (value.executionPolicy !== undefined && typeof value.executionPolicy !== "string") return false;
  if (value.defaultWorkId !== undefined && !isNullableString(value.defaultWorkId)) return false;
  if (value.defaultAgentId !== undefined && !isNullableString(value.defaultAgentId)) return false;
  if (
    value.autoApproveSenders !== undefined &&
    (!Array.isArray(value.autoApproveSenders) || !value.autoApproveSenders.every((entry) => typeof entry === "string"))
  )
    return false;
  if (value.approvalGate !== undefined && !isRendererRecord(value.approvalGate)) return false;
  if (
    value.proposals !== undefined &&
    (!Array.isArray(value.proposals) || !value.proposals.every(isResidentCeoProposal))
  )
    return false;
  if (value.history !== undefined && (!Array.isArray(value.history) || !value.history.every(isResidentCeoHistoryEntry)))
    return false;
  return true;
}

export function readResidentCeoStatusReceipt(value: unknown): ResidentCeoReceipt {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    (value.profile !== null && !isResidentCeoProfile(value.profile)) ||
    (value.response !== undefined && value.response !== null && typeof value.response !== "string")
  )
    throw new Error(localErrorHint(value, "Resident CEO status returned an invalid result."));
  return value as unknown as ResidentCeoReceipt;
}

export function readResidentCeoReceipt(value: unknown): ResidentCeoReceipt {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    !isResidentCeoProfile(value.profile) ||
    (value.response !== undefined && value.response !== null && typeof value.response !== "string")
  )
    throw new Error(localErrorHint(value, "Resident CEO command returned an invalid result."));
  return value as unknown as ResidentCeoReceipt;
}

export function readResidentCeoProposalsReceipt(value: unknown): ResidentCeoProposalsReceipt {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    (value.profile !== null && !isResidentCeoProfile(value.profile)) ||
    !Array.isArray(value.proposals) ||
    !value.proposals.every(isResidentCeoProposal)
  )
    throw new Error(localErrorHint(value, "Resident CEO proposals returned an invalid result."));
  return value as unknown as ResidentCeoProposalsReceipt;
}

export function readResidentCeoHistoryReceipt(value: unknown): ResidentCeoHistoryReceipt {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    (value.profile !== null && !isResidentCeoProfile(value.profile)) ||
    !Array.isArray(value.history) ||
    !value.history.every(isResidentCeoHistoryEntry)
  )
    throw new Error(localErrorHint(value, "Resident CEO history returned an invalid result."));
  return value as unknown as ResidentCeoHistoryReceipt;
}

export function readResidentCeoProposalDecisionReceipt(value: unknown): ResidentCeoProposalDecisionReceipt {
  if (
    !isRendererRecord(value) ||
    value.ok !== true ||
    (value.profile !== null && !isResidentCeoProfile(value.profile)) ||
    !isResidentCeoProposal(value.proposal)
  )
    throw new Error(localErrorHint(value, "Resident CEO proposal decision returned an invalid result."));
  return value as unknown as ResidentCeoProposalDecisionReceipt;
}
