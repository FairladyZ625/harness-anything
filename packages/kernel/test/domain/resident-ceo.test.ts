// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  appendResidentCeoActionAudit,
  assertResidentCeoExecutionAllowed,
  assertResidentCeoPrincipal,
  classifyResidentCeoAction,
  createResidentCeoProfile,
  effectiveResidentCeoApprovalGate,
  effectiveResidentCeoExecutionPolicy,
  effectiveResidentCeoProposalActionKind,
  evaluateResidentCeoAutoApproval,
  evaluateResidentCeoGateDecision,
  evaluateResidentCeoOwnerDirectApproval,
  evaluateResidentCeoTier0Access,
  isValidResidentCeoTargetNodeId,
  parseResidentCeoDelegationDecision,
  parseResidentCeoTurnActions,
  recordResidentCeoProposalGateVerdict,
  recordResidentCeoProposalTerminalOutcome,
  RESIDENT_CEO_DEFAULT_GATE_MIN_CONFIDENCE,
  RESIDENT_CEO_GATE_ABSTAIN_OPTION_ID,
  RESIDENT_CEO_MAX_ACTION_AUDIT_ENTRIES,
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
    '```json\n{"action":"propose_task","title":"Audit storage migration","workId":"task_work_2","agentId":"sol","targetNodeId":"cea7e947","prompt":"Check PG schema","rationale":"Needs tracked task."}\n```',
    fallback,
  );
  assert.deepEqual(structured, {
    decision: "propose_task",
    proposedTitle: "Audit storage migration",
    proposedWorkId: "task_work_2",
    proposedAgentId: "sol",
    proposedTargetNodeId: "cea7e947",
    proposedPrompt: "Check PG schema",
    rationale: "Needs tracked task.",
  });

  const dottedNode = parseResidentCeoDelegationDecision(
    '{"action":"propose_task","title":"Run on edge","targetNodeId":" edge-mac.prod_1 ","rationale":"Offload build."}',
    fallback,
  );
  assert.equal(dottedNode.decision, "propose_task");
  if (dottedNode.decision === "propose_task") {
    assert.equal(dottedNode.proposedTargetNodeId, "edge-mac.prod_1");
  }

  for (const invalidTarget of ["   ", "bad node", "../escape", "node..double", "-leading", ".leading", "node/slash"]) {
    assert.equal(isValidResidentCeoTargetNodeId(invalidTarget), false, `expected ${invalidTarget} to fail`);
    const parsedInvalid = parseResidentCeoDelegationDecision(
      JSON.stringify({
        action: "propose_task",
        title: "Invalid target node",
        targetNodeId: invalidTarget,
        rationale: "Reject invalid node ids.",
      }),
      fallback,
    );
    assert.equal(parsedInvalid.decision, "propose_task");
    if (parsedInvalid.decision === "propose_task") {
      assert.equal(parsedInvalid.proposedTargetNodeId, null);
    }
  }
  for (const validTarget of ["cea7e947", "node_edge_1", "edge-1.prod", "center"]) {
    assert.equal(isValidResidentCeoTargetNodeId(validTarget), true, `expected ${validTarget} to pass`);
  }

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
    assert.equal(plain.proposedTargetNodeId, null);
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

