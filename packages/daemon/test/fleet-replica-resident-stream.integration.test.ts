// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 B1/B2/S2: the production edge stream (runFleetReplicaSync) against a real center.
// Covers: one resident replication session per node+repo across many commits (no reconnect per round);
// edge command sessions never cut it and a replication start never cuts a command session; after a
// connection failure it reconnects with backoff and resumes from the last ACK without a new base backup;
// write-then-read waits for the commit sequence the center returned; the center prunes its replication
// log on its single writer down to the slowest slot and the edge recycles its own log below its applied
// position; a resync installs a new generation and the old one is deleted once no read pins it; stream
// start removes staging a crashed install left; edge sync waits for the center's head on the resident
// stream, and write waits survive reconnects but fail when their own signal expires or the stream stops.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { syncFleetEdgeMirror } from "../src/fleet-center-admission.ts";
import { locateFleetMirrorView } from "../src/fleet-edge-mirror.ts";
import {
  runFleetReplicaSync,
  waitForFleetReplicaReady,
  waitForFleetReplicaSequence,
} from "../src/fleet/replica-sync.ts";
import { readReplicaGeneration, replicaGenerationReaders } from "../src/fleet/replica-generation.ts";
import { readReplicaHealth } from "../src/fleet/replica-health.ts";
import {
  fleetReplicationFixture,
  fakeReplicationCenter,
  replicationRepoId,
  seedCenterData,
  waitForState,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";
import { rawPeer } from "./fleet-tls-session.fixture.ts";

const seededTask = { taskId: "task_resident0000000000000000001", executionId: "exe_resident", title: "Resident" };

test("duplicate connection rejection records its cause and avoids ordinary reconnect backoff", async (t) => {
  const fixture = await fleetReplicationFixture(t);
  const fake = await fakeReplicationCenter(t, fixture, (frame, send) => {
    if (frame.type === "replica.start")
      send({
        type: "replica.reject",
        code: "replica_duplicate_connection",
        message: "replica_duplicate_connection: stop the other daemon before retrying.",
        centerBuildCommit: null,
        taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
      });
  });
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-replica-duplicate-")),
    controller = new AbortController(),
    failed = Promise.withResolvers<void>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = runFleetReplicaSync({
    hostname: "127.0.0.1",
    port: fake.port,
    ca: fixture.cert,
    servername: "localhost",
    nodeId: "edge-one",
    credential: "secret-edge-one",
    repoId: replicationRepoId,
    viewRoot,
    diskQuotaBytes: 64 * 1024 * 1024,
    signal: controller.signal,
    onFailure: () => failed.resolve(),
  });
  try {
    await failed.promise;
    t.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fake.counts()["replica.start"], 1, "duplicate ownership is not retried on ordinary network backoff");
    assert.equal(
      readReplicaHealth(path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one")).syncFailure?.code,
      "replica_duplicate_connection",
    );
  } finally {
    controller.abort();
    await running;
    t.mock.timers.reset();
    rmSync(viewRoot, { recursive: true, force: true });
  }
});

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

test(
  "a deterministic handshake rejection is recorded and does not reconnect in a tight loop",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    const fake = await fakeReplicationCenter(t, fixture, (frame, send) => {
      if (frame.type === "replica.start")
        send({
          type: "replica.reject",
          code: "edge_upgrade_required",
          message: `Edge must upgrade to center build 86d1398 before applying task event shape ${TASK_EVENT_SHAPE_COMPAT_VERSION}.`,
          centerBuildCommit: "86d1398",
          taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
        });
    });
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-replica-deterministic-failure-"));
    t.after(() => rmSync(viewRoot, { recursive: true, force: true }));
    const stream = startStream(t, fixture, viewRoot, fake.port);
    await waitForState(() => stream.failures.length === 1, "the first deterministic rejection", 10_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 750));
    assert.equal(fake.counts()["replica.start"], 1, "the permanent failure waits five minutes before retrying");
    assert.equal(
      readReplicaHealth(path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one")).syncFailure?.code,
      "edge_upgrade_required",
    );
    await stream.stop();
  },
);
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
function startStream(
  t: TestContext,
  fixture: FleetReplicationFixture,
  viewRoot: string,
  port: number,
  diskQuotaBytes = 64 * 1024 * 1024,
) {
  const controller = new AbortController(),
    failures: unknown[] = [],
    // What `ha doctor` on the edge read when each failure was reported.
    healthAtFailure: ReturnType<typeof readReplicaHealth>[] = [];
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
    diskQuotaBytes,
    signal: controller.signal,
    onFailure: (error) => {
      failures.push(error);
      healthAtFailure.push(readReplicaHealth(path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one")));
    },
  });
  const stop = async () => {
    controller.abort();
    await running;
  };
  t.after(stop);
  return { stop, failures, healthAtFailure };
}

