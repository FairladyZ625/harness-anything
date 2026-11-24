// harness-test-tier: integration
// dec_9284BD6119D453EEECEED62450 real-machine hardening of the resident edge stream (runFleetReplicaSync):
// edge-runtime confirmations never run inside the receiver's ACK path; an edge upgraded in place over
// the retired cut/pull layout starts a fresh replica instead of failing on the old pointer; content
// objects larger than the in-memory envelope bound stream to staging files and are digest-checked.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { TLSSocket } from "node:tls";
import { connect, createServer, type Socket } from "node:net";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import {
  runFleetReplicaSync,
  waitForFleetReplicaSequence,
  type ReplicaSyncOptions,
} from "../src/daemon-host/fleet/replica-sync.ts";
import { readReplicaGeneration } from "../src/fleet-sync/fleet/replica-generation.ts";
import { writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { edgeReplicaDoctor } from "../src/daemon-host/edge-replica-doctor.ts";
import { FleetEdgeGitPreflightError } from "../src/daemon-host/fleet-edge-git-preflight.ts";
import { openRuntimeRecoveryWatch, runReplicaConfirmedRound } from "../src/daemon-host/runtime-recovery-watch.ts";
import { runWalReceiver } from "../src/daemon-host/fleet/walreceiver.ts";
import { REPLICATION_CHUNK_BYTES, type ReplicationFrame } from "../src/fleet-sync/fleet/protocol.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import {
  fleetReplicationFixture,
  replicationRepoId,
  seedCenterData,
  waitForState,
  type FleetReplicationFixture,
} from "./fleet-replication.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { runSwitchoverSlice2Mode2E2e } from "./center-switchover-slice2-e2e.fixture.ts";

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

test("stop joins the active confirmation and drops queued confirmations", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-stop-")),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0,
    confirmed = false,
    stopped = false;
  const stream = startHardeningStream(t, fixture, viewRoot, {
    onConfirmed: async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
      confirmed = true;
    },
  });
  try {
    await entered.promise;
    await pressure(fixture);
    await waitForFleetReplicaSequence(viewKey(viewRoot), centerSequence(fixture), AbortSignal.timeout(20_000));
    const disconnected = assert.rejects(waitForFleetReplicaSequence(viewKey(viewRoot), centerSequence(fixture) + 1), {
      code: "replica_stream_down",
    });
    const stopping = stream.stop().then(() => {
      stopped = true;
    });
    await disconnected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "the stream owner returned while its confirmation was still active");
    release.resolve();
    await stopping;
    assert.equal(confirmed, true);
    assert.equal(calls, 1, "an aborted stream never starts its queued confirmation");
  } finally {
    release.resolve();
    await stream.stop();
    removeTempRepository(viewRoot);
  }
});

test(
  "daemon shutdown cancels pending confirmation work without reporting a close failure",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-shutdown-confirm-")),
      streamController = new AbortController(),
      shutdownController = new AbortController(),
      entered = Promise.withResolvers<void>();
    t.after(() => removeTempRepository(viewRoot));
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
      signal: streamController.signal,
      shutdownSignal: shutdownController.signal,
      confirmTimeoutMs: 60_000,
      onConfirmed: async () => {
        entered.resolve();
        await new Promise<never>((_resolve, reject) =>
          shutdownController.signal.addEventListener("abort", () => reject(new Error("daemon closed")), {
            once: true,
          }),
        );
      },
      onConfirmedFailure: (error) => {
        throw error;
      },
    });
    t.after(async () => {
      shutdownController.abort(new Error("daemon closed"));
      streamController.abort();
      await running;
    });
    await entered.promise;
    shutdownController.abort(new Error("daemon closed"));
    streamController.abort();
    await running;
  },
);

test(
  "stop releases a confirmation waiting for a future replica sequence before joining it",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-stop-waiter-")),
      entered = Promise.withResolvers<void>(),
      failures: unknown[] = [];
    const stream = startHardeningStream(t, fixture, viewRoot, {
      onConfirmed: async () => {
        const pending = waitForFleetReplicaSequence(viewKey(viewRoot), centerSequence(fixture) + 1);
        entered.resolve();
        await pending;
      },
      onConfirmedFailure: (error) => failures.push(error),
    });
    try {
      await entered.promise;
      await stream.stop();
      assert.equal(failures.length, 1);
      assert.equal((failures[0] as { code?: string }).code, "replica_stream_down");
      assert.deepEqual(stream.failures, [], "shutdown does not report a reconnect failure");
    } finally {
      await stream.stop();
      removeTempRepository(viewRoot);
    }
  },
);

