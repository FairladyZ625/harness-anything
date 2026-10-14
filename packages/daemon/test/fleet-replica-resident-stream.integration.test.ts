// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 B1/B2/S2: the production edge stream (runFleetReplicaSync) against a real center.
// Covers: one resident replication session per node+repo across many commits (no reconnect per round);
// edge command sessions never cut it and a replication start never cuts a command session; after a
// connection failure it reconnects with backoff and resumes from the last ACK without a new base backup;
// write-then-read waits for the commit sequence the center returned; the center prunes its replication
// log on its single writer down to the slowest slot; a resync installs a new generation and the old one
// is deleted once no read pins it.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runFleetReplicaSync, waitForFleetReplicaSequence } from "../src/fleet/replica-sync.ts";
import { readReplicaGeneration, replicaGenerationReaders } from "../src/fleet/replica-generation.ts";
import {
  fleetReplicationFixture,
  replicationRepoId,
  seedCenterData,
  waitForState,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";
import { rawPeer } from "./fleet-tls-session.fixture.ts";

const seededTask = { taskId: "task_resident0000000000000000001", executionId: "exe_resident", title: "Resident" };
let pressureCounter = 0;
const pressure = async (fixture: FleetReplicationFixture, count = 1) => {
  for (let index = 0; index < count; index += 1) {
    const appended = await fixture.centerRun({
      kind: "task-create",
      taskId: `task_rs${String(++pressureCounter).padStart(6, "0")}00000000000000000000`,
      title: "resident pressure",
    });
    assert.equal(appended.outcome, "applied", JSON.stringify(appended));
  }
};
const readOne = <T>(file: string, sql: string, params: readonly (string | number)[] = []): T => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
};
const centerSequence = (fixture: FleetReplicationFixture): number =>
  readOne<{ sequence: number }>(fixture.ledgerPath, "SELECT sequence FROM replication_state").sequence;
const centerLogFloor = (fixture: FleetReplicationFixture): number =>
  readOne<{ floor: number }>(fixture.ledgerPath, "SELECT MIN(sequence) AS floor FROM replication_log").floor;
const slotFence = (fixture: FleetReplicationFixture): number =>
  readOne<{ fence: number }>(
    path.join(fixture.stateRoot, "replication-slots.sqlite"),
    "SELECT fence FROM replication_slot WHERE repo=? AND node=?",
    [replicationRepoId, "edge-one"],
  ).fence;

/** Starts the production resident stream for edge-one, optionally through a cuttable TCP relay. */
function startStream(t: TestContext, fixture: FleetReplicationFixture, viewRoot: string, port: number) {
  const controller = new AbortController(),
    failures: unknown[] = [];
  const running = runFleetReplicaSync({
    hostname: "127.0.0.1",
    port,
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
  });
  const stop = async () => {
    controller.abort();
    await running;
  };
  t.after(stop);
  return { stop, failures };
}

/** A TCP relay in front of the center whose live connections the test can cut. */
async function relay(t: TestContext, target: number) {
  const live = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(target, "127.0.0.1");
    live.add(client).add(upstream);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of live) socket.destroy();
    server.close();
  });
  return {
    port: (server.address() as { port: number }).port,
    cut: () => {
      for (const socket of live) socket.destroy();
    },
  };
}

test(
  "one resident stream serves every commit, survives edge commands and a cut, and resumes from its ACK",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-resident-view-")),
      viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
      mirrorSequence = () => readReplicaGeneration(viewDir)?.metadata.position.sequence ?? -1,
      converged = (label: string) =>
        waitForState(() => mirrorSequence() === centerSequence(fixture), `edge-one ${label}`, 60_000);
    const link = await relay(t, fixture.centerPort());
    const stream = startStream(t, fixture, viewRoot, link.port);
    await converged("initial convergence");
    const firstGeneration = readReplicaGeneration(viewDir)!.id;
    // A command session the node holds open must survive the node's replication start and stream.
    const command = await rawPeer(fixture.track, fixture.centerPort(), fixture.cert, "edge-one", "secret-edge-one");
    for (let round = 0; round < 3; round += 1) {
      await pressure(fixture);
      // Write-then-read: the center answers with its replication head; the stream must reach it.
      const written = await fixture.edgeTaskCommand("edge-one", {
        kind: "task-create",
        taskId: `task_wr${String(round).padStart(6, "0")}00000000000000000000`,
        title: "write then read",
      });
      assert.equal(written.schema, "fleet.task.result/v1", JSON.stringify(written));
      const sequence = (written as { replicationSequence: number | null }).replicationSequence;
      assert.equal(typeof sequence, "number", "the center returns the commit sequence of the write");
      await waitForFleetReplicaSequence(
        { viewRoot, repoId: replicationRepoId, nodeId: "edge-one" },
        sequence!,
        AbortSignal.timeout(60_000),
      );
      assert.ok(mirrorSequence() >= sequence!, "the local applied position reached the write");
    }
    await converged("convergence across rounds");
    assert.equal(slotFence(fixture), 1, "every round rode the first replication session");
    // The center pruned its log on the writer down to the slowest slot (only edge-one here).
    await waitForState(
      () => centerLogFloor(fixture) === centerSequence(fixture),
      "the replication log to be pruned to the slot ACK",
    );
    // A failed connection reconnects with backoff and resumes from the last ACK: no new package.
    link.cut();
    await pressure(fixture, 2);
    await converged("convergence after reconnect");
    assert.equal(slotFence(fixture), 2, "exactly one reconnect after the cut");
    assert.equal(readReplicaGeneration(viewDir)!.id, firstGeneration, "resumed in place, no base backup");
    assert.ok(stream.failures.length >= 1, "the cut surfaced as one stream failure");
    // The reconnect's replication start displaced no command session of the node.
    const metadata = await Promise.race([
      command.request({ schema: "fleet.repo.metadata.get/v1", messageId: "still-open", repoId: replicationRepoId }),
      command.closed.then(() => ({ schema: "closed" })),
    ]);
    assert.equal(metadata.schema, "fleet.repo.metadata.result/v1", "the command session was never cut");
  },
);

test(
  "a resync publishes a new generation; the old one is deleted once its last pinned read releases",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t, { retentionWindowCommits: 2 });
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-resident-view-")),
      viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
      generationsDir = path.join(viewDir, "generations"),
      published = () => readdirSync(generationsDir).filter((name) => !name.endsWith(".staging"));
    const first = startStream(t, fixture, viewRoot, fixture.centerPort());
    await waitForState(
      () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
      "initial convergence",
      60_000,
    );
    await first.stop();
    const old = readReplicaGeneration(viewDir)!;
    // An edge read pins the generation it reads; the offline edge falls beyond the retention cap.
    const pin = replicaGenerationReaders(viewDir).acquire()!;
    assert.equal(pin.generation.id, old.id);
    await pressure(fixture, 4);
    startStream(t, fixture, viewRoot, fixture.centerPort());
    await waitForState(
      () => readReplicaGeneration(viewDir)?.id !== old.id,
      "the resync to publish a new generation",
      60_000,
    );
    await waitForState(
      () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
      "convergence after resync",
      60_000,
    );
    assert.equal(existsSync(old.rootDir), true, "a pinned generation outlives the publish");
    pin.release();
    await waitForState(() => !existsSync(old.rootDir), "the released old generation to be deleted");
    assert.deepEqual(published(), [readReplicaGeneration(viewDir)!.id], "only the current generation remains");
  },
);
