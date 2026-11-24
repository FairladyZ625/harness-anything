// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  verifySwitchoverFenceEpoch,
  isSwitchoverPhaseTransitionAllowed,
  computeSwitchoverRollbackEpoch,
  computeSwitchoverTargetEpoch,
  createCenterSwitchoverState,
  evaluateRpoZeroCatchupBarrier,
  evaluateSwitchoverPreflight,
  evaluateSwitchoverRollbackEligibility,
  transitionCenterSwitchoverState,
  type SwitchoverFrozenCut,
  type SwitchoverPreflightInput,
} from "../../src/domain/center-switchover.ts";

const HISTORY = "0123456789abcdef0123456789abcdef";
const TIP = `sha256:${"a".repeat(64)}`;
const SPKI = `sha256:${"b".repeat(64)}`;

function healthyPreflightInput(): SwitchoverPreflightInput {
  return {
    repoId: "fleet-repo",
    triggerSource: "operator",
    sourceNodeId: "node-a",
    targetNodeId: "node-b",
    oldEpoch: 3,
    centerHistory: HISTORY,
    tlsReachable: true,
    targetExternalUrl: "https://node-b.example.invalid:9443",
    targetSpkiSha256: SPKI,
    replicaConnected: true,
    replicaHistory: HISTORY,
    replicaSyncFailureCode: null,
    replicaLagRevisions: 0,
    maxAllowedLagRevisions: 100,
    availableDiskBytes: 2 * 1024 * 1024 * 1024,
    requiredDiskBytes: 64 * 1024 * 1024,
    authReachable: true,
    targetLoginUrl: "https://login.example.invalid:8443",
    sourceSymmetricReady: true,
  };
}

test("switchover state machine enforces legal two-phase transitions and audited rollback preconditions", () => {
  const cut: SwitchoverFrozenCut = {
    repoId: "fleet-repo",
    finalRevision: 10,
    tipHash: TIP,
    history: HISTORY,
    sequence: 12,
  };
  let state = createCenterSwitchoverState({
    switchoverId: "sw_1",
    repoId: "fleet-repo",
    triggerSource: "operator",
    sourceNodeId: "node-a",
    targetNodeId: "node-b",
    oldEpoch: 4,
    now: "2026-11-24T00:00:00.000Z",
  });
  assert.equal(state.phase, "idle");
  assert.equal(state.targetEpoch, 5);
  assert.equal(isSwitchoverPhaseTransitionAllowed("idle", "target_activated"), false);
  assert.throws(() => transitionCenterSwitchoverState(state, "fenced_ceded", { now: "2026-11-24T00:00:01.000Z" }));

  state = transitionCenterSwitchoverState(state, "freezing", { now: "2026-11-24T00:00:01.000Z" });
  assert.throws(
    () => transitionCenterSwitchoverState(state, "fenced_ceded", { now: "2026-11-24T00:00:02.000Z" }),
    /frozen center cut/u,
  );
  state = transitionCenterSwitchoverState(state, "fenced_ceded", {
    now: "2026-11-24T00:00:02.000Z",
    frozenCut: cut,
  });

  // Rollback from fenced_ceded requires targetNeverActivated, targetInvalidated, and rollbackEpoch >= oldEpoch + 2.
  assert.throws(
    () =>
      transitionCenterSwitchoverState(state, "aborted_rolled_back", {
        now: "2026-11-24T00:00:03.000Z",
      }),
    /audited proof/u,
  );
  assert.throws(
    () =>
      transitionCenterSwitchoverState(state, "aborted_rolled_back", {
        now: "2026-11-24T00:00:03.000Z",
        rollbackAudit: {
          targetNeverActivated: true,
          targetInvalidated: true,
          rollbackEpoch: 5,
          reason: "too low",
        },
      }),
    /oldEpoch \+ 2/u,
  );
  const rolledBack = transitionCenterSwitchoverState(state, "aborted_rolled_back", {
    now: "2026-11-24T00:00:03.000Z",
    rollbackAudit: {
      targetNeverActivated: true,
      targetInvalidated: true,
      rollbackEpoch: 6,
      reason: "target offline before activation",
    },
  });
  assert.equal(rolledBack.phase, "aborted_rolled_back");
  assert.equal(rolledBack.rollbackEpoch, 6);

  // Forward happy path: fenced_ceded -> target_activated -> demoted_edge.
  const activated = transitionCenterSwitchoverState(state, "target_activated", { now: "2026-11-24T00:00:04.000Z" });
  const demoted = transitionCenterSwitchoverState(activated, "demoted_edge", { now: "2026-11-24T00:00:05.000Z" });
  assert.equal(demoted.phase, "demoted_edge");
  assert.throws(() => transitionCenterSwitchoverState(demoted, "idle", { now: "2026-11-24T00:00:06.000Z" }));
});