test("a failing confirmation is reported and never fails the replication stream", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
    confirmFailures: unknown[] = [],
    confirmedPaths: (readonly string[] | undefined)[] = [];
  const stream = startHardeningStream(t, fixture, viewRoot, {
    onConfirmed: (changedPaths) => {
      confirmedPaths.push(changedPaths);
      throw new Error("center rejected the reconcile");
    },
    onConfirmedFailure: (error) => confirmFailures.push(error),
  });
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  // The receiver can reach the center position while confirmation is still retrying.
  await waitForState(() => confirmFailures.length >= 1, "confirmation reports its failure after retries", 60_000);
  await pressure(fixture, 3);
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "convergence across failing confirmations",
    60_000,
  );
  assert.deepEqual(stream.failures, [], "confirmation failures are not stream failures");
  assert.deepEqual(
    confirmedPaths.filter((paths) => paths !== undefined),
    [],
    "a failed confirmation loses its path list, so every retry compares the whole cut",
  );
});

test(
  "a stream confirms the whole cut first, then only the paths later commits changed",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
      viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
      confirmedPaths: (readonly string[] | undefined)[] = [];
    startHardeningStream(t, fixture, viewRoot, {
      onConfirmed: (changedPaths) => {
        confirmedPaths.push(changedPaths);
      },
    });
    await waitForState(
      () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
      "initial convergence",
      60_000,
    );
    await waitForState(() => confirmedPaths.length > 0, "the first confirmation", 60_000);
    assert.equal(confirmedPaths[0], undefined, "a new process and a base backup materialize the whole cut");
    const before = confirmedPaths.length;
    await pressure(fixture, 3);
    await waitForState(
      () => confirmedPaths.slice(before).some((paths) => (paths?.length ?? 0) > 0),
      "a confirmation naming the changed paths",
      60_000,
    );
    assert.ok(
      confirmedPaths.slice(before).every((paths) => paths !== undefined),
      "streamed commits carry their changed paths",
    );
  },
);

test(
  "an edge upgraded over the retired cut/pull layout discards it and installs a generation",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
      repoDir = path.join(viewRoot, "repos", replicationRepoId),
      viewDir = path.join(repoDir, "views", "edge-one");
    // The retired replica used viewId = nodeId, so its pointer sits exactly where a generation pointer goes.
    mkdirSync(path.join(viewDir, "cuts", "7-g1"), { recursive: true });
    writeFileSync(path.join(viewDir, "cuts", "7-g1", "manifest.json"), "{}");
    mkdirSync(path.join(viewDir, ".staging", "transfer"), { recursive: true });
    writeFileSync(path.join(viewDir, "read-model.sqlite"), "");
    mkdirSync(path.join(repoDir, "cas", "sha256", "ab"), { recursive: true });
    writeFileSync(path.join(repoDir, "manifests.sqlite"), "");
    writeFileSync(
      path.join(viewDir, "current.json"),
      JSON.stringify({
        cut: { revision: 7, headDigest: `sha256:${"0".repeat(64)}` },
        schemaGeneration: 1,
        manifestDigest: `sha256:${"1".repeat(64)}`,
        readerProfile: { personId: "edge-operator", nodeId: "edge-one" },
        authorizationShapeDigest: `sha256:${"2".repeat(64)}`,
      }),
    );
    assert.equal(readReplicaGeneration(viewDir), null, "the retired pointer names no generation");
    const stream = startHardeningStream(t, fixture, viewRoot);
    await waitForState(
      () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
      "a fresh generation over the retired layout",
      60_000,
    );
    for (const retired of [
      path.join(viewDir, "cuts"),
      path.join(viewDir, ".staging"),
      path.join(viewDir, "read-model.sqlite"),
      path.join(repoDir, "cas"),
      path.join(repoDir, "manifests.sqlite"),
    ])
      assert.equal(existsSync(retired), false, `${retired} was discarded`);
    assert.deepEqual(stream.failures, []);
  },
);

