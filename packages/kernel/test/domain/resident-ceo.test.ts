// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertResidentCeoExecutionAllowed,
  assertResidentCeoPrincipal,
  createResidentCeoProfile,
  effectiveResidentCeoExecutionPolicy,
  evaluateResidentCeoAutoApproval,
  parseResidentCeoDelegationDecision,
  recordResidentCeoProposalTerminalOutcome,
  RESIDENT_CEO_MAX_PROPOSALS,
  ResidentCeoProfileError,
  residentCeoWakeDue,
  residentCeoWakeReceipt,
  transitionResidentCeoProposal,
  upsertResidentCeoProposal,
  type ResidentCeoDelegationProposal,
} from "../../src/domain/resident-ceo.ts";

const profile = createResidentCeoProfile(
  {
    principalPersonId: "person_owner",
    runtimeInstanceId: "runtime_local",
    model: "model-a",
    heartbeatIntervalSec: 60,
  },
  "2026-11-24T00:00:00.000Z",
);

test("resident CEO profile validates its principal, provider selection, and controlled interval", () => {
  assert.equal(profile.principalPersonId, "person_owner");
  assert.equal(profile.runtimeInstanceId, "runtime_local");
  assert.equal(profile.model, "model-a");
  assert.throws(
    () => assertResidentCeoPrincipal(profile, "person_other"),
    (error: unknown) => error instanceof ResidentCeoProfileError && error.code === "resident_ceo_principal_mismatch",
  );
  assert.throws(
    () => createResidentCeoProfile({ ...profile, heartbeatIntervalSec: 1 }, "2026-11-24T00:00:00.000Z"),
    (error: unknown) => error instanceof ResidentCeoProfileError && error.code === "resident_ceo_invalid_profile",
  );
});

test("heartbeat is due only for a running profile and advances from the previous receipt", () => {
  const running = { ...profile, status: "running" as const };
  assert.equal(residentCeoWakeDue(profile, Date.parse("2026-11-24T00:01:00.000Z")), false);
  assert.equal(residentCeoWakeDue(running, Date.parse("2026-11-24T00:00:00.000Z")), true);
  const completed = residentCeoWakeReceipt({
    profile: running,
    wakeId: "wake-1",
    cause: "heartbeat",
    requestedAt: "2026-11-24T00:00:00.000Z",
    completedAt: "2026-11-24T00:00:10.000Z",
    status: "succeeded",
    runtimeSessionId: "session-1",
    persistentSessionId: "provider-session-1",
  });
  assert.equal(residentCeoWakeDue(completed, Date.parse("2026-11-24T00:01:09.999Z")), false);
  assert.equal(residentCeoWakeDue(completed, Date.parse("2026-11-24T00:01:10.000Z")), true);
  assert.equal(completed.persistentSessionId, "provider-session-1");
});

test("a running wake receipt prevents overlapping heartbeat dispatch", () => {
  const waking = residentCeoWakeReceipt({
    profile: { ...profile, status: "running" },
    wakeId: "wake-2",
    cause: "peer-request",
    requestedAt: "2026-11-24T00:00:00.000Z",
    completedAt: null,
    status: "running",
    runtimeSessionId: null,
  });
  assert.equal(residentCeoWakeDue(waking, Date.parse("2026-11-24T00:05:00.000Z")), false);
});

test("execution policy defaults to advisory-only and fails closed on write actions until approval-gated is enabled", () => {
  assert.equal(effectiveResidentCeoExecutionPolicy(profile), "advisory-only");
  assert.throws(
    () => assertResidentCeoExecutionAllowed(profile, "approving delegation proposals"),
    (error: unknown) => error instanceof ResidentCeoProfileError && error.code === "resident_ceo_advisory_only",
  );
  const gated = createResidentCeoProfile(
    {
      principalPersonId: "person_owner",
      runtimeInstanceId: "runtime_local",
      model: "model-a",
      heartbeatIntervalSec: 60,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_work_1",
      defaultAgentId: "neon",
      autoApproveSenders: ["person_alice", "person_alice"],
    },
    "2026-11-24T00:00:00.000Z",
  );
  assert.equal(effectiveResidentCeoExecutionPolicy(gated), "approval-gated");
  assert.deepEqual(gated.autoApproveSenders, ["person_alice"]);
  assert.doesNotThrow(() => assertResidentCeoExecutionAllowed(gated, "approving delegation proposals"));
  assert.throws(
    () => createResidentCeoProfile({ ...profile, executionPolicy: "autonomous" as never }, "2026-11-24T00:00:00.000Z"),
    (error: unknown) => error instanceof ResidentCeoProfileError && error.code === "resident_ceo_invalid_profile",
  );
});

