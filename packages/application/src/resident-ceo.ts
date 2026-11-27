import {
  appendResidentCeoActionAudit,
  assertResidentCeoExecutionAllowed,
  assertResidentCeoPrincipal,
  checkResidentCeoGatePreconditions,
  createResidentCeoProfile,
  effectiveResidentCeoApprovalGate,
  effectiveResidentCeoProposalActionKind,
  effectiveResidentCeoProposalSourceChannel,
  evaluateResidentCeoAutoApproval,
  evaluateResidentCeoGateDecision,
  evaluateResidentCeoOwnerDirectApproval,
  evaluateResidentCeoTier0Access,
  findResidentCeoProposal,
  isResidentCeoTier1ActionKind,
  isValidResidentCeoTargetNodeId,
  recordResidentCeoProposalGateVerdict,
  recordResidentCeoProposalTerminalOutcome,
  ResidentCeoProfileError,
  residentCeoWakeDue,
  residentCeoWakeReceipt,
  transitionResidentCeoProposal,
  upsertResidentCeoProposal,
  type ResidentCeoActionAuditEntry,
  type ResidentCeoActionAuditOutcome,
  type ResidentCeoActionTier,
  type ResidentCeoApprovalGateMode,
  type ResidentCeoApprovalMode,
  type ResidentCeoCleanupMode,
  type ResidentCeoDelegationProposal,
  type ResidentCeoGateObservation,
  type ResidentCeoPeerReplyOutcome,
  type ResidentCeoProfile,
  type ResidentCeoProfileInput,
  type ResidentCeoPromotedTaskTerminalState,
  type ResidentCeoProposalSourceChannel,
  type ResidentCeoProposalStatus,
  type ResidentCeoTier1ActionKind,
  type ResidentCeoWakeCause,
} from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

export interface ResidentCeoProfileStore {
  readonly read: (principalPersonId: string) => Promise<ResidentCeoProfile | null>;
  /** Writes are serialized by the owning daemon writer. */
  readonly write: (profile: ResidentCeoProfile, expectedUpdatedAt: string | null) => Promise<void>;
}

export interface ResidentCeoActionReceipt {
  readonly tier: ResidentCeoActionTier;
  readonly actionKind: string;
  readonly outcome: ResidentCeoActionAuditOutcome;
  readonly approvalMode: ResidentCeoApprovalMode | null;
  readonly targetRef: string | null;
  readonly resultRef: string | null;
  readonly proposalId: string | null;
  readonly requestId?: string | null;
  readonly taskId?: string | null;
  readonly runtimeSessionId?: string | null;
  readonly errorCode: string | null;
  readonly detail: string;
}

export interface ResidentCeoRuntime {
  readonly run: (input: {
    readonly principalPersonId: string;
    readonly runtimeInstanceId: string;
    readonly model: string;
    readonly persistentSessionId: string | null;
    readonly cause: ResidentCeoWakeCause;
    readonly message: string;
    readonly wakeId: string;
    readonly peerRequestId?: string;
  }) => Promise<{
    readonly runtimeSessionId: string;
    readonly awaitResponse: () => Promise<{
      readonly response: string;
      readonly persistentSessionId: string | null;
      readonly actionReceipts?: readonly ResidentCeoActionReceipt[];
    }>;
  }>;
}