test("approvalGate configuration defaults to off/0.85 and validates mode, providerId, and minConfidence in (0, 1]", () => {
  assert.deepEqual(effectiveResidentCeoApprovalGate(profile), {
    mode: "off",
    providerId: null,
    minConfidence: RESIDENT_CEO_DEFAULT_GATE_MIN_CONFIDENCE,
  });

  const configured = createResidentCeoProfile(
    {
      principalPersonId: "person_owner",
      runtimeInstanceId: "runtime_local",
      model: "model-a",
      heartbeatIntervalSec: 60,
      executionPolicy: "approval-gated",
      approvalGate: {
        mode: "auto-promote",
        providerId: "  openrouter-decider  ",
        minConfidence: 0.9,
      },
    },
    "2026-11-26T00:00:00.000Z",
  );
  assert.deepEqual(configured.approvalGate, {
    mode: "auto-promote",
    providerId: "openrouter-decider",
    minConfidence: 0.9,
  });
  assert.deepEqual(effectiveResidentCeoApprovalGate(configured), {
    mode: "auto-promote",
    providerId: "openrouter-decider",
    minConfidence: 0.9,
  });

  const clearedProvider = createResidentCeoProfile(
    {
      ...profile,
      approvalGate: { mode: "secondary-guard", providerId: "   ", minConfidence: 1 },
    },
    "2026-11-26T00:00:00.000Z",
  );
  assert.equal(clearedProvider.approvalGate?.providerId, null);
  assert.equal(clearedProvider.approvalGate?.minConfidence, 1);

  for (const invalidGate of [
    { mode: "autonomous" as never },
    { mode: "auto-promote" as const, providerId: "bad provider id" },
    { mode: "auto-promote" as const, minConfidence: 0 },
    { mode: "auto-promote" as const, minConfidence: -0.2 },
    { mode: "auto-promote" as const, minConfidence: 1.01 },
    { mode: "auto-promote" as const, minConfidence: Number.NaN },
  ]) {
    assert.throws(
      () => createResidentCeoProfile({ ...profile, approvalGate: invalidGate }, "2026-11-26T00:00:00.000Z"),
      (error: unknown) => error instanceof ResidentCeoProfileError && error.code === "resident_ceo_invalid_profile",
    );
  }
});