/** Feeds one commit carrying one content object to the receiver, then stops it. */
async function receiveOneObjectCommit(object: Buffer, announcedSha256: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "ha-harden-objects-")),
    stop = new Error("stop"),
    commit = Buffer.from(
      JSON.stringify({ position: { history: "h", sequence: 1, revision: 0 }, events: [], outcome: null, writer: null }),
    ),
    data = (bytes: Buffer): ReplicationFrame[] => {
      const frames: ReplicationFrame[] = [];
      for (let offset = 0; offset < bytes.length; offset += REPLICATION_CHUNK_BYTES)
        frames.push({
          type: "replica.data",
          offset,
          data: bytes.subarray(offset, offset + REPLICATION_CHUNK_BYTES).toString("base64"),
        });
      return frames;
    },
    frames: ReplicationFrame[] = [
      {
        type: "replica.accept",
        centerBuildCommit: null,
        taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
      },
      { type: "replica.commit", size: commit.length },
      ...data(commit),
      { type: "replica.object", sha256: announcedSha256, size: object.length },
      ...data(object),
      { type: "replica.object.end" },
      { type: "replica.commit.end" },
    ],
    installed: { sha256: string; bytes: Buffer }[] = [],
    applied: number[] = [];
  const result = await runWalReceiver({
    peer: {
      send: async () => undefined,
      receive: async () => {
        const next = frames.shift();
        if (!next) throw stop;
        return next;
      },
    },
    repoId: replicationRepoId,
    directory,
    quotaBytes: 64 * 1024 * 1024,
    // Far below the object: the object never sits in memory, only the commit envelope does.
    maxBufferedBytes: 64 * 1024,
    signal: new AbortController().signal,
    target: {
      position: () => null,
      install: async () => {
        throw new Error("unexpected install");
      },
      installObject: async (sha256, file) => {
        installed.push({ sha256, bytes: readFileSync(file) });
      },
      apply: (applying) => {
        applied.push(applying.position.sequence);
      },
      project: async () => undefined,
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  return { result, stop, installed, applied };
}

test("a content object larger than the in-memory bound streams to staging and installs before apply", async () => {
  const object = Buffer.alloc(512 * 1024, 0x61),
    sha256 = createHash("sha256").update(object).digest("hex");
  const received = await receiveOneObjectCommit(object, sha256);
  assert.equal(received.result, received.stop, String(received.result));
  assert.equal(received.installed.length, 1);
  assert.equal(received.installed[0]!.sha256, sha256);
  assert.ok(received.installed[0]!.bytes.equals(object), "the staged object holds the exact bytes");
  assert.deepEqual(received.applied, [1], "the commit applies after its object is installed");
});

test("a streamed content object whose bytes differ from its digest is rejected before apply", async () => {
  const object = Buffer.alloc(256 * 1024, 0x62);
  const received = await receiveOneObjectCommit(object, "0".repeat(64));
  assert.match(String(received.result), /digest differs/u);
  assert.deepEqual(received.installed, []);
  assert.deepEqual(received.applied, []);
});

test("an idle connected edge costs the center no busy event loop", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one");
  startHardeningStream(t, fixture, viewRoot);
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  // The center's sender and the edge's receiver both live in this process; idle, they must sleep.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const used = process.cpuUsage(before),
    cpuMs = (used.user + used.system) / 1000;
  assert.ok(cpuMs < 600, `idle replication used ${cpuMs.toFixed(0)} ms CPU in 2 s`);
});

/** A TCP relay whose center-to-edge direction can go silent without closing: a half-open link. */
async function silenceableRelay(t: TestContext, target: number) {
  const live = new Set<Socket>();
  let silent = false;
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
    client.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (!silent) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of live) socket.destroy();
    server.close();
  });
  return {
    port: (server.address() as { port: number }).port,
    silence: (value: boolean) => {
      silent = value;
    },
  };
}

test("an idle stream is kept fresh by center keepalives", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t, { replicationKeepaliveMs: 200 });
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one");
  const stream = startHardeningStream(t, fixture, viewRoot, { idleTimeoutMs: 1_500 });
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  // Let the convergence round (its trailing progress and ACK) settle before observing idleness.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const confirmedAt = statSync(path.join(viewDir, "current.json")).mtimeMs;
  // No commits: only keepalives arrive. They must refresh the read freshness and never trip the
  // edge's idle timeout.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.ok(
    statSync(path.join(viewDir, "current.json")).mtimeMs > confirmedAt,
    "keepalive progress refreshed the confirmed position",
  );
  assert.deepEqual(stream.failures, [], "keepalives kept the idle stream alive");
});

