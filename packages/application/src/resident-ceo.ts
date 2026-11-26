import {
  assertResidentCeoExecutionAllowed,
  assertResidentCeoPrincipal,
  createResidentCeoProfile,
  evaluateResidentCeoAutoApproval,
  findResidentCeoProposal,
  recordResidentCeoProposalTerminalOutcome,
  ResidentCeoProfileError,
  residentCeoWakeDue,
  residentCeoWakeReceipt,
  transitionResidentCeoProposal,
  upsertResidentCeoProposal,
  type ResidentCeoApprovalMode,
  type ResidentCeoDelegationProposal,
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
    readonly idempotencyKey: string;
  }) => Promise<{ readonly promotedTaskId: string }>;
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

export interface ResidentCeoServiceInput {
  readonly profiles: ResidentCeoProfileStore;
  readonly runtime: ResidentCeoRuntime;
  readonly delegation?: ResidentCeoDelegationExecutor;
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
  readonly proposedPrompt: string | null;
  readonly rationale: string;
  readonly wakeId: string;
}

export interface ResidentCeoApproveProposalInput {
  readonly proposalId: string;
  readonly workId?: string;
  readonly title?: string;
  readonly agentId?: string;
  readonly runtimeInstanceId?: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly approvalMode?: ResidentCeoApprovalMode;
}

function codedError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
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
    const prompt = (approveInput.prompt?.trim() || proposal.proposedPrompt || proposal.summary).trim();
    const { promotedTaskId } = await delegation.promote({
      peerRequestId: proposal.peerRequestId,
      workId,
      title,
      idempotencyKey: `resident-ceo-promote-${proposal.proposalId}`,
    });
    let dispatchRuntimeSessionId: string | null = null;
    let dispatchError: string | null = null;
    if (agentId !== null && delegation.dispatchAgent) {
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
        proposedPrompt: draft.proposedPrompt,
        rationale: draft.rationale,
        wakeId: draft.wakeId,
        status: "pending_approval",
        approvalMode: null,
        createdAt,
        decidedAt: null,
        decidedByPersonId: null,
        promotedTaskId: null,
        dispatchRuntimeSessionId: null,
        dispatchError: null,
        rejectionReason: null,
        terminalOutcome: null,
      };
      const saved = await commitProfileMutation(principalPersonId, repoId, (current) =>
        upsertResidentCeoProposal(current, proposal, createdAt),
      );
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
