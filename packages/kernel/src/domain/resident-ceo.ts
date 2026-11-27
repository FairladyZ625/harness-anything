export const RESIDENT_CEO_PROFILE_SCHEMA = "resident-ceo-profile/v1" as const;
export const RESIDENT_CEO_MIN_HEARTBEAT_INTERVAL_SEC = 30;
export const RESIDENT_CEO_MAX_HEARTBEAT_INTERVAL_SEC = 86_400;
export const RESIDENT_CEO_MAX_PROPOSALS = 50;
export const RESIDENT_CEO_DEFAULT_GATE_MIN_CONFIDENCE = 0.85;
export const RESIDENT_CEO_GATE_ABSTAIN_OPTION_ID = "insufficient_information" as const;
export const residentCeoProfileStatuses = ["stopped", "running"] as const;
export const residentCeoWakeStatuses = ["running", "succeeded", "failed"] as const;
export const residentCeoExecutionPolicies = ["advisory-only", "approval-gated"] as const;
export const residentCeoProposalStatuses = ["pending_approval", "promoted", "rejected", "failed"] as const;
export const residentCeoApprovalModes = ["manual", "allowlist-auto", "decider-auto"] as const;
export const residentCeoApprovalGateModes = ["off", "secondary-guard", "auto-promote"] as const;
export const residentCeoGateOptionIds = [
  "approve_low_risk",
  "require_human_approval",
  RESIDENT_CEO_GATE_ABSTAIN_OPTION_ID,
] as const;

export type ResidentCeoWakeCause = "heartbeat" | "peer-request" | "human-chat";
export type ResidentCeoProfileStatus = (typeof residentCeoProfileStatuses)[number];
export type ResidentCeoWakeStatus = (typeof residentCeoWakeStatuses)[number];
export type ResidentCeoExecutionPolicy = (typeof residentCeoExecutionPolicies)[number];
export type ResidentCeoProposalStatus = (typeof residentCeoProposalStatuses)[number];
export type ResidentCeoApprovalMode = (typeof residentCeoApprovalModes)[number];
export type ResidentCeoApprovalGateMode = (typeof residentCeoApprovalGateModes)[number];
export type ResidentCeoGateOptionId = (typeof residentCeoGateOptionIds)[number];
export type ResidentCeoPromotedTaskTerminalState = "done" | "cancelled";

export interface ResidentCeoApprovalGateConfig {
  readonly mode: ResidentCeoApprovalGateMode;
  readonly providerId?: string | null;
  readonly minConfidence?: number;
}

export interface ResidentCeoGateVerdict {
  readonly mode: ResidentCeoApprovalGateMode;
  readonly selected: ResidentCeoGateOptionId | null;
  readonly confidence: number | null;
  readonly minConfidence: number;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly evaluatedAt: string;
  readonly fallbackReason: string | null;
}

export interface ResidentCeoGateObservation {
  readonly selected: string | null;
  readonly distribution: Readonly<Record<string, number>> | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly evaluatedAt: string;
  readonly errorReason?: string | null;
}

export type ResidentCeoGateEvaluation =
  | {
      readonly allowAutoPromote: true;
      readonly workId: string;
      readonly verdict: ResidentCeoGateVerdict;
    }
  | {
      readonly allowAutoPromote: false;
      readonly verdict: ResidentCeoGateVerdict;
    };

export interface ResidentCeoWakeReceipt {
  readonly wakeId: string;
  readonly cause: ResidentCeoWakeCause;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly status: ResidentCeoWakeStatus;
  readonly runtimeSessionId: string | null;
  readonly peerRequestId?: string;
  readonly detail: string | null;
}

export interface ResidentCeoProposalTerminalOutcome {
  readonly taskStatus: ResidentCeoPromotedTaskTerminalState;
  readonly summary: string;
  readonly reportedAt: string;
}