test("a silent center connection is detected and the stream reconnects", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t, { replicationKeepaliveMs: 200 });
  await seedCenterData(fixture, seededTask);
  await fixture.openCenter();
  const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
    viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one"),
    link = await silenceableRelay(t, fixture.centerPort());
  const stream = startHardeningStream(t, fixture, viewRoot, { port: link.port, idleTimeoutMs: 1_500 });
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "initial convergence",
    60_000,
  );
  link.silence(true);
  await waitForState(
    () => stream.failures.some((error) => (error as { code?: string }).code === "replica_keepalive_missed"),
    "the edge to notice the silent connection",
    30_000,
  );
  link.silence(false);
  await pressure(fixture, 2);
  await waitForState(
    () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
    "convergence after reconnecting",
    60_000,
  );
});

test(
  "the center reports each slot's ACK against the head and the edge doctor ages its stream",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    const center = await fixture.openCenter();
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
      viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one");
    const stream = startHardeningStream(t, fixture, viewRoot);
    await waitForState(
      () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
      "initial convergence",
      60_000,
    );
    await waitForState(
      () => center.status().replicas.some((row) => row.nodeId === "edge-one" && row.lagCommits === 0),
      "the slot ACK to reach the head",
    );
    const row = center.status().replicas.find((replica) => replica.nodeId === "edge-one")!;
    assert.equal(row.repoId, replicationRepoId);
    assert.equal(row.connected, true);
    assert.equal(row.delivery, "current");
    assert.equal(row.ackSequence, centerSequence(fixture));
    assert.equal(row.centerSequence, centerSequence(fixture));
    assert.equal(typeof row.ackedAt, "string");

    // Edge doctor: a confirming stream is healthy; a stream silent past three keepalives is not.
    const workspace = mkdtempSync(path.join(tmpdir(), "ha-harden-workspace-")),
      doctorUserRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-user-"));
    t.after(() => {
      removeTempRepository(workspace);
      removeTempRepository(doctorUserRoot);
    });
    writeFleetEdgeConfig(doctorUserRoot, replicationRepoId, {
      repoId: replicationRepoId,
      host: "127.0.0.1",
      port: fixture.centerPort(),
      caPath: "ca.pem",
      nodeId: "edge-one",
      credential: "secret-edge-one",
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
    });
    const fresh = edgeReplicaDoctor(workspace, replicationRepoId, undefined, doctorUserRoot);
    assert.equal(fresh.failureCode, null, JSON.stringify(fresh));
    assert.equal(fresh.lag, 0);
    assert.equal(typeof fresh.lastSuccessAt, "string");
    const silent = edgeReplicaDoctor(workspace, replicationRepoId, () => Date.now() + 10 * 60_000, doctorUserRoot);
    assert.equal(silent.failureCode, "replica_stream_silent", JSON.stringify(silent));
    assert.equal(silent.lag, null);

    await stream.stop();
    await waitForState(
      () => center.status().replicas.find((replica) => replica.nodeId === "edge-one")?.connected === false,
      "the center to see the replication session end",
    );
  },
);

test("each base backup owns a directory that keeps only its archive", { timeout: 120_000 }, async (t) => {
  const fixture = await fleetReplicationFixture(t);
  await seedCenterData(fixture, seededTask);
  const backupsRoot = path.join(fixture.stateRoot, "replication-backups");
  // A directory left by a previous center process is not served and is removed at start.
  mkdirSync(path.join(backupsRoot, "payload"), { recursive: true });
  await fixture.openCenter();
  assert.equal(existsSync(path.join(backupsRoot, "payload")), false);
  // Publication precedes the ACK; the center deletes the archive after its last sender's ACK.
  // Hold that existing protocol boundary so the directory is still owned when inspected.
  const edge = fixture.startEdge("edge-one", { holdAcks: true });
  await edge.waitForEvent("installed");
  const backups = readdirSync(backupsRoot);
  assert.deepEqual(backups, [replicationRepoId], JSON.stringify(backups));
  const repoBackups = readdirSync(path.join(backupsRoot, replicationRepoId));
  assert.equal(repoBackups.length, 1, JSON.stringify(repoBackups));
  assert.match(repoBackups[0]!, /^[0-9a-f-]{36}$/u, "a backup directory is named for that backup, not shared");
  assert.deepEqual(
    readdirSync(path.join(backupsRoot, replicationRepoId, repoBackups[0]!)).sort(),
    ["base.tar.gz", "pin.json"],
    "only the archive and its pin metadata are kept",
  );
  edge.control({ control: "release-acks" });
  await waitForState(() => readdirSync(backupsRoot).length === 0, "last backup user to release its archive");
});