test("auto-approval requires approval-gated policy, allowlisted sender, and a resolved workId", () => {
  const gated = createResidentCeoProfile(
    {
      principalPersonId: "person_owner",
      runtimeInstanceId: "runtime_local",
      model: "model-a",
      heartbeatIntervalSec: 60,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_work_default",
      autoApproveSenders: ["person_alice"],
    },
    "2026-11-24T00:00:00.000Z",
  );
  assert.deepEqual(
    evaluateResidentCeoAutoApproval(profile, { fromPersonId: "person_alice", proposedWorkId: "task_work_1" }),
    { autoApprove: false },
  );
  assert.deepEqual(
    evaluateResidentCeoAutoApproval(gated, { fromPersonId: "person_mallory", proposedWorkId: "task_work_1" }),
    { autoApprove: false },
  );
  assert.deepEqual(evaluateResidentCeoAutoApproval(gated, { fromPersonId: "person_alice", proposedWorkId: null }), {
    autoApprove: true,
    workId: "task_work_default",
  });
  assert.deepEqual(
    evaluateResidentCeoAutoApproval(
      { ...gated, defaultWorkId: null },
      { fromPersonId: "person_alice", proposedWorkId: null },
    ),
    { autoApprove: false },
  );
});

test("delegation response parser extracts structured proposals, honors advise_only, and falls back to pending proposal", () => {
  const fallback = {
    summary: "Migrate storage",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
    requestedAction: "Run migration audit",
  };
  const structured = parseResidentCeoDelegationDecision(
    '```json\n{"action":"propose_task","title":"Audit storage migration","workId":"task_work_2","agentId":"sol","prompt":"Check PG schema","rationale":"Needs tracked task."}\n```',
    fallback,
  );
  assert.deepEqual(structured, {
    decision: "propose_task",
    proposedTitle: "Audit storage migration",
    proposedWorkId: "task_work_2",
    proposedAgentId: "sol",
    proposedPrompt: "Check PG schema",
    rationale: "Needs tracked task.",
  });

  const advise = parseResidentCeoDelegationDecision(
    '{"action":"advise_only","rationale":"Already answered in docs."}',
    fallback,
  );
  assert.deepEqual(advise, { decision: "advise_only", rationale: "Already answered in docs." });

  const plain = parseResidentCeoDelegationDecision("Looks good, suggest creating a task.", fallback);
  assert.equal(plain.decision, "propose_task");
  if (plain.decision === "propose_task") {
    assert.equal(plain.proposedTitle, "Migrate storage");
    assert.equal(plain.proposedWorkId, "task_work_1");
    assert.equal(plain.proposedAgentId, "neon");
  }
});

test("proposal transitions enforce pending_approval guard, record idempotent terminal outcome, and cap retention", () => {
  const baseProposal = (index: number): ResidentCeoDelegationProposal => ({
    proposalId: `prop_${index}`,
    peerRequestId: `peer_${index}`,
    fromPersonId: "person_alice",
    summary: `Task ${index}`,
    proposedTitle: `Task ${index}`,
    proposedWorkId: "task_work_1",
    proposedAgentId: null,
    proposedPrompt: "Execute",
    rationale: "Structured",
    wakeId: `wake_${index}`,
    status: "pending_approval",
    approvalMode: null,
    createdAt: "2026-11-24T00:00:00.000Z",
    decidedAt: null,
    decidedByPersonId: null,
    promotedTaskId: null,
    dispatchRuntimeSessionId: null,
    dispatchError: null,
    rejectionReason: null,
    terminalOutcome: null,
  });

  let current = upsertResidentCeoProposal(profile, baseProposal(1), "2026-11-24T00:00:01.000Z");
  current = transitionResidentCeoProposal(current, "prop_1", {
    status: "promoted",
    approvalMode: "manual",
    decidedAt: "2026-11-24T00:01:00.000Z",
    decidedByPersonId: "person_owner",
    promotedTaskId: "task_101",
    proposedWorkId: "task_work_1",
    proposedTitle: "Task 1",
    proposedAgentId: null,
    dispatchRuntimeSessionId: null,
    dispatchError: null,
  });
  assert.throws(
    () =>
      transitionResidentCeoProposal(current, "prop_1", {
        status: "rejected",
        decidedAt: "2026-11-24T00:02:00.000Z",
        decidedByPersonId: "person_owner",
        rejectionReason: "Too late",
      }),
    (error: unknown) =>
      error instanceof ResidentCeoProfileError && error.code === "resident_ceo_proposal_transition_invalid",
  );

  const withOutcome = recordResidentCeoProposalTerminalOutcome(current, "prop_1", {
    taskStatus: "done",
    summary: "Completed",
    reportedAt: "2026-11-24T00:05:00.000Z",
  });
  assert.equal(withOutcome.proposals?.[0]?.terminalOutcome?.taskStatus, "done");
  assert.equal(
    recordResidentCeoProposalTerminalOutcome(withOutcome, "prop_1", {
      taskStatus: "cancelled",
      summary: "Duplicate",
      reportedAt: "2026-11-24T00:06:00.000Z",
    }),
    withOutcome,
  );

  let bounded = profile;
  for (let i = 0; i < RESIDENT_CEO_MAX_PROPOSALS + 10; i += 1) {
    bounded = upsertResidentCeoProposal(
      bounded,
      { ...baseProposal(i), status: i < 55 ? "rejected" : "pending_approval" },
      "2026-11-24T00:00:01.000Z",
    );
  }
  assert.equal(bounded.proposals?.length, RESIDENT_CEO_MAX_PROPOSALS);
  assert.equal(bounded.proposals?.filter((p) => p.status === "pending_approval").length, 5);
});
