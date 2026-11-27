import {
  assertResidentCeoExecutionAllowed,
  assertResidentCeoPrincipal,
  checkResidentCeoGatePreconditions,
  createResidentCeoProfile,
  effectiveResidentCeoApprovalGate,
  evaluateResidentCeoAutoApproval,
  evaluateResidentCeoGateDecision,
  findResidentCeoProposal,
  isValidResidentCeoEntityId,
  isValidResidentCeoTargetNodeId,
  recordResidentCeoProposalGateVerdict,
  recordResidentCeoProposalTerminalOutcome,
  ResidentCeoProfileError,
  residentCeoWakeDue,
  residentCeoWakeReceipt,
  transitionResidentCeoProposal,
  upsertResidentCeoProposal,
  type ResidentCeoApprovalGateMode,
  type ResidentCeoApprovalMode,
  type ResidentCeoDelegationProposal,
  type ResidentCeoGateObservation,
  type ResidentCeoProfile,
  type ResidentCeoProfileInput,
  type ResidentCeoPromotedTaskTerminalState,
  type ResidentCeoProposalStatus,
  type ResidentCeoWakeCause,
} from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

export interface ResidentCeoProfileStore {
  readonly read: (principalPersonId: string) => Promise<ResidentCeoProfile | null>;
  /** Writes are serialized by the owning daemon writer. */
  readonly write: (profile: ResidentCeoProfile, expectedUpdatedAt: string | null) => Promise<void>;
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
    readonly awaitResponse: () => Promise<{ readonly response: string; readonly persistentSessionId: string | null }>;
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
  readonly resolveLocalNodeId?: () => string | null;
  readonly assignToNode?: (input: {
    readonly taskId: string;
    readonly targetNodeId: string;
    readonly idempotencyKey: string;
  }) => Promise<void>;
  readonly supersedeTask?: (input: {
    readonly taskId: string;
    readonly promotedTaskId: string;
    readonly peerRequestId: string;
    readonly proposalId: string;
    readonly rationale: string;
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
  readonly proposedTitle: string;
  readonly proposedWorkId: string | null;
  readonly proposedAgentId: string | null;
  readonly proposedTargetNodeId?: string | null;
  readonly proposedSupersedesTaskId?: string | null;
  readonly proposedPrompt: string | null;
  readonly rationale: string;
  readonly wakeId: string;
}

export interface ResidentCeoApproveProposalInput {
  readonly proposalId: string;
  readonly workId?: string;
  readonly title?: string;
  readonly agentId?: string;
  readonly targetNodeId?: string;
  readonly supersedesTaskId?: string;
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
  readonly supersedesTaskId?: string | null;
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
    `- Target Work: \`${input.workId}\`; Assigned Executor: ${assignee}${input.targetNodeId ? `; Target Node: \`${input.targetNodeId}\`` : ""}${input.supersedesTaskId ? `; Supersedes: \`${input.supersedesTaskId}\`` : ""}.`,
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
    const workId = (approveInput.workId?.trim() || proposal.proposedWorkId || profile.defaultWorkId || "").trim();
    if (workId.length === 0)
      throw codedError("invalid_field", "Target work id (--work) is required to approve and promote this proposal.");
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
    const supersedesTaskId = (() => {
      if (approveInput.supersedesTaskId !== undefined) {
        const trimmed = approveInput.supersedesTaskId.trim();
        if (trimmed.length === 0 || !isValidResidentCeoEntityId(trimmed))
          throw codedError("invalid_field", `Invalid supersedesTaskId: ${approveInput.supersedesTaskId}.`);
        return trimmed;
      }
      const proposed = proposal.proposedSupersedesTaskId ?? null;
      if (proposed === null) return null;
      const trimmed = proposed.trim();
      if (trimmed.length === 0) return null;
      if (!isValidResidentCeoEntityId(trimmed))
        throw codedError("invalid_field", `Invalid proposedSupersedesTaskId: ${proposed}.`);
      return trimmed;
    })();
    const prompt = (approveInput.prompt?.trim() || proposal.proposedPrompt || proposal.summary).trim();
    const approvalMode = approveInput.approvalMode ?? "manual";
    const plan = buildResidentCeoPromotedTaskPlan({
      proposalId: proposal.proposalId,
      peerRequestId: proposal.peerRequestId,
      fromPersonId: proposal.fromPersonId,
      decidedByPersonId: principalPersonId,
      approvalMode,
      workId,
      agentId,
      targetNodeId,
      supersedesTaskId,
      title,
      summary: proposal.summary,
      prompt,
      rationale: proposal.rationale,
      wakeId: proposal.wakeId,
    });
    const { promotedTaskId } = await delegation.promote({
      peerRequestId: proposal.peerRequestId,
      workId,
      title,
      plan,
      idempotencyKey: `resident-ceo-promote-${proposal.proposalId}`,
    });
    let supersededTaskId: string | null = null;
    let supersedeError: string | null = null;
    if (supersedesTaskId !== null) {
      if (supersedesTaskId === promotedTaskId) {
        supersedeError = `Cannot supersede task ${supersedesTaskId}: target matches promoted task ${promotedTaskId}.`;
      } else if (!delegation.supersedeTask) {
        supersedeError = `Task ${supersedesTaskId} cannot be superseded because task supersede executor is unavailable.`;
      } else {
        const [superseded] = await Promise.allSettled([
          delegation.supersedeTask({
            taskId: supersedesTaskId,
            promotedTaskId,
            peerRequestId: proposal.peerRequestId,
            proposalId: proposal.proposalId,
            rationale: `Superseded by promoted task ${promotedTaskId} (proposal ${proposal.proposalId}, peer request ${proposal.peerRequestId}).`,
            idempotencyKey: `resident-ceo-supersede-${proposal.proposalId}-${supersedesTaskId}`,
          }),
        ]);
        if (superseded.status === "fulfilled") supersededTaskId = supersedesTaskId;
        else
          supersedeError = superseded.reason instanceof Error ? superseded.reason.message : String(superseded.reason);
      }
    }
    const localNodeId = delegation.resolveLocalNodeId?.() ?? null;
    const isRemoteTargetNode = targetNodeId !== null && targetNodeId !== localNodeId;
    let dispatchRuntimeSessionId: string | null = null;
    let dispatchedTargetNodeId: string | null = null;
    let dispatchError: string | null = null;
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
    const decidedAt = input.now();
    const saved = await commitProfileMutation(principalPersonId, repoId, (current) =>
      transitionResidentCeoProposal(current, proposal.proposalId, {
        status: "promoted",
        approvalMode: approveInput.approvalMode ?? "manual",
        decidedAt,
        decidedByPersonId: principalPersonId,
        promotedTaskId,
        proposedWorkId: workId,
        proposedTitle: title,
        proposedAgentId: agentId,
        proposedTargetNodeId: targetNodeId,
        proposedSupersedesTaskId: supersedesTaskId,
        supersededTaskId,
        supersedeError,
        dispatchedTargetNodeId,
        dispatchRuntimeSessionId,
        dispatchError,
      }),
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
    recordProposal: async (
      principalPersonId: string,
      draft: ResidentCeoProposalDraft,
      repoId?: string,
    ): Promise<{
      readonly profile: ResidentCeoProfile;
      readonly proposal: ResidentCeoDelegationProposal;
      readonly autoApproved: boolean;
    }> => {
      const profile = await requiredProfile(principalPersonId, repoId);
      assertResidentCeoExecutionAllowed(profile, "recording delegation proposals");
      const existing = (profile.proposals ?? []).find((entry) => entry.peerRequestId === draft.peerRequestId);
      if (existing) return { profile, proposal: existing, autoApproved: false };
      const createdAt = input.now();
      const proposalId = `prop_${input.createId().replaceAll("-", "").slice(0, 16)}`;
      const proposal: ResidentCeoDelegationProposal = {
        proposalId,
        peerRequestId: draft.peerRequestId,
        fromPersonId: draft.fromPersonId,
        summary: draft.summary,
        proposedTitle: draft.proposedTitle,
        proposedWorkId: draft.proposedWorkId,
        proposedAgentId: draft.proposedAgentId,
        proposedTargetNodeId: draft.proposedTargetNodeId ?? null,
        proposedSupersedesTaskId: draft.proposedSupersedesTaskId ?? null,
        proposedPrompt: draft.proposedPrompt,
        rationale: draft.rationale,
        wakeId: draft.wakeId,
        status: "pending_approval",
        approvalMode: null,
        createdAt,
        decidedAt: null,
        decidedByPersonId: null,
        promotedTaskId: null,
        supersededTaskId: null,
        supersedeError: null,
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
      const gate = effectiveResidentCeoApprovalGate(saved);
      if (gate.mode === "off") {
        const auto = evaluateResidentCeoAutoApproval(saved, proposal);
        if (auto.autoApprove && input.delegation) {
          const approved = await approveProposal(
            principalPersonId,
            { proposalId, workId: auto.workId, approvalMode: "allowlist-auto" },
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
        { proposalId, workId: evaluation.workId, approvalMode: "decider-auto" },
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
      await delegation.rejectPeerRequest({
        peerRequestId: proposal.peerRequestId,
        reason,
        idempotencyKey: `resident-ceo-reject-${proposal.proposalId}`,
      });
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
      if (proposal.status !== "promoted" || proposal.promotedTaskId === null || proposal.terminalOutcome !== null)
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
      return { profile: saved, response: completedResponse.response } as const;
    },
  };
}
