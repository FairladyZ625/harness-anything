// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeResidentCeoService } from "../src/resident-ceo.ts";
import type { ResidentCeoProfile } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

test("Tier 0 actions, Tier 1 owner-direct fastpath, active-lease rejection, and Tier 2 fail-closed audit", async () => {
  let profile: ResidentCeoProfile | null = null;
  let seq = 0;
  const peerAsks: unknown[] = [];
  const peerReplies: unknown[] = [];
  const steers: unknown[] = [];
  const startedExisting: unknown[] = [];
  const cleanups: unknown[] = [];
  const syncedPlans: unknown[] = [];
  const rejectedPeers: unknown[] = [];
  let blockActiveLease = false;

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
        runtimeSessionId: "session-1",
        awaitResponse: async () => ({ response: "ok", persistentSessionId: "p-1" }),
      }),
    },
    delegation: {
      promote: async () => ({ promotedTaskId: "task_promoted_1" }),
      rejectPeerRequest: async (req) => {
        rejectedPeers.push(req);
      },
      reportTerminalOutcome: async () => undefined,
      peerAsk: async (req) => {
        peerAsks.push(req);
        return { requestId: `peer_sent_${peerAsks.length}` };
      },
      peerReply: async (req) => {
        peerReplies.push(req);
        return { requestId: req.requestId, outcome: req.outcome ?? "answered" };
      },
      runtimeSteer: async (req) => {
        steers.push(req);
        return {
          runtimeSessionId: req.runtimeSessionId ?? "rs_steered_1",
          dispatchId: req.dispatchId ?? "disp_steered_1",
          opId: `op_steer_${steers.length}`,
        };
      },
      startExistingTask: async (req) => {
        startedExisting.push(req);
        return {
          taskId: req.taskId,
          dispatchedTargetNodeId: null,
          dispatchRuntimeSessionId: "rs_started_1",
          dispatchError: null,
        };
      },
      archiveOrCancelUnleased: async (req) => {
        cleanups.push(req);
        if (blockActiveLease) {
          throw Object.assign(new Error(`Task ${req.taskId} has an active lease.`), {
            code: "resident_ceo_active_lease_blocked",
          });
        }
        return { taskId: req.taskId, appliedAction: req.cleanupMode === "archive" ? "archived" : "cancelled" };
      },
      syncTaskPlan: async (req) => {
        syncedPlans.push(req);
        return { taskId: req.taskId, path: `tasks/${req.taskId}/task_plan.md` };
      },
    },
    now: () => "2026-11-27T04:10:00.000Z",
    createId: () => `tier${++seq}abcdef0123456789`,
  });

  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
    autoApproveSenders: ["person_zeyu"],
  });

  // 1. Tier 0 peer_ask / peer_reply / runtime_steer on human-chat -> owner-direct
  const askReceipt = await service.executeTier0Action("person_owner", {
    wakeId: "wake_1",
    channel: "human-chat",
    actorPersonId: "person_owner",
    action: { actionKind: "peer_ask", toPersonId: "person_zeyu", summary: "Ask PR 1B progress" },
  });
  assert.equal(askReceipt.outcome, "executed");
  assert.equal(askReceipt.approvalMode, "owner-direct");
  assert.equal(askReceipt.requestId, "peer_sent_1");

  const replyReceipt = await service.executeTier0Action("person_owner", {
    wakeId: "wake_1",
    channel: "human-chat",
    actorPersonId: "person_owner",
    action: { actionKind: "peer_reply", requestId: "peer_in_1", claim: "On track" },
  });
  assert.equal(replyReceipt.outcome, "executed");
  assert.equal(peerReplies.length, 1);

  const steerReceipt = await service.executeTier0Action("person_owner", {
    wakeId: "wake_1",
    channel: "human-chat",
    actorPersonId: "person_owner",
    action: { actionKind: "runtime_steer", runtimeSessionId: "rs_live_1", prompt: "Focus on tests" },
  });
  assert.equal(steerReceipt.outcome, "executed");
  assert.equal(steers.length, 1);

  // 2. Tier 0 peer_ask from external peer-request to non-allowlisted target -> denied + audited
  const deniedAsk = await service.executeTier0Action("person_owner", {
    wakeId: "wake_2",
    channel: "peer-request",
    actorPersonId: "person_stranger",
    targetPersonId: "person_victim",
    action: { actionKind: "peer_ask", toPersonId: "person_victim", summary: "Spam target" },
  });
  assert.equal(deniedAsk.outcome, "denied");
  assert.equal(deniedAsk.errorCode, "resident_ceo_tier0_target_denied");
  assert.equal(peerAsks.length, 1);

  // 3. Tier 1 human-chat owner-direct fastpath: start_and_dispatch_existing & doc_sync_plan
  const started = await service.recordProposal("person_owner", {
    peerRequestId: "human-chat:wake_3:0",
    fromPersonId: "person_owner",
    summary: "Start task_pr1b",
    actionKind: "start_and_dispatch_existing",
    sourceChannel: "human-chat",
    targetTaskId: "task_pr1b",
    proposedTitle: "Start task_pr1b",
    proposedWorkId: null,
    proposedAgentId: "neon",
    proposedPrompt: "Run PR 1B",
    rationale: "Owner direct start",
    wakeId: "wake_3",
  });
  assert.equal(started.autoApproved, true);
  assert.equal(started.proposal.status, "promoted");
  assert.equal(started.proposal.approvalMode, "owner-direct");
  assert.equal(started.proposal.promotedTaskId, "task_pr1b");
  assert.equal(started.proposal.dispatchRuntimeSessionId, "rs_started_1");
  assert.equal(startedExisting.length, 1);

  const synced = await service.recordProposal("person_owner", {
    peerRequestId: "human-chat:wake_4:0",
    fromPersonId: "person_owner",
    summary: "Update task_pr1b plan",
    actionKind: "doc_sync_plan",
    sourceChannel: "human-chat",
    targetTaskId: "task_pr1b",
    planContent: "# Updated plan\n",
    proposedTitle: "Sync plan",
    proposedWorkId: null,
    proposedAgentId: null,
    proposedPrompt: null,
    rationale: "Owner direct plan sync",
    wakeId: "wake_4",
  });
  assert.equal(synced.autoApproved, true);
  assert.equal(synced.proposal.status, "promoted");
  assert.equal(syncedPlans.length, 1);

  // 4. archive_or_cancel_unleased active lease guard: marks proposal failed + records denied audit on owner-direct
  blockActiveLease = true;
  const blockedCleanup = await service.recordProposal("person_owner", {
    peerRequestId: "human-chat:wake_5:0",
    fromPersonId: "person_owner",
    summary: "Cancel active task",
    actionKind: "archive_or_cancel_unleased",
    sourceChannel: "human-chat",
    targetTaskId: "task_active_1",
    cleanupMode: "cancel",
    proposedTitle: "Cleanup task_active_1",
    proposedWorkId: null,
    proposedAgentId: null,
    proposedPrompt: null,
    rationale: "Try cleaning active task",
    wakeId: "wake_5",
  });
  assert.equal(blockedCleanup.autoApproved, false);
  assert.equal(blockedCleanup.errorCode, "resident_ceo_active_lease_blocked");
  assert.equal(blockedCleanup.proposal.status, "failed");

  // 5. External peer-request stays pending_approval and rejecting a human-chat proposal does not call rejectPeerRequest
  const extPending = await service.recordProposal("person_owner", {
    peerRequestId: "peer_ext_1",
    fromPersonId: "person_stranger",
    summary: "External start request",
    actionKind: "start_and_dispatch_existing",
    sourceChannel: "peer-request",
    targetTaskId: "task_pr1b",
    proposedTitle: "External start",
    proposedWorkId: null,
    proposedAgentId: "neon",
    proposedPrompt: null,
    rationale: "External peer",
    wakeId: "wake_6",
  });
  assert.equal(extPending.autoApproved, false);
  assert.equal(extPending.proposal.status, "pending_approval");

  // 6. Tier 2 rejection recorded in audit log and forged Tier 2 proposal rejected fail-closed
  const t2 = await service.recordTier2Rejection("person_owner", {
    wakeId: "wake_7",
    channel: "human-chat",
    actorPersonId: "person_owner",
    rawAction: "review-consent",
    rationale: "Attempted auto-consent",
  });
  assert.equal(t2.outcome, "denied");
  assert.equal(t2.errorCode, "resident_ceo_tier2_forbidden");

  await assert.rejects(
    service.recordProposal("person_owner", {
      peerRequestId: "peer_forged_t2",
      fromPersonId: "person_owner",
      summary: "Forged",
      actionKind: "task_complete" as never,
      proposedTitle: "Forged",
      proposedWorkId: "task_work_1",
      proposedAgentId: null,
      proposedPrompt: null,
      rationale: "Forged",
      wakeId: "wake_8",
    }),
    { code: "resident_ceo_tier2_forbidden" },
  );

  const saved = await service.status("person_owner");
  assert.ok(
    (saved.actionAuditLog ?? []).some(
      (entry) => entry.tier === "tier2" && entry.errorCode === "resident_ceo_tier2_forbidden",
    ),
  );
  assert.ok(
    (saved.actionAuditLog ?? []).some(
      (entry) =>
        entry.actionKind === "archive_or_cancel_unleased" && entry.errorCode === "resident_ceo_active_lease_blocked",
    ),
  );
  assert.equal(rejectedPeers.length, 0);
});