test(
  "a base backup larger than the receive window flows at the edge's write speed",
  { timeout: 180_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    const { planPath } = await seedCenterData(fixture, seededTask);
    // Incompressible content keeps the archive past the receive window (256 frames of 64 KiB).
    // Three documents keep every single document under the 20,000,000-byte ceiling while their
    // combined ~50MB still exceeds the window.
    const bulkDir = `${path.posix.dirname(planPath)}/artifacts`,
      bulkPaths = [1, 2, 3].map((part) => `${bulkDir}/bulk-${part}.md`);
    mkdirSync(path.join(fixture.repo, "harness", bulkDir), { recursive: true });
    for (const [index, bulkPath] of bulkPaths.entries())
      writeFileSync(
        path.join(fixture.repo, "harness", bulkPath),
        `# Bulk ${index + 1}\n\n${randomBytes(12 * 1024 * 1024).toString("base64")}\n`,
      );
    const submitted = await fixture.centerRun({ kind: "doc-submit", paths: bulkPaths });
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await fixture.openCenter();
    // A stalled disk on the edge: staged writes wait until the stream stops reading, so frames
    // can only pile up behind them. Without backpressure the pause never comes and nothing converges.
    const probe = await open(path.join(mkdtempSync(path.join(tmpdir(), "ha-harden-probe-")), "probe"), "w"),
      handlePrototype = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<void> };
    await probe.close();
    const writeFile = handlePrototype.writeFile,
      pause = TLSSocket.prototype.pause;
    let pauses = 0,
      release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    handlePrototype.writeFile = async function (this: unknown, ...args: unknown[]) {
      await paused;
      return writeFile.apply(this, args);
    };
    TLSSocket.prototype.pause = function (this: TLSSocket) {
      pauses += 1;
      release();
      return pause.call(this);
    };
    t.after(() => {
      // A stream still stalled behind the gate must be able to stop.
      release();
      handlePrototype.writeFile = writeFile;
      TLSSocket.prototype.pause = pause;
    });
    const viewRoot = mkdtempSync(path.join(tmpdir(), "ha-harden-view-")),
      viewDir = path.join(viewRoot, "repos", replicationRepoId, "views", "edge-one");
    const stream = startHardeningStream(t, fixture, viewRoot, { diskQuotaBytes: 256 * 1024 * 1024 });
    await waitForState(
      () => readReplicaGeneration(viewDir)?.metadata.position.sequence === centerSequence(fixture),
      "convergence after a backup larger than the receive window",
      150_000,
    );
    assert.ok(pauses > 0, "the edge stopped reading while received frames waited to be written");
    assert.deepEqual(stream.failures, []);
  },
);

test(
  "a hung confirmation releases its confirming lock on timeout so later revisions confirm",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRootTimeout = mkdtempSync(path.join(tmpdir(), "ha-harden-confirm-timeout-"));
    t.after(() => removeTempRepository(viewRootTimeout));

    let timeoutCalls = 0,
      timeoutSecondConfirmed = false;
    const timeoutFailures: unknown[] = [];
    startHardeningStream(t, fixture, viewRootTimeout, {
      confirmTimeoutMs: 80,
      onConfirmed: async () => {
        const call = ++timeoutCalls;
        if (call === 1) {
          await new Promise<never>(() => undefined);
        }
        timeoutSecondConfirmed = true;
      },
      onConfirmedFailure: (error) => timeoutFailures.push(error),
    });
    await waitForState(
      () => timeoutFailures.some((error) => (error as { code?: string }).code === "replica_confirm_timeout"),
      "hung confirmation timeout",
      30_000,
    );
    await pressure(fixture);
    await waitForState(() => timeoutSecondConfirmed, "later revision confirmation after timeout", 30_000);
    assert.ok(timeoutCalls >= 2, `expected later revision to re-trigger onConfirmed, got ${timeoutCalls}`);
  },
);

