// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { makeResidentCeoService } from "../src/resident-ceo.ts";
import type { ResidentCeoProfile } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

function fixture() {
  let profile: ResidentCeoProfile | null = null;
  let now = "2026-11-24T00:00:00.000Z";
  const runs: { readonly persistentSessionId: string | null; readonly peerRequestId?: string }[] = [];
  const service = makeResidentCeoService({
    profiles: {
      read: async () => profile,
      write: async (next, expectedUpdatedAt) => {
        assert.equal(expectedUpdatedAt, profile?.updatedAt ?? null);
        profile = next;
      },
    },
    runtime: {
      run: async (request) => {
        runs.push({
          persistentSessionId: request.persistentSessionId,
          ...(request.peerRequestId === undefined ? {} : { peerRequestId: request.peerRequestId }),
        });
        return {
          runtimeSessionId: `session-${runs.length}`,
          awaitResponse: async () => ({
            response: `reply-${runs.length}`,
            persistentSessionId: `provider-session-${runs.length}`,
          }),
        };
      },
    },
    now: () => now,
    createId: () => `wake-${runs.length + 1}`,
  });
  return { service, runs, setNow: (value: string) => (now = value) };
}

test("resident CEO config, start, and stop preserve principal ownership", async () => {
  const { service } = fixture();
  const configured = await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  assert.equal(configured.status, "stopped");
  assert.equal((await service.start("person_owner")).status, "running");
  assert.equal((await service.stop("person_owner")).status, "stopped");
  await assert.rejects(service.status("person_other"), /belongs to person_owner/u);
});

test("resident CEO actions reject a profile bound to another repository", async () => {
  const { service } = fixture();
  await service.configure("person_owner", {
    repoId: "repo-one",
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await assert.rejects(service.start("person_owner", "repo-two"), { code: "resident_ceo_repo_mismatch" });
  assert.equal((await service.status("person_owner"))?.status, "stopped");
});

test("chat and peer wakes resume the same persistent session and record a receipt", async () => {
  const { service, runs, setNow } = fixture();
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await service.start("person_owner");
  const first = await service.wake("person_owner", "human-chat", "Please review the current plan.");
  setNow("2026-11-24T00:00:30.000Z");
  const second = await service.wake(
    "person_owner",
    "peer-request",
    "Peer request: prepare a handoff.",
    "peer_request_1",
  );
  assert.equal(first.response, "reply-1");
  assert.equal(second.response, "reply-2");
  assert.equal(runs[0]?.persistentSessionId, null);
  assert.equal(runs[1]?.persistentSessionId, "provider-session-1");
  assert.equal(runs[1]?.peerRequestId, "peer_request_1");
  assert.equal(second.profile.persistentSessionId, "provider-session-2");
  assert.equal(second.profile.lastWake?.cause, "peer-request");
  assert.equal(second.profile.lastWake?.status, "succeeded");
});

test("heartbeat wakes only when due and persists the current session pointer", async () => {
  const { service, runs, setNow } = fixture();
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await service.start("person_owner");
  await service.wake("person_owner", "heartbeat", "Check inbox.");
  setNow("2026-11-24T00:00:59.999Z");
  const early = await service.wake("person_owner", "heartbeat", "Check inbox.");
  assert.equal(early.response, null);
  assert.equal(runs.length, 1);
  setNow("2026-11-24T00:01:00.000Z");
  const next = await service.wake("person_owner", "heartbeat", "Check inbox.");
  assert.equal(next.response, "reply-2");
  assert.equal(runs[1]?.persistentSessionId, "provider-session-1");
});

test("changing provider instance or model clears an incompatible provider session pointer", async () => {
  const { service } = fixture();
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await service.start("person_owner");
  await service.wake("person_owner", "human-chat", "Continue this session.");
  const changed = await service.configure("person_owner", {
    runtimeInstanceId: "instance-two",
    model: "model-two",
    heartbeatIntervalSec: 60,
  });
  assert.equal(changed.persistentSessionId, null);
  assert.equal(changed.status, "running");
});

test("failed runtime response settles cleanly without unhandled rejection while profile persistence is pending", async () => {
  let profile: ResidentCeoProfile | null = null;
  let now = "2026-11-24T00:00:00.000Z";
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const service = makeResidentCeoService({
      profiles: {
        read: async () => profile,
        write: async (next, expectedUpdatedAt) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          assert.equal(expectedUpdatedAt, profile?.updatedAt ?? null);
          profile = next;
        },
      },
      runtime: {
        run: async () => ({
          runtimeSessionId: "session-fail",
          awaitResponse: async () => {
            throw new Error("Runtime session lost: Dispatch stalled after 300000 ms.");
          },
        }),
      },
      now: () => now,
      createId: () => "wake-fail",
    });
    await service.configure("person_owner", {
      runtimeInstanceId: "instance-one",
      model: "model-one",
      heartbeatIntervalSec: 60,
    });
    await service.start("person_owner");
    now = "2026-11-24T00:00:05.000Z";
    await assert.rejects(
      service.wake("person_owner", "peer-request", "Check stalled turn.", "peer_request_fail"),
      /Dispatch stalled after 300000 ms/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0);
    const saved = await service.status("person_owner");
    assert.equal(saved.lastWake?.status, "failed");
    assert.equal(saved.lastWake?.runtimeSessionId, "session-fail");
    assert.match(saved.lastWake?.detail ?? "", /Dispatch stalled after 300000 ms/u);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("profile write failure before awaiting response does not invoke awaitResponse", async () => {
  let profile: ResidentCeoProfile | null = null;
  let writeCount = 0;
  let awaitResponseCalled = false;
  const service = makeResidentCeoService({
    profiles: {
      read: async () => profile,
      write: async (next, expectedUpdatedAt) => {
        writeCount += 1;
        // Writes: 1 configure, 2 start, 3 initial wake ("running"), 4 persist runtimeSessionId -> fail here.
        if (writeCount === 4) throw new Error("simulated write failure");
        assert.equal(expectedUpdatedAt, profile?.updatedAt ?? null);
        profile = next;
      },
    },
    runtime: {
      run: async () => ({
        runtimeSessionId: "session-orphaned",
        awaitResponse: async () => {
          awaitResponseCalled = true;
          throw new Error("must not run when runtimeSessionId write fails");
        },
      }),
    },
    now: () => "2026-11-24T00:00:00.000Z",
    createId: () => "wake-write-fail",
  });
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await service.start("person_owner");
  await assert.rejects(service.wake("person_owner", "human-chat", "Hi"), /simulated write failure/u);
  assert.equal(awaitResponseCalled, false);
});

test("advisory-only policy rejects proposal creation, approval, and rejection without invoking delegation writes", async () => {
  let profile: ResidentCeoProfile | null = null;
  let delegationCalls = 0;
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
      promote: async () => {
        delegationCalls += 1;
        return { promotedTaskId: "task_should_not_happen" };
      },
      rejectPeerRequest: async () => {
        delegationCalls += 1;
      },
      reportTerminalOutcome: async () => {
        delegationCalls += 1;
      },
    },
    now: () => "2026-11-24T00:00:00.000Z",
    createId: () => "id-advisory",
  });
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
  });
  await assert.rejects(
    service.recordProposal("person_owner", {
      peerRequestId: "peer_1",
      fromPersonId: "person_alice",
      summary: "Create task",
      proposedTitle: "Create task",
      proposedWorkId: "task_work_1",
      proposedAgentId: null,
      proposedPrompt: "Do it",
      rationale: "Requested",
      wakeId: "wake_1",
    }),
    { code: "resident_ceo_advisory_only" },
  );
  await assert.rejects(service.approveProposal("person_owner", { proposalId: "prop_1", workId: "task_work_1" }), {
    code: "resident_ceo_advisory_only",
  });
  await assert.rejects(service.rejectProposal("person_owner", { proposalId: "prop_1", reason: "No" }), {
    code: "resident_ceo_advisory_only",
  });
  assert.equal(delegationCalls, 0);
});

