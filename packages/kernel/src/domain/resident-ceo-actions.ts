import type {
  ResidentCeoApprovalMode,
  ResidentCeoDelegationProposal,
  ResidentCeoExecutionPolicy,
  ResidentCeoProfile,
  ResidentCeoWakeCause,
} from "./resident-ceo.ts";

export const RESIDENT_CEO_MAX_TIER0_ACTIONS_PER_TURN = 3;
export const RESIDENT_CEO_MAX_ACTION_AUDIT_ENTRIES = 100;

const residentCeoTier1ActionKinds = [
  "promote_and_dispatch",
  "start_and_dispatch_existing",
  "archive_or_cancel_unleased",
  "doc_sync_plan",
] as const;
const residentCeoCleanupModes = ["archive", "cancel"] as const;
export const residentCeoActionAuditOutcomes = ["executed", "proposed", "denied", "failed"] as const;
export const residentCeoPeerReplyOutcomes = ["answered", "done", "rejected"] as const;

const residentCeoTier2ForbiddenActions = [
  "review_consent",
  "task_complete",
  "force_takeover",
  "lease_takeover",
  "merge_pr",
  "pr_merge",
  "modify_ci_gate",
  "ci_gate_modify",
  "modify_gates",
] as const;

export type ResidentCeoActionTier = "tier0" | "tier1" | "tier2";
export type ResidentCeoTier0ActionKind = "peer_ask" | "peer_reply" | "runtime_steer";
export type ResidentCeoTier1ActionKind = (typeof residentCeoTier1ActionKinds)[number];
export type ResidentCeoCleanupMode = (typeof residentCeoCleanupModes)[number];
export type ResidentCeoActionAuditOutcome = (typeof residentCeoActionAuditOutcomes)[number];
export type ResidentCeoPeerReplyOutcome = (typeof residentCeoPeerReplyOutcomes)[number];
export type ResidentCeoProposalSourceChannel = "peer-request" | "human-chat";
type ResidentCeoTier2ForbiddenAction = (typeof residentCeoTier2ForbiddenActions)[number];

const TARGET_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isValidResidentCeoTargetNodeId(value: string): boolean {
  return TARGET_NODE_ID_PATTERN.test(value) && !value.includes("..");
}

export function effectiveResidentCeoExecutionPolicy(
  profile: Pick<ResidentCeoProfile, "executionPolicy">,
): ResidentCeoExecutionPolicy {
  return profile.executionPolicy ?? "advisory-only";
}

export interface ResidentCeoLeaseSnapshot {
  readonly phase?: unknown;
  readonly expiresAt?: unknown;
  readonly actor?: {
    readonly principal?: {
      readonly personId?: unknown;
    } | null;
  } | null;
}

export function evaluateResidentCeoLeaseBlock(input: {
  readonly taskId: string;
  readonly lease: ResidentCeoLeaseSnapshot | null;
  readonly principalPersonId: string | null;
  readonly nowIso: string;
}):
  | {
      readonly blocked: true;
      readonly code: "resident_ceo_active_lease_blocked" | "resident_ceo_foreign_lease_blocked";
      readonly message: string;
    }
  | { readonly blocked: false; readonly hasOwnExpiredLease: boolean } {
  const { taskId, lease, principalPersonId, nowIso } = input;
  if (lease === null || lease.phase === "released") return { blocked: false, hasOwnExpiredLease: false };
  const expiresMs = typeof lease.expiresAt === "string" ? Date.parse(lease.expiresAt) : Number.NaN;
  const nowMs = Date.parse(nowIso);
  const expired = Number.isFinite(expiresMs) && Number.isFinite(nowMs) && expiresMs <= nowMs;
  if ((lease.phase === "held" || lease.phase === "reserving") && !expired) {
    return {
      blocked: true,
      code: "resident_ceo_active_lease_blocked",
      message: `Task ${taskId} holds an active unexpired ${String(lease.phase)} lease until ${String(lease.expiresAt ?? "unknown")}; Resident CEO refuses to override active leases.`,
    };
  }
  const holderPersonId = typeof lease.actor?.principal?.personId === "string" ? lease.actor.principal.personId : null;
  if (principalPersonId !== null && holderPersonId !== null && holderPersonId !== principalPersonId) {
    return {
      blocked: true,
      code: "resident_ceo_foreign_lease_blocked",
      message: `Task ${taskId} has an orphaned/expired lease belonging to ${holderPersonId}, not ${principalPersonId}.`,
    };
  }
  return { blocked: false, hasOwnExpiredLease: lease.phase === "orphaned" || expired };
}