test(
  "a hung confirmation releases its confirming lock on connection drop so later revisions confirm",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t);
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();
    const viewRootDrop = mkdtempSync(path.join(tmpdir(), "ha-harden-confirm-drop-"));
    t.after(() => removeTempRepository(viewRootDrop));

    const liveSockets = new Set<Socket>(),
      relayServer = createServer((client) => {
        const upstream = connect(fixture.centerPort(), "127.0.0.1");
        liveSockets.add(client).add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          liveSockets.delete(client);
          liveSockets.delete(upstream);
        };
        client.on("error", drop).on("close", drop);
        upstream.on("error", drop).on("close", drop);
        client.pipe(upstream).pipe(client);
      });
    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      for (const socket of liveSockets) socket.destroy();
      relayServer.close();
    });
    const relayPort = (relayServer.address() as { port: number }).port;
    let dropCalls = 0,
      sawAbortedSignal = false,
      dropFirstEntered = false,
      dropSecondConfirmed = false;
    const dropFailures: unknown[] = [];
    const dropStream = startHardeningStream(t, fixture, viewRootDrop, {
      port: relayPort,
      confirmTimeoutMs: 60_000,
      onConfirmed: async (_paths, signal) => {
        const call = ++dropCalls;
        if (call === 1) {
          signal?.addEventListener(
            "abort",
            () => {
              sawAbortedSignal = true;
            },
            { once: true },
          );
          dropFirstEntered = true;
          // Intentionally ignore signal to verify the confirming lock releases even for non-cancellable callbacks.
          await new Promise<never>(() => undefined);
        }
        dropSecondConfirmed = true;
      },
      onConfirmedFailure: (error) => dropFailures.push(error),
    });
    await waitForState(() => dropFirstEntered, "first confirmation to enter", 30_000);
    for (const socket of [...liveSockets]) socket.destroy();
    await waitForState(
      () =>
        dropStream.failures.length >= 1 &&
        dropFailures.some((error) => (error as { code?: string }).code === "replica_stream_down"),
      "hung confirmation released on connection drop",
      30_000,
    );
    assert.equal(sawAbortedSignal, true, "the confirmation abort signal fires on disconnect");
    await pressure(fixture);
    await waitForState(() => dropSecondConfirmed, "later revision confirmation after reconnect", 30_000);
    assert.ok(dropCalls >= 2, `expected later revision after reconnect to trigger onConfirmed, got ${dropCalls}`);
  },
);