test("approval-gated lifecycle records proposal, approves with promote + dispatch, reports terminal outcome, and supports allowlist auto-approval", async () => {
  let profile: ResidentCeoProfile | null = null;
  let seq = 0;
  const promoted: unknown[] = [];
  const dispatched: unknown[] = [];
  const rejected: unknown[] = [];
  const reported: unknown[] = [];
  let failDispatch = false;
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
      promote: async (req) => {
        promoted.push(req);
        return { promotedTaskId: `task_promoted_${promoted.length}` };
      },
      dispatchAgent: async (req) => {
        dispatched.push(req);
        if (failDispatch) throw new Error("agent_not_ready");
        return { runtimeSessionId: `runtime_dispatched_${dispatched.length}` };
      },
      rejectPeerRequest: async (req) => {
        rejected.push(req);
      },
      reportTerminalOutcome: async (req) => {
        reported.push(req);
      },
    },
    now: () => "2026-11-24T00:00:00.000Z",
    createId: () => `id${++seq}abcdef0123456789`,
  });

  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
  });

  // 1. Manual approval flow
  const recorded = await service.recordProposal("person_owner", {
    peerRequestId: "peer_1",
    fromPersonId: "person_alice",
    summary: "Build feature X",
    proposedTitle: "Build feature X",
    proposedWorkId: null,
    proposedAgentId: null,
    proposedPrompt: "Implement feature X",
    rationale: "Valid delegation",
    wakeId: "wake_1",
  });
  assert.equal(recorded.autoApproved, false);
  assert.equal(recorded.proposal.status, "pending_approval");
  assert.equal((await service.listProposals("person_owner", { status: "pending_approval" })).length, 1);

  const approved = await service.approveProposal("person_owner", { proposalId: recorded.proposal.proposalId });
  assert.equal(approved.proposal.status, "promoted");
  assert.equal(approved.proposal.approvalMode, "manual");
  assert.equal(approved.proposal.promotedTaskId, "task_promoted_1");
  assert.equal(approved.proposal.dispatchRuntimeSessionId, "runtime_dispatched_1");
  assert.equal(approved.proposal.dispatchError, null);
  assert.equal(promoted.length, 1);
  assert.equal(dispatched.length, 1);

  const firstReport = await service.reportPromotedTaskOutcome("person_owner", {
    proposalId: recorded.proposal.proposalId,
    taskStatus: "done",
    summary: "Build feature X",
  });
  assert.equal(firstReport.reported, true);
  assert.equal(firstReport.proposal.terminalOutcome?.taskStatus, "done");
  assert.equal(reported.length, 1);
  const secondReport = await service.reportPromotedTaskOutcome("person_owner", {
    proposalId: recorded.proposal.proposalId,
    taskStatus: "done",
    summary: "Build feature X",
  });
  assert.equal(secondReport.reported, false);
  assert.equal(reported.length, 1);

  // 2. Manual rejection flow
  const toReject = await service.recordProposal("person_owner", {
    peerRequestId: "peer_2",
    fromPersonId: "person_bob",
    summary: "Unneeded work",
    proposedTitle: "Unneeded work",
    proposedWorkId: "task_work_1",
    proposedAgentId: null,
    proposedPrompt: "Skip",
    rationale: "Waiting for decision",
    wakeId: "wake_2",
  });
  const rej = await service.rejectProposal("person_owner", {
    proposalId: toReject.proposal.proposalId,
    reason: "Out of scope",
  });
  assert.equal(rej.proposal.status, "rejected");
  assert.equal(rej.proposal.rejectionReason, "Out of scope");
  assert.equal(rejected.length, 1);

  // 3. Allowlist auto-approval + truthful dispatchError capture
  failDispatch = true;
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    autoApproveSenders: ["person_trusted"],
  });
  const auto = await service.recordProposal("person_owner", {
    peerRequestId: "peer_3",
    fromPersonId: "person_trusted",
    summary: "Trusted work",
    proposedTitle: "Trusted work",
    proposedWorkId: null,
    proposedAgentId: "neon",
    proposedPrompt: "Run trusted work",
    rationale: "Trusted sender",
    wakeId: "wake_3",
  });
  assert.equal(auto.autoApproved, true);
  assert.equal(auto.proposal.status, "promoted");
  assert.equal(auto.proposal.approvalMode, "allowlist-auto");
  assert.equal(auto.proposal.promotedTaskId, "task_promoted_2");
  assert.equal(auto.proposal.dispatchRuntimeSessionId, null);
  assert.match(auto.proposal.dispatchError ?? "", /agent_not_ready/u);
});

