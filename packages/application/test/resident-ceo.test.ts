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
  const firstPromote = promoted[0] as { readonly plan?: string };
  assert.equal(typeof firstPromote.plan, "string");
  for (const heading of [
    "## Brief",
    "## Goal",
    "## Cheaper Alternatives",
    "## Context",
    "## Required Reading",
    "## Execution Surface",
    "## Constraints",
    "## Deliverable Contract",
    "## Evidence Protocol",
    "## Verification",
  ]) {
    assert.ok(firstPromote.plan?.includes(heading), `promoted plan missing ${heading}`);
  }
  assert.match(firstPromote.plan ?? "", /peer_1/u);
  assert.match(firstPromote.plan ?? "", /person_alice/u);
  assert.match(firstPromote.plan ?? "", /task_work_1/u);
  assert.match(firstPromote.plan ?? "", /neon/u);
  assert.match(firstPromote.plan ?? "", /Implement feature X/u);
  assert.match(firstPromote.plan ?? "", /Valid delegation/u);
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

test("Phase 3 approvalGate supports auto-promote, secondary-guard interception, fail-closed fallbacks, and mode=off zero-regression", async () => {
  let profile: ResidentCeoProfile | null = null;
  let seq = 0;
  const promoted: unknown[] = [];
  const dispatched: unknown[] = [];
  const gateCalls: { readonly mode: string; readonly providerId: string | null; readonly proposalId: string }[] = [];
  let nextGateResponse:
    | (() => Promise<{
        readonly selected: string | null;
        readonly distribution: Readonly<Record<string, number>> | null;
        readonly providerId: string | null;
        readonly model: string | null;
        readonly evaluatedAt: string;
        readonly errorReason?: string | null;
      }>)
    | null = null;

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
        return { promotedTaskId: `task_gate_${promoted.length}` };
      },
      dispatchAgent: async (req) => {
        dispatched.push(req);
        return { runtimeSessionId: `runtime_gate_${dispatched.length}` };
      },
      rejectPeerRequest: async () => undefined,
      reportTerminalOutcome: async () => undefined,
    },
    approvalGate: {
      evaluate: async (req) => {
        gateCalls.push({ mode: req.mode, providerId: req.providerId, proposalId: req.proposal.proposalId });
        assert.ok(nextGateResponse, "unexpected approvalGate invocation");
        return nextGateResponse();
      },
    },
    now: () => "2026-11-26T00:00:00.000Z",
    createId: () => `gate${++seq}abcdef0123456789`,
  });

  // 1. Positive auto-promote path (non-allowlisted sender, high confidence approve_low_risk)
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
    approvalGate: { mode: "auto-promote", providerId: "decider-main", minConfidence: 0.85 },
  });
  nextGateResponse = async () => ({
    selected: "approve_low_risk",
    distribution: { approve_low_risk: 0.93, require_human_approval: 0.05, insufficient_information: 0.02 },
    providerId: "decider-main",
    model: "pplx-decider",
    evaluatedAt: "2026-11-26T00:00:01.000Z",
  });
  const autoPromoted = await service.recordProposal("person_owner", {
    peerRequestId: "peer_gate_pos",
    fromPersonId: "person_external",
    summary: "Add unit tests for parser",
    proposedTitle: "Add unit tests for parser",
    proposedWorkId: null,
    proposedAgentId: null,
    proposedPrompt: "Add fast unit tests for parser edge cases.",
    rationale: "Low-risk scoped test addition.",
    wakeId: "wake_1",
  });
  assert.equal(autoPromoted.autoApproved, true);
  assert.equal(autoPromoted.proposal.status, "promoted");
  assert.equal(autoPromoted.proposal.approvalMode, "decider-auto");
  assert.equal(autoPromoted.proposal.promotedTaskId, "task_gate_1");
  assert.equal(autoPromoted.proposal.dispatchRuntimeSessionId, "runtime_gate_1");
  assert.equal(autoPromoted.proposal.dispatchError, null);
  assert.equal(autoPromoted.proposal.gateVerdict?.selected, "approve_low_risk");
  assert.equal(autoPromoted.proposal.gateVerdict?.confidence, 0.93);
  assert.equal(autoPromoted.proposal.gateVerdict?.fallbackReason, null);
  assert.equal(gateCalls.length, 1);

  // 2. Fail-closed: low confidence (< 0.85)
  nextGateResponse = async () => ({
    selected: "approve_low_risk",
    distribution: { approve_low_risk: 0.72, require_human_approval: 0.2, insufficient_information: 0.08 },
    providerId: "decider-main",
    model: "pplx-decider",
    evaluatedAt: "2026-11-26T00:00:02.000Z",
  });
  const lowConf = await service.recordProposal("person_owner", {
    peerRequestId: "peer_gate_low_conf",
    fromPersonId: "person_external",
    summary: "Borderline change",
    proposedTitle: "Borderline change",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Refactor core module",
    rationale: "Borderline",
    wakeId: "wake_2",
  });
  assert.equal(lowConf.autoApproved, false);
  assert.equal(lowConf.proposal.status, "pending_approval");
  assert.equal(lowConf.proposal.gateVerdict?.fallbackReason, "confidence_below_threshold");
  assert.equal(promoted.length, 1);

  // 3. Fail-closed: require_human_approval
  nextGateResponse = async () => ({
    selected: "require_human_approval",
    distribution: { approve_low_risk: 0.05, require_human_approval: 0.91, insufficient_information: 0.04 },
    providerId: "decider-main",
    model: "pplx-decider",
    evaluatedAt: "2026-11-26T00:00:03.000Z",
  });
  const humanBlocked = await service.recordProposal("person_owner", {
    peerRequestId: "peer_gate_human",
    fromPersonId: "person_external",
    summary: "Drop legacy production tables",
    proposedTitle: "Drop legacy production tables",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Drop tables",
    rationale: "Risky",
    wakeId: "wake_3",
  });
  assert.equal(humanBlocked.autoApproved, false);
  assert.equal(humanBlocked.proposal.status, "pending_approval");
  assert.equal(humanBlocked.proposal.gateVerdict?.fallbackReason, "selected_require_human_approval");

  // 4. Fail-closed: abstain (insufficient_information)
  nextGateResponse = async () => ({
    selected: "insufficient_information",
    distribution: { approve_low_risk: 0.1, require_human_approval: 0.15, insufficient_information: 0.75 },
    providerId: "decider-main",
    model: "pplx-decider",
    evaluatedAt: "2026-11-26T00:00:04.000Z",
  });
  const abstained = await service.recordProposal("person_owner", {
    peerRequestId: "peer_gate_abstain",
    fromPersonId: "person_external",
    summary: "Do the thing",
    proposedTitle: "Do the thing",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Do it",
    rationale: "Vague",
    wakeId: "wake_4",
  });
  assert.equal(abstained.autoApproved, false);
  assert.equal(abstained.proposal.status, "pending_approval");
  assert.equal(abstained.proposal.gateVerdict?.fallbackReason, "abstained_insufficient_information");

  // 5. Fail-closed: provider throws timeout/error
  nextGateResponse = async () => {
    throw Object.assign(new Error("The Decisions request timed out."), { code: "decision_timeout" });
  };
  const timedOut = await service.recordProposal("person_owner", {
    peerRequestId: "peer_gate_timeout",
    fromPersonId: "person_external",
    summary: "Timeout case",
    proposedTitle: "Timeout case",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Run check",
    rationale: "Routine",
    wakeId: "wake_5",
  });
  assert.equal(timedOut.autoApproved, false);
  assert.equal(timedOut.proposal.status, "pending_approval");
  assert.match(timedOut.proposal.gateVerdict?.fallbackReason ?? "", /decision_timeout/u);

  // 6. Deterministic precheck: missing workId fails closed without invoking Decider
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    defaultWorkId: null,
  });
  const callsBeforeMissingWork = gateCalls.length;
  nextGateResponse = null;
  const missingWork = await service.recordProposal("person_owner", {
    peerRequestId: "peer_gate_no_work",
    fromPersonId: "person_external",
    summary: "Missing work",
    proposedTitle: "Missing work",
    proposedWorkId: null,
    proposedAgentId: "neon",
    proposedPrompt: "Run without work",
    rationale: "No work",
    wakeId: "wake_6",
  });
  assert.equal(missingWork.autoApproved, false);
  assert.equal(missingWork.proposal.status, "pending_approval");
  assert.equal(missingWork.proposal.gateVerdict?.fallbackReason, "missing_work_id");
  assert.equal(gateCalls.length, callsBeforeMissingWork);

  // 7. secondary-guard: allowlisted sender intercepted vs passed; non-allowlisted skips Decider
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    defaultWorkId: "task_work_1",
    autoApproveSenders: ["person_trusted"],
    approvalGate: { mode: "secondary-guard", providerId: "decider-main", minConfidence: 0.85 },
  });
  const callsBeforeNonAllowlisted = gateCalls.length;
  nextGateResponse = null;
  const nonAllowlisted = await service.recordProposal("person_owner", {
    peerRequestId: "peer_guard_non_allowlist",
    fromPersonId: "person_other",
    summary: "Non allowlist",
    proposedTitle: "Non allowlist",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Skip gate",
    rationale: "Untrusted sender",
    wakeId: "wake_7",
  });
  assert.equal(nonAllowlisted.autoApproved, false);
  assert.equal(nonAllowlisted.proposal.status, "pending_approval");
  assert.equal(nonAllowlisted.proposal.gateVerdict, null);
  assert.equal(gateCalls.length, callsBeforeNonAllowlisted);

  nextGateResponse = async () => ({
    selected: "require_human_approval",
    distribution: { approve_low_risk: 0.1, require_human_approval: 0.85, insufficient_information: 0.05 },
    providerId: "decider-main",
    model: "pplx-decider",
    evaluatedAt: "2026-11-26T00:00:05.000Z",
  });
  const guardBlocked = await service.recordProposal("person_owner", {
    peerRequestId: "peer_guard_blocked",
    fromPersonId: "person_trusted",
    summary: "Publish credentials externally",
    proposedTitle: "Publish credentials externally",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Upload secrets",
    rationale: "Suspicious even from allowlisted sender",
    wakeId: "wake_8",
  });
  assert.equal(guardBlocked.autoApproved, false);
  assert.equal(guardBlocked.proposal.status, "pending_approval");
  assert.equal(guardBlocked.proposal.gateVerdict?.mode, "secondary-guard");
  assert.equal(guardBlocked.proposal.gateVerdict?.fallbackReason, "selected_require_human_approval");

  nextGateResponse = async () => ({
    selected: "approve_low_risk",
    distribution: { approve_low_risk: 0.96, require_human_approval: 0.02, insufficient_information: 0.02 },
    providerId: "decider-main",
    model: "pplx-decider",
    evaluatedAt: "2026-11-26T00:00:06.000Z",
  });
  const guardApproved = await service.recordProposal("person_owner", {
    peerRequestId: "peer_guard_approved",
    fromPersonId: "person_trusted",
    summary: "Safe allowlisted task",
    proposedTitle: "Safe allowlisted task",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Run safe check",
    rationale: "Routine check",
    wakeId: "wake_9",
  });
  assert.equal(guardApproved.autoApproved, true);
  assert.equal(guardApproved.proposal.status, "promoted");
  assert.equal(guardApproved.proposal.approvalMode, "decider-auto");
  assert.equal(guardApproved.proposal.gateVerdict?.mode, "secondary-guard");

  // 8. Regression: mode="off" restores exact Phase 2 allowlist-auto without calling Decider
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    approvalGate: { mode: "off" },
  });
  const callsBeforeOff = gateCalls.length;
  nextGateResponse = null;
  const phase2Allowlist = await service.recordProposal("person_owner", {
    peerRequestId: "peer_gate_off_allowlist",
    fromPersonId: "person_trusted",
    summary: "Phase 2 allowlist task",
    proposedTitle: "Phase 2 allowlist task",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedPrompt: "Run phase 2 allowlist",
    rationale: "Gate off",
    wakeId: "wake_10",
  });
  assert.equal(phase2Allowlist.autoApproved, true);
  assert.equal(phase2Allowlist.proposal.approvalMode, "allowlist-auto");
  assert.equal(phase2Allowlist.proposal.gateVerdict, null);
  assert.equal(gateCalls.length, callsBeforeOff);
});