export interface ResidentCeoActionAuditEntry {
  readonly auditId: string;
  readonly wakeId: string;
  readonly channel: ResidentCeoWakeCause;
  readonly tier: ResidentCeoActionTier;
  readonly actionKind: string;
  readonly outcome: ResidentCeoActionAuditOutcome;
  readonly approvalMode: ResidentCeoApprovalMode | null;
  readonly actorPersonId: string;
  readonly targetRef: string | null;
  readonly resultRef: string | null;
  readonly proposalId: string | null;
  readonly errorCode: string | null;
  readonly detail: string;
  readonly recordedAt: string;
}

type ResidentCeoClassifiedAction =
  | { readonly kind: "advise_only" }
  | { readonly kind: "tier0"; readonly actionKind: ResidentCeoTier0ActionKind }
  | { readonly kind: "tier1"; readonly actionKind: ResidentCeoTier1ActionKind }
  | { readonly kind: "tier2"; readonly rawAction: string; readonly canonicalAction: ResidentCeoTier2ForbiddenAction }
  | { readonly kind: "unknown"; readonly rawAction: string };

type ParsedResidentCeoTier0Action =
  | {
      readonly tier: "tier0";
      readonly actionKind: "peer_ask";
      readonly toPersonId: string;
      readonly summary: string;
      readonly requestKind: string | null;
      readonly claim: string | null;
      readonly requestedAction: string | null;
      readonly workId: string | null;
      readonly anchorRef: string | null;
      readonly rationale: string;
    }
  | {
      readonly tier: "tier0";
      readonly actionKind: "peer_reply";
      readonly requestId: string;
      readonly claim: string | null;
      readonly requestedAction: string | null;
      readonly outcome: ResidentCeoPeerReplyOutcome;
      readonly reason: string | null;
      readonly verification: string | null;
      readonly rationale: string;
    }
  | {
      readonly tier: "tier0";
      readonly actionKind: "runtime_steer";
      readonly runtimeSessionId: string | null;
      readonly dispatchId: string | null;
      readonly prompt: string;
      readonly rationale: string;
    };

type ParsedResidentCeoTier1Action =
  | {
      readonly tier: "tier1";
      readonly actionKind: "promote_and_dispatch";
      readonly proposedTitle: string;
      readonly proposedWorkId: string | null;
      readonly proposedAgentId: string | null;
      readonly proposedTargetNodeId: string | null;
      readonly proposedSupersedesTaskId: string | null;
      readonly proposedPrompt: string | null;
      readonly rationale: string;
    }
  | {
      readonly tier: "tier1";
      readonly actionKind: "start_and_dispatch_existing";
      readonly targetTaskId: string;
      readonly proposedTitle: string;
      readonly proposedAgentId: string | null;
      readonly proposedTargetNodeId: string | null;
      readonly proposedPrompt: string | null;
      readonly rationale: string;
    }
  | {
      readonly tier: "tier1";
      readonly actionKind: "archive_or_cancel_unleased";
      readonly targetTaskId: string;
      readonly cleanupMode: ResidentCeoCleanupMode | null;
      readonly proposedTitle: string;
      readonly rationale: string;
    }
  | {
      readonly tier: "tier1";
      readonly actionKind: "doc_sync_plan";
      readonly targetTaskId: string;
      readonly planContent: string;
      readonly proposedTitle: string;
      readonly rationale: string;
    };

type ParsedResidentCeoAction =
  | ParsedResidentCeoTier0Action
  | ParsedResidentCeoTier1Action
  | {
      readonly tier: "tier2";
      readonly rawAction: string;
      readonly canonicalAction: ResidentCeoTier2ForbiddenAction;
      readonly rationale: string;
    }
  | {
      readonly tier: "rejected";
      readonly rawAction: string;
      readonly errorCode: string;
      readonly reason: string;
      readonly rationale: string;
    };