export interface ResidentCeoDelegationProposal {
  readonly proposalId: string;
  readonly peerRequestId: string;
  readonly fromPersonId: string;
  readonly summary: string;
  readonly proposedTitle: string;
  readonly proposedWorkId: string | null;
  readonly proposedAgentId: string | null;
  readonly proposedTargetNodeId?: string | null;
  readonly proposedSupersedesTaskId?: string | null;
  readonly proposedPrompt: string | null;
  readonly rationale: string;
  readonly wakeId: string;
  readonly status: ResidentCeoProposalStatus;
  readonly approvalMode: ResidentCeoApprovalMode | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedByPersonId: string | null;
  readonly promotedTaskId: string | null;
  readonly supersededTaskId?: string | null;
  readonly supersedeError?: string | null;
  readonly dispatchedTargetNodeId?: string | null;
  readonly dispatchRuntimeSessionId: string | null;
  readonly dispatchError: string | null;
  readonly rejectionReason: string | null;
  readonly gateVerdict?: ResidentCeoGateVerdict | null;
  readonly terminalOutcome: ResidentCeoProposalTerminalOutcome | null;
}

export interface ResidentCeoProfile {
  readonly schema: typeof RESIDENT_CEO_PROFILE_SCHEMA;
  readonly principalPersonId: string;
  readonly repoId?: string;
  readonly runtimeInstanceId: string;
  readonly model: string;
  readonly heartbeatIntervalSec: number;
  readonly executionPolicy?: ResidentCeoExecutionPolicy;
  readonly defaultWorkId?: string | null;
  readonly defaultAgentId?: string | null;
  readonly autoApproveSenders?: readonly string[];
  readonly approvalGate?: ResidentCeoApprovalGateConfig;
  readonly persistentSessionId: string | null;
  readonly status: ResidentCeoProfileStatus;
  readonly lastWake: ResidentCeoWakeReceipt | null;
  readonly proposals?: readonly ResidentCeoDelegationProposal[];
  readonly updatedAt: string;
}

export type ResidentCeoProfileInput = Pick<
  ResidentCeoProfile,
  | "principalPersonId"
  | "repoId"
  | "runtimeInstanceId"
  | "model"
  | "heartbeatIntervalSec"
  | "executionPolicy"
  | "defaultWorkId"
  | "defaultAgentId"
  | "autoApproveSenders"
  | "approvalGate"
>;

export type ResidentCeoErrorCode =
  | "resident_ceo_invalid_profile"
  | "resident_ceo_principal_mismatch"
  | "resident_ceo_advisory_only"
  | "resident_ceo_proposal_not_found"
  | "resident_ceo_proposal_transition_invalid";

export class ResidentCeoProfileError extends Error {
  readonly code: ResidentCeoErrorCode;

  constructor(code: ResidentCeoErrorCode, message: string) {
    super(message);
    this.name = "ResidentCeoProfileError";
    this.code = code;
  }
}

const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TARGET_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isValidResidentCeoEntityId(value: string): boolean {
  return ENTITY_ID_PATTERN.test(value);
}

export function isValidResidentCeoTargetNodeId(value: string): boolean {
  return TARGET_NODE_ID_PATTERN.test(value) && !value.includes("..");
}

function normalizeOptionalEntityId(value: string | null | undefined, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!ENTITY_ID_PATTERN.test(trimmed))
    throw new ResidentCeoProfileError("resident_ceo_invalid_profile", `Invalid ${label}: ${value}.`);
  return trimmed;
}

