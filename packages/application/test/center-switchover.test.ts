// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  abortCenterSwitchoverRollback,
  runCenterSwitchover,
  type CenterSwitchoverPorts,
  type CenterSwitchoverRollbackPorts,
} from "../src/commands/center-switchover.ts";

const HISTORY = "0123456789abcdef0123456789abcdef";
const TIP = `sha256:${"a".repeat(64)}`;
const SPKI = `sha256:${"b".repeat(64)}`;

function makePorts(events: string[], overrides: Partial<CenterSwitchoverPorts> = {}): CenterSwitchoverPorts {
  return {
    now: () => "2026-11-24T00:00:00.000Z",
    authorize: async () => {
      events.push("authorize");
    },
    inspectPreflight: async () => {
      events.push("inspectPreflight");
      return {
        repoId: "fleet-repo",
        triggerSource: "operator",
        sourceNodeId: "node-a",
        targetNodeId: "node-b",
        oldEpoch: 5,
        centerHistory: HISTORY,
        tlsReachable: true,
        targetExternalUrl: "https://node-b.example.invalid:9443",
        targetSpkiSha256: SPKI,
        replicaConnected: true,
        replicaHistory: HISTORY,
        replicaSyncFailureCode: null,
        replicaLagRevisions: 0,
        maxAllowedLagRevisions: 100,
        availableDiskBytes: 1024 * 1024 * 1024,
        requiredDiskBytes: 1024 * 1024,
        authReachable: true,
        targetLoginUrl: "https://login.example.invalid",
        sourceSymmetricReady: true,
      };
    },
    freezeAndDrainSource: async () => {
      events.push("freezeAndDrainSource");
      return { repoId: "fleet-repo", finalRevision: 15, tipHash: TIP, history: HISTORY, sequence: 18 };
    },
    unfreezeSource: async () => {
      events.push("unfreezeSource");
    },
    awaitTargetCatchup: async () => {
      events.push("awaitTargetCatchup");
      return { repoId: "fleet-repo", revision: 15, tipHash: TIP, history: HISTORY, sequence: 18 };
    },
    persistCededFence: async () => {
      events.push("persistCededFence");
    },
    activateTargetCenter: async () => {
      events.push("activateTargetCenter");
      return {
        switchoverId: "sw_1",
        repoId: "fleet-repo",
        oldEpoch: 5,
        newEpoch: 6,
        finalRevision: 15,
        tipHash: TIP,
        replicationHistory: HISTORY,
        replicationSequence: 19,
        retainedLogMinSequence: 1,
        retainedLogRowCount: 19,
        promotedAt: "2026-11-24T00:00:01.000Z",
      };
    },
    demoteSourceToEdge: async () => {
      events.push("demoteSourceToEdge");
      return {
        switchoverId: "sw_1",
        repoId: "fleet-repo",
        sourceNodeId: "node-a",
        targetNodeId: "node-b",
        newEpoch: 6,
        mode: "remote-edge",
        viewRoot: "/tmp/views",
        demotedAt: "2026-11-24T00:00:02.000Z",
      };
    },
    ...overrides,
  };
}

test("runCenterSwitchover dry-run evaluates preflight with zero mutations", async () => {
  const events: string[] = [];
  const outcome = await runCenterSwitchover(
    { switchoverId: "sw_dry", repoId: "fleet-repo", targetNodeId: "node-b", dryRun: true },
    makePorts(events),
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.dryRun, true);
    assert.equal(outcome.phase, "idle");
  }
  assert.deepEqual(events, ["authorize", "inspectPreflight"]);
});

test("runCenterSwitchover enforces strict Phase 1 fence before Phase 2 target activation and Phase 3 demotion", async () => {
  const events: string[] = [];
  const outcome = await runCenterSwitchover(
    { switchoverId: "sw_1", repoId: "fleet-repo", targetNodeId: "node-b" },
    makePorts(events),
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok && !outcome.dryRun) {
    assert.equal(outcome.phase, "demoted_edge");
    assert.equal(outcome.activation.newEpoch, 6);
    assert.equal(outcome.activation.replicationHistory, HISTORY);
    assert.equal(outcome.demotion.mode, "remote-edge");
  }
  assert.deepEqual(events, [
    "authorize",
    "inspectPreflight",
    "freezeAndDrainSource",
    "awaitTargetCatchup",
    "persistCededFence",
    "activateTargetCenter",
    "demoteSourceToEdge",
  ]);
});