type ParsedResidentCeoTurnActions =
  | { readonly mode: "advise_only"; readonly replyText: string; readonly actions: readonly [] }
  | { readonly mode: "reply_only"; readonly replyText: string; readonly actions: readonly [] }
  | {
      readonly mode: "actions";
      readonly replyText: string | null;
      readonly actions: readonly ParsedResidentCeoAction[];
    };

const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export function isResidentCeoTier1ActionKind(value: unknown): value is ResidentCeoTier1ActionKind {
  return typeof value === "string" && (residentCeoTier1ActionKinds as readonly string[]).includes(value);
}

function isResidentCeoCleanupMode(value: unknown): value is ResidentCeoCleanupMode {
  return typeof value === "string" && (residentCeoCleanupModes as readonly string[]).includes(value);
}

export function effectiveResidentCeoProposalActionKind(
  proposal: Pick<ResidentCeoDelegationProposal, "actionKind">,
): ResidentCeoTier1ActionKind {
  return proposal.actionKind ?? "promote_and_dispatch";
}

export function effectiveResidentCeoProposalSourceChannel(
  proposal: Pick<ResidentCeoDelegationProposal, "sourceChannel">,
): ResidentCeoProposalSourceChannel {
  return proposal.sourceChannel ?? "peer-request";
}

function normalizeActionToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[.\-\s]+/gu, "_");
}