test("proposal rejection retries profile CAS cleanly if a concurrent wake updates updatedAt mid-flight", async () => {
  let profile: ResidentCeoProfile | null = null;
  let injectedConflict = false;
  let seq = 0;
  const service = makeResidentCeoService({
    profiles: {
      read: async () => profile,
      write: async (next, expectedUpdatedAt) => {
        if (!injectedConflict && next.proposals?.some((entry) => entry.status === "rejected")) {
          injectedConflict = true;
          profile = { ...profile!, updatedAt: "2026-11-24T00:05:00.000Z" };
        }
        if ((profile?.updatedAt ?? null) !== expectedUpdatedAt) {
          throw new Error(`Resident CEO profile for ${next.principalPersonId} changed before write.`);
        }
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
      promote: async () => ({ promotedTaskId: "task_promoted_cas" }),
      dispatchAgent: async () => ({ runtimeSessionId: "runtime_cas" }),
      rejectPeerRequest: async () => undefined,
      reportTerminalOutcome: async () => undefined,
    },
    now: () => "2026-11-24T00:00:00.000Z",
    createId: () => `cas${++seq}abcdef0123456789`,
  });
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
  });
  const recorded = await service.recordProposal("person_owner", {
    peerRequestId: "peer_cas",
    fromPersonId: "person_alice",
    summary: "Concurrent reject",
    proposedTitle: "Concurrent reject",
    proposedWorkId: "task_work_1",
    proposedAgentId: null,
    proposedPrompt: null,
    rationale: "Needs decision",
    wakeId: "wake_cas",
  });
  const rejected = await service.rejectProposal("person_owner", {
    proposalId: recorded.proposal.proposalId,
    reason: "Superseded",
  });
  assert.equal(injectedConflict, true);
  assert.equal(rejected.proposal.status, "rejected");
  assert.equal(rejected.proposal.rejectionReason, "Superseded");
});