test("candidate preflight validates TLS, replica health/disk, auth reachability, triggerSource, and symmetric identity", () => {
  const pass = evaluateSwitchoverPreflight(healthyPreflightInput());
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.blockingCodes, []);

  const sentinelBlocked = evaluateSwitchoverPreflight({ ...healthyPreflightInput(), triggerSource: "sentinel" });
  assert.equal(sentinelBlocked.ok, false);
  assert.ok(sentinelBlocked.blockingCodes.includes("unsupported_trigger_source"));

  const sentinelAllowed = evaluateSwitchoverPreflight({
    ...healthyPreflightInput(),
    triggerSource: "sentinel",
    allowSentinelTrigger: true,
  });
  assert.equal(sentinelAllowed.ok, true);

  const failing = evaluateSwitchoverPreflight({
    ...healthyPreflightInput(),
    tlsReachable: false,
    replicaLagRevisions: 5000,
    availableDiskBytes: 100,
    authReachable: false,
    sourceSymmetricReady: false,
  });
  assert.equal(failing.ok, false);
  assert.ok(failing.blockingCodes.includes("target_tls_unreachable"));
  assert.ok(failing.blockingCodes.includes("replica_lag_exceeded"));
  assert.ok(failing.blockingCodes.includes("auth_surface_unreachable"));
  assert.ok(failing.blockingCodes.includes("source_symmetric_identity_missing"));
});

test("RPO=0 catch-up barrier accepts exact lineage match and rejects lag, tip mismatch, or history divergence", () => {
  const center: SwitchoverFrozenCut = {
    repoId: "fleet-repo",
    finalRevision: 42,
    tipHash: TIP,
    history: HISTORY,
    sequence: 50,
  };
  assert.deepEqual(
    evaluateRpoZeroCatchupBarrier(center, {
      repoId: "fleet-repo",
      revision: 42,
      tipHash: TIP,
      history: HISTORY,
      sequence: 50,
    }),
    { ok: true },
  );

  const lagging = evaluateRpoZeroCatchupBarrier(center, {
    repoId: "fleet-repo",
    revision: 41,
    tipHash: TIP,
    history: HISTORY,
    sequence: 49,
  });
  assert.equal(lagging.ok, false);
  assert.equal(lagging.code, "rpo_zero_barrier_unmet");
  assert.ok(lagging.issues.includes("revision_lagging_or_mismatch"));
  assert.ok(lagging.issues.includes("sequence_mismatch"));

  const badTip = evaluateRpoZeroCatchupBarrier(center, {
    repoId: "fleet-repo",
    revision: 42,
    tipHash: `sha256:${"f".repeat(64)}`,
    history: "fedcba9876543210fedcba9876543210",
    sequence: 50,
  });
  assert.equal(badTip.ok, false);
  assert.ok(badTip.issues.includes("tip_hash_mismatch"));
  assert.ok(badTip.issues.includes("history_mismatch"));
});

test("epoch invariants and rollback eligibility enforce oldEpoch+1 fence and oldEpoch+2 audited rollback", () => {
  assert.equal(computeSwitchoverTargetEpoch(7), 8);
  assert.equal(computeSwitchoverRollbackEpoch(7), 9);
  assert.doesNotThrow(() => verifySwitchoverFenceEpoch(7, 8));
  assert.throws(() => verifySwitchoverFenceEpoch(7, 7));

  assert.deepEqual(
    evaluateSwitchoverRollbackEligibility({
      requestedSwitchoverId: "sw_1",
      fenceSwitchoverId: "sw_1",
      oldEpoch: 7,
      cededEpoch: 8,
      targetNeverActivated: true,
      targetInvalidated: true,
    }),
    { ok: true, rollbackEpoch: 9 },
  );

  const unverifiedTarget = evaluateSwitchoverRollbackEligibility({
    requestedSwitchoverId: "sw_1",
    fenceSwitchoverId: "sw_1",
    oldEpoch: 7,
    cededEpoch: 8,
    targetNeverActivated: false,
    targetInvalidated: true,
  });
  assert.equal(unverifiedTarget.ok, false);
  assert.equal(unverifiedTarget.code, "target_activation_not_disproven");

  const uninvalidated = evaluateSwitchoverRollbackEligibility({
    requestedSwitchoverId: "sw_1",
    fenceSwitchoverId: "sw_1",
    oldEpoch: 7,
    cededEpoch: 8,
    targetNeverActivated: true,
    targetInvalidated: false,
  });
  assert.equal(uninvalidated.ok, false);
  assert.equal(uninvalidated.code, "target_attempt_not_invalidated");
});