export function classifyResidentCeoAction(rawAction: string): ResidentCeoClassifiedAction {
  const normalized = normalizeActionToken(rawAction);
  if (normalized === "advise_only") return { kind: "advise_only" };
  if (normalized === "peer_ask") return { kind: "tier0", actionKind: "peer_ask" };
  if (normalized === "peer_reply") return { kind: "tier0", actionKind: "peer_reply" };
  if (normalized === "runtime_steer") return { kind: "tier0", actionKind: "runtime_steer" };
  if (normalized === "propose_task" || normalized === "promote_and_dispatch") {
    return { kind: "tier1", actionKind: "promote_and_dispatch" };
  }
  if (normalized === "start_and_dispatch_existing") {
    return { kind: "tier1", actionKind: "start_and_dispatch_existing" };
  }
  if (normalized === "archive_or_cancel_unleased") {
    return { kind: "tier1", actionKind: "archive_or_cancel_unleased" };
  }
  if (normalized === "doc_sync_plan") {
    return { kind: "tier1", actionKind: "doc_sync_plan" };
  }
  if ((residentCeoTier2ForbiddenActions as readonly string[]).includes(normalized)) {
    return {
      kind: "tier2",
      rawAction,
      canonicalAction: normalized as ResidentCeoTier2ForbiddenAction,
    };
  }
  return { kind: "unknown", rawAction };
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalEntityId(value: unknown): string | null {
  const text = optionalText(value);
  return text !== null && ENTITY_ID_PATTERN.test(text) ? text : null;
}

function optionalTargetNodeId(value: unknown): string | null {
  const text = optionalText(value);
  return text !== null && isValidResidentCeoTargetNodeId(text) ? text : null;
}

function extractStructuredJson(
  text: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly outsideText: string | null }
  | { readonly ok: false } {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  const raw = (fenced?.[1] ?? trimmed).trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const outside = fenced
        ? `${trimmed.slice(0, fenced.index)}${trimmed.slice(fenced.index + fenced[0].length)}`.trim()
        : "";
      return {
        ok: true,
        value: parsed as Record<string, unknown>,
        outsideText: outside.length > 0 ? outside : null,
      };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

interface ResidentCeoTurnParseFallback {
  readonly summary: string;
  readonly defaultWorkId: string | null;
  readonly defaultAgentId: string | null;
  readonly requestedAction: string;
}

function rejectedAction(
  rawAction: string,
  errorCode: string,
  reason: string,
  rationale: string,
): ParsedResidentCeoAction {
  return { tier: "rejected", rawAction, errorCode, reason, rationale };
}

function parseSingleActionRecord(
  record: Record<string, unknown>,
  fallback: ResidentCeoTurnParseFallback,
): ParsedResidentCeoAction | { readonly adviseOnly: true; readonly rationale: string } {
  const rawAction = optionalText(record.action) ?? optionalText(record.actionKind);
  const rationale = optionalText(record.rationale) ?? optionalText(record.reason) ?? fallback.summary;
  if (rawAction === null) {
    return rejectedAction(
      "",
      "resident_ceo_invalid_action",
      "Action object is missing required action/actionKind field.",
      rationale,
    );
  }
  const classified = classifyResidentCeoAction(rawAction);
  if (classified.kind === "advise_only") return { adviseOnly: true, rationale };
  if (classified.kind === "tier2") {
    return {
      tier: "tier2",
      rawAction,
      canonicalAction: classified.canonicalAction,
      rationale,
    };
  }
  if (classified.kind === "unknown") {
    return rejectedAction(
      rawAction,
      "resident_ceo_unknown_action",
      `Unsupported Resident CEO action: ${rawAction}.`,
      rationale,
    );
  }
  if (classified.kind === "tier0") {
    if (classified.actionKind === "peer_ask") {
      const toPersonId = optionalEntityId(record.toPersonId ?? record.to);
      const summary = optionalText(record.summary) ?? optionalText(record.question) ?? optionalText(record.message);
      if (toPersonId === null || summary === null) {
        return rejectedAction(
          rawAction,
          "resident_ceo_invalid_action",
          "peer_ask requires valid toPersonId and non-empty summary.",
          rationale,
        );
      }
      return {
        tier: "tier0",
        actionKind: "peer_ask",
        toPersonId,
        summary,
        requestKind: optionalText(record.requestKind),
        claim: optionalText(record.claim),
        requestedAction: optionalText(record.requestedAction),
        workId: optionalEntityId(record.workId),
        anchorRef: optionalText(record.anchorRef),
        rationale,
      };
    }
    if (classified.actionKind === "peer_reply") {
      const requestId = optionalEntityId(record.requestId ?? record.peerRequestId);
      const rawOutcome = optionalText(record.outcome) ?? "answered";
      if (requestId === null || !(residentCeoPeerReplyOutcomes as readonly string[]).includes(rawOutcome)) {
        return rejectedAction(
          rawAction,
          "resident_ceo_invalid_action",
          "peer_reply requires valid requestId and outcome (answered|done|rejected).",
          rationale,
        );
      }
      const outcome = rawOutcome as ResidentCeoPeerReplyOutcome;
      const claim = optionalText(record.claim) ?? optionalText(record.message);
      const reason = optionalText(record.reason);
      if (outcome === "answered" && claim === null) {
        return rejectedAction(
          rawAction,
          "resident_ceo_invalid_action",
          "peer_reply with outcome=answered requires non-empty claim.",
          rationale,
        );
      }
      if (outcome === "rejected" && reason === null) {
        return rejectedAction(
          rawAction,
          "resident_ceo_invalid_action",
          "peer_reply with outcome=rejected requires non-empty reason.",
          rationale,
        );
      }
      return {
        tier: "tier0",
        actionKind: "peer_reply",
        requestId,
        claim,
        requestedAction: optionalText(record.requestedAction),
        outcome,
        reason,
        verification: optionalText(record.verification),
        rationale,
      };
    }
    const runtimeSessionId = optionalEntityId(record.runtimeSessionId);
    const dispatchId = optionalEntityId(record.dispatchId);
    const prompt = optionalText(record.prompt) ?? optionalText(record.message);
    if ((runtimeSessionId !== null) === (dispatchId !== null) || prompt === null) {
      return rejectedAction(
        rawAction,
        "resident_ceo_invalid_action",
        "runtime_steer requires exactly one valid runtimeSessionId or dispatchId and a non-empty prompt.",
        rationale,
      );
    }
    return {
      tier: "tier0",
      actionKind: "runtime_steer",
      runtimeSessionId,
      dispatchId,
      prompt,
      rationale,
    };
  }
  // Tier 1 actions
  if (classified.actionKind === "promote_and_dispatch") {
    return {
      tier: "tier1",
      actionKind: "promote_and_dispatch",
      proposedTitle: optionalText(record.title) ?? fallback.summary,
      proposedWorkId: optionalEntityId(record.workId) ?? fallback.defaultWorkId,
      proposedAgentId: optionalEntityId(record.agentId) ?? fallback.defaultAgentId,
      proposedTargetNodeId: optionalTargetNodeId(record.targetNodeId),
      proposedSupersedesTaskId: optionalEntityId(record.supersedesTaskId),
      proposedPrompt: optionalText(record.prompt) ?? fallback.requestedAction,
      rationale,
    };
  }
  if (classified.actionKind === "start_and_dispatch_existing") {
    const targetTaskId = optionalEntityId(record.taskId ?? record.targetTaskId);
    if (targetTaskId === null) {
      return rejectedAction(
        rawAction,
        "resident_ceo_invalid_action",
        "start_and_dispatch_existing requires a valid taskId.",
        rationale,
      );
    }
    return {
      tier: "tier1",
      actionKind: "start_and_dispatch_existing",
      targetTaskId,
      proposedTitle: optionalText(record.title) ?? `Start and dispatch ${targetTaskId}`,
      proposedAgentId: optionalEntityId(record.agentId) ?? fallback.defaultAgentId,
      proposedTargetNodeId: optionalTargetNodeId(record.targetNodeId),
      proposedPrompt: optionalText(record.prompt),
      rationale,
    };
  }
  if (classified.actionKind === "archive_or_cancel_unleased") {
    const targetTaskId = optionalEntityId(record.taskId ?? record.targetTaskId);
    const rawMode = optionalText(record.cleanupMode ?? record.mode);
    if (targetTaskId === null || (rawMode !== null && !isResidentCeoCleanupMode(rawMode))) {
      return rejectedAction(
        rawAction,
        "resident_ceo_invalid_action",
        "archive_or_cancel_unleased requires a valid taskId and optional cleanupMode (archive|cancel).",
        rationale,
      );
    }
    return {
      tier: "tier1",
      actionKind: "archive_or_cancel_unleased",
      targetTaskId,
      cleanupMode: rawMode,
      proposedTitle: optionalText(record.title) ?? `Cleanup unleased task ${targetTaskId}`,
      rationale,
    };
  }
  // doc_sync_plan
  const targetTaskId = optionalEntityId(record.taskId ?? record.targetTaskId);
  const planContent = optionalText(record.planContent ?? record.plan);
  if (targetTaskId === null || planContent === null) {
    return rejectedAction(
      rawAction,
      "resident_ceo_invalid_action",
      "doc_sync_plan requires a valid taskId and non-empty planContent.",
      rationale,
    );
  }
  return {
    tier: "tier1",
    actionKind: "doc_sync_plan",
    targetTaskId,
    planContent,
    proposedTitle: optionalText(record.title) ?? `Sync plan for ${targetTaskId}`,
    rationale,
  };
}

export function parseResidentCeoTurnActions(
  responseText: string,
  options: {
    readonly channel: ResidentCeoWakeCause;
    readonly fallbackToProposeTask?: boolean;
    readonly fallback: ResidentCeoTurnParseFallback;
  },
): ParsedResidentCeoTurnActions {
  const trimmed = responseText.trim();
  const extracted = extractStructuredJson(trimmed);
  if (extracted.ok) {
    const obj = extracted.value;
    const explicitReply = optionalText(obj.reply) ?? optionalText(obj.message) ?? extracted.outsideText;
    if (Array.isArray(obj.actions)) {
      const parsedActions: ParsedResidentCeoAction[] = [];
      for (const item of obj.actions) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          parsedActions.push({
            tier: "rejected",
            rawAction: String(item),
            errorCode: "resident_ceo_invalid_action",
            reason: "Each entry in actions must be a JSON object.",
            rationale: options.fallback.summary,
          });
          continue;
        }
        const single = parseSingleActionRecord(item as Record<string, unknown>, options.fallback);
        if (!("adviseOnly" in single)) parsedActions.push(single);
      }
      if (parsedActions.length === 0) {
        return { mode: "advise_only", replyText: explicitReply ?? trimmed, actions: [] };
      }
      return { mode: "actions", replyText: explicitReply, actions: parsedActions };
    }
    if (Object.hasOwn(obj, "action") || Object.hasOwn(obj, "actionKind")) {
      const single = parseSingleActionRecord(obj, options.fallback);
      if ("adviseOnly" in single) {
        return { mode: "advise_only", replyText: single.rationale, actions: [] };
      }
      return { mode: "actions", replyText: explicitReply, actions: [single] };
    }
  }
  if (options.channel === "peer-request" && options.fallbackToProposeTask === true) {
    return {
      mode: "actions",
      replyText: null,
      actions: [
        {
          tier: "tier1",
          actionKind: "promote_and_dispatch",
          proposedTitle: options.fallback.summary,
          proposedWorkId: options.fallback.defaultWorkId,
          proposedAgentId: options.fallback.defaultAgentId,
          proposedTargetNodeId: null,
          proposedSupersedesTaskId: null,
          proposedPrompt: options.fallback.requestedAction,
          rationale: trimmed || options.fallback.summary,
        },
      ],
    };
  }
  return { mode: "reply_only", replyText: trimmed, actions: [] };
}

