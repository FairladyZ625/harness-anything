// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeResidentCeoService } from "../src/resident-ceo.ts";
import type {
  ResidentCeoDelegationProposal,
  ResidentCeoProfile,
} from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

test("supersedesTaskId promotes, cancels old task before dispatch, honors CLI override, supports allowlist-auto, preserves legacy proposals, and surfaces active-lease refusal", async () => {
  let profile: ResidentCeoProfile | null = null;
  let seq = 0;
  let supersedeRejectMessage: string | null = null;
  const order: string[] = [];
  const promoted: { readonly peerRequestId: string; readonly plan?: string }[] = [];
  const supersededCalls: {
    readonly taskId: string;
    readonly promotedTaskId: string;
    readonly peerRequestId: string;
    readonly rationale: string;
    readonly idempotencyKey: string;
  }[] = [];

  const service = makeResidentCeoService({
    profiles: {
      read: async () => profile,
      write: async (next, expectedUpdatedAt) => {
        assert.equal(expectedUpdatedAt, profile?.updatedAt ?? null);
        profile = next;
      },
    },
    runtime: {
      run: async () => ({
        runtimeSessionId: "session-sup",
        awaitResponse: async () => ({ response: "ok", persistentSessionId: "p-sup" }),
      }),
    },
    delegation: {
      promote: async (req) => {
        order.push("promote");
        promoted.push({ peerRequestId: req.peerRequestId, plan: req.plan });
        return { promotedTaskId: `task_sup_new_${promoted.length}` };
      },
      supersedeTask: async (req) => {
        order.push(`supersede:${req.taskId}`);
        supersededCalls.push({
          taskId: req.taskId,
          promotedTaskId: req.promotedTaskId,
          peerRequestId: req.peerRequestId,
          rationale: req.rationale,
          idempotencyKey: req.idempotencyKey,
        });
        if (supersedeRejectMessage !== null) throw new Error(supersedeRejectMessage);
      },
      dispatchAgent: async (req) => {
        order.push(`dispatch:${req.taskId}`);
        return { runtimeSessionId: `rt_sup_${promoted.length}` };
      },
      rejectPeerRequest: async () => undefined,
      reportTerminalOutcome: async () => undefined,
    },
    now: () => "2026-11-27T04:00:00.000Z",
    createId: () => `sup${++seq}abcdef0123456789`,
  });

  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
  });

  // 1. Proposal with proposedSupersedesTaskId cancels old task AFTER promote and BEFORE dispatchAgent.
  const draft1 = await service.recordProposal("person_owner", {
    peerRequestId: "peer_sup_1",
    fromPersonId: "person_alice",
    summary: "Replace stale PR 1A draft",
    proposedTitle: "Replace stale PR 1A draft",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedSupersedesTaskId: "task_old_1",
    proposedPrompt: "Implement replacement",
    rationale: "Old task was superseded.",
    wakeId: "wake_sup_1",
  });
  assert.equal(draft1.proposal.proposedSupersedesTaskId, "task_old_1");
  const approved1 = await service.approveProposal("person_owner", { proposalId: draft1.proposal.proposalId });
  assert.equal(approved1.proposal.status, "promoted");
  assert.equal(approved1.proposal.promotedTaskId, "task_sup_new_1");
  assert.equal(approved1.proposal.proposedSupersedesTaskId, "task_old_1");
  assert.equal(approved1.proposal.supersededTaskId, "task_old_1");
  assert.equal(approved1.proposal.supersedeError, null);
  assert.deepEqual(order, ["promote", "supersede:task_old_1", "dispatch:task_sup_new_1"]);
  assert.match(promoted[0]?.plan ?? "", /Supersedes: `task_old_1`/u);
  assert.match(supersededCalls[0]?.rationale ?? "", /task_sup_new_1/u);
  assert.match(supersededCalls[0]?.rationale ?? "", /peer_sup_1/u);
  assert.equal(supersededCalls[0]?.idempotencyKey, `resident-ceo-supersede-${draft1.proposal.proposalId}-task_old_1`);

  // 2. approveInput.supersedesTaskId overrides proposal.proposedSupersedesTaskId; invalid override rejects before promote.
  const draft2 = await service.recordProposal("person_owner", {
    peerRequestId: "peer_sup_2",
    fromPersonId: "person_alice",
    summary: "Override supersedes target",
    proposedTitle: "Override supersedes target",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedSupersedesTaskId: "task_old_ignored",
    proposedPrompt: "Run override",
    rationale: "Owner overrides target",
    wakeId: "wake_sup_2",
  });
  await assert.rejects(
    service.approveProposal("person_owner", {
      proposalId: draft2.proposal.proposalId,
      supersedesTaskId: "bad task/id",
    }),
    { code: "invalid_field" },
  );
  assert.equal(promoted.length, 1, "invalid supersedesTaskId must fail before promotion");

  const approved2 = await service.approveProposal("person_owner", {
    proposalId: draft2.proposal.proposalId,
    supersedesTaskId: "task_old_override",
  });
  assert.equal(approved2.proposal.proposedSupersedesTaskId, "task_old_override");
  assert.equal(approved2.proposal.supersededTaskId, "task_old_override");
  assert.equal(approved2.proposal.supersedeError, null);
  assert.equal(supersededCalls[1]?.taskId, "task_old_override");

  // 3. Self-supersede guard refuses without calling supersedeTask when supersedesTaskId === promotedTaskId.
  const draftSelf = await service.recordProposal("person_owner", {
    peerRequestId: "peer_sup_self",
    fromPersonId: "person_alice",
    summary: "Self supersede guard",
    proposedTitle: "Self supersede guard",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedSupersedesTaskId: "task_sup_new_3",
    proposedPrompt: "Verify guard",
    rationale: "Should not cancel self",
    wakeId: "wake_sup_self",
  });
  const approvedSelf = await service.approveProposal("person_owner", { proposalId: draftSelf.proposal.proposalId });
  assert.equal(approvedSelf.proposal.promotedTaskId, "task_sup_new_3");
  assert.equal(approvedSelf.proposal.supersededTaskId, null);
  assert.match(approvedSelf.proposal.supersedeError ?? "", /matches promoted task task_sup_new_3/u);
  assert.equal(supersededCalls.length, 2);

  // 4. Negative control: active-lease refusal from supersedeTask is surfaced in supersedeError (never silently swallowed).
  supersedeRejectMessage = "Cannot supersede task task_live_lease: task holds an active held lease (exe_live).";
  const draftLive = await service.recordProposal("person_owner", {
    peerRequestId: "peer_sup_live",
    fromPersonId: "person_alice",
    summary: "Active lease protection",
    proposedTitle: "Active lease protection",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedSupersedesTaskId: "task_live_lease",
    proposedPrompt: "Should not kill active lease",
    rationale: "Protect active holder",
    wakeId: "wake_sup_live",
  });
  const approvedLive = await service.approveProposal("person_owner", { proposalId: draftLive.proposal.proposalId });
  assert.equal(approvedLive.proposal.status, "promoted");
  assert.equal(approvedLive.proposal.supersededTaskId, null);
  assert.match(approvedLive.proposal.supersedeError ?? "", /active held lease/u);

  // 5. Allowlist-auto preserves proposedSupersedesTaskId and cancels the old task automatically.
  supersedeRejectMessage = null;
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    autoApproveSenders: ["person_trusted"],
  });
  const autoSup = await service.recordProposal("person_owner", {
    peerRequestId: "peer_sup_auto",
    fromPersonId: "person_trusted",
    summary: "Allowlist auto supersede",
    proposedTitle: "Allowlist auto supersede",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedSupersedesTaskId: "task_old_auto",
    proposedPrompt: "Auto supersede",
    rationale: "Trusted sender replacement",
    wakeId: "wake_sup_auto",
  });
  assert.equal(autoSup.autoApproved, true);
  assert.equal(autoSup.proposal.supersededTaskId, "task_old_auto");
  assert.equal(autoSup.proposal.supersedeError, null);

  // 6. Historical persisted proposal lacking proposedSupersedesTaskId approves cleanly (dec_659E15CF backward compat).
  const legacyProposal: ResidentCeoDelegationProposal = {
    proposalId: "prop_legacy_no_supersede",
    peerRequestId: "peer_legacy_1",
    fromPersonId: "person_alice",
    summary: "Legacy proposal without proposedSupersedesTaskId",
    proposedTitle: "Legacy proposal",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Run legacy task",
    rationale: "Persisted before supersedesTaskId existed",
    wakeId: "wake_legacy",
    status: "pending_approval",
    approvalMode: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    decidedAt: null,
    decidedByPersonId: null,
    promotedTaskId: null,
    dispatchRuntimeSessionId: null,
    dispatchError: null,
    rejectionReason: null,
    terminalOutcome: null,
  };
  profile = {
    ...profile!,
    proposals: [...(profile!.proposals ?? []), legacyProposal],
  };
  const approvedLegacy = await service.approveProposal("person_owner", { proposalId: "prop_legacy_no_supersede" });
  assert.equal(approvedLegacy.proposal.status, "promoted");
  assert.equal(approvedLegacy.proposal.proposedSupersedesTaskId, null);
  assert.equal(approvedLegacy.proposal.supersededTaskId, null);
  assert.equal(approvedLegacy.proposal.supersedeError, null);
});