test("Option A targetNodeId routes remote nodes to assignToNode, honors approve override priority, and keeps local/empty on dispatchAgent", async () => {
  let profile: ResidentCeoProfile | null = null;
  let seq = 0;
  let localNodeId: string | null = "center";
  let failAssign = false;
  const promoted: { readonly peerRequestId: string; readonly plan?: string }[] = [];
  const assigned: { readonly taskId: string; readonly targetNodeId: string; readonly idempotencyKey: string }[] = [];
  const dispatched: { readonly taskId: string; readonly agentId: string }[] = [];
  const reported: { readonly promotedTaskId: string; readonly taskStatus: string }[] = [];

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
        promoted.push({ peerRequestId: req.peerRequestId, plan: req.plan });
        return { promotedTaskId: `task_opt_a_${promoted.length}` };
      },
      resolveLocalNodeId: () => localNodeId,
      assignToNode: async (req) => {
        assigned.push(req);
        if (failAssign) throw new Error("node_assignment_rejected");
      },
      dispatchAgent: async (req) => {
        dispatched.push({ taskId: req.taskId, agentId: req.agentId });
        return { runtimeSessionId: `rt_local_${dispatched.length}` };
      },
      rejectPeerRequest: async () => undefined,
      reportTerminalOutcome: async (req) => {
        reported.push({ promotedTaskId: req.promotedTaskId, taskStatus: req.taskStatus });
      },
    },
    now: () => "2026-11-27T00:00:00.000Z",
    createId: () => `opta${++seq}abcdef0123456789`,
  });

  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
  });

  // 1. Proposal with remote targetNodeId routes to assignToNode and skips dispatchAgent.
  const remoteDraft = await service.recordProposal("person_owner", {
    peerRequestId: "peer_remote_1",
    fromPersonId: "person_alice",
    summary: "Run heavy build on edge",
    proposedTitle: "Run heavy build on edge",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedTargetNodeId: "cea7e947",
    proposedPrompt: "Run build on remote edge",
    rationale: "Offload CPU work",
    wakeId: "wake_remote_1",
  });
  assert.equal(remoteDraft.proposal.proposedTargetNodeId, "cea7e947");
  const remoteApproved = await service.approveProposal("person_owner", { proposalId: remoteDraft.proposal.proposalId });
  assert.equal(remoteApproved.proposal.status, "promoted");
  assert.equal(remoteApproved.proposal.promotedTaskId, "task_opt_a_1");
  assert.equal(remoteApproved.proposal.proposedTargetNodeId, "cea7e947");
  assert.equal(remoteApproved.proposal.dispatchedTargetNodeId, "cea7e947");
  assert.equal(remoteApproved.proposal.dispatchRuntimeSessionId, null);
  assert.equal(remoteApproved.proposal.dispatchError, null);
  assert.equal(dispatched.length, 0);
  assert.deepEqual(assigned, [
    {
      taskId: "task_opt_a_1",
      targetNodeId: "cea7e947",
      idempotencyKey: `resident-ceo-assign-${remoteDraft.proposal.proposalId}`,
    },
  ]);
  assert.match(promoted[0]?.plan ?? "", /Target Node: `cea7e947`/u);

  // Terminal outcome writeback still works for remotely assigned tasks.
  const remoteOutcome = await service.reportPromotedTaskOutcome("person_owner", {
    proposalId: remoteDraft.proposal.proposalId,
    taskStatus: "done",
    summary: "Remote build finished",
  });
  assert.equal(remoteOutcome.reported, true);
  assert.deepEqual(reported, [{ promotedTaskId: "task_opt_a_1", taskStatus: "done" }]);

  // 2. targetNodeId matching localNodeId runs local dispatchAgent and skips assignToNode.
  const localDraft = await service.recordProposal("person_owner", {
    peerRequestId: "peer_local_1",
    fromPersonId: "person_alice",
    summary: "Run locally on center",
    proposedTitle: "Run locally on center",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedTargetNodeId: "center",
    proposedPrompt: "Run on center",
    rationale: "Local node matches",
    wakeId: "wake_local_1",
  });
  const localApproved = await service.approveProposal("person_owner", { proposalId: localDraft.proposal.proposalId });
  assert.equal(localApproved.proposal.dispatchedTargetNodeId, null);
  assert.equal(localApproved.proposal.dispatchRuntimeSessionId, "rt_local_1");
  assert.equal(localApproved.proposal.dispatchError, null);
  assert.equal(assigned.length, 1);
  assert.equal(dispatched.length, 1);

  // 3. approveInput.targetNodeId overrides proposal.proposedTargetNodeId (remote override wins over local/other remote).
  const overrideDraft = await service.recordProposal("person_owner", {
    peerRequestId: "peer_override_1",
    fromPersonId: "person_alice",
    summary: "Override target node",
    proposedTitle: "Override target node",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedTargetNodeId: "center",
    proposedPrompt: "Override to edge",
    rationale: "Owner redirects",
    wakeId: "wake_override_1",
  });
  // Invalid override rejects before promotion.
  await assert.rejects(
    service.approveProposal("person_owner", {
      proposalId: overrideDraft.proposal.proposalId,
      targetNodeId: "bad node!",
    }),
    { code: "invalid_field" },
  );
  assert.equal(promoted.length, 2);

  const overridden = await service.approveProposal("person_owner", {
    proposalId: overrideDraft.proposal.proposalId,
    targetNodeId: "edge-mac.prod-2",
  });
  assert.equal(overridden.proposal.proposedTargetNodeId, "edge-mac.prod-2");
  assert.equal(overridden.proposal.dispatchedTargetNodeId, "edge-mac.prod-2");
  assert.equal(overridden.proposal.dispatchRuntimeSessionId, null);
  assert.equal(overridden.proposal.dispatchError, null);
  assert.equal(assigned.length, 2);
  assert.equal(assigned[1]?.targetNodeId, "edge-mac.prod-2");
  assert.equal(dispatched.length, 1);

  // 4. Allowlist auto-approval preserves proposedTargetNodeId and routes remotely.
  localNodeId = "node-host-local";
  await service.configure("person_owner", {
    runtimeInstanceId: "instance-one",
    model: "model-one",
    heartbeatIntervalSec: 60,
    autoApproveSenders: ["person_trusted"],
  });
  const autoRemote = await service.recordProposal("person_owner", {
    peerRequestId: "peer_auto_remote",
    fromPersonId: "person_trusted",
    summary: "Auto remote offload",
    proposedTitle: "Auto remote offload",
    proposedWorkId: "task_work_1",
    proposedAgentId: null,
    proposedTargetNodeId: "cea7e947",
    proposedPrompt: "Auto offload to cea7e947",
    rationale: "Trusted remote offload",
    wakeId: "wake_auto_remote",
  });
  assert.equal(autoRemote.autoApproved, true);
  assert.equal(autoRemote.proposal.dispatchedTargetNodeId, "cea7e947");
  assert.equal(autoRemote.proposal.dispatchRuntimeSessionId, null);
  assert.equal(autoRemote.proposal.dispatchError, null);
  assert.equal(assigned.length, 3);
  assert.equal(assigned[2]?.targetNodeId, "cea7e947");

  // 5. Truthful dispatchError when remote assignToNode fails.
  failAssign = true;
  const failedRemote = await service.recordProposal("person_owner", {
    peerRequestId: "peer_auto_remote_fail",
    fromPersonId: "person_trusted",
    summary: "Remote assign failure",
    proposedTitle: "Remote assign failure",
    proposedWorkId: "task_work_1",
    proposedAgentId: "neon",
    proposedTargetNodeId: "cea7e947",
    proposedPrompt: "Trigger failure",
    rationale: "Verify fail-closed recording",
    wakeId: "wake_auto_remote_fail",
  });
  assert.equal(failedRemote.proposal.status, "promoted");
  assert.equal(failedRemote.proposal.dispatchedTargetNodeId, null);
  assert.equal(failedRemote.proposal.dispatchRuntimeSessionId, null);
  assert.match(failedRemote.proposal.dispatchError ?? "", /node_assignment_rejected/u);
});