function denyTier0Access(
  code: string,
  reason: string,
): { readonly allowed: false; readonly code: string; readonly reason: string } {
  return { allowed: false, code, reason };
}

function allowTier0Access(approvalMode: ResidentCeoApprovalMode): {
  readonly allowed: true;
  readonly approvalMode: ResidentCeoApprovalMode;
} {
  return { allowed: true, approvalMode };
}

export function evaluateResidentCeoTier0Access(
  profile: Pick<ResidentCeoProfile, "principalPersonId" | "executionPolicy" | "autoApproveSenders">,
  input: {
    readonly channel: ResidentCeoWakeCause;
    readonly actorPersonId: string;
    readonly actionKind: ResidentCeoTier0ActionKind;
    readonly targetPersonId?: string | null;
    readonly triggerPeerRequestId?: string | null;
    readonly targetPeerRequestId?: string | null;
  },
):
  | { readonly allowed: true; readonly approvalMode: ResidentCeoApprovalMode }
  | { readonly allowed: false; readonly code: string; readonly reason: string } {
  if (effectiveResidentCeoExecutionPolicy(profile) !== "approval-gated") {
    return denyTier0Access(
      "resident_ceo_advisory_only",
      `Resident CEO execution policy is advisory-only; Tier 0 action ${input.actionKind} requires approval-gated policy.`,
    );
  }
  if (input.channel === "human-chat") {
    if (input.actorPersonId !== profile.principalPersonId) {
      return denyTier0Access(
        "resident_ceo_principal_mismatch",
        `human-chat actor ${input.actorPersonId} does not match Resident CEO principal ${profile.principalPersonId}.`,
      );
    }
    return allowTier0Access("owner-direct");
  }
  const allowedTargets = new Set([profile.principalPersonId, ...(profile.autoApproveSenders ?? [])]);
  if (input.actionKind === "peer_ask") {
    if (!input.targetPersonId || !allowedTargets.has(input.targetPersonId)) {
      return denyTier0Access(
        "resident_ceo_tier0_target_denied",
        `Tier 0 peer_ask from ${input.channel} to ${input.targetPersonId ?? "unknown"} is outside principal/allowlist targets.`,
      );
    }
    return allowTier0Access("allowlist-auto");
  }
  if (input.actionKind === "peer_reply") {
    const replyingToTrigger =
      input.triggerPeerRequestId !== undefined &&
      input.triggerPeerRequestId !== null &&
      input.targetPeerRequestId === input.triggerPeerRequestId;
    if (!replyingToTrigger && (!input.targetPersonId || !allowedTargets.has(input.targetPersonId))) {
      return denyTier0Access(
        "resident_ceo_tier0_target_denied",
        `Tier 0 peer_reply from ${input.channel} is not addressed to the triggering request or an allowlisted collaborator.`,
      );
    }
    return allowTier0Access("allowlist-auto");
  }
  // runtime_steer from non-human-chat requires allowlisted sender
  if (!allowedTargets.has(input.actorPersonId)) {
    return denyTier0Access(
      "resident_ceo_tier0_target_denied",
      `Tier 0 runtime_steer from ${input.actorPersonId} requires principal or allowlisted sender.`,
    );
  }
  return allowTier0Access("allowlist-auto");
}