test("evaluateResidentCeoGateDecision enforces deterministic guards, abstain handling, and minConfidence thresholds fail-closed", () => {
  const autoPromoteProfile = createResidentCeoProfile(
    {
      principalPersonId: "person_owner",
      runtimeInstanceId: "runtime_local",
      model: "model-a",
      heartbeatIntervalSec: 60,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_work_default",
      defaultAgentId: "neon",
      approvalGate: { mode: "auto-promote", providerId: "decider-1", minConfidence: 0.85 },
    },
    "2026-11-26T00:00:00.000Z",
  );
  const secondaryGuardProfile = createResidentCeoProfile(
    {
      ...autoPromoteProfile,
      autoApproveSenders: ["person_alice"],
      approvalGate: { mode: "secondary-guard", providerId: "decider-1", minConfidence: 0.85 },
    },
    "2026-11-26T00:00:00.000Z",
  );

  // Positive: exact threshold boundary (0.85 >= 0.85) under auto-promote
  const boundaryPass = evaluateResidentCeoGateDecision({
    profile: autoPromoteProfile,
    proposal: { fromPersonId: "person_stranger", proposedWorkId: null, proposedAgentId: null },
    observation: {
      selected: "approve_low_risk",
      distribution: { approve_low_risk: 0.85, require_human_approval: 0.1, insufficient_information: 0.05 },
      providerId: "decider-1",
      model: "pplx-decider",
      evaluatedAt: "2026-11-26T00:01:00.000Z",
    },
  });
  assert.equal(boundaryPass.allowAutoPromote, true);
  if (boundaryPass.allowAutoPromote) {
    assert.equal(boundaryPass.workId, "task_work_default");
    assert.equal(boundaryPass.verdict.fallbackReason, null);
    assert.equal(boundaryPass.verdict.confidence, 0.85);
  }

  // Positive: secondary-guard with allowlisted sender
  const guardPass = evaluateResidentCeoGateDecision({
    profile: secondaryGuardProfile,
    proposal: { fromPersonId: "person_alice", proposedWorkId: "task_work_custom", proposedAgentId: "sol" },
    observation: {
      selected: "approve_low_risk",
      distribution: { approve_low_risk: 0.92, require_human_approval: 0.05, insufficient_information: 0.03 },
      providerId: "decider-1",
      model: "pplx-decider",
      evaluatedAt: "2026-11-26T00:01:00.000Z",
    },
  });
  assert.equal(guardPass.allowAutoPromote, true);
  if (guardPass.allowAutoPromote) assert.equal(guardPass.workId, "task_work_custom");

  // Negative: below threshold (0.849 < 0.85)
  const lowConfidence = evaluateResidentCeoGateDecision({
    profile: autoPromoteProfile,
    proposal: { fromPersonId: "person_stranger", proposedWorkId: "task_work_1", proposedAgentId: "neon" },
    observation: {
      selected: "approve_low_risk",
      distribution: { approve_low_risk: 0.849, require_human_approval: 0.101, insufficient_information: 0.05 },
      providerId: "decider-1",
      model: "pplx-decider",
      evaluatedAt: "2026-11-26T00:01:00.000Z",
    },
  });
  assert.equal(lowConfidence.allowAutoPromote, false);
  assert.equal(lowConfidence.verdict.fallbackReason, "confidence_below_threshold");
  assert.equal(lowConfidence.verdict.confidence, 0.849);

  // Negative: require_human_approval
  const humanRequired = evaluateResidentCeoGateDecision({
    profile: autoPromoteProfile,
    proposal: { fromPersonId: "person_stranger", proposedWorkId: "task_work_1", proposedAgentId: "neon" },
    observation: {
      selected: "require_human_approval",
      distribution: { approve_low_risk: 0.08, require_human_approval: 0.9, insufficient_information: 0.02 },
      providerId: "decider-1",
      model: "pplx-decider",
      evaluatedAt: "2026-11-26T00:01:00.000Z",
    },
  });
  assert.equal(humanRequired.allowAutoPromote, false);
  assert.equal(humanRequired.verdict.fallbackReason, "selected_require_human_approval");

  // Negative: abstain (insufficient_information)
  const abstained = evaluateResidentCeoGateDecision({
    profile: autoPromoteProfile,
    proposal: { fromPersonId: "person_stranger", proposedWorkId: "task_work_1", proposedAgentId: "neon" },
    observation: {
      selected: RESIDENT_CEO_GATE_ABSTAIN_OPTION_ID,
      distribution: { approve_low_risk: 0.1, require_human_approval: 0.1, insufficient_information: 0.8 },
      providerId: "decider-1",
      model: "pplx-decider",
      evaluatedAt: "2026-11-26T00:01:00.000Z",
    },
  });
  assert.equal(abstained.allowAutoPromote, false);
  assert.equal(abstained.verdict.fallbackReason, "abstained_insufficient_information");

  // Negative: provider error
  const providerFailed = evaluateResidentCeoGateDecision({
    profile: autoPromoteProfile,
    proposal: { fromPersonId: "person_stranger", proposedWorkId: "task_work_1", proposedAgentId: "neon" },
    observation: {
      selected: null,
      distribution: null,
      providerId: "decider-1",
      model: "pplx-decider",
      evaluatedAt: "2026-11-26T00:01:00.000Z",
      errorReason: "decision_timeout: timed out",
    },
  });
  assert.equal(providerFailed.allowAutoPromote, false);
  assert.equal(providerFailed.verdict.fallbackReason, "decision_timeout: timed out");

  // Deterministic guards always beat 0.99 model probability
  const highConfidenceObs = {
    selected: "approve_low_risk",
    distribution: { approve_low_risk: 0.99, require_human_approval: 0.005, insufficient_information: 0.005 },
    providerId: "decider-1",
    model: "pplx-decider",
    evaluatedAt: "2026-11-26T00:01:00.000Z",
  };
  assert.equal(
    evaluateResidentCeoGateDecision({
      profile: { ...autoPromoteProfile, defaultWorkId: null },
      proposal: { fromPersonId: "person_stranger", proposedWorkId: null, proposedAgentId: "neon" },
      observation: highConfidenceObs,
    }).verdict.fallbackReason,
    "missing_work_id",
  );
  assert.equal(
    evaluateResidentCeoGateDecision({
      profile: { ...autoPromoteProfile, executionPolicy: "advisory-only" },
      proposal: { fromPersonId: "person_stranger", proposedWorkId: "task_work_1", proposedAgentId: "neon" },
      observation: highConfidenceObs,
    }).verdict.fallbackReason,
    "execution_policy_not_approval_gated",
  );
  assert.equal(
    evaluateResidentCeoGateDecision({
      profile: secondaryGuardProfile,
      proposal: { fromPersonId: "person_mallory", proposedWorkId: "task_work_1", proposedAgentId: "neon" },
      observation: highConfidenceObs,
    }).verdict.fallbackReason,
    "sender_not_allowlisted",
  );
  assert.equal(
    evaluateResidentCeoGateDecision({
      profile: autoPromoteProfile,
      proposal: { fromPersonId: "person_stranger", proposedWorkId: "task_work_1", proposedAgentId: "bad agent id" },
      observation: highConfidenceObs,
    }).verdict.fallbackReason,
    "invalid_agent_id",
  );

  // Gate verdict persists across decider-auto promotion
  const proposal: ResidentCeoDelegationProposal = {
    proposalId: "prop_gate_1",
    peerRequestId: "peer_gate_1",
    fromPersonId: "person_stranger",
    summary: "Run read-only audit",
    proposedTitle: "Run read-only audit",
    proposedWorkId: "task_work_default",
    proposedAgentId: "neon",
    proposedPrompt: "Audit logs",
    rationale: "Low risk",
    wakeId: "wake_gate_1",
    status: "pending_approval",
    approvalMode: null,
    createdAt: "2026-11-26T00:00:00.000Z",
    decidedAt: null,
    decidedByPersonId: null,
    promotedTaskId: null,
    dispatchRuntimeSessionId: null,
    dispatchError: null,
    rejectionReason: null,
    gateVerdict: null,
    terminalOutcome: null,
  };
  let next = upsertResidentCeoProposal(autoPromoteProfile, proposal, "2026-11-26T00:00:01.000Z");
  next = recordResidentCeoProposalGateVerdict(next, "prop_gate_1", boundaryPass.verdict);
  next = transitionResidentCeoProposal(next, "prop_gate_1", {
    status: "promoted",
    approvalMode: "decider-auto",
    decidedAt: "2026-11-26T00:01:02.000Z",
    decidedByPersonId: "person_owner",
    promotedTaskId: "task_decider_1",
    proposedWorkId: "task_work_default",
    proposedTitle: "Run read-only audit",
    proposedAgentId: "neon",
    dispatchRuntimeSessionId: "session_decider_1",
    dispatchError: null,
  });
  assert.equal(next.proposals?.[0]?.approvalMode, "decider-auto");
  assert.deepEqual(next.proposals?.[0]?.gateVerdict, boundaryPass.verdict);
  // Legacy persisted proposal without proposedTargetNodeId remains valid and transitions cleanly.
  assert.equal(next.proposals?.[0]?.proposedTargetNodeId, undefined);

  const invalidTargetNodeGate = evaluateResidentCeoGateDecision({
    profile: autoPromoteProfile,
    proposal: {
      fromPersonId: "person_stranger",
      proposedWorkId: "task_work_default",
      proposedAgentId: "neon",
      proposedTargetNodeId: "bad node!",
    },
    observation: {
      selected: "approve_low_risk",
      distribution: { approve_low_risk: 0.99 },
      providerId: "decider-main",
      model: "decider-v1",
      evaluatedAt: "2026-11-26T00:00:05.000Z",
    },
  });
  assert.equal(invalidTargetNodeGate.allowAutoPromote, false);
  assert.equal(invalidTargetNodeGate.verdict.fallbackReason, "invalid_target_node_id");
});

