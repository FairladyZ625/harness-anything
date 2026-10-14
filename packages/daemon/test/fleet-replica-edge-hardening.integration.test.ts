// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 real-machine hardening of the resident edge stream (runFleetReplicaSync):
// edge-runtime confirmations never run inside the receiver's ACK path.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  runFleetReplicaSync,
  waitForFleetReplicaSequence,
  type ReplicaSyncOptions,
} from "../src/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet/replica-generation.ts";
import {
  fleetReplicationFixture,
  replicationRepoId,
  seedCenterData,
  waitForState,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";

const seededTask = { taskId: "task_harden00000000000000000000001", executionId: "exe_harden", title: "Harden" };
let pressureCounter = 0;
const pressure = async (fixture: FleetReplicationFixture, count = 1) => {
  for (let index = 0; index < count; index += 1) {
    const appended = await fixture.centerRun({
      kind: "task-create",
      taskId: `task_hd${String(++pressureCounter).padStart(6, "0")}00000000000000000000`,
      title: "hardening pressure",
    });
    assert.equal(appended.outcome, "applied", JSON.stringify(appended));
  }
};
const centerSequence = (fixture: FleetReplicationFixture): number => {
  const db = new DatabaseSync(fixture.ledgerPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return (db.prepare("SELECT sequence FROM replication_state").get() as { sequence: number }).sequence;
  } finally {
    db.close();
  }
};
const viewKey = (viewRoot: string) => ({ viewRoot, repoId: replicationRepoId, nodeId: "edge-one" });

export function startHardeningStream(
  t: TestContext,
  fixture: FleetReplicationFixture,
  viewRoot: string,
  extra: Partial<ReplicaSyncOptions> = {},
) {
  const controller = new AbortController(),
    failures: unknown[] = [];
  const running = runFleetReplicaSync({
    hostname: "127.0.0.1",
    port: fixture.centerPort(),
    ca: fixture.cert,
    servername: "localhost",
    nodeId: "edge-one",
    credential: "secret-edge-one",
    readAccessToken: async () => "device-token-edge-one",
    repoId: replicationRepoId,
    viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
    signal: controller.signal,
    onFailure: (error) => failures.push(error),
    ...extra,
  });
  const stop = async () => {
    controller.abort();
    await running;
  };
  t.after(stop);
  return { stop, failures };
}

test(
  "a confirmation that waits for a later replicated commit does not stall the stream that applies it",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-"));
    let calls = 0,
      waitedForLaterCommit = false;
    // The squad reconcile shape: a confirmation writes at the center, then waits for the edge to apply
    // that write (write-then-read). Awaiting it inside the ACK path deadlocks the receiver.
    const stream = startHardeningStream(t, fixture, viewRoot, {
      onConfirmed: async () => {
        if (calls++ > 0) return;
        await pressure(fixture);
        await waitForFleetReplicaSequence(viewKey(viewRoot), centerSequence(fixture), AbortSignal.timeout(20_000));
        waitedForLaterCommit = true;
      },
    });
    await waitForState(() => waitedForLaterCommit, "the confirmation's write-then-read to complete", 60_000);
    assert.deepEqual(stream.failures, [], "the stream never failed while the confirmation waited");
  },
);

test("a failing confirmation is reported and never fails the replication stream", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
    confirmFailures: unknown[] = [];
  const stream = startHardeningStream(t, fixture, viewRoot, {
    onConfirmed: () => {
      throw new Error("center rejected the reconcile");
    },
    onConfirmedFailure: (error) => confirmFailures.push(error),
  });
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  await pressure(fixture, 3);
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "convergence across failing confirmations",
    60_000,
  );
  assert.ok(confirmFailures.length >= 1, "the confirmation failure was reported");
  assert.deepEqual(stream.failures, [], "confirmation failures are not stream failures");
});