export interface ResidentCeoDelegationExecutor {
  readonly promote: (input: {
    readonly peerRequestId: string;
    readonly workId: string;
    readonly title: string;
    readonly plan?: string;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly promotedTaskId: string }>;
  readonly createTask?: (input: {
    readonly workId: string;
    readonly title: string;
    readonly plan: string;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly taskId: string }>;
  readonly startExistingTask?: (input: {
    readonly taskId: string;
    readonly targetNodeId?: string | null;
    readonly agentId?: string | null;
    readonly runtimeInstanceId?: string;
    readonly model?: string;
    readonly prompt?: string | null;
    readonly dispatchKey: string;
    readonly idempotencyKey: string;
  }) => Promise<{
    readonly taskId: string;
    readonly dispatchedTargetNodeId: string | null;
    readonly dispatchRuntimeSessionId: string | null;
    readonly dispatchError: string | null;
  }>;
  readonly archiveOrCancelUnleased?: (input: {
    readonly taskId: string;
    readonly principalPersonId: string;
    readonly cleanupMode?: ResidentCeoCleanupMode | null;
    readonly reason: string;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly taskId: string; readonly appliedAction: "archived" | "cancelled" }>;
  readonly syncTaskPlan?: (input: {
    readonly taskId: string;
    readonly planContent: string;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly taskId: string; readonly path: string }>;
  readonly peerAsk?: (input: {
    readonly toPersonId: string;
    readonly requestKind?: string | null;
    readonly summary: string;
    readonly claim?: string | null;
    readonly requestedAction?: string | null;
    readonly workId?: string | null;
    readonly anchorRef?: string | null;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly requestId: string }>;
  readonly peerReply?: (input: {
    readonly requestId: string;
    readonly claim?: string | null;
    readonly requestedAction?: string | null;
    readonly outcome?: ResidentCeoPeerReplyOutcome;
    readonly reason?: string | null;
    readonly verification?: string | null;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly requestId: string; readonly outcome: string }>;
  readonly runtimeSteer?: (input: {
    readonly runtimeSessionId?: string | null;
    readonly dispatchId?: string | null;
    readonly prompt: string;
    readonly idempotencyKey: string;
  }) => Promise<{ readonly runtimeSessionId: string; readonly dispatchId: string; readonly opId: string }>;
  readonly resolveLocalNodeId?: () => string | null;
  readonly assignToNode?: (input: {
    readonly taskId: string;
    readonly targetNodeId: string;
    readonly idempotencyKey: string;
  }) => Promise<void>;
  readonly dispatchAgent?: (input: {
    readonly taskId: string;
    readonly agentId: string;
    readonly runtimeInstanceId?: string;
    readonly model?: string;
    readonly prompt: string;
    readonly dispatchKey: string;
  }) => Promise<{ readonly runtimeSessionId: string }>;
  readonly rejectPeerRequest: (input: {
    readonly peerRequestId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }) => Promise<void>;
  readonly reportTerminalOutcome: (input: {
    readonly peerRequestId: string;
    readonly promotedTaskId: string;
    readonly taskStatus: ResidentCeoPromotedTaskTerminalState;
    readonly summary: string;
    readonly idempotencyKey: string;
  }) => Promise<void>;
}

export interface ResidentCeoApprovalGatePort {
  readonly evaluate: (input: {
    readonly profile: ResidentCeoProfile;
    readonly proposal: ResidentCeoDelegationProposal;
    readonly mode: Exclude<ResidentCeoApprovalGateMode, "off">;
    readonly providerId: string | null;
    readonly minConfidence: number;
  }) => Promise<ResidentCeoGateObservation>;
}

export interface ResidentCeoServiceInput {
  readonly profiles: ResidentCeoProfileStore;
  readonly runtime: ResidentCeoRuntime;
  readonly delegation?: ResidentCeoDelegationExecutor;
  readonly approvalGate?: ResidentCeoApprovalGatePort;
  readonly now: () => string;
  readonly createId: () => string;
}

export interface ResidentCeoProposalDraft {
  readonly peerRequestId: string;
  readonly fromPersonId: string;
  readonly summary: string;
  readonly actionKind?: ResidentCeoTier1ActionKind;
  readonly sourceChannel?: ResidentCeoProposalSourceChannel;
  readonly targetTaskId?: string | null;
  readonly cleanupMode?: ResidentCeoCleanupMode | null;
  readonly planContent?: string | null;
  readonly proposedTitle: string;
  readonly proposedWorkId: string | null;
  readonly proposedAgentId: string | null;
  readonly proposedTargetNodeId?: string | null;
  readonly proposedPrompt: string | null;
  readonly rationale: string;
  readonly wakeId: string;
}

export interface ResidentCeoTier0ActionInput {
  readonly wakeId: string;
  readonly channel: ResidentCeoWakeCause;
  readonly actorPersonId: string;
  readonly triggerPeerRequestId?: string | null;
  readonly targetPersonId?: string | null;
  readonly action:
    | {
        readonly actionKind: "peer_ask";
        readonly toPersonId: string;
        readonly summary: string;
        readonly requestKind?: string | null;
        readonly claim?: string | null;
        readonly requestedAction?: string | null;
        readonly workId?: string | null;
        readonly anchorRef?: string | null;
      }
    | {
        readonly actionKind: "peer_reply";
        readonly requestId: string;
        readonly claim?: string | null;
        readonly requestedAction?: string | null;
        readonly outcome?: ResidentCeoPeerReplyOutcome;
        readonly reason?: string | null;
        readonly verification?: string | null;
      }
    | {
        readonly actionKind: "runtime_steer";
        readonly runtimeSessionId?: string | null;
        readonly dispatchId?: string | null;
        readonly prompt: string;
      };
}

export interface ResidentCeoApproveProposalInput {
  readonly proposalId: string;
  readonly workId?: string;
  readonly title?: string;
  readonly agentId?: string;
  readonly targetNodeId?: string;
  readonly runtimeInstanceId?: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly approvalMode?: ResidentCeoApprovalMode;
}

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

export interface ResidentCeoPromotedTaskPlanInput {
  readonly proposalId: string;
  readonly peerRequestId: string;
  readonly fromPersonId: string;
  readonly decidedByPersonId: string;
  readonly approvalMode: ResidentCeoApprovalMode;
  readonly workId: string;
  readonly agentId: string | null;
  readonly targetNodeId?: string | null;
  readonly title: string;
  readonly summary: string;
  readonly prompt: string;
  readonly rationale: string;
  readonly wakeId: string;
}

function singleLinePlanField(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function buildResidentCeoPromotedTaskPlan(input: ResidentCeoPromotedTaskPlanInput): string {
  const title = singleLinePlanField(input.title);
  const summary = singleLinePlanField(input.summary);
  const prompt = singleLinePlanField(input.prompt);
  const rationale = singleLinePlanField(input.rationale);
  const assignee = input.agentId ? `agent \`${input.agentId}\`` : "the assigned executor";
  return [
    `# ${title}`,
    "",
    "Task Contract: harness-task v1",
    "",
    "## Brief",
    "",
    `Execute peer delegation \`${input.peerRequestId}\` from \`${input.fromPersonId}\` under work \`${input.workId}\`: ${title}.`,
    "",
    "## Goal",
    "",
    `Resolve the approved delegation request (${summary}) and deliver the requested outcome: ${prompt}.`,
    "",
    "## Cheaper Alternatives",
    "",
    `- Doing nothing leaves peer request \`${input.peerRequestId}\` from \`${input.fromPersonId}\` unresolved without tracked task ownership.`,
    `- Replying advisory-only without promotion cannot execute or verify the delegated work (${rationale}).`,
    "",
    "## Context",
    "",
    `- Proposal: \`${input.proposalId}\` (wake \`${input.wakeId}\`, approval mode \`${input.approvalMode}\`, approved by \`${input.decidedByPersonId}\`).`,
    `- Source PeerRequest: \`${input.peerRequestId}\` from \`${input.fromPersonId}\`.`,
    `- Target Work: \`${input.workId}\`; Assigned Executor: ${assignee}${input.targetNodeId ? `; Target Node: \`${input.targetNodeId}\`` : ""}.`,
    `- Rationale: ${rationale}`,
    "",
    "## Required Reading",
    "",
    `- Canonical PeerRequest \`${input.peerRequestId}\` and parent Work \`${input.workId}\` ledger state.`,
    "- Task package `task_plan.md` and `task-contract.json` materialized for this promoted task.",
    "",
    "## Execution Surface",
    "",
    `Operate inside the leased worktree and branch for this task under work \`${input.workId}\`; keep edits scoped to the files required by the delegation and do not touch unrelated worktrees or the canonical root checkout.`,
    "",
    "## Constraints",
    "",
    `- Stay strictly within the scope approved for proposal \`${input.proposalId}\` and peer request \`${input.peerRequestId}\`.`,
    "- Do not weaken repository gates, bypass canonical ledger transitions, or perform destructive external actions without explicit owner approval.",
    "",
    "## Deliverable Contract",
    "",
    `Deliver the concrete changes or artifacts requested in "${prompt}" to \`${input.decidedByPersonId}\` and report terminal task status back to \`${input.fromPersonId}\` through peer request \`${input.peerRequestId}\`.`,
    "",
    "## Evidence Protocol",
    "",
    "Record concrete verification commands, observed runner outputs, changed file paths, and execution receipts in closeout and submission so reviewers can verify every claim.",
    "",
    "## Verification",
    "",
    "Run the targeted tests and repository checks covering the modified surface, confirm all assertions pass, and record exact commands and real runner output before closing out.",
    "",
  ].join("\n");
}

export function makeResidentCeoService(input: ResidentCeoServiceInput) {
  const requiredProfile = async (principalPersonId: string, repoId?: string): Promise<ResidentCeoProfile> => {
    const profile = await input.profiles.read(principalPersonId);
    if (profile === null) throw new Error(`Resident CEO is not configured for ${principalPersonId}.`);
    assertResidentCeoPrincipal(profile, principalPersonId);
    if (repoId !== undefined && profile.repoId !== repoId)
      throw codedError("resident_ceo_repo_mismatch", "Resident CEO profile is configured for another repository.");
    return profile;
  };

  const update = async (profile: ResidentCeoProfile, next: ResidentCeoProfile): Promise<ResidentCeoProfile> => {
    const updated = {
      ...next,
      updatedAt: new Date(Math.max(Date.parse(next.updatedAt), Date.parse(profile.updatedAt) + 1)).toISOString(),
    };
    await input.profiles.write(updated, profile.updatedAt);
    return updated;
  };

  const commitProfileMutation = async (
    principalPersonId: string,
    repoId: string | undefined,
    buildNext: (current: ResidentCeoProfile) => ResidentCeoProfile,
  ): Promise<ResidentCeoProfile> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await requiredProfile(principalPersonId, repoId);
      const next = buildNext(current);
      const [settled] = await Promise.allSettled([update(current, next)]);
      if (settled.status === "fulfilled") return settled.value;
      const isCasConflict = settled.reason instanceof Error && settled.reason.message.includes("changed before write");
      if (!isCasConflict || attempt === 3) throw settled.reason;
    }
    throw codedError(
      "resident_ceo_profile_conflict",
      `Resident CEO profile for ${principalPersonId} changed before write.`,
    );
  };

  const requiredDelegation = (): ResidentCeoDelegationExecutor => {
    if (!input.delegation)
      throw codedError("resident_ceo_delegation_unavailable", "Resident CEO delegation executor is not available.");
    return input.delegation;
  };

  const buildAuditEntry = (
    entry: Omit<ResidentCeoActionAuditEntry, "auditId" | "recordedAt">,
  ): ResidentCeoActionAuditEntry => ({
    auditId: `aud_${input.createId().replaceAll("-", "").slice(0, 16)}`,
    recordedAt: input.now(),
    ...entry,
  });

  const errorCodeOf = (error: unknown, fallback: string): string =>
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : fallback;

  const approveProposal = async (
    principalPersonId: string,
    approveInput: ResidentCeoApproveProposalInput,
    repoId?: string,
  ): Promise<{ readonly profile: ResidentCeoProfile; readonly proposal: ResidentCeoDelegationProposal }> => {
    const profile = await requiredProfile(principalPersonId, repoId);
    assertResidentCeoExecutionAllowed(profile, "approving delegation proposals");
    const delegation = requiredDelegation();
    const proposal = findResidentCeoProposal(profile, approveInput.proposalId);
    if (proposal.status !== "pending_approval") {
      throw new ResidentCeoProfileError(
        "resident_ceo_proposal_transition_invalid",
        `Proposal ${proposal.proposalId} is already ${proposal.status}.`,
      );
    }
    const actionKind = effectiveResidentCeoProposalActionKind(proposal);
    if (!isResidentCeoTier1ActionKind(actionKind)) {
      throw new ResidentCeoProfileError(
        "resident_ceo_tier2_forbidden",
        `Proposal ${proposal.proposalId} references forbidden or unsupported action kind: ${String(actionKind)}.`,
      );
    }
    const sourceChannel = effectiveResidentCeoProposalSourceChannel(proposal);
    const title = (approveInput.title?.trim() || proposal.proposedTitle).trim();
    const agentId =
      (approveInput.agentId?.trim() || proposal.proposedAgentId || profile.defaultAgentId || "").trim() || null;
    const targetNodeId = (() => {
      if (approveInput.targetNodeId !== undefined) {
        const trimmed = approveInput.targetNodeId.trim();
        if (trimmed.length === 0 || !isValidResidentCeoTargetNodeId(trimmed))
          throw codedError("invalid_field", `Invalid targetNodeId: ${approveInput.targetNodeId}.`);
        return trimmed;
      }
      const proposed = proposal.proposedTargetNodeId ?? null;
      if (proposed === null) return null;
      const trimmed = proposed.trim();
      if (trimmed.length === 0) return null;
      if (!isValidResidentCeoTargetNodeId(trimmed))
        throw codedError("invalid_field", `Invalid proposedTargetNodeId: ${proposed}.`);
      return trimmed;
    })();
    const prompt = (approveInput.prompt?.trim() || proposal.proposedPrompt || proposal.summary).trim();
    const approvalMode = approveInput.approvalMode ?? "manual";
    const workId: string | null =
      (approveInput.workId?.trim() || proposal.proposedWorkId || profile.defaultWorkId || "").trim() || null;
    let promotedTaskId: string | null = null;
    let dispatchRuntimeSessionId: string | null = null;
    let dispatchedTargetNodeId: string | null = null;
    let dispatchError: string | null = null;
    let executionDetail: string;

    if (actionKind === "promote_and_dispatch") {
      if (workId === null)
        throw codedError("invalid_field", "Target work id (--work) is required to approve and promote this proposal.");
      const plan = buildResidentCeoPromotedTaskPlan({
        proposalId: proposal.proposalId,
        peerRequestId: proposal.peerRequestId,
        fromPersonId: proposal.fromPersonId,
        decidedByPersonId: principalPersonId,
        approvalMode,
        workId,
        agentId,
        targetNodeId,
        title,
        summary: proposal.summary,
        prompt,
        rationale: proposal.rationale,
        wakeId: proposal.wakeId,
      });
      if (sourceChannel === "human-chat") {
        if (!delegation.createTask) {
          throw codedError("resident_ceo_delegation_unavailable", "Task creation executor is not available.");
        }
        const created = await delegation.createTask({
          workId,
          title,
          plan,
          idempotencyKey: `resident-ceo-create-${proposal.proposalId}`,
        });
        promotedTaskId = created.taskId;
      } else {
        const promoted = await delegation.promote({
          peerRequestId: proposal.peerRequestId,
          workId,
          title,
          plan,
          idempotencyKey: `resident-ceo-promote-${proposal.proposalId}`,
        });
        promotedTaskId = promoted.promotedTaskId;
      }
      const localNodeId = delegation.resolveLocalNodeId?.() ?? null;
      const isRemoteTargetNode = targetNodeId !== null && targetNodeId !== localNodeId;
      if (isRemoteTargetNode) {
        if (!delegation.assignToNode) {
          dispatchError = `Remote target node ${targetNodeId} cannot be assigned because node assignment executor is unavailable.`;
        } else {
          const [assigned] = await Promise.allSettled([
            delegation.assignToNode({
              taskId: promotedTaskId,
              targetNodeId,
              idempotencyKey: `resident-ceo-assign-${proposal.proposalId}`,
            }),
          ]);
          if (assigned.status === "fulfilled") dispatchedTargetNodeId = targetNodeId;
          else dispatchError = assigned.reason instanceof Error ? assigned.reason.message : String(assigned.reason);
        }
      } else if (agentId !== null && delegation.dispatchAgent) {
        const [dispatched] = await Promise.allSettled([
          delegation.dispatchAgent({
            taskId: promotedTaskId,
            agentId,
            runtimeInstanceId: approveInput.runtimeInstanceId ?? profile.runtimeInstanceId,
            model: approveInput.model ?? profile.model,
            prompt,
            dispatchKey: `resident-ceo-delegate:${proposal.proposalId}`,
          }),
        ]);
        if (dispatched.status === "fulfilled") dispatchRuntimeSessionId = dispatched.value.runtimeSessionId;
        else dispatchError = dispatched.reason instanceof Error ? dispatched.reason.message : String(dispatched.reason);
      }
      executionDetail = `promoted task/${promotedTaskId}`;
    } else if (actionKind === "start_and_dispatch_existing") {
      const targetTaskId = proposal.targetTaskId?.trim() ?? "";
      if (targetTaskId.length === 0)
        throw codedError("invalid_field", "targetTaskId is required for start_and_dispatch_existing.");
      if (!delegation.startExistingTask)
        throw codedError("resident_ceo_delegation_unavailable", "startExistingTask executor is not available.");
      const started = await delegation.startExistingTask({
        taskId: targetTaskId,
        targetNodeId,
        agentId,
        runtimeInstanceId: approveInput.runtimeInstanceId ?? profile.runtimeInstanceId,
        model: approveInput.model ?? profile.model,
        prompt: approveInput.prompt?.trim() ?? proposal.proposedPrompt,
        dispatchKey: `resident-ceo-start-existing:${proposal.proposalId}`,
        idempotencyKey: proposal.proposalId,
      });
      promotedTaskId = started.taskId;
      dispatchedTargetNodeId = started.dispatchedTargetNodeId;
      dispatchRuntimeSessionId = started.dispatchRuntimeSessionId;
      dispatchError = started.dispatchError;
      executionDetail = `started existing task/${targetTaskId}`;
    } else if (actionKind === "archive_or_cancel_unleased") {
      const targetTaskId = proposal.targetTaskId?.trim() ?? "";
      if (targetTaskId.length === 0)
        throw codedError("invalid_field", "targetTaskId is required for archive_or_cancel_unleased.");
      if (!delegation.archiveOrCancelUnleased)
        throw codedError("resident_ceo_delegation_unavailable", "archiveOrCancelUnleased executor is not available.");
      const [cleaned] = await Promise.allSettled([
        delegation.archiveOrCancelUnleased({
          taskId: targetTaskId,
          principalPersonId,
          cleanupMode: proposal.cleanupMode ?? null,
          reason: proposal.rationale || `Resident CEO cleanup (${proposal.proposalId})`,
          idempotencyKey: `resident-ceo-cleanup-${proposal.proposalId}`,
        }),
      ]);
      if (cleaned.status === "rejected") {
        const errCode = errorCodeOf(cleaned.reason, "resident_ceo_cleanup_failed");
        const errMessage = cleaned.reason instanceof Error ? cleaned.reason.message : String(cleaned.reason);
        const deniedAudit = buildAuditEntry({
          wakeId: proposal.wakeId,
          channel: sourceChannel,
          tier: "tier1",
          actionKind,
          outcome: "denied",
          approvalMode,
          actorPersonId: proposal.fromPersonId,
          targetRef: `task/${targetTaskId}`,
          resultRef: null,
          proposalId: proposal.proposalId,
          errorCode: errCode,
          detail: errMessage,
        });
        await commitProfileMutation(principalPersonId, repoId, (current) =>
          appendResidentCeoActionAudit(current, deniedAudit),
        );
        throw cleaned.reason;
      }
      promotedTaskId = cleaned.value.taskId;
      executionDetail = `${cleaned.value.appliedAction} unleased task/${cleaned.value.taskId}`;
    } else {
      // doc_sync_plan
      const targetTaskId = proposal.targetTaskId?.trim() ?? "";
      const planContent = proposal.planContent?.trim() ?? "";
      if (targetTaskId.length === 0 || planContent.length === 0)
        throw codedError("invalid_field", "targetTaskId and planContent are required for doc_sync_plan.");
      if (!delegation.syncTaskPlan)
        throw codedError("resident_ceo_delegation_unavailable", "syncTaskPlan executor is not available.");
      const synced = await delegation.syncTaskPlan({
        taskId: targetTaskId,
        planContent,
        idempotencyKey: `resident-ceo-doc-sync-${proposal.proposalId}`,
      });
      promotedTaskId = synced.taskId;
      executionDetail = `synced plan ${synced.path}`;
    }

    const decidedAt = input.now();
    const audit = buildAuditEntry({
      wakeId: proposal.wakeId,
      channel: sourceChannel,
      tier: "tier1",
      actionKind,
      outcome: "executed",
      approvalMode,
      actorPersonId: principalPersonId,
      targetRef: proposal.targetTaskId ? `task/${proposal.targetTaskId}` : workId ? `work/${workId}` : null,
      resultRef: promotedTaskId ? `task/${promotedTaskId}` : null,
      proposalId: proposal.proposalId,
      errorCode: null,
      detail: dispatchError ? `${executionDetail} (dispatch error: ${dispatchError})` : executionDetail,
    });
    const saved = await commitProfileMutation(principalPersonId, repoId, (current) =>
      appendResidentCeoActionAudit(
        transitionResidentCeoProposal(current, proposal.proposalId, {
          status: "promoted",
          approvalMode,
          decidedAt,
          decidedByPersonId: principalPersonId,
          promotedTaskId,
          proposedWorkId: workId,
          proposedTitle: title,
          proposedAgentId: agentId,
          proposedTargetNodeId: targetNodeId,
          dispatchedTargetNodeId,
          dispatchRuntimeSessionId,
          dispatchError,
        }),
        audit,
      ),
    );
    return { profile: saved, proposal: findResidentCeoProposal(saved, proposal.proposalId) };
  };

  return {
    reconcileWake: async (
      principalPersonId: string,
      wakeId: string,
      settlement: {
        readonly runtimeSessionId: string;
        readonly succeeded: boolean;
        readonly persistentSessionId: string | null;
        readonly detail: string | null;
      },
    ) => {
      const profile = await requiredProfile(principalPersonId);
      const wake = profile.lastWake;
      if (wake?.status !== "running" || wake.wakeId !== wakeId) return profile;
      return update(
        profile,
        residentCeoWakeReceipt({
          profile,
          wakeId,
          cause: wake.cause,
          requestedAt: wake.requestedAt,
          completedAt: input.now(),
          status: settlement.succeeded ? "succeeded" : "failed",
          runtimeSessionId: settlement.runtimeSessionId,
          ...(wake.peerRequestId === undefined ? {} : { peerRequestId: wake.peerRequestId }),
          ...(settlement.succeeded ? { persistentSessionId: settlement.persistentSessionId } : {}),
          detail: settlement.detail,
        }),
      );
    },
    configure: async (principalPersonId: string, configuration: Omit<ResidentCeoProfileInput, "principalPersonId">) => {
      const previous = await input.profiles.read(principalPersonId);
      if (previous !== null) assertResidentCeoPrincipal(previous, principalPersonId);
      if (previous?.lastWake?.status === "running")
        throw codedError("resident_ceo_busy", "Resident CEO has a turn in progress.");
      const mergedConfig: ResidentCeoProfileInput = {
        ...configuration,
        principalPersonId,
        ...(configuration.executionPolicy === undefined && previous?.executionPolicy !== undefined
          ? { executionPolicy: previous.executionPolicy }
          : {}),
        ...(configuration.defaultWorkId === undefined && previous?.defaultWorkId !== undefined
          ? { defaultWorkId: previous.defaultWorkId }
          : {}),
        ...(configuration.defaultAgentId === undefined && previous?.defaultAgentId !== undefined
          ? { defaultAgentId: previous.defaultAgentId }
          : {}),
        ...(configuration.autoApproveSenders === undefined && previous?.autoApproveSenders !== undefined
          ? { autoApproveSenders: previous.autoApproveSenders }
          : {}),
        ...(configuration.approvalGate === undefined && previous?.approvalGate !== undefined
          ? { approvalGate: previous.approvalGate }
          : {}),
      };
      const created = createResidentCeoProfile(mergedConfig, input.now());
      const next: ResidentCeoProfile = previous
        ? {
            ...created,
            persistentSessionId:
              previous.repoId === created.repoId &&
              previous.runtimeInstanceId === created.runtimeInstanceId &&
              previous.model === created.model
                ? previous.persistentSessionId
                : null,
            status: previous.status,
            lastWake: previous.lastWake,
            ...(previous.proposals === undefined ? {} : { proposals: previous.proposals }),
            ...(previous.actionAuditLog === undefined ? {} : { actionAuditLog: previous.actionAuditLog }),
          }
        : created;
      if (previous) return update(previous, next);
      await input.profiles.write(next, null);
      return next;
    },
    start: async (principalPersonId: string, repoId?: string) => {
      const profile = await requiredProfile(principalPersonId, repoId);
      return update(profile, { ...profile, status: "running", updatedAt: input.now() });
    },
    stop: async (principalPersonId: string, repoId?: string) => {
      const profile = await requiredProfile(principalPersonId, repoId);
      return update(profile, { ...profile, status: "stopped", updatedAt: input.now() });
    },
    status: requiredProfile,
    listProposals: async (
      principalPersonId: string,
      filter?: { readonly status?: ResidentCeoProposalStatus },
      repoId?: string,
    ): Promise<readonly ResidentCeoDelegationProposal[]> => {
      const profile = await requiredProfile(principalPersonId, repoId);
      const proposals = profile.proposals ?? [];
      return filter?.status ? proposals.filter((entry) => entry.status === filter.status) : proposals;
    },
    executeTier0Action: async (
      principalPersonId: string,
      tier0Input: ResidentCeoTier0ActionInput,
      repoId?: string,
    ): Promise<ResidentCeoActionReceipt> => {
      const profile = await requiredProfile(principalPersonId, repoId);
      const targetRef =
        tier0Input.action.actionKind === "peer_ask"
          ? `person/${tier0Input.action.toPersonId}`
          : tier0Input.action.actionKind === "peer_reply"
            ? `peer/${tier0Input.action.requestId}`
            : tier0Input.action.runtimeSessionId
              ? `session/${tier0Input.action.runtimeSessionId}`
              : `dispatch/${tier0Input.action.dispatchId ?? "unknown"}`;
      const access = evaluateResidentCeoTier0Access(profile, {
        channel: tier0Input.channel,
        actorPersonId: tier0Input.actorPersonId,
        actionKind: tier0Input.action.actionKind,
        targetPersonId:
          tier0Input.action.actionKind === "peer_ask"
            ? tier0Input.action.toPersonId
            : (tier0Input.targetPersonId ?? null),
        triggerPeerRequestId: tier0Input.triggerPeerRequestId ?? null,
        targetPeerRequestId: tier0Input.action.actionKind === "peer_reply" ? tier0Input.action.requestId : null,
      });
      if (!access.allowed) {
        const deniedAudit = buildAuditEntry({
          wakeId: tier0Input.wakeId,
          channel: tier0Input.channel,
          tier: "tier0",
          actionKind: tier0Input.action.actionKind,
          outcome: "denied",
          approvalMode: null,
          actorPersonId: tier0Input.actorPersonId,
          targetRef,
          resultRef: null,
          proposalId: null,
          errorCode: access.code,
          detail: access.reason,
        });
        await commitProfileMutation(principalPersonId, repoId, (current) =>
          appendResidentCeoActionAudit(current, deniedAudit),
        );
        return {
          tier: "tier0",
          actionKind: tier0Input.action.actionKind,
          outcome: "denied",
          approvalMode: null,
          targetRef,
          resultRef: null,
          proposalId: null,
          errorCode: access.code,
          detail: access.reason,
        };
      }
      const delegation = requiredDelegation();
      const idempotencyKey = `resident-ceo-tier0-${tier0Input.wakeId}-${input.createId().replaceAll("-", "").slice(0, 12)}`;
      const [settled] = await Promise.allSettled([
        (async () => {
          if (tier0Input.action.actionKind === "peer_ask") {
            if (!delegation.peerAsk)
              throw codedError("resident_ceo_delegation_unavailable", "Tier 0 peerAsk executor is unavailable.");
            const res = await delegation.peerAsk({
              toPersonId: tier0Input.action.toPersonId,
              requestKind: tier0Input.action.requestKind ?? null,
              summary: tier0Input.action.summary,
              claim: tier0Input.action.claim ?? null,
              requestedAction: tier0Input.action.requestedAction ?? null,
              workId: tier0Input.action.workId ?? null,
              anchorRef: tier0Input.action.anchorRef ?? null,
              idempotencyKey,
            });
            return {
              resultRef: `peer/${res.requestId}`,
              requestId: res.requestId,
              runtimeSessionId: null as string | null,
              detail: `Sent PeerRequest ${res.requestId} to ${tier0Input.action.toPersonId}.`,
            };
          }
          if (tier0Input.action.actionKind === "peer_reply") {
            if (!delegation.peerReply)
              throw codedError("resident_ceo_delegation_unavailable", "Tier 0 peerReply executor is unavailable.");
            const res = await delegation.peerReply({
              requestId: tier0Input.action.requestId,
              claim: tier0Input.action.claim ?? null,
              requestedAction: tier0Input.action.requestedAction ?? null,
              outcome: tier0Input.action.outcome ?? "answered",
              reason: tier0Input.action.reason ?? null,
              verification: tier0Input.action.verification ?? null,
              idempotencyKey,
            });
            return {
              resultRef: `peer/${res.requestId}`,
              requestId: res.requestId,
              runtimeSessionId: null as string | null,
              detail: `Replied to PeerRequest ${res.requestId} (${res.outcome}).`,
            };
          }
          if (!delegation.runtimeSteer)
            throw codedError("resident_ceo_delegation_unavailable", "Tier 0 runtimeSteer executor is unavailable.");
          const res = await delegation.runtimeSteer({
            runtimeSessionId: tier0Input.action.runtimeSessionId ?? null,
            dispatchId: tier0Input.action.dispatchId ?? null,
            prompt: tier0Input.action.prompt,
            idempotencyKey,
          });
          return {
            resultRef: res.dispatchId ? `dispatch/${res.dispatchId}` : `session/${res.runtimeSessionId}`,
            requestId: null as string | null,
            runtimeSessionId: res.runtimeSessionId || null,
            detail: `Steered runtime ${res.runtimeSessionId || res.dispatchId} (op=${res.opId}).`,
          };
        })(),
      ]);
      if (settled.status === "rejected") {
        const errCode = errorCodeOf(settled.reason, "resident_ceo_tier0_failed");
        const errMessage = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        const failedAudit = buildAuditEntry({
          wakeId: tier0Input.wakeId,
          channel: tier0Input.channel,
          tier: "tier0",
          actionKind: tier0Input.action.actionKind,
          outcome: "failed",
          approvalMode: access.approvalMode,
          actorPersonId: tier0Input.actorPersonId,
          targetRef,
          resultRef: null,
          proposalId: null,
          errorCode: errCode,
          detail: errMessage,
        });
        await commitProfileMutation(principalPersonId, repoId, (current) =>
          appendResidentCeoActionAudit(current, failedAudit),
        );
        return {
          tier: "tier0",
          actionKind: tier0Input.action.actionKind,
          outcome: "failed",
          approvalMode: access.approvalMode,
          targetRef,
          resultRef: null,
          proposalId: null,
          errorCode: errCode,
          detail: errMessage,
        };
      }
      const successAudit = buildAuditEntry({
        wakeId: tier0Input.wakeId,
        channel: tier0Input.channel,
        tier: "tier0",
        actionKind: tier0Input.action.actionKind,
        outcome: "executed",
        approvalMode: access.approvalMode,
        actorPersonId: tier0Input.actorPersonId,
        targetRef,
        resultRef: settled.value.resultRef,
        proposalId: null,
        errorCode: null,
        detail: settled.value.detail,
      });
      await commitProfileMutation(principalPersonId, repoId, (current) =>
        appendResidentCeoActionAudit(current, successAudit),
      );
      return {
        tier: "tier0",
        actionKind: tier0Input.action.actionKind,
        outcome: "executed",
        approvalMode: access.approvalMode,
        targetRef,
        resultRef: settled.value.resultRef,
        proposalId: null,
        requestId: settled.value.requestId,
        runtimeSessionId: settled.value.runtimeSessionId,
        errorCode: null,
        detail: settled.value.detail,
      };
    },
    recordTier2Rejection: async (
      principalPersonId: string,
      rejection: {
        readonly wakeId: string;
        readonly channel: ResidentCeoWakeCause;
        readonly actorPersonId: string;
        readonly rawAction: string;
        readonly rationale: string;
      },
      repoId?: string,
    ): Promise<ResidentCeoActionReceipt> => {
      const detail = `Tier 2 forbidden action "${rejection.rawAction}" was fail-closed rejected; explicit human review/execution is required.`;
      const audit = buildAuditEntry({
        wakeId: rejection.wakeId,
        channel: rejection.channel,
        tier: "tier2",
        actionKind: rejection.rawAction,
        outcome: "denied",
        approvalMode: null,
        actorPersonId: rejection.actorPersonId,
        targetRef: null,
        resultRef: null,
        proposalId: null,
        errorCode: "resident_ceo_tier2_forbidden",
        detail,
      });
      await commitProfileMutation(principalPersonId, repoId, (current) => appendResidentCeoActionAudit(current, audit));
      return {
        tier: "tier2",
        actionKind: rejection.rawAction,
        outcome: "denied",
        approvalMode: null,
        targetRef: null,
        resultRef: null,
        proposalId: null,
        errorCode: "resident_ceo_tier2_forbidden",
        detail,
      };
    },
    recordDeniedAction: async (
      principalPersonId: string,
      denied: {
        readonly wakeId: string;
        readonly channel: ResidentCeoWakeCause;
        readonly tier: ResidentCeoActionTier;
        readonly actionKind: string;
        readonly actorPersonId: string;
        readonly errorCode: string;
        readonly detail: string;
        readonly targetRef?: string | null;
      },
      repoId?: string,
    ): Promise<ResidentCeoActionReceipt> => {
      const audit = buildAuditEntry({
        wakeId: denied.wakeId,
        channel: denied.channel,
        tier: denied.tier,
        actionKind: denied.actionKind,
        outcome: "denied",
        approvalMode: null,
        actorPersonId: denied.actorPersonId,
        targetRef: denied.targetRef ?? null,
        resultRef: null,
        proposalId: null,
        errorCode: denied.errorCode,
        detail: denied.detail,
      });
      await commitProfileMutation(principalPersonId, repoId, (current) => appendResidentCeoActionAudit(current, audit));
      return {
        tier: denied.tier,
        actionKind: denied.actionKind,
        outcome: "denied",
        approvalMode: null,
        targetRef: denied.targetRef ?? null,
        resultRef: null,
        proposalId: null,
        errorCode: denied.errorCode,
        detail: denied.detail,
      };
    },
    recordProposal: async (
      principalPersonId: string,
      draft: ResidentCeoProposalDraft,
      repoId?: string,
    ): Promise<{
      readonly profile: ResidentCeoProfile;
      readonly proposal: ResidentCeoDelegationProposal;
      readonly autoApproved: boolean;
      readonly errorCode?: string | null;
    }> => {
      const profile = await requiredProfile(principalPersonId, repoId);
      assertResidentCeoExecutionAllowed(profile, "recording delegation proposals");
      const actionKind = draft.actionKind ?? "promote_and_dispatch";
      if (!isResidentCeoTier1ActionKind(actionKind)) {
        throw new ResidentCeoProfileError(
          "resident_ceo_tier2_forbidden",
          `Resident CEO refused forbidden action kind: ${String(actionKind)}.`,
        );
      }
      const existing = (profile.proposals ?? []).find((entry) => entry.peerRequestId === draft.peerRequestId);
      if (existing) return { profile, proposal: existing, autoApproved: false };
      const createdAt = input.now();
      const proposalId = `prop_${input.createId().replaceAll("-", "").slice(0, 16)}`;
      const sourceChannel = draft.sourceChannel ?? "peer-request";
      const proposal: ResidentCeoDelegationProposal = {
        proposalId,
        peerRequestId: draft.peerRequestId,
        fromPersonId: draft.fromPersonId,
        summary: draft.summary,
        ...(draft.actionKind !== undefined ? { actionKind: draft.actionKind } : {}),
        ...(draft.sourceChannel !== undefined ? { sourceChannel: draft.sourceChannel } : {}),
        ...(draft.targetTaskId !== undefined ? { targetTaskId: draft.targetTaskId } : {}),
        ...(draft.cleanupMode !== undefined ? { cleanupMode: draft.cleanupMode } : {}),
        ...(draft.planContent !== undefined ? { planContent: draft.planContent } : {}),
        proposedTitle: draft.proposedTitle,
        proposedWorkId: draft.proposedWorkId,
        proposedAgentId: draft.proposedAgentId,
        proposedTargetNodeId: draft.proposedTargetNodeId ?? null,
        proposedPrompt: draft.proposedPrompt,
        rationale: draft.rationale,
        wakeId: draft.wakeId,
        status: "pending_approval",
        approvalMode: null,
        createdAt,
        decidedAt: null,
        decidedByPersonId: null,
        promotedTaskId: null,
        dispatchedTargetNodeId: null,
        dispatchRuntimeSessionId: null,
        dispatchError: null,
        rejectionReason: null,
        gateVerdict: null,
        terminalOutcome: null,
      };
      const saved = await commitProfileMutation(principalPersonId, repoId, (current) =>
        upsertResidentCeoProposal(current, proposal, createdAt),
      );
      // Track A: Principal local human-chat -> owner-direct auto execution for Tier 1 actions
      if (sourceChannel === "human-chat") {
        const ownerDirect = evaluateResidentCeoOwnerDirectApproval(saved, proposal);
        if (ownerDirect.autoApprove && input.delegation) {
          const [executed] = await Promise.allSettled([
            approveProposal(
              principalPersonId,
              {
                proposalId,
                ...(ownerDirect.workId ? { workId: ownerDirect.workId } : {}),
                approvalMode: "owner-direct",
              },
              repoId,
            ),
          ]);
          if (executed.status === "fulfilled") {
            return { ...executed.value, autoApproved: true };
          }
          const errCode = errorCodeOf(executed.reason, "resident_ceo_owner_direct_failed");
          const errMessage = executed.reason instanceof Error ? executed.reason.message : String(executed.reason);
          const failedAt = input.now();
          const failedProfile = await commitProfileMutation(principalPersonId, repoId, (current) =>
            transitionResidentCeoProposal(current, proposalId, {
              status: "failed",
              decidedAt: failedAt,
              decidedByPersonId: principalPersonId,
              dispatchError: errMessage,
            }),
          );
          return {
            profile: failedProfile,
            proposal: findResidentCeoProposal(failedProfile, proposalId),
            autoApproved: false,
            errorCode: errCode,
          };
        }
        return { profile: saved, proposal, autoApproved: false };
      }
      // Track B: External peer-request -> allowlist-auto + Phase 3 Decider Gate
      const gate = effectiveResidentCeoApprovalGate(saved);
      if (gate.mode === "off") {
        const auto = evaluateResidentCeoAutoApproval(saved, proposal);
        if (auto.autoApprove && input.delegation) {
          const approved = await approveProposal(
            principalPersonId,
            {
              proposalId,
              ...(auto.workId ? { workId: auto.workId } : {}),
              approvalMode: "allowlist-auto",
            },
            repoId,
          );
          return { ...approved, autoApproved: true };
        }
        return { profile: saved, proposal, autoApproved: false };
      }
      if (gate.mode === "secondary-guard" && !(saved.autoApproveSenders ?? []).includes(proposal.fromPersonId)) {
        return { profile: saved, proposal, autoApproved: false };
      }
      const precheck = checkResidentCeoGatePreconditions(saved, proposal);
      let observation: ResidentCeoGateObservation;
      if (!precheck.ok) {
        observation = {
          selected: null,
          distribution: null,
          providerId: gate.providerId,
          model: null,
          evaluatedAt: input.now(),
          errorReason: null,
        };
      } else if (!input.delegation) {
        observation = {
          selected: null,
          distribution: null,
          providerId: gate.providerId,
          model: null,
          evaluatedAt: input.now(),
          errorReason: "delegation_unavailable",
        };
      } else if (!input.approvalGate) {
        observation = {
          selected: null,
          distribution: null,
          providerId: gate.providerId,
          model: null,
          evaluatedAt: input.now(),
          errorReason: "approval_gate_unavailable",
        };
      } else {
        const [evaluated] = await Promise.allSettled([
          input.approvalGate.evaluate({
            profile: saved,
            proposal,
            mode: gate.mode,
            providerId: gate.providerId,
            minConfidence: gate.minConfidence,
          }),
        ]);
        if (evaluated.status === "fulfilled") {
          observation = evaluated.value;
        } else {
          const reason = evaluated.reason;
          const code =
            reason !== null && typeof reason === "object" && "code" in reason && typeof reason.code === "string"
              ? reason.code
              : null;
          const message = reason instanceof Error ? reason.message : String(reason);
          observation = {
            selected: null,
            distribution: null,
            providerId: gate.providerId,
            model: null,
            evaluatedAt: input.now(),
            errorReason: code ? `${code}: ${message}` : `gate_error: ${message}`,
          };
        }
      }
      const evaluation = evaluateResidentCeoGateDecision({
        profile: saved,
        proposal,
        observation,
      });
      const withVerdict = await commitProfileMutation(principalPersonId, repoId, (current) =>
        recordResidentCeoProposalGateVerdict(current, proposalId, evaluation.verdict),
      );
      if (!evaluation.allowAutoPromote) {
        return {
          profile: withVerdict,
          proposal: findResidentCeoProposal(withVerdict, proposalId),
          autoApproved: false,
        };
      }
      const approved = await approveProposal(
        principalPersonId,
        {
          proposalId,
          ...(evaluation.workId ? { workId: evaluation.workId } : {}),
          approvalMode: "decider-auto",
        },
        repoId,
      );
      return { ...approved, autoApproved: true };
    },
    approveProposal,
    rejectProposal: async (
      principalPersonId: string,
      rejectInput: { readonly proposalId: string; readonly reason: string },
      repoId?: string,
    ): Promise<{ readonly profile: ResidentCeoProfile; readonly proposal: ResidentCeoDelegationProposal }> => {
      const profile = await requiredProfile(principalPersonId, repoId);
      assertResidentCeoExecutionAllowed(profile, "rejecting delegation proposals");
      const reason = rejectInput.reason.trim();
      if (reason.length === 0) throw codedError("invalid_field", "Rejection reason (--reason) is required.");
      const delegation = requiredDelegation();
      const proposal = findResidentCeoProposal(profile, rejectInput.proposalId);
      if (proposal.status !== "pending_approval") {
        throw new ResidentCeoProfileError(
          "resident_ceo_proposal_transition_invalid",
          `Proposal ${proposal.proposalId} is already ${proposal.status}.`,
        );
      }
      if (effectiveResidentCeoProposalSourceChannel(proposal) === "peer-request") {
        await delegation.rejectPeerRequest({
          peerRequestId: proposal.peerRequestId,
          reason,
          idempotencyKey: `resident-ceo-reject-${proposal.proposalId}`,
        });
      }
      const decidedAt = input.now();
      const saved = await commitProfileMutation(principalPersonId, repoId, (current) =>
        transitionResidentCeoProposal(current, proposal.proposalId, {
          status: "rejected",
          decidedAt,
          decidedByPersonId: principalPersonId,
          rejectionReason: reason,
        }),
      );
      return { profile: saved, proposal: findResidentCeoProposal(saved, proposal.proposalId) };
    },
    reportPromotedTaskOutcome: async (
      principalPersonId: string,
      outcomeInput: {
        readonly proposalId: string;
        readonly taskStatus: ResidentCeoPromotedTaskTerminalState;
        readonly summary: string;
      },
      repoId?: string,
    ): Promise<{
      readonly profile: ResidentCeoProfile;
      readonly proposal: ResidentCeoDelegationProposal;
      readonly reported: boolean;
    }> => {
      const profile = await requiredProfile(principalPersonId, repoId);
      const proposal = findResidentCeoProposal(profile, outcomeInput.proposalId);
      if (
        proposal.status !== "promoted" ||
        proposal.promotedTaskId === null ||
        proposal.terminalOutcome !== null ||
        effectiveResidentCeoProposalSourceChannel(proposal) !== "peer-request" ||
        effectiveResidentCeoProposalActionKind(proposal) !== "promote_and_dispatch"
      )
        return { profile, proposal, reported: false };
      const delegation = requiredDelegation();
      await delegation.reportTerminalOutcome({
        peerRequestId: proposal.peerRequestId,
        promotedTaskId: proposal.promotedTaskId,
        taskStatus: outcomeInput.taskStatus,
        summary: outcomeInput.summary,
        idempotencyKey: `resident-ceo-outcome-${proposal.proposalId}-${outcomeInput.taskStatus}`,
      });
      const reportedAt = input.now();
      const saved = await commitProfileMutation(principalPersonId, repoId, (current) =>
        recordResidentCeoProposalTerminalOutcome(current, proposal.proposalId, {
          taskStatus: outcomeInput.taskStatus,
          summary: outcomeInput.summary,
          reportedAt,
        }),
      );
      return { profile: saved, proposal: findResidentCeoProposal(saved, proposal.proposalId), reported: true };
    },
    wake: async (
      principalPersonId: string,
      cause: ResidentCeoWakeCause,
      message: string,
      peerRequestId?: string,
      repoId?: string,
    ) => {
      let profile = await requiredProfile(principalPersonId, repoId);
      if (profile.status !== "running") throw new Error("Resident CEO is stopped.");
      if (cause === "heartbeat" && !residentCeoWakeDue(profile, Date.parse(input.now())))
        return { profile, response: null } as const;
      if (profile.lastWake?.status === "running")
        throw codedError("resident_ceo_busy", "Resident CEO has a turn in progress.");

      const wakeId = input.createId();
      const requestedAt = input.now();
      profile = await update(
        profile,
        residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt: null,
          status: "running",
          runtimeSessionId: null,
          ...(peerRequestId === undefined ? {} : { peerRequestId }),
        }),
      );
      let run: Awaited<ReturnType<ResidentCeoRuntime["run"]>>;
      try {
        run = await input.runtime.run({
          principalPersonId,
          runtimeInstanceId: profile.runtimeInstanceId,
          model: profile.model,
          persistentSessionId: profile.persistentSessionId,
          cause,
          message,
          wakeId,
          ...(peerRequestId === undefined ? {} : { peerRequestId }),
        });
      } catch (error) {
        const completedAt = input.now();
        profile = await requiredProfile(principalPersonId, repoId);
        const failed = residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt,
          status: "failed",
          runtimeSessionId: null,
          ...(peerRequestId === undefined ? {} : { peerRequestId }),
          detail: error instanceof Error ? error.message : String(error),
        });
        const saved = await update(profile, failed);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          residentCeoProfile: saved,
        });
      }
      profile = await requiredProfile(principalPersonId, repoId);
      profile = await update(
        profile,
        residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt: null,
          status: "running",
          runtimeSessionId: run.runtimeSessionId,
          ...(peerRequestId === undefined ? {} : { peerRequestId }),
        }),
      );
      let completedResponse: Awaited<ReturnType<Awaited<ReturnType<ResidentCeoRuntime["run"]>>["awaitResponse"]>>;
      try {
        completedResponse = await run.awaitResponse();
      } catch (error) {
        const completedAt = input.now();
        profile = await requiredProfile(principalPersonId, repoId);
        const failed = residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt,
          status: "failed",
          runtimeSessionId: run.runtimeSessionId,
          ...(peerRequestId === undefined ? {} : { peerRequestId }),
          detail: error instanceof Error ? error.message : String(error),
        });
        const saved = await update(profile, failed);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          residentCeoProfile: saved,
        });
      }
      const completedAt = input.now();
      const saved = await commitProfileMutation(principalPersonId, repoId, (current) =>
        residentCeoWakeReceipt({
          profile: current,
          wakeId,
          cause,
          requestedAt,
          completedAt,
          status: "succeeded",
          runtimeSessionId: run.runtimeSessionId,
          ...(peerRequestId === undefined ? {} : { peerRequestId }),
          ...(current.repoId === profile.repoId &&
          current.runtimeInstanceId === profile.runtimeInstanceId &&
          current.model === profile.model
            ? { persistentSessionId: completedResponse.persistentSessionId }
            : {}),
        }),
      );
      return {
        profile: saved,
        response: completedResponse.response,
        ...(completedResponse.actionReceipts === undefined ? {} : { actionReceipts: completedResponse.actionReceipts }),
      } as const;
    },
  };
}