test("tiered action classifier and turn parser cover Tier 0, Tier 1, Tier 2 fail-closed, and plain human-chat replies", () => {
  assert.deepEqual(classifyResidentCeoAction("peer.ask"), { kind: "tier0", actionKind: "peer_ask" });
  assert.deepEqual(classifyResidentCeoAction("peer_reply"), { kind: "tier0", actionKind: "peer_reply" });
  assert.deepEqual(classifyResidentCeoAction("runtime.steer"), { kind: "tier0", actionKind: "runtime_steer" });
  assert.deepEqual(classifyResidentCeoAction("propose_task"), { kind: "tier1", actionKind: "promote_and_dispatch" });
  assert.deepEqual(classifyResidentCeoAction("start_and_dispatch_existing"), {
    kind: "tier1",
    actionKind: "start_and_dispatch_existing",
  });
  assert.deepEqual(classifyResidentCeoAction("archive_or_cancel_unleased"), {
    kind: "tier1",
    actionKind: "archive_or_cancel_unleased",
  });
  assert.deepEqual(classifyResidentCeoAction("doc_sync_plan"), { kind: "tier1", actionKind: "doc_sync_plan" });

  for (const forbidden of [
    "review-consent",
    "review_consent",
    "task.complete",
    "task_complete",
    "force-takeover",
    "merge_pr",
    "modify-ci-gate",
  ]) {
    const classified = classifyResidentCeoAction(forbidden);
    assert.equal(classified.kind, "tier2", `expected ${forbidden} to classify as tier2`);
  }

  const fallback = {
    summary: "Check status",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
    requestedAction: "Check status",
  };

  // Plain human-chat stays reply_only (no synthetic task proposals).
  const plainChat = parseResidentCeoTurnActions("All builds look green right now.", {
    channel: "human-chat",
    fallback,
  });
  assert.deepEqual(plainChat, {
    mode: "reply_only",
    replyText: "All builds look green right now.",
    actions: [],
  });

  // Multi-action envelope with Tier 0, Tier 1, and forbidden Tier 2.
  const multi = parseResidentCeoTurnActions(
    JSON.stringify({
      reply: "Executing requested actions.",
      actions: [
        { action: "peer_ask", toPersonId: "person_zeyu", summary: "Check PR 1B progress" },
        { action: "start_and_dispatch_existing", taskId: "task_pr1b", agentId: "sol", targetNodeId: "mac-pro" },
        { action: "archive_or_cancel_unleased", taskId: "task_old", cleanupMode: "cancel", rationale: "Merged" },
        { action: "doc_sync_plan", taskId: "task_pr1b", planContent: "# Plan\n\nUpdated." },
        { action: "review-consent", taskId: "task_pr1b" },
      ],
    }),
    { channel: "human-chat", fallback },
  );
  assert.equal(multi.mode, "actions");
  if (multi.mode === "actions") {
    assert.equal(multi.replyText, "Executing requested actions.");
    assert.equal(multi.actions.length, 5);
    assert.equal(multi.actions[0]?.tier, "tier0");
    assert.equal(multi.actions[1]?.tier, "tier1");
    assert.equal(multi.actions[2]?.tier, "tier1");
    assert.equal(multi.actions[3]?.tier, "tier1");
    assert.equal(multi.actions[4]?.tier, "tier2");
  }

  // Missing required fields fail closed into rejected action.
  const badSteer = parseResidentCeoTurnActions(
    JSON.stringify({ action: "runtime_steer", runtimeSessionId: "rs_1", dispatchId: "disp_1", prompt: "Both ids" }),
    { channel: "human-chat", fallback },
  );
  assert.equal(badSteer.mode, "actions");
  if (badSteer.mode === "actions") {
    assert.equal(badSteer.actions[0]?.tier, "rejected");
  }
});