test(
  "deterministic edge mirror conflict logs replica_confirm_failed once, keeps auto-claim/dispatch running, surfaces in ha agenda, and clears on resolution",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    let autoDispatchTriggers = 0,
      autoClaimTriggers = 0;
    const originalDispatchRead = f.host.readNodeAutoDispatchCandidates.bind(f.host),
      originalClaimRead = f.host.readNodeAutoClaimCandidates.bind(f.host);
    f.host.readNodeAutoDispatchCandidates = async (...args) => {
      autoDispatchTriggers += 1;
      return originalDispatchRead(...args);
    };
    f.host.readNodeAutoClaimCandidates = async (...args) => {
      autoClaimTriggers += 1;
      return originalClaimRead(...args);
    };

    const taskId = "task_confirmconflict0000000001";
    const created = await f.host.run(
      "lease-repo",
      { kind: "task-create", taskId, title: "Edge confirm conflict isolation" },
      localAuthFixture(),
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const shown = await f.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture()),
      packagePath = String(JSON.parse(String(shown.evidence)).packagePath),
      planLogical = `${packagePath}/task_plan.md`,
      centerPlanPath = path.join(f.repo, "harness", ...planLogical.split("/"));
    mkdirSync(path.dirname(centerPlanPath), { recursive: true });
    writeFileSync(centerPlanPath, realizedTaskPlan(taskId));
    const seededPlan = await f.host.run("lease-repo", { kind: "doc-submit", paths: [planLogical] }, localAuthFixture());
    assert.equal(seededPlan.outcome, "applied", JSON.stringify(seededPlan));

    const lifecycleEvents: { readonly event: string; readonly code?: string; readonly error?: string }[] = [],
      edge = await fleetEdgeHostFixture(t, f, {
        recordLifecycle: (entry) => lifecycleEvents.push(entry),
      });
    const edgePlanPath = path.join(resolveHarnessLayout(edge.edgeRoot).authoredRoot, ...planLogical.split("/")),
      edgeViewDir = path.join(edge.viewRoot, "repos", "lease-repo", "views", "node-one");
    await waitForState(() => existsSync(edgePlanPath), "initial mirror materialization on edge", 60_000);
    await edge.host.configureNodeAutoClaim(
      {
        schema: "node-auto-claim/v1",
        enabled: true,
        allowedSources: { personIds: [], teamIds: [] },
        allowedAgentIds: ["worker-one"],
        maxConcurrent: 1,
      },
      localAuthFixture(),
    );

    // Inject a genuine modify/modify workspace conflict: local edits task_plan.md while center advances it + 2 more cuts.
    const conflictingLocalText = `${readFileSync(edgePlanPath, "utf8")}\nLocal conflicting edit\n`,
      updatedCenterText = `${realizedTaskPlan(taskId)}\nCanonical center amendment\n`;
    writeFileSync(edgePlanPath, conflictingLocalText);
    autoDispatchTriggers = 0;
    autoClaimTriggers = 0;

    writeFileSync(centerPlanPath, updatedCenterText);
    assert.equal(
      (await f.host.run("lease-repo", { kind: "doc-submit", paths: [planLogical] }, localAuthFixture())).outcome,
      "applied",
    );
    for (const index of [1, 2]) {
      const extra = await f.host.run(
        "lease-repo",
        {
          kind: "task-create",
          taskId: `task_confirmpressure000000000${index}`,
          title: `Confirm pressure ${index}`,
        },
        localAuthFixture(),
      );
      assert.equal(extra.outcome, "applied", JSON.stringify(extra));
    }
    const centerRevisionAfterPressure = f.eventCount();
    await waitForState(
      () =>
        readReplicaGeneration(edgeViewDir)?.metadata.position.revision === centerRevisionAfterPressure &&
        autoDispatchTriggers >= 1 &&
        autoClaimTriggers >= 1,
      "edge stream convergence and unblocked auto-claim/dispatch across 3 conflicting cuts",
      60_000,
    );

    const confirmFailureEvents = () => lifecycleEvents.filter((entry) => entry.event === "replica_confirm_failed");
    await waitForState(() => confirmFailureEvents().length >= 1, "single replica_confirm_failed record", 15_000);
    assert.equal(
      confirmFailureEvents().length,
      1,
      `deterministic confirmation conflict must log once across repeated cuts: ${JSON.stringify(confirmFailureEvents())}`,
    );
    assert.ok(autoDispatchTriggers >= 1, "autoDispatchLoop must run even when applyFleetMirrorCut is pull_blocked");
    assert.ok(autoClaimTriggers >= 1, "autoClaimLoop must run even when applyFleetMirrorCut is pull_blocked");

    const edgeAgendaBlocked = await edge.host.read(
      "lease-repo",
      "repo.agenda.read",
      {},
      { transportKind: "unix-socket" },
    );
    assert.match(
      edgeAgendaBlocked.summary,
      /本节点副本确认待处理 \[阻塞\][\s\S]*\[pull_blocked\][\s\S]*task_plan\.md/u,
      `edge agenda must immediately surface the deterministic confirmation block: ${edgeAgendaBlocked.summary}`,
    );
    const centerAgenda = await f.host.read("lease-repo", "repo.agenda.read", {}, localAuthFixture());
    assert.doesNotMatch(
      centerAgenda.summary,
      /本节点副本确认待处理/u,
      "node-local mirror conflicts must never pollute the canonical center agenda",
    );

    // Operator resolves the local workspace conflict; the next confirmed cut clears agenda and keeps log count at 1.
    writeFileSync(edgePlanPath, updatedCenterText);
    assert.equal(
      (
        await f.host.run(
          "lease-repo",
          { kind: "task-create", taskId: "task_confirmrecover0000000001", title: "Recovery cut" },
          localAuthFixture(),
        )
      ).outcome,
      "applied",
    );
    await waitForState(
      async () => {
        const agenda = await edge.host.read("lease-repo", "repo.agenda.read", {}, { transportKind: "unix-socket" });
        return !agenda.summary.includes("本节点副本确认待处理");
      },
      "edge agenda confirmation block to clear automatically after conflict resolution",
      60_000,
    );
    assert.equal(confirmFailureEvents().length, 1, "recovery must not emit extra failure logs");
  },
);