test(
  "edge sync reports an initial replica quota failure instead of waiting across retries",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-replica-under-quota-")),
      workspaceRoot = mkdtempSync(path.join(tmpdir(), "ha-replica-under-quota-workspace-"));
    t.after(() => rmSync(viewRoot, { recursive: true, force: true }));
    t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
    const stream = startStream(t, fixture, viewRoot, fixture.centerPort(), 1);
    await assert.rejects(
      syncFleetEdgeMirror(
        {
          payload: {
            host: "127.0.0.1",
            port: fixture.centerPort(),
            caPath: fixture.certFile,
            servername: "localhost",
            nodeId: "edge-one",
            credential: "secret-edge-one",
            repoId: replicationRepoId,
            viewRoot,
            quotaBytes: 1,
            workspaceRoot,
          },
        },
        async () => "device-token-edge-one",
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "replica_sync_failed");
        assert.match(String(error), /base backup exceeds disk quota/u);
        return true;
      },
    );
    assert.ok(stream.failures.length > 0, "the resident stream recorded the initial failure");
  },
);

/**
 * A TCP relay in front of the center. The test can cut live connections, refuse new ones, hold the
 * center's bytes back from the edge, and observe a relayed connection closing.
 */
async function relay(t: TestContext, target: number) {
  const live = new Set<Socket>(),
    held: [Socket, Buffer][] = [],
    closes: (() => void)[] = [];
  let refusing = false,
    holding = false;
  const server = createServer((client) => {
    if (refusing) {
      client.destroy();
      return;
    }
    const upstream = connect(target, "127.0.0.1");
    live.add(client).add(upstream);
    let dropped = false;
    const drop = () => {
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
      if (dropped) return;
      dropped = true;
      for (const notify of closes.splice(0)) notify();
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
    client.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => (holding ? held.push([client, chunk]) : client.write(chunk)));
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
    refuse: (value: boolean) => {
      refusing = value;
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const [client, chunk] of held.splice(0)) if (!client.destroyed) client.write(chunk);
    },
    nextClose: () => new Promise<void>((resolve) => closes.push(resolve)),
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
    // The edge recycles its own log on apply: only the row at its applied position remains.
    assert.deepEqual(
      {
        ...readOne<{ rows: number; floor: number }>(
          readReplicaGeneration(viewDir)!.ledgerPath,
          "SELECT COUNT(*) AS rows, MIN(sequence) AS floor FROM replication_log",
        ),
      },
      { rows: 1, floor: mirrorSequence() },
      "the edge log keeps only its applied anchor",
    );
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
    assert.ok(
      stream.healthAtFailure.every((health) => health.syncFailure !== null),
      "edge doctor sees each stream failure",
    );
    assert.equal(
      readReplicaHealth(viewDir).syncFailure,
      null,
      "the failure clears once the reconnected stream applies",
    );
    // The reconnect's replication start displaced no command session of the node.
    const metadata = await Promise.race([
      command.request({ schema: "fleet.repo.metadata.get/v1", messageId: "still-open", repoId: replicationRepoId }),
      command.closed.then(() => ({ schema: "closed" })),
    ]);
    assert.equal(metadata.schema, "fleet.repo.metadata.result/v1", "the command session was never cut");
    // A converged edge names the center's own ledger cut, so the mirrorBaseCut it sends with document
    // changes passes the protocol shape and the center's base check.
    if (metadata.schema !== "fleet.repo.metadata.result/v1") return;
    const view = locateFleetMirrorView(viewRoot, replicationRepoId, "edge-one")!;
    assert.deepEqual(
      { revision: view.revision, headDigest: view.headDigest },
      { revision: metadata.baseLedgerSha.revision, headDigest: metadata.baseLedgerSha.headDigest },
    );
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
    // An install that crashed mid-way left an unpublished generation and a received archive.
    const crashedGeneration = path.join(generationsDir, "crashed.staging"),
      crashedArchive = path.join(viewDir, "staging", "crashed.tar.gz");
    mkdirSync(crashedGeneration, { recursive: true });
    writeFileSync(path.join(crashedGeneration, "backup.json"), "{}");
    mkdirSync(path.dirname(crashedArchive), { recursive: true });
    writeFileSync(crashedArchive, "partial");
    startStream(t, fixture, viewRoot, fixture.centerPort());
    await waitForState(
      () => !existsSync(crashedGeneration) && !existsSync(crashedArchive),
      "stream start to remove the crashed install's staging",
    );
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

test(
  "edge sync waits for the center head on the resident stream; waits fail with the stream's state",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-resident-view-")),
      viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
      view = { viewRoot, repoId: replicationRepoId, nodeId: "edge-one" },
      mirrorSequence = () => readReplicaGeneration(viewDir)?.metadata.position.sequence ?? -1,
      converged = (label: string) =>
        waitForState(() => mirrorSequence() === centerSequence(fixture), `edge-one ${label}`, 60_000);
    const command = await relay(t, fixture.centerPort());
    const sync = () =>
      syncFleetEdgeMirror(
        {
          payload: {
            host: "127.0.0.1",
            port: command.port,
            caPath: fixture.certFile,
            servername: "localhost",
            nodeId: "edge-one",
            credential: "secret-edge-one",
            repoId: replicationRepoId,
            viewRoot,
            quotaBytes: 64 * 1024 * 1024,
            workspaceRoot: mkdtempSync(path.join(tmpdir(), "ha-resident-workspace-")),
          },
        },
        async () => "device-token-edge-one",
      );
    const streamDown = (pattern: RegExp) => (error: unknown) => {
      assert.equal((error as { code?: string }).code, "replica_stream_down", String(error));
      assert.match(String(error), pattern);
      return true;
    };
    const link = await relay(t, fixture.centerPort());
    assert.equal(await waitForFleetReplicaReady(view), false, "an edge without a resident stream stays unavailable");
    link.hold();
    const stream = startStream(t, fixture, viewRoot, link.port),
      initialReady = waitForFleetReplicaReady(view);
    link.release();
    assert.equal(await initialReady, true, "runtime readiness waits for the first durable replica ACK");
    await converged("initial convergence");
    // The stream is held behind the center's head; sync asks the center for it and waits for it.
    link.hold();
    await pressure(fixture, 2);
    const head = centerSequence(fixture),
      metadataAnswered = command.nextClose(),
      synced = sync();
    await metadataAnswered;
    link.release();
    const receipt = (await synced) as { ok: boolean; knownHead: { headDigest: string } };
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.ok(
      Number(receipt.knownHead.headDigest.split(":").at(-1)) >= head,
      `sync reported ${receipt.knownHead.headDigest} before the center head ${head}`,
    );
    // A wait pending across a transient disconnect remains registered until the resident reconnects.
    link.hold();
    await pressure(fixture);
    const target = centerSequence(fixture),
      failuresBeforeCut = stream.failures.length,
      pending = waitForFleetReplicaSequence(view, target);
    link.refuse(true);
    link.cut();
    await waitForState(() => stream.failures.length > failuresBeforeCut, "resident stream to observe the disconnect");
    link.refuse(false);
    link.release();
    await pending;
    await converged("convergence after the outage");
    await waitForFleetReplicaSequence(view, target);
    // The caller's signal cancels a wait; stopping the stream fails the waits it would have served.
    const caller = new AbortController(),
      cancelled = waitForFleetReplicaSequence(view, target + 1000, caller.signal);
    caller.abort(new Error("caller gave up"));
    await assert.rejects(cancelled, /caller gave up/u);
    const timedOut = waitForFleetReplicaSequence(view, target + 1000, AbortSignal.timeout(20));
    await assert.rejects(timedOut, (error: unknown) => (error as { name?: string }).name === "TimeoutError");
    const orphan = waitForFleetReplicaSequence(view, target + 1000);
    await stream.stop();
    await assert.rejects(orphan, streamDown(/stopped/u));
    await assert.rejects(waitForFleetReplicaSequence(view, target + 1000), streamDown(/not running/u));
    // Without a resident stream for this view, sync fails at once instead of answering a stale mirror.
    await pressure(fixture);
    await assert.rejects(sync(), streamDown(/not running/u));
  },
);

test(
  "a node owner who loses repository-read has the replica withdrawn and the failure reported; a re-grant restores it",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-denied-view-")),
      viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
      mirrorSequence = () => readReplicaGeneration(viewDir)?.metadata.position.sequence ?? -1;
    const link = await relay(t, fixture.centerPort());
    const stream = startStream(t, fixture, viewRoot, link.port);
    await waitForState(() => mirrorSequence() === centerSequence(fixture), "initial convergence", 60_000);
    fixture.owners.keycloak.revoke("person-owner", replicationRepoId, ["repository-read"]);
    // An explicit edge sync the center denies withholds the delivered rows at once, before the stream
    // learns of the denial.
    await assert.rejects(
      syncFleetEdgeMirror(
        {
          payload: {
            host: "127.0.0.1",
            port: fixture.centerPort(),
            caPath: fixture.certFile,
            servername: "localhost",
            nodeId: "edge-one",
            credential: "secret-edge-one",
            repoId: replicationRepoId,
            viewRoot,
            quotaBytes: 64 * 1024 * 1024,
            workspaceRoot: mkdtempSync(path.join(tmpdir(), "ha-denied-workspace-")),
          },
        },
        async () => "device-token-edge-one",
      ),
      { code: "authorization_denied" },
    );
    assert.equal(readReplicaGeneration(viewDir), null, "the denied sync withholds the replica");
    link.cut();
    await waitForState(
      () => stream.failures.some((error) => (error as { code?: unknown }).code === "authorization_denied"),
      "the denial to be reported",
      60_000,
    );
    assert.equal(readReplicaGeneration(viewDir), null, "the denied stream keeps the replica withdrawn");
    assert.deepEqual(readdirSync(path.join(viewDir, "generations")), [], "and its files are collected");
    assert.equal(readReplicaHealth(viewDir).syncFailure?.code, "authorization_denied");
    fixture.owners.keycloak.permit("person-owner", replicationRepoId, ["repository-read"]);
    await waitForState(() => mirrorSequence() === centerSequence(fixture), "re-admission after the grant", 60_000);
  },
);
