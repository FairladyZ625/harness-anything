export const RESIDENT_CEO_PROFILE_SCHEMA = "resident-ceo-profile/v1" as const;
export const RESIDENT_CEO_MIN_HEARTBEAT_INTERVAL_SEC = 30;
export const RESIDENT_CEO_MAX_HEARTBEAT_INTERVAL_SEC = 86_400;
export const RESIDENT_CEO_MAX_PROPOSALS = 50;
export const residentCeoProfileStatuses = ["stopped", "running"] as const;
export const residentCeoWakeStatuses = ["running", "succeeded", "failed"] as const;
export const residentCeoExecutionPolicies = ["advisory-only", "approval-gated"] as const;
export const residentCeoProposalStatuses = ["pending_approval", "promoted", "rejected", "failed"] as const;
export const residentCeoApprovalModes = ["manual", "allowlist-auto"] as const;

export type ResidentCeoWakeCause = "heartbeat" | "peer-request" | "human-chat";
export type ResidentCeoProfileStatus = (typeof residentCeoProfileStatuses)[number];
export type ResidentCeoWakeStatus = (typeof residentCeoWakeStatuses)[number];
export type ResidentCeoExecutionPolicy = (typeof residentCeoExecutionPolicies)[number];
export type ResidentCeoProposalStatus = (typeof residentCeoProposalStatuses)[number];
export type ResidentCeoApprovalMode = (typeof residentCeoApprovalModes)[number];
export type ResidentCeoPromotedTaskTerminalState = "done" | "cancelled";

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
  readonly proposedPrompt: string | null;
  readonly rationale: string;
  readonly wakeId: string;
  readonly status: ResidentCeoProposalStatus;
  readonly approvalMode: ResidentCeoApprovalMode | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedByPersonId: string | null;
  readonly promotedTaskId: string | null;
  readonly dispatchRuntimeSessionId: string | null;
  readonly dispatchError: string | null;
  readonly rejectionReason: string | null;
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

export type ParsedResidentCeoDelegationDecision =
  | { readonly decision: "advise_only"; readonly rationale: string }
  | {
      readonly decision: "propose_task";
      readonly proposedTitle: string;
      readonly proposedWorkId: string | null;
      readonly proposedAgentId: string | null;
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