test(
  "deterministic branch divergence coalesces heartbeat scans without blocking downstream rounds, while transient errors recover via backoff",
  { timeout: 120_000 },
  async (t) => {
    const fixture = await fleetReplicationFixture(t, { replicationKeepaliveMs: 150 });
    await seedCenterData(fixture, seededTask);
    await fixture.openCenter();

    // Positive control 1: deterministic divergence across commits + keepalive heartbeats.
    const viewRootDet = mkdtempSync(path.join(tmpdir(), "ha-harden-det-divergence-"));
    t.after(() => removeTempRepository(viewRootDet));
    const watch = openRuntimeRecoveryWatch(),
      confirmFailureEvents: unknown[] = [];
    let diverged = true,
      fullMirrorScans = 0,
      heartbeatSkips = 0,
      autoDispatchTriggers = 0,
      recoveredRounds = 0;

    const detStream = startHardeningStream(t, fixture, viewRootDet, {
      onConfirmed: async (changedPaths) => {
        await runReplicaConfirmedRound({
          materialize: () => {
            if (diverged && changedPaths !== undefined && changedPaths.length === 0) {
              heartbeatSkips += 1;
              throw new FleetEdgeGitPreflightError(
                "edge_default_branch_diverged",
                "edge main diverges from center main",
              );
            }
            fullMirrorScans += 1;
            if (diverged)
              throw new FleetEdgeGitPreflightError(
                "edge_default_branch_diverged",
                "edge main diverges from center main",
              );
          },
          observeConfirm: (failure) =>
            failure === null || failure === "unchanged"
              ? failure === null
                ? (recoveredRounds += 1)
                : undefined
              : watch.observe("lease-repo", [], new Date().toISOString()),
          reconcile: async () => undefined,
          observeRecovery: () => undefined,
          triggers: [
            async () => {
              autoDispatchTriggers += 1;
            },
          ],
        });
      },
      onConfirmedFailure: (error) => confirmFailureEvents.push(error),
    });

    await waitForState(
      () => confirmFailureEvents.length >= 1 && autoDispatchTriggers >= 1,
      "first diverged round",
      30_000,
    );
    await pressure(fixture, 2);
    await waitForState(
      () => fullMirrorScans >= 2 && heartbeatSkips >= 2 && autoDispatchTriggers >= 4,
      "commits and keepalive heartbeats while diverged",
      30_000,
    );
    const scansBeforeIdleHeartbeats = fullMirrorScans;
    const skipsBeforeIdleHeartbeats = heartbeatSkips;
    await waitForState(
      () => heartbeatSkips >= skipsBeforeIdleHeartbeats + 2,
      "two additional idle keepalive heartbeats",
      15_000,
    );
    assert.equal(
      fullMirrorScans,
      scansBeforeIdleHeartbeats,
      "empty keepalive ACKs must not trigger full-cut mirror scans while deterministic divergence is unchanged",
    );
    assert.equal(confirmFailureEvents.length, 1, "identical deterministic failure must emit onConfirmedFailure once");

    diverged = false;
    await pressure(fixture, 1);
    await waitForState(() => recoveredRounds >= 1, "confirmation recovery after branch divergence resolved", 30_000);
    assert.equal(confirmFailureEvents.length, 1);
    await detStream.stop();

    // Positive control 2: transient confirmation error recovers automatically via single retry backoff port.
    const viewRootTransient = mkdtempSync(path.join(tmpdir(), "ha-harden-transient-confirm-"));
    t.after(() => removeTempRepository(viewRootTransient));
    const transientFailureEvents: unknown[] = [];
    let transientCalls = 0,
      callsAtFirstRecovery = 0,
      transientRecovered = false;
    const transientStream = startHardeningStream(t, fixture, viewRootTransient, {
      onConfirmed: async () => {
        const call = ++transientCalls;
        if (call <= 2) throw Object.assign(new Error("temporary center reset"), { code: "ECONNRESET" });
        if (callsAtFirstRecovery === 0) callsAtFirstRecovery = call;
        transientRecovered = true;
      },
      onConfirmedFailure: (error) => transientFailureEvents.push(error),
    });
    await waitForState(
      () => transientRecovered,
      "transient confirmation error to self-heal via backoff without new commits",
      30_000,
    );
    assert.equal(callsAtFirstRecovery, 3, "transient failure retried twice and succeeded on the third run");
    assert.deepEqual(transientFailureEvents, [], "a transient failure that heals within retry budget does not latch");
    await transientStream.stop();
  },
);

test(
  "Switchover Slice 2 (Mode 2): stale offline edge refuses silent basebackup -> explicit --allow-basebackup rebuilds + managed RBAC relocation refreshes loginUrl/loginCertificate",
  { timeout: 180_000 },
  runSwitchoverSlice2Mode2E2e,
);