test("dual-track trust evaluators enforce owner-direct on human-chat, whitelist on peer-request Tier 0, and bounded audit log", () => {
  const gated = createResidentCeoProfile(
    {
      principalPersonId: "person_owner",
      runtimeInstanceId: "runtime_local",
      model: "model-a",
      heartbeatIntervalSec: 60,
      executionPolicy: "approval-gated",
      defaultWorkId: "task_work_default",
      defaultAgentId: "neon",
      autoApproveSenders: ["person_zeyu"],
    },
    "2026-11-27T00:00:00.000Z",
  );

  // Tier 0: human-chat owner-direct allowed; advisory-only blocked; peer-request requires allowlist target
  assert.deepEqual(
    evaluateResidentCeoTier0Access(gated, {
      channel: "human-chat",
      actorPersonId: "person_owner",
      actionKind: "peer_ask",
      targetPersonId: "person_anyone",
    }),
    { allowed: true, approvalMode: "owner-direct" },
  );
  assert.equal(
    evaluateResidentCeoTier0Access(profile, {
      channel: "human-chat",
      actorPersonId: "person_owner",
      actionKind: "peer_ask",
      targetPersonId: "person_zeyu",
    }).allowed,
    false,
  );
  assert.equal(
    evaluateResidentCeoTier0Access(gated, {
      channel: "peer-request",
      actorPersonId: "person_stranger",
      actionKind: "peer_ask",
      targetPersonId: "person_stranger",
    }).allowed,
    false,
  );
  assert.deepEqual(
    evaluateResidentCeoTier0Access(gated, {
      channel: "peer-request",
      actorPersonId: "person_stranger",
      actionKind: "peer_ask",
      targetPersonId: "person_zeyu",
    }),
    { allowed: true, approvalMode: "allowlist-auto" },
  );

  // Tier 1 owner-direct: only human-chat from principal; never peer-request
  assert.equal(effectiveResidentCeoProposalActionKind({}), "promote_and_dispatch");
  assert.deepEqual(
    evaluateResidentCeoOwnerDirectApproval(gated, {
      actionKind: "start_and_dispatch_existing",
      sourceChannel: "human-chat",
      fromPersonId: "person_owner",
      proposedWorkId: null,
      proposedAgentId: "neon",
      proposedTargetNodeId: null,
      targetTaskId: "task_existing_1",
      planContent: null,
    }),
    { autoApprove: true, approvalMode: "owner-direct", workId: "task_work_default" },
  );
  assert.equal(
    evaluateResidentCeoOwnerDirectApproval(gated, {
      actionKind: "start_and_dispatch_existing",
      sourceChannel: "peer-request",
      fromPersonId: "person_owner",
      proposedWorkId: null,
      proposedAgentId: "neon",
      proposedTargetNodeId: null,
      targetTaskId: "task_existing_1",
      planContent: null,
    }).autoApprove,
    false,
  );

  // Audit log caps at RESIDENT_CEO_MAX_ACTION_AUDIT_ENTRIES
  let audited = gated;
  for (let i = 0; i < RESIDENT_CEO_MAX_ACTION_AUDIT_ENTRIES + 15; i += 1) {
    audited = appendResidentCeoActionAudit(audited, {
      auditId: `aud_${i}`,
      wakeId: `wake_${i}`,
      channel: "human-chat",
      tier: "tier0",
      actionKind: "peer_ask",
      outcome: "executed",
      approvalMode: "owner-direct",
      actorPersonId: "person_owner",
      targetRef: "person/person_zeyu",
      resultRef: `peer/peer_${i}`,
      proposalId: null,
      errorCode: null,
      detail: `entry ${i}`,
      recordedAt: "2026-11-27T00:00:01.000Z",
    });
  }
  assert.equal(audited.actionAuditLog?.length, RESIDENT_CEO_MAX_ACTION_AUDIT_ENTRIES);
  assert.equal(audited.actionAuditLog?.[0]?.auditId, "aud_15");
});