function normalizeAutoApproveSenders(senders: readonly string[] | undefined): readonly string[] | undefined {
  if (senders === undefined) return undefined;
  const normalized: string[] = [];
  for (const sender of senders) {
    const trimmed = sender.trim();
    if (!ENTITY_ID_PATTERN.test(trimmed))
      throw new ResidentCeoProfileError("resident_ceo_invalid_profile", `Invalid auto-approve sender id: ${sender}.`);
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return Object.freeze(normalized);
}

export function isResidentCeoExecutionPolicy(value: unknown): value is ResidentCeoExecutionPolicy {
  return typeof value === "string" && (residentCeoExecutionPolicies as readonly string[]).includes(value);
}

export function effectiveResidentCeoExecutionPolicy(
  profile: Pick<ResidentCeoProfile, "executionPolicy">,
): ResidentCeoExecutionPolicy {
  return profile.executionPolicy ?? "advisory-only";
}

export function assertResidentCeoExecutionAllowed(
  profile: Pick<ResidentCeoProfile, "executionPolicy">,
  operation: string,
): void {
  if (effectiveResidentCeoExecutionPolicy(profile) !== "approval-gated") {
    throw new ResidentCeoProfileError(
      "resident_ceo_advisory_only",
      `Resident CEO execution policy is advisory-only; ${operation} requires --policy approval-gated.`,
    );
  }
}

function isValidGateMinConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

export function isResidentCeoApprovalGateMode(value: unknown): value is ResidentCeoApprovalGateMode {
  return typeof value === "string" && (residentCeoApprovalGateModes as readonly string[]).includes(value);
}

function isResidentCeoGateOptionId(value: unknown): value is ResidentCeoGateOptionId {
  return typeof value === "string" && (residentCeoGateOptionIds as readonly string[]).includes(value);
}

function normalizeApprovalGate(
  gate: ResidentCeoApprovalGateConfig | undefined,
): ResidentCeoApprovalGateConfig | undefined {
  if (gate === undefined) return undefined;
  if (!isResidentCeoApprovalGateMode(gate.mode)) {
    throw new ResidentCeoProfileError(
      "resident_ceo_invalid_profile",
      `Invalid approvalGate.mode: ${String(gate.mode)}. Expected off, secondary-guard, or auto-promote.`,
    );
  }
  const providerId = normalizeOptionalEntityId(gate.providerId, "approvalGate.providerId");
  if (gate.minConfidence !== undefined && !isValidGateMinConfidence(gate.minConfidence)) {
    throw new ResidentCeoProfileError(
      "resident_ceo_invalid_profile",
      `Invalid approvalGate.minConfidence: ${String(gate.minConfidence)}. Expected a finite number in (0, 1].`,
    );
  }
  return {
    mode: gate.mode,
    ...(providerId === undefined ? {} : { providerId }),
    ...(gate.minConfidence === undefined ? {} : { minConfidence: gate.minConfidence }),
  };
}

export function effectiveResidentCeoApprovalGate(profile: Pick<ResidentCeoProfile, "approvalGate">): {
  readonly mode: ResidentCeoApprovalGateMode;
  readonly providerId: string | null;
  readonly minConfidence: number;
} {
  const configured = profile.approvalGate;
  return {
    mode: configured?.mode ?? "off",
    providerId: configured?.providerId ?? null,
    minConfidence: configured?.minConfidence ?? RESIDENT_CEO_DEFAULT_GATE_MIN_CONFIDENCE,
  };
}

export function evaluateResidentCeoAutoApproval(
  profile: Pick<ResidentCeoProfile, "executionPolicy" | "autoApproveSenders" | "defaultWorkId">,
  proposal: Pick<ResidentCeoDelegationProposal, "fromPersonId" | "proposedWorkId">,
): { readonly autoApprove: true; readonly workId: string } | { readonly autoApprove: false } {
  if (effectiveResidentCeoExecutionPolicy(profile) !== "approval-gated") return { autoApprove: false };
  const allowlist = profile.autoApproveSenders ?? [];
  if (!allowlist.includes(proposal.fromPersonId)) return { autoApprove: false };
  const workId = proposal.proposedWorkId ?? profile.defaultWorkId ?? null;
  if (workId === null || workId.trim().length === 0) return { autoApprove: false };
  return { autoApprove: true, workId };
}

function readOptionProbability(distribution: Readonly<Record<string, number>> | null, optionId: string): number | null {
  if (distribution === null || !Object.hasOwn(distribution, optionId)) return null;
  const value = distribution[optionId];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function checkResidentCeoGatePreconditions(
  profile: Pick<
    ResidentCeoProfile,
    "executionPolicy" | "autoApproveSenders" | "defaultWorkId" | "defaultAgentId" | "approvalGate"
  >,
  proposal: Pick<
    ResidentCeoDelegationProposal,
    "fromPersonId" | "proposedWorkId" | "proposedAgentId" | "proposedTargetNodeId" | "proposedSupersedesTaskId"
  >,
): { readonly ok: true; readonly workId: string } | { readonly ok: false; readonly reason: string } {
  const gate = effectiveResidentCeoApprovalGate(profile);
  if (effectiveResidentCeoExecutionPolicy(profile) !== "approval-gated")
    return { ok: false, reason: "execution_policy_not_approval_gated" };
  if (!isResidentCeoApprovalGateMode(gate.mode) || gate.mode === "off") return { ok: false, reason: "gate_mode_off" };
  if (!isValidGateMinConfidence(gate.minConfidence)) return { ok: false, reason: "invalid_min_confidence" };
  if (gate.mode === "secondary-guard" && !(profile.autoApproveSenders ?? []).includes(proposal.fromPersonId))
    return { ok: false, reason: "sender_not_allowlisted" };
  const rawWorkId = proposal.proposedWorkId ?? profile.defaultWorkId ?? null;
  const workId = rawWorkId?.trim() ?? "";
  if (workId.length === 0) return { ok: false, reason: "missing_work_id" };
  if (!ENTITY_ID_PATTERN.test(workId)) return { ok: false, reason: "invalid_work_id" };
  const rawAgentId = proposal.proposedAgentId ?? profile.defaultAgentId ?? null;
  if (rawAgentId !== null && rawAgentId.trim().length > 0 && !ENTITY_ID_PATTERN.test(rawAgentId.trim()))
    return { ok: false, reason: "invalid_agent_id" };
  const rawTargetNodeId = proposal.proposedTargetNodeId ?? null;
  if (
    rawTargetNodeId !== null &&
    rawTargetNodeId.trim().length > 0 &&
    !isValidResidentCeoTargetNodeId(rawTargetNodeId.trim())
  )
    return { ok: false, reason: "invalid_target_node_id" };
  const rawSupersedesTaskId = proposal.proposedSupersedesTaskId ?? null;
  if (
    rawSupersedesTaskId !== null &&
    rawSupersedesTaskId.trim().length > 0 &&
    !ENTITY_ID_PATTERN.test(rawSupersedesTaskId.trim())
  )
    return { ok: false, reason: "invalid_supersedes_task_id" };
  return { ok: true, workId };
}

export function evaluateResidentCeoGateDecision(input: {
  readonly profile: Pick<
    ResidentCeoProfile,
    "executionPolicy" | "autoApproveSenders" | "defaultWorkId" | "defaultAgentId" | "approvalGate"
  >;
  readonly proposal: Pick<
    ResidentCeoDelegationProposal,
    "fromPersonId" | "proposedWorkId" | "proposedAgentId" | "proposedTargetNodeId" | "proposedSupersedesTaskId"
  >;
  readonly observation: ResidentCeoGateObservation;
}): ResidentCeoGateEvaluation {
  const gate = effectiveResidentCeoApprovalGate(input.profile);
  const selected = isResidentCeoGateOptionId(input.observation.selected) ? input.observation.selected : null;
  const selectedConfidence = selected !== null ? readOptionProbability(input.observation.distribution, selected) : null;
  const approveConfidence = readOptionProbability(input.observation.distribution, "approve_low_risk");
  const buildVerdict = (fallbackReason: string | null, confidence: number | null): ResidentCeoGateVerdict => ({
    mode: gate.mode,
    selected,
    confidence,
    minConfidence: gate.minConfidence,
    providerId: input.observation.providerId,
    model: input.observation.model,
    evaluatedAt: input.observation.evaluatedAt,
    fallbackReason,
  });

  const precheck = checkResidentCeoGatePreconditions(input.profile, input.proposal);
  if (!precheck.ok) {
    return { allowAutoPromote: false, verdict: buildVerdict(precheck.reason, selectedConfidence) };
  }
  const errorReason = input.observation.errorReason?.trim() ?? "";
  if (errorReason.length > 0) {
    return { allowAutoPromote: false, verdict: buildVerdict(errorReason, selectedConfidence) };
  }
  if (selected === null) {
    return { allowAutoPromote: false, verdict: buildVerdict("invalid_decision_option", null) };
  }
  if (selected === RESIDENT_CEO_GATE_ABSTAIN_OPTION_ID) {
    return { allowAutoPromote: false, verdict: buildVerdict("abstained_insufficient_information", selectedConfidence) };
  }
  if (selected !== "approve_low_risk") {
    return { allowAutoPromote: false, verdict: buildVerdict("selected_require_human_approval", selectedConfidence) };
  }
  if (approveConfidence === null) {
    return { allowAutoPromote: false, verdict: buildVerdict("missing_confidence", null) };
  }
  if (approveConfidence < gate.minConfidence) {
    return { allowAutoPromote: false, verdict: buildVerdict("confidence_below_threshold", approveConfidence) };
  }
  return {
    allowAutoPromote: true,
    workId: precheck.workId,
    verdict: buildVerdict(null, approveConfidence),
  };
}

export type ParsedResidentCeoDelegationDecision =
  | { readonly decision: "advise_only"; readonly rationale: string }
  | {
      readonly decision: "propose_task";
      readonly proposedTitle: string;
      readonly proposedWorkId: string | null;
      readonly proposedAgentId: string | null;
      readonly proposedTargetNodeId: string | null;
      readonly proposedSupersedesTaskId: string | null;
      readonly proposedPrompt: string | null;
      readonly rationale: string;
    };

function extractCandidateJsonObject(
  text: string,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const raw = (fenced?.[1] ?? text).trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function optionalProposalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalProposalId(value: unknown): string | null {
  const text = optionalProposalText(value);
  return text !== null && ENTITY_ID_PATTERN.test(text) ? text : null;
}

function optionalProposalTargetNodeId(value: unknown): string | null {
  const text = optionalProposalText(value);
  return text !== null && isValidResidentCeoTargetNodeId(text) ? text : null;
}

export function parseResidentCeoDelegationDecision(
  responseText: string,
  fallback: {
    readonly summary: string;
    readonly defaultWorkId: string | null;
    readonly defaultAgentId: string | null;
    readonly requestedAction: string;
  },
): ParsedResidentCeoDelegationDecision {
  const trimmed = responseText.trim();
  const parsed = extractCandidateJsonObject(trimmed);
  if (parsed.ok) {
    const action = optionalProposalText(parsed.value.action);
    const rationale = optionalProposalText(parsed.value.rationale) ?? trimmed;
    if (action === "advise_only") return { decision: "advise_only", rationale };
    if (action === "propose_task") {
      return {
        decision: "propose_task",
        proposedTitle: optionalProposalText(parsed.value.title) ?? fallback.summary,
        proposedWorkId: optionalProposalId(parsed.value.workId) ?? fallback.defaultWorkId,
        proposedAgentId: optionalProposalId(parsed.value.agentId) ?? fallback.defaultAgentId,
        proposedTargetNodeId: optionalProposalTargetNodeId(parsed.value.targetNodeId),
        proposedSupersedesTaskId: optionalProposalId(parsed.value.supersedesTaskId),
        proposedPrompt: optionalProposalText(parsed.value.prompt) ?? fallback.requestedAction,
        rationale,
      };
    }
  }
  return {
    decision: "propose_task",
    proposedTitle: fallback.summary,
    proposedWorkId: fallback.defaultWorkId,
    proposedAgentId: fallback.defaultAgentId,
    proposedTargetNodeId: null,
    proposedSupersedesTaskId: null,
    proposedPrompt: fallback.requestedAction,
    rationale: trimmed || fallback.summary,
  };
}

export function createResidentCeoProfile(input: ResidentCeoProfileInput, updatedAt: string): ResidentCeoProfile {
  const fields = [input.principalPersonId, input.runtimeInstanceId, input.model, updatedAt];
  if (
    fields.some((field) => field.trim().length === 0) ||
    !Number.isSafeInteger(input.heartbeatIntervalSec) ||
    input.heartbeatIntervalSec < RESIDENT_CEO_MIN_HEARTBEAT_INTERVAL_SEC ||
    input.heartbeatIntervalSec > RESIDENT_CEO_MAX_HEARTBEAT_INTERVAL_SEC ||
    (input.executionPolicy !== undefined && !isResidentCeoExecutionPolicy(input.executionPolicy))
  ) {
    throw new ResidentCeoProfileError(
      "resident_ceo_invalid_profile",
      `Resident CEO requires a principal, runtime instance, model, timestamp, valid execution policy, and heartbeat interval from ${RESIDENT_CEO_MIN_HEARTBEAT_INTERVAL_SEC} to ${RESIDENT_CEO_MAX_HEARTBEAT_INTERVAL_SEC} seconds.`,
    );
  }
  const defaultWorkId = normalizeOptionalEntityId(input.defaultWorkId, "defaultWorkId");
  const defaultAgentId = normalizeOptionalEntityId(input.defaultAgentId, "defaultAgentId");
  const autoApproveSenders = normalizeAutoApproveSenders(input.autoApproveSenders);
  const approvalGate = normalizeApprovalGate(input.approvalGate);
  return {
    schema: RESIDENT_CEO_PROFILE_SCHEMA,
    principalPersonId: input.principalPersonId,
    ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
    runtimeInstanceId: input.runtimeInstanceId,
    model: input.model,
    heartbeatIntervalSec: input.heartbeatIntervalSec,
    ...(input.executionPolicy === undefined ? {} : { executionPolicy: input.executionPolicy }),
    ...(defaultWorkId === undefined ? {} : { defaultWorkId }),
    ...(defaultAgentId === undefined ? {} : { defaultAgentId }),
    ...(autoApproveSenders === undefined ? {} : { autoApproveSenders }),
    ...(approvalGate === undefined ? {} : { approvalGate }),
    persistentSessionId: null,
    status: "stopped",
    lastWake: null,
    updatedAt,
  };
}

export function assertResidentCeoPrincipal(profile: ResidentCeoProfile, principalPersonId: string): void {
  if (profile.principalPersonId !== principalPersonId) {
    throw new ResidentCeoProfileError(
      "resident_ceo_principal_mismatch",
      `Resident CEO profile belongs to ${profile.principalPersonId}, not ${principalPersonId}.`,
    );
  }
}

export function residentCeoWakeDue(profile: ResidentCeoProfile, now: number): boolean {
  if (profile.status !== "running" || profile.lastWake?.status === "running") return false;
  if (profile.lastWake === null) return true;
  const lastWakeAt = Date.parse(profile.lastWake.completedAt ?? profile.lastWake.requestedAt);
  return Number.isFinite(lastWakeAt) && now >= lastWakeAt + profile.heartbeatIntervalSec * 1_000;
}

export function residentCeoWakeReceipt(input: {
  readonly profile: ResidentCeoProfile;
  readonly wakeId: string;
  readonly cause: ResidentCeoWakeCause;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly status: ResidentCeoWakeStatus;
  readonly runtimeSessionId: string | null;
  readonly peerRequestId?: string;
  readonly persistentSessionId?: string | null;
  readonly detail?: string | null;
}): ResidentCeoProfile {
  const receipt: ResidentCeoWakeReceipt = {
    wakeId: input.wakeId,
    cause: input.cause,
    requestedAt: input.requestedAt,
    completedAt: input.completedAt,
    status: input.status,
    runtimeSessionId: input.runtimeSessionId,
    ...(input.peerRequestId === undefined ? {} : { peerRequestId: input.peerRequestId }),
    detail: input.detail ?? null,
  };
  return {
    ...input.profile,
    persistentSessionId: input.persistentSessionId ?? input.profile.persistentSessionId,
    lastWake: receipt,
    updatedAt: input.completedAt ?? input.requestedAt,
  };
}

function retainBoundedProposals(
  proposals: readonly ResidentCeoDelegationProposal[],
): readonly ResidentCeoDelegationProposal[] {
  if (proposals.length <= RESIDENT_CEO_MAX_PROPOSALS) return proposals;
  const active = proposals.filter(
    (entry) => entry.status === "pending_approval" || (entry.status === "promoted" && entry.terminalOutcome === null),
  );
  const settled = proposals.filter(
    (entry) => entry.status !== "pending_approval" && !(entry.status === "promoted" && entry.terminalOutcome === null),
  );
  const remainingSlots = Math.max(0, RESIDENT_CEO_MAX_PROPOSALS - active.length);
  return [...settled.slice(-remainingSlots), ...active];
}

export function upsertResidentCeoProposal(
  profile: ResidentCeoProfile,
  proposal: ResidentCeoDelegationProposal,
  updatedAt: string,
): ResidentCeoProfile {
  const existing = profile.proposals ?? [];
  const next = existing.some((entry) => entry.proposalId === proposal.proposalId)
    ? existing.map((entry) => (entry.proposalId === proposal.proposalId ? proposal : entry))
    : [...existing, proposal];
  return {
    ...profile,
    proposals: retainBoundedProposals(next),
    updatedAt,
  };
}

export function findResidentCeoProposal(
  profile: Pick<ResidentCeoProfile, "proposals">,
  proposalId: string,
): ResidentCeoDelegationProposal {
  const proposal = (profile.proposals ?? []).find((entry) => entry.proposalId === proposalId);
  if (!proposal) {
    throw new ResidentCeoProfileError(
      "resident_ceo_proposal_not_found",
      `Resident CEO delegation proposal ${proposalId} does not exist.`,
    );
  }
  return proposal;
}

export function transitionResidentCeoProposal(
  profile: ResidentCeoProfile,
  proposalId: string,
  transition:
    | {
        readonly status: "promoted";
        readonly approvalMode: ResidentCeoApprovalMode;
        readonly decidedAt: string;
        readonly decidedByPersonId: string;
        readonly promotedTaskId: string;
        readonly proposedWorkId: string;
        readonly proposedTitle: string;
        readonly proposedAgentId: string | null;
        readonly proposedTargetNodeId?: string | null;
        readonly proposedSupersedesTaskId?: string | null;
        readonly supersededTaskId?: string | null;
        readonly supersedeError?: string | null;
        readonly dispatchedTargetNodeId?: string | null;
        readonly dispatchRuntimeSessionId: string | null;
        readonly dispatchError: string | null;
      }
    | {
        readonly status: "rejected";
        readonly decidedAt: string;
        readonly decidedByPersonId: string;
        readonly rejectionReason: string;
      }
    | {
        readonly status: "failed";
        readonly decidedAt: string;
        readonly decidedByPersonId: string;
        readonly dispatchError: string;
      },
): ResidentCeoProfile {
  const current = findResidentCeoProposal(profile, proposalId);
  if (current.status !== "pending_approval") {
    throw new ResidentCeoProfileError(
      "resident_ceo_proposal_transition_invalid",
      `Proposal ${proposalId} is already ${current.status} and cannot transition to ${transition.status}.`,
    );
  }
  const updated: ResidentCeoDelegationProposal =
    transition.status === "promoted"
      ? {
          ...current,
          status: "promoted",
          approvalMode: transition.approvalMode,
          decidedAt: transition.decidedAt,
          decidedByPersonId: transition.decidedByPersonId,
          promotedTaskId: transition.promotedTaskId,
          proposedWorkId: transition.proposedWorkId,
          proposedTitle: transition.proposedTitle,
          proposedAgentId: transition.proposedAgentId,
          ...(transition.proposedTargetNodeId === undefined
            ? {}
            : { proposedTargetNodeId: transition.proposedTargetNodeId }),
          ...(transition.proposedSupersedesTaskId === undefined
            ? {}
            : { proposedSupersedesTaskId: transition.proposedSupersedesTaskId }),
          ...(transition.supersededTaskId === undefined ? {} : { supersededTaskId: transition.supersededTaskId }),
          ...(transition.supersedeError === undefined ? {} : { supersedeError: transition.supersedeError }),
          ...(transition.dispatchedTargetNodeId === undefined
            ? {}
            : { dispatchedTargetNodeId: transition.dispatchedTargetNodeId }),
          dispatchRuntimeSessionId: transition.dispatchRuntimeSessionId,
          dispatchError: transition.dispatchError,
        }
      : transition.status === "rejected"
        ? {
            ...current,
            status: "rejected",
            approvalMode: "manual",
            decidedAt: transition.decidedAt,
            decidedByPersonId: transition.decidedByPersonId,
            rejectionReason: transition.rejectionReason,
          }
        : {
            ...current,
            status: "failed",
            decidedAt: transition.decidedAt,
            decidedByPersonId: transition.decidedByPersonId,
            dispatchError: transition.dispatchError,
          };
  return upsertResidentCeoProposal(profile, updated, transition.decidedAt);
}

export function recordResidentCeoProposalGateVerdict(
  profile: ResidentCeoProfile,
  proposalId: string,
  verdict: ResidentCeoGateVerdict,
): ResidentCeoProfile {
  const current = findResidentCeoProposal(profile, proposalId);
  return upsertResidentCeoProposal(profile, { ...current, gateVerdict: verdict }, verdict.evaluatedAt);
}

export function recordResidentCeoProposalTerminalOutcome(
  profile: ResidentCeoProfile,
  proposalId: string,
  outcome: ResidentCeoProposalTerminalOutcome,
): ResidentCeoProfile {
  const current = findResidentCeoProposal(profile, proposalId);
  if (current.status !== "promoted" || current.promotedTaskId === null) {
    throw new ResidentCeoProfileError(
      "resident_ceo_proposal_transition_invalid",
      `Proposal ${proposalId} must be promoted before recording a terminal task outcome.`,
    );
  }
  if (current.terminalOutcome !== null) return profile;
  return upsertResidentCeoProposal(profile, { ...current, terminalOutcome: outcome }, outcome.reportedAt);
}