test("runCenterSwitchover aborts and safely unfreezes source when RPO=0 catch-up barrier is unmet", async () => {
  const events: string[] = [];
  const outcome = await runCenterSwitchover(
    { switchoverId: "sw_lag", repoId: "fleet-repo", targetNodeId: "node-b" },
    makePorts(events, {
      awaitTargetCatchup: async () => {
        events.push("awaitTargetCatchup");
        return { repoId: "fleet-repo", revision: 14, tipHash: TIP, history: HISTORY, sequence: 17 };
      },
    }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "rpo_zero_barrier_unmet");
    assert.equal(outcome.phase, "aborted_rolled_back");
    assert.ok(outcome.barrierIssues?.includes("revision_lagging_or_mismatch"));
  }
  assert.deepEqual(events, [
    "authorize",
    "inspectPreflight",
    "freezeAndDrainSource",
    "awaitTargetCatchup",
    "unfreezeSource",
  ]);
});

test("runCenterSwitchover NEVER auto-unfreezes source if Phase 2 fails after Phase 1 ceded fence persisted", async () => {
  const events: string[] = [];
  const outcome = await runCenterSwitchover(
    { switchoverId: "sw_crash", repoId: "fleet-repo", targetNodeId: "node-b" },
    makePorts(events, {
      activateTargetCenter: async () => {
        events.push("activateTargetCenter");
        throw Object.assign(new Error("target unreachable during activation"), { code: "target_unreachable" });
      },
    }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.fencedCeded, true);
    assert.equal(outcome.phase, "fenced_ceded");
    assert.equal(outcome.code, "target_unreachable");
  }
  assert.equal(events.includes("unfreezeSource"), false);
});

test("abortCenterSwitchoverRollback refuses unverified target and commits oldEpoch+2 once invalidated", async () => {
  const basePorts: CenterSwitchoverRollbackPorts = {
    now: () => "2026-11-24T00:05:00.000Z",
    authorize: async () => undefined,
    readCededFence: async () => ({
      switchoverId: "sw_crash",
      repoId: "fleet-repo",
      oldEpoch: 5,
      cededEpoch: 6,
      sourceNodeId: "node-a",
      targetNodeId: "node-b",
      finalRevision: 15,
      tipHash: TIP,
      newExternalUrl: "https://node-b.example.invalid:9443",
      newLoginUrl: "https://login.example.invalid",
      spkiSha256: SPKI,
      fencedAt: "2026-11-24T00:00:00.000Z",
    }),
    invalidateTargetAttempt: async () => ({ targetNeverActivated: false, targetInvalidated: false }),
    commitAuditedRollback: async () => {
      throw new Error("must not commit when target may have activated");
    },
  };
  const refused = await abortCenterSwitchoverRollback(
    { repoId: "fleet-repo", switchoverId: "sw_crash", reason: "network drop" },
    basePorts,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "target_activation_not_disproven");

  let committedEpoch = 0;
  const approved = await abortCenterSwitchoverRollback(
    { repoId: "fleet-repo", switchoverId: "sw_crash", reason: "target crashed before Phase 2" },
    {
      ...basePorts,
      invalidateTargetAttempt: async () => ({ targetNeverActivated: true, targetInvalidated: true }),
      commitAuditedRollback: async (input) => {
        committedEpoch = input.rollbackEpoch;
        return {
          switchoverId: input.switchoverId,
          repoId: input.repoId,
          oldEpoch: input.oldEpoch,
          cededEpoch: input.cededEpoch,
          rollbackEpoch: input.rollbackEpoch,
          auditPath: "/tmp/audit.json",
          rolledBackAt: "2026-11-24T00:05:00.000Z",
        };
      },
    },
  );
  assert.equal(approved.ok, true);
  assert.equal(committedEpoch, 7);
});