export function evaluateResidentCeoOwnerDirectApproval(
  profile: Pick<ResidentCeoProfile, "principalPersonId" | "executionPolicy" | "defaultWorkId" | "defaultAgentId">,
  proposal: Pick<
    ResidentCeoDelegationProposal,
    | "actionKind"
    | "sourceChannel"
    | "fromPersonId"
    | "proposedWorkId"
    | "proposedAgentId"
    | "proposedTargetNodeId"
    | "proposedSupersedesTaskId"
    | "targetTaskId"
    | "planContent"
  >,
):
  | { readonly autoApprove: true; readonly approvalMode: "owner-direct"; readonly workId: string | null }
  | { readonly autoApprove: false; readonly reason: string } {
  if (effectiveResidentCeoExecutionPolicy(profile) !== "approval-gated") {
    return { autoApprove: false, reason: "execution_policy_not_approval_gated" };
  }
  if (effectiveResidentCeoProposalSourceChannel(proposal) !== "human-chat") {
    return { autoApprove: false, reason: "source_channel_not_human_chat" };
  }
  if (proposal.fromPersonId !== profile.principalPersonId) {
    return { autoApprove: false, reason: "sender_not_principal" };
  }
  const actionKind = effectiveResidentCeoProposalActionKind(proposal);
  if (!isResidentCeoTier1ActionKind(actionKind)) {
    return { autoApprove: false, reason: "forbidden_action_kind" };
  }
  const rawAgentId = proposal.proposedAgentId ?? profile.defaultAgentId ?? null;
  if (rawAgentId !== null && rawAgentId.trim().length > 0 && !ENTITY_ID_PATTERN.test(rawAgentId.trim())) {
    return { autoApprove: false, reason: "invalid_agent_id" };
  }
  const rawTargetNodeId = proposal.proposedTargetNodeId ?? null;
  if (
    rawTargetNodeId !== null &&
    rawTargetNodeId.trim().length > 0 &&
    !isValidResidentCeoTargetNodeId(rawTargetNodeId.trim())
  ) {
    return { autoApprove: false, reason: "invalid_target_node_id" };
  }
  const rawSupersedesTaskId = proposal.proposedSupersedesTaskId ?? null;
  if (
    rawSupersedesTaskId !== null &&
    rawSupersedesTaskId.trim().length > 0 &&
    !ENTITY_ID_PATTERN.test(rawSupersedesTaskId.trim())
  ) {
    return { autoApprove: false, reason: "invalid_supersedes_task_id" };
  }
  if (actionKind === "promote_and_dispatch") {
    const workId = (proposal.proposedWorkId ?? profile.defaultWorkId ?? "").trim();
    if (workId.length === 0) return { autoApprove: false, reason: "missing_work_id" };
    if (!ENTITY_ID_PATTERN.test(workId)) return { autoApprove: false, reason: "invalid_work_id" };
    return { autoApprove: true, approvalMode: "owner-direct", workId };
  }
  const targetTaskId = proposal.targetTaskId?.trim() ?? "";
  if (targetTaskId.length === 0 || !ENTITY_ID_PATTERN.test(targetTaskId)) {
    return { autoApprove: false, reason: "missing_or_invalid_target_task_id" };
  }
  if (actionKind === "doc_sync_plan" && (!proposal.planContent || proposal.planContent.trim().length === 0)) {
    return { autoApprove: false, reason: "missing_plan_content" };
  }
  return {
    autoApprove: true,
    approvalMode: "owner-direct",
    workId: proposal.proposedWorkId ?? profile.defaultWorkId ?? null,
  };
}

export function appendResidentCeoActionAudit(
  profile: ResidentCeoProfile,
  entry: ResidentCeoActionAuditEntry,
): ResidentCeoProfile {
  const existing = profile.actionAuditLog ?? [];
  const next = [...existing, entry].slice(-RESIDENT_CEO_MAX_ACTION_AUDIT_ENTRIES);
  return {
    ...profile,
    actionAuditLog: next,
    updatedAt: entry.recordedAt,
  };
}
